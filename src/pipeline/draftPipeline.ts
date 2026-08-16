import { readFile } from "node:fs/promises";
import { env } from "../config/env.js";
import {
  appendFeedback,
  clearFeedbackWait,
  createDraft,
  markTopicBatchUsed,
  requireDraft,
  setDraftStatus,
  topicFromDraft,
  updateDraft,
} from "../db/repo.js";
import type { Draft, ModerationReport, RevisionScope, TopicCandidate } from "../db/schema.js";
import { generateImage } from "../generation/image.js";
import { generatePost, revisePost, MAX_POST_CHARS, type GeneratedPost } from "../generation/post.js";
import { moderateDraft } from "../moderation/index.js";
import { publishToLinkedIn } from "../linkedin/post.js";
import { LinkedInAuthRequiredError } from "../linkedin/oauth.js";
import { errorMessage, logger } from "../logger.js";
import {
  announceFailure,
  announcePublished,
  clearKeyboard,
  deleteMessage,
  notify,
  presentBlockedDraft,
  presentDraftForReview,
  sendWorkingNotice,
} from "../telegram/notify.js";

type ImageMediaType = "image/png" | "image/jpeg" | "image/webp";

function mediaTypeFor(filePath: string): ImageMediaType {
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
  if (filePath.endsWith(".webp")) return "image/webp";
  return "image/png";
}

/** Deterministic checks that run before the model-based safety gate. */
function structuralIssues(post: GeneratedPost): string[] {
  const issues: string[] = [];
  const text = post.postText.trim();
  if (text.length === 0) issues.push("The post text is empty.");
  if (text.length > MAX_POST_CHARS) {
    issues.push(
      `The post is ${text.length} characters, which is over the ${MAX_POST_CHARS} character limit. Cut it down without losing the main point.`,
    );
  }
  if (/\*\*|^#{1,6}\s/m.test(text)) {
    issues.push("The post contains markdown formatting, which LinkedIn renders literally. Use plain text.");
  }
  if (post.imagePrompt.trim().length === 0) issues.push("The image prompt is empty.");
  return issues;
}

/** Turns a failed safety report into instructions the revision pass can act on. */
function repairInstruction(report: ModerationReport): { scope: RevisionScope; feedback: string } {
  const parts: string[] = [];
  const textBad = !report.text.safe;
  const imageBad = Boolean(report.image && !report.image.safe);

  if (textBad) {
    parts.push(
      `The post text failed the safety review (${report.text.categories.join(", ") || "unspecified"}): ${report.text.reason}`,
    );
  }
  if (imageBad && report.image) {
    parts.push(
      `The image failed the safety review (${report.image.categories.join(", ") || "unspecified"}): ${report.image.reason}`,
    );
  }
  parts.push("Rewrite so the problem is gone. Keep the original topic and angle.");

  const scope: RevisionScope = textBad && imageBad ? "both" : imageBad ? "image" : "text";
  return { scope, feedback: parts.join("\n") };
}

type CycleStart =
  | { kind: "new" }
  | { kind: "revise"; scope: RevisionScope; feedback: string };

/**
 * The core loop: generate (or revise) → render image → run the safety gate →
 * either auto-repair, hand the draft to the reviewer, or block it.
 */
async function runProductionCycle(draftId: string, start: CycleStart): Promise<Draft> {
  let draft = await setDraftStatus(draftId, "generating");
  const topic: TopicCandidate = topicFromDraft(draft);

  const notice = await sendWorkingNotice(
    start.kind === "new" ? "✍️ Writing the post and generating the image…" : "✍️ Applying your changes…",
  );

  try {
    let generated: GeneratedPost =
      start.kind === "new"
        ? await generatePost(topic)
        : await revisePost({
            topic,
            currentText: draft.postText ?? "",
            currentImagePrompt: draft.imagePrompt ?? "",
            currentAltText: draft.imageAltText ?? "",
            scope: start.scope,
            feedback: start.feedback,
            history: draft.feedbackHistory,
          });

    let imageIsStale = start.kind === "new" || start.scope !== "text";
    let autoRepairs = 0;

    for (;;) {
      const structural = structuralIssues(generated);
      if (structural.length > 0 && autoRepairs < env.MODERATION_MAX_RETRIES) {
        autoRepairs += 1;
        logger.warn({ draftId, issues: structural }, "Draft failed structural checks, regenerating");
        generated = await revisePost({
          topic,
          currentText: generated.postText,
          currentImagePrompt: generated.imagePrompt,
          currentAltText: generated.imageAltText,
          scope: "text",
          feedback: structural.join(" "),
          history: draft.feedbackHistory,
        });
        continue;
      }

      draft = await updateDraft(draftId, {
        postText: generated.postText.trim().slice(0, MAX_POST_CHARS),
        imagePrompt: generated.imagePrompt,
        imageAltText: generated.imageAltText,
        status: "generating",
        errorMessage: null,
      });

      if (imageIsStale || !draft.imagePath) {
        const image = await generateImage(draftId, draft.revisionCount + autoRepairs, generated.imagePrompt);
        draft = await updateDraft(draftId, { imagePath: image.filePath });
        imageIsStale = false;
      }

      draft = await setDraftStatus(draftId, "moderating");

      const imageBytes = draft.imagePath ? await readFile(draft.imagePath) : null;
      const report = await moderateDraft({
        postText: draft.postText ?? "",
        image:
          imageBytes && draft.imagePath
            ? { base64: imageBytes.toString("base64"), mediaType: mediaTypeFor(draft.imagePath) }
            : null,
      });

      draft = await updateDraft(draftId, {
        moderation: report,
        moderationAttempts: draft.moderationAttempts + (report.safe ? 0 : 1),
      });

      if (report.safe) {
        draft = await updateDraft(draftId, { status: "pending_review" });
        await deleteMessage(notice);
        return presentDraftForReview(draft);
      }

      if (autoRepairs >= env.MODERATION_MAX_RETRIES) {
        logger.warn({ draftId, report }, "Draft blocked by safety gate after retries");
        draft = await updateDraft(draftId, { status: "moderation_blocked" });
        await deleteMessage(notice);
        return presentBlockedDraft(draft);
      }

      autoRepairs += 1;
      const repair = repairInstruction(report);
      imageIsStale = repair.scope !== "text";
      logger.info({ draftId, attempt: autoRepairs, scope: repair.scope }, "Auto-repairing unsafe draft");
      generated = await revisePost({
        topic,
        currentText: generated.postText,
        currentImagePrompt: generated.imagePrompt,
        currentAltText: generated.imageAltText,
        scope: repair.scope,
        feedback: repair.feedback,
        history: draft.feedbackHistory,
      });
    }
  } catch (error) {
    await deleteMessage(notice);
    const reason = errorMessage(error);
    logger.error({ draftId, err: reason }, "Production cycle failed");
    await updateDraft(draftId, { status: "failed", errorMessage: reason });
    await notify(`❗️ Could not produce the draft.\n<code>${reason}</code>`);
    throw error;
  }
}

/* ------------------------------------------------------------ entry points */

export async function startDraftFromTopic(
  topic: TopicCandidate,
  topicBatchId: string | null,
): Promise<Draft> {
  const draft = await createDraft({ topicBatchId, topic });
  if (topicBatchId) await markTopicBatchUsed(topicBatchId);
  logger.info({ draftId: draft.id, topic: topic.title }, "Draft started");
  return runProductionCycle(draft.id, { kind: "new" });
}

export async function applyReviewerFeedback(
  draftId: string,
  scope: RevisionScope,
  feedback: string,
): Promise<Draft> {
  const current = await requireDraft(draftId);

  if (current.revisionCount >= env.MAX_REVISIONS) {
    await notify(
      `🛑 This draft has been through ${current.revisionCount} revisions, which is the configured limit. Cancel it and start fresh with /topics.`,
    );
    return current;
  }

  await clearFeedbackWait(draftId);
  await appendFeedback(draftId, { at: new Date().toISOString(), scope, note: feedback });
  await updateDraft(draftId, { revisionCount: current.revisionCount + 1 });

  return runProductionCycle(draftId, { kind: "revise", scope, feedback });
}

export async function publishDraft(draftId: string): Promise<Draft> {
  let draft = await requireDraft(draftId);

  if (draft.status === "posted") {
    await notify("That post has already gone out.");
    return draft;
  }
  const postText = draft.postText;
  if (!postText) {
    throw new Error("Draft has no text to publish");
  }
  if (!draft.moderation?.safe) {
    await notify("🛑 Refusing to publish: this draft has not passed the safety check.");
    return draft;
  }

  await clearKeyboard(draft);
  draft = await setDraftStatus(draftId, "publishing");
  const notice = await sendWorkingNotice("🚀 Publishing to LinkedIn…");

  try {
    const result = await publishToLinkedIn({
      postText,
      imagePath: draft.imagePath,
      imageAltText: draft.imageAltText,
    });

    draft = await updateDraft(draftId, {
      status: "posted",
      linkedinPostId: result.postUrn,
      errorMessage: null,
    });

    await deleteMessage(notice);
    await announcePublished(draft, result.postUrl);
    return draft;
  } catch (error) {
    await deleteMessage(notice);
    const reason = errorMessage(error);
    logger.error({ draftId, err: reason }, "Publishing failed");
    draft = await updateDraft(draftId, { status: "failed", errorMessage: reason });

    if (error instanceof LinkedInAuthRequiredError) {
      await notify(`🔐 ${reason}`);
    } else {
      await announceFailure(draft, reason);
    }
    return draft;
  }
}

/** Re-attempts publishing for a draft that failed at the LinkedIn step. */
export async function retryPublish(draftId: string): Promise<Draft> {
  const draft = await requireDraft(draftId);
  if (draft.status !== "failed") {
    await notify("That draft is not in a failed state, so there is nothing to retry.");
    return draft;
  }
  return publishDraft(draftId);
}
