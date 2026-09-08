import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AuthedImage } from "../components/AuthedImage";
import { HexLoader } from "../components/HexLoader";
import { StatusBadge } from "../components/StatusBadge";
import { LinkedInPreview } from "../components/LinkedInPreview";
import type {
  ActivityEvent,
  ReviewDraft,
  ReviewState,
  ReviewTopicBatch,
  RevisionScope,
} from "../data/types";
import {
  ApiError,
  approveDraft,
  cancelDraft,
  getActivity,
  getReview,
  pickTopic,
  refreshTopics,
  reviseDraft,
  scanTopics,
  sendDraftBackToReview,
  submitCustomTopic,
} from "../lib/api";
import styles from "./Review.module.css";

const POLL_MS = 4000;
const WORKING_STATUSES = new Set(["generating", "moderating", "publishing"]);

type LoadState = "loading" | "ready" | "error";

export function Review() {
  const [review, setReview] = useState<ReviewState | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await getReview();
      setReview(next);
      setLoadState("ready");
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load the review queue");
      setLoadState((s) => (s === "ready" ? s : "error"));
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await refresh();
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [refresh]);

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Review</h1>
        <p className={styles.subtitle}>
          Pick a topic, approve or revise a draft, and publish — the same steps as the bot's buttons.
        </p>
      </div>

      {loadState === "loading" && (
        <p className={styles.status}>
          <HexLoader label="Loading the review queue" />
        </p>
      )}
      {loadState === "error" && <p className={styles.statusError}>{loadError}</p>}

      {loadState === "ready" && review && (
        <>
          {review.draft ? (
            <DraftCard
              key={`${review.draft.id}:${review.draft.revisionCount}:${review.draft.status}`}
              draft={review.draft}
              onChanged={refresh}
            />
          ) : review.topicBatch ? (
            <TopicPicker batch={review.topicBatch} onChanged={refresh} />
          ) : (
            <EmptyState onChanged={refresh} />
          )}
        </>
      )}

      <ActivityLog />
    </div>
  );
}

/* ------------------------------------------------------------------ helpers */

function useAction(onChanged: () => Promise<void>) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (name: string, fn: () => Promise<unknown>) => {
      setBusy(name);
      setError(null);
      try {
        await fn();
        await onChanged();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "That didn't work — try again");
      } finally {
        setBusy(null);
      }
    },
    [onChanged],
  );

  return { busy, error, run };
}

/* --------------------------------------------------------------- draft card */

function DraftCard({ draft, onChanged }: { draft: ReviewDraft; onChanged: () => Promise<void> }) {
  const navigate = useNavigate();
  const { busy, error, run } = useAction(onChanged);
  // Keyed on id:revision:status by the parent, so this state starts fresh each round.
  const [reviseOpen, setReviseOpen] = useState(false);
  const [scope, setScope] = useState<RevisionScope>("text");
  const [feedback, setFeedback] = useState("");

  const working = WORKING_STATUSES.has(draft.status);
  const atLimit = draft.revisionCount >= draft.maxRevisions;
  const modIssues = moderationIssues(draft);

  function submitRevision() {
    const note = feedback.trim();
    if (!note) return;
    void run("revise", () => reviseDraft(draft.id, scope, note));
  }

  return (
    <section className={styles.card}>
      <div className={styles.cardTop}>
        <h2 className={styles.cardTitle}>{draft.topicTitle}</h2>
        <StatusBadge status={draft.status} />
      </div>
      <div className={styles.cardMeta}>
        Revision {draft.revisionCount} of {draft.maxRevisions} allowed
        {draft.feedbackHistory.length > 0 && ` · ${draft.feedbackHistory.length} change request${draft.feedbackHistory.length === 1 ? "" : "s"} so far`}
      </div>

      {working ? (
        <div className={styles.working}>
          <HexLoader label={draft.status === "publishing" ? "Publishing to LinkedIn" : "Working on the draft"} />
          <p className={styles.workingNote}>Takes a minute or two. Progress shows in the log below.</p>
        </div>
      ) : (
        <>
          <LinkedInPreview text={draft.postText} />

          {draft.hasImage && draft.imageUrl && (
            <figure className={styles.figure}>
              <AuthedImage
                key={draft.imageUrl}
                src={draft.imageUrl}
                alt={draft.imageAltText ?? "Draft image"}
                className={styles.image}
              />
              {draft.imageAltText && <figcaption className={styles.caption}>{draft.imageAltText}</figcaption>}
            </figure>
          )}

          {modIssues.length > 0 && (
            <div className={styles.modBox}>
              <strong>Safety check flagged this:</strong>
              <ul>
                {modIssues.map((issue, i) => (
                  <li key={i}>{issue}</li>
                ))}
              </ul>
            </div>
          )}

          {draft.errorMessage && draft.status === "failed" && (
            <div className={styles.errorBox}>{draft.errorMessage}</div>
          )}

          {draft.status === "awaiting_confirmation" && (
            <div className={styles.confirmBanner}>
              Final confirmation — publishing to LinkedIn <strong>cannot be undone</strong>.
            </div>
          )}

          {error && <div className={styles.actionError}>{error}</div>}

          <div className={styles.actions}>{renderActions()}</div>

          {(reviseOpen || draft.status === "awaiting_feedback") && (
            <ReviseForm
              hasImage={draft.hasImage}
              scope={scope}
              onScope={setScope}
              feedback={feedback}
              onFeedback={setFeedback}
              disabled={busy !== null || atLimit}
              submitting={busy === "revise"}
              onSubmit={submitRevision}
              onClose={() => setReviseOpen(false)}
              closable={draft.status !== "awaiting_feedback"}
              atLimit={atLimit}
            />
          )}
        </>
      )}
    </section>
  );

  function renderActions() {
    if (draft.status === "pending_review") {
      return (
        <>
          <button
            className={styles.primary}
            disabled={busy !== null}
            onClick={() => void run("approve", () => approveDraft(draft.id))}
          >
            {busy === "approve" ? "Approving…" : "Approve"}
          </button>
          <button className={styles.secondary} disabled={busy !== null} onClick={() => setReviseOpen((v) => !v)}>
            Request changes
          </button>
          <button
            className={styles.danger}
            disabled={busy !== null}
            onClick={() => void run("cancel", () => cancelDraft(draft.id))}
          >
            {busy === "cancel" ? "Cancelling…" : "Cancel"}
          </button>
        </>
      );
    }

    if (draft.status === "awaiting_confirmation") {
      return (
        <>
          <button
            className={styles.primary}
            disabled={busy !== null}
            onClick={() => navigate(`/editor?draft=${draft.id}`)}
          >
            Edit &amp; publish
          </button>
          <button
            className={styles.secondary}
            disabled={busy !== null}
            onClick={() => void run("back", () => sendDraftBackToReview(draft.id))}
          >
            {busy === "back" ? "…" : "Go back"}
          </button>
        </>
      );
    }

    if (draft.status === "moderation_blocked") {
      return (
        <>
          <button className={styles.secondary} disabled={busy !== null} onClick={() => setReviseOpen((v) => !v)}>
            Tell it what to fix
          </button>
          <button
            className={styles.danger}
            disabled={busy !== null}
            onClick={() => void run("cancel", () => cancelDraft(draft.id))}
          >
            {busy === "cancel" ? "Discarding…" : "Discard"}
          </button>
        </>
      );
    }

    if (draft.status === "awaiting_feedback") {
      return (
        <button
          className={styles.danger}
          disabled={busy !== null}
          onClick={() => void run("cancel", () => cancelDraft(draft.id))}
        >
          {busy === "cancel" ? "Cancelling…" : "Cancel this post"}
        </button>
      );
    }

    return null;
  }
}

function ReviseForm({
  hasImage,
  scope,
  onScope,
  feedback,
  onFeedback,
  disabled,
  submitting,
  onSubmit,
  onClose,
  closable,
  atLimit,
}: {
  hasImage: boolean;
  scope: RevisionScope;
  onScope: (s: RevisionScope) => void;
  feedback: string;
  onFeedback: (s: string) => void;
  disabled: boolean;
  submitting: boolean;
  onSubmit: () => void;
  onClose: () => void;
  closable: boolean;
  atLimit: boolean;
}) {
  const scopes: RevisionScope[] = hasImage ? ["text", "image", "both"] : ["text"];
  const label: Record<RevisionScope, string> = { text: "Text", image: "Image", both: "Both" };

  return (
    <div className={styles.reviseForm}>
      <div className={styles.reviseHead}>
        <span>What should change?</span>
        {closable && (
          <button className={styles.linkBtn} onClick={onClose}>
            Close
          </button>
        )}
      </div>

      {hasImage && (
        <div className={styles.scopeRow}>
          {scopes.map((s) => (
            <button
              key={s}
              className={`${styles.scopeBtn} ${scope === s ? styles.scopeBtnActive : ""}`}
              onClick={() => onScope(s)}
              disabled={disabled}
            >
              {label[s]}
            </button>
          ))}
        </div>
      )}

      <textarea
        className={styles.textarea}
        placeholder='Be specific — "cut the third paragraph", "sharper hook", "warmer colours"'
        value={feedback}
        onChange={(e) => onFeedback(e.target.value)}
        disabled={disabled}
        rows={3}
      />

      {atLimit ? (
        <p className={styles.limitNote}>Revision limit reached — cancel this post and start a new one.</p>
      ) : (
        <button className={styles.primary} disabled={disabled || feedback.trim().length === 0} onClick={onSubmit}>
          {submitting ? "Sending…" : "Send changes"}
        </button>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- topic picker */

function TopicPicker({ batch, onChanged }: { batch: ReviewTopicBatch; onChanged: () => Promise<void> }) {
  const { busy, error, run } = useAction(onChanged);
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState("");

  return (
    <section className={styles.card}>
      <div className={styles.cardTop}>
        <h2 className={styles.cardTitle}>Pick a topic</h2>
      </div>
      <div className={styles.cardMeta}>Sigmσid will write the post and hand it back here for review.</div>

      {error && <div className={styles.actionError}>{error}</div>}

      <ol className={styles.topicList}>
        {batch.topics.map((topic, i) => (
          <li key={i}>
            <button
              className={styles.topicBtn}
              disabled={busy !== null}
              onClick={() => void run(`pick-${i}`, () => pickTopic(batch.id, i))}
            >
              <span className={styles.topicTitle}>
                {i + 1}. {topic.title}
                {busy === `pick-${i}` && " …"}
              </span>
              <span className={styles.topicAngle}>{topic.angle}</span>
              {topic.whyNow && <span className={styles.topicWhy}>{topic.whyNow}</span>}
            </button>
          </li>
        ))}
      </ol>

      <div className={styles.actions}>
        <button className={styles.secondary} disabled={busy !== null} onClick={() => setCustomOpen((v) => !v)}>
          My own topic
        </button>
        <button
          className={styles.secondary}
          disabled={busy !== null}
          onClick={() => void run("refresh", () => refreshTopics(batch.id))}
        >
          {busy === "refresh" ? "Scanning…" : "New options"}
        </button>
      </div>

      {customOpen && (
        <div className={styles.reviseForm}>
          <textarea
            className={styles.textarea}
            placeholder="The topic or angle you want, in your own words"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            disabled={busy !== null}
            rows={3}
          />
          <button
            className={styles.primary}
            disabled={busy !== null || custom.trim().length === 0}
            onClick={() => void run("custom", () => submitCustomTopic(batch.id, custom.trim()))}
          >
            {busy === "custom" ? "Sending…" : "Write this post"}
          </button>
        </div>
      )}
    </section>
  );
}

/* --------------------------------------------------------------- empty state */

function EmptyState({ onChanged }: { onChanged: () => Promise<void> }) {
  const { busy, error, run } = useAction(onChanged);
  return (
    <section className={styles.card}>
      <p className={styles.empty}>Nothing to review right now.</p>
      {error && <div className={styles.actionError}>{error}</div>}
      <div className={styles.actions}>
        <button
          className={styles.primary}
          disabled={busy !== null}
          onClick={() => void run("scan", () => scanTopics())}
        >
          {busy === "scan" ? "Scanning headlines…" : "Scan for topics"}
        </button>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- activity log */

function ActivityLog() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const cursor = useRef(0);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const { events: fresh, cursor: next } = await getActivity(cursor.current);
        cursor.current = next;
        if (fresh.length > 0 && !stopped) {
          setEvents((prev) => {
            const seen = new Set(prev.map((e) => e.id));
            const merged = [...prev, ...fresh.filter((e) => !seen.has(e.id))];
            return merged.slice(-12);
          });
        }
      } catch {
        // Not authorised outside Telegram, or offline — retry next tick.
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  if (events.length === 0) return null;

  return (
    <div className={styles.log}>
      <div className={styles.logHead}>Activity</div>
      {[...events].reverse().map((ev) => (
        <div key={ev.id} className={`${styles.logRow} ${styles[`tone_${ev.tone}`]}`}>
          <span dangerouslySetInnerHTML={{ __html: ev.html }} />
        </div>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------------- misc */

function moderationIssues(draft: ReviewDraft): string[] {
  const m = draft.moderation;
  if (!m || m.safe) return [];
  const out: string[] = [];
  if (!m.text.safe && m.text.reason) out.push(`Text — ${m.text.reason}`);
  if (m.image && !m.image.safe && m.image.reason) out.push(`Image — ${m.image.reason}`);
  return out;
}
