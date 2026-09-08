import { motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { HexLoader } from "../components/HexLoader";
import { LinkedInPreview } from "../components/LinkedInPreview";
import { useSpotlight } from "../hooks/useSpotlight";
import {
  ApiError,
  getDraftById,
  getLatestDraft,
  publishEditedDraft,
  sendComposedPost,
} from "../lib/api";
import {
  type BlockStyle,
  type InlineStyle,
  LINKEDIN_MAX_CHARS,
  postLength,
  stripStyles,
  toggleBlock,
  toggleInline,
} from "../lib/linkedinFormat";
import styles from "./PostEditor.module.css";

const STORAGE_KEY = "sigmoid.postEditor.draft";

type InlineTool = { kind: "inline"; style: InlineStyle; label: string; title: string };
type BlockTool = { kind: "block"; style: BlockStyle; label: string; title: string };
type ClearTool = { kind: "clear"; label: string; title: string };
type Tool = InlineTool | BlockTool | ClearTool;

const TOOLS: Tool[] = [
  { kind: "inline", style: "bold", label: "B", title: "Bold" },
  { kind: "inline", style: "italic", label: "I", title: "Italic" },
  { kind: "inline", style: "boldItalic", label: "BI", title: "Bold italic" },
  { kind: "inline", style: "underline", label: "U", title: "Underline" },
  { kind: "inline", style: "strikethrough", label: "S", title: "Strikethrough" },
  { kind: "block", style: "bullet", label: "•", title: "Bulleted list" },
  { kind: "block", style: "numbered", label: "1.", title: "Numbered list" },
  { kind: "clear", label: "Clear", title: "Clear formatting" },
];

type SendState = "idle" | "sending" | "sent" | "error" | "publishing" | "blocked";

function readStored(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function PostEditor() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  // Opened from the Review tab's "Edit & publish" — this specific draft's text is
  // loaded from the server and the button publishes it straight to LinkedIn.
  const draftId = params.get("draft");

  const [text, setText] = useState(() => (draftId ? "" : readStored()));
  const [linkedTitle, setLinkedTitle] = useState<string | null>(null);
  const [loading, setLoading] = useState(() => Boolean(draftId));
  const [notice, setNotice] = useState<string | null>(null);
  const [sendState, setSendState] = useState<SendState>("idle");

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { ref: cardRef, onPointerMove } = useSpotlight<HTMLDivElement>();

  useEffect(() => {
    // A linked draft is a one-shot editing session — don't overwrite the freehand draft.
    if (draftId) return;
    try {
      localStorage.setItem(STORAGE_KEY, text);
    } catch {
      // Private mode or storage disabled — the editor still works, it just won't persist.
    }
  }, [text, draftId]);

  useEffect(() => {
    if (!draftId) return;
    let cancelled = false;
    getDraftById(draftId)
      .then((draft) => {
        if (cancelled) return;
        setText(draft.postText);
        setLinkedTitle(draft.title);
        setSendState("idle");
        setNotice(`Editing “${draft.title}”. Press Publish to LinkedIn when it's right.`);
      })
      .catch((err) => {
        if (cancelled) return;
        setNotice(
          err instanceof ApiError ? err.message : "Could not load that draft — it may have been cancelled.",
        );
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [draftId]);

  const count = postLength(text);
  const overLimit = count > LINKEDIN_MAX_CHARS;

  /** Runs `fn` over the current selection and splices the result back in. `mode`
   *  "inline" needs a selection; "lines" widens the selection to whole lines (and
   *  falls back to the entire post when nothing is selected). */
  function transform(fn: (chunk: string) => string, mode: "inline" | "lines" | "selectionOrAll") {
    const el = textareaRef.current;
    if (!el) return;
    let start = el.selectionStart ?? 0;
    let end = el.selectionEnd ?? 0;

    if (mode === "inline" && start === end) {
      setNotice("Select some text first, then pick a style.");
      return;
    }

    if (mode === "selectionOrAll" && start === end) {
      start = 0;
      end = text.length;
    }

    if (mode === "lines") {
      if (start === end && text.length > 0) {
        start = 0;
        end = text.length;
      }
      start = text.lastIndexOf("\n", start - 1) + 1;
      const nextBreak = text.indexOf("\n", end);
      end = nextBreak === -1 ? text.length : nextBreak;
    }

    const before = text.slice(0, start);
    const target = text.slice(start, end);
    const after = text.slice(end);
    const replaced = fn(target);
    const next = before + replaced + after;

    setNotice(null);
    setSendState("idle");
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = start;
      el.selectionEnd = start + replaced.length;
    });
  }

  function runTool(tool: Tool) {
    if (tool.kind === "inline") transform((chunk) => toggleInline(chunk, tool.style), "inline");
    else if (tool.kind === "block") transform((chunk) => toggleBlock(chunk, tool.style), "lines");
    else transform((chunk) => stripStyles(chunk), "selectionOrAll");
  }

  async function loadLatest() {
    setLoading(true);
    setNotice(null);
    try {
      const draft = await getLatestDraft();
      setText(draft.postText);
      setSendState("idle");
      setNotice(`Loaded “${draft.title}”. Edit freely — nothing is sent until you press the button.`);
    } catch (err) {
      setNotice(
        err instanceof ApiError && /no drafts/i.test(err.message)
          ? "No generated draft yet. Start one from New post, or just write here."
          : err instanceof ApiError
            ? err.message
            : "Could not load the latest draft.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function send() {
    const trimmed = text.trim();
    if (!trimmed || sendState === "sending") return;
    if (overLimit) {
      setNotice("This post is over LinkedIn's 3,000-character limit. Trim it first.");
      return;
    }
    setSendState("sending");
    setNotice(null);
    try {
      await sendComposedPost(trimmed);
      setSendState("sent");
      setNotice("Sent for review. Approve and confirm it in Telegram to publish — nothing goes to LinkedIn on its own.");
    } catch (err) {
      setSendState("error");
      setNotice(err instanceof ApiError ? err.message : "Could not send the post.");
    }
  }

  async function publishToLinkedIn() {
    const trimmed = text.trim();
    if (!draftId || !trimmed || sendState === "publishing") return;
    if (overLimit) {
      setNotice("This post is over LinkedIn's 3,000-character limit. Trim it first.");
      return;
    }
    setSendState("publishing");
    setNotice(null);
    try {
      const result = await publishEditedDraft(draftId, trimmed);
      if (result.published) {
        setSendState("sent");
        setNotice("Safety check passed — publishing to LinkedIn now. Follow it on the Review tab.");
        setTimeout(() => navigate("/review"), 1400);
      } else {
        setSendState("blocked");
        setNotice(result.reason ?? "The safety check blocked this edit — it was not published.");
      }
    } catch (err) {
      setSendState("error");
      setNotice(err instanceof ApiError ? err.message : "Could not publish the post.");
    }
  }

  return (
    <motion.div
      className={styles.page}
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className={styles.inputPane}>
        <div className={styles.header}>
          <h1 className={styles.title}>{linkedTitle ? "Edit before publishing" : "Preview & edit the post"}</h1>
          <p className={styles.subtitle}>
            {linkedTitle
              ? "Fine-tune the wording and formatting of the approved draft. Publish to LinkedIn re-runs the safety check on your edits, then posts it — the image is unchanged."
              : "Load the latest generated draft, format it with real LinkedIn-safe styling, and see exactly how the feed will render it. When it's right, send it straight into the approval loop."}
          </p>
        </div>

        <div ref={cardRef} className={styles.card} onPointerMove={onPointerMove}>
          <div className={styles.toolbar}>
            {TOOLS.map((tool) => (
              <button
                key={tool.title}
                type="button"
                className={styles.toolButton}
                data-face={tool.kind === "clear" ? "clear" : tool.style}
                title={tool.title}
                aria-label={tool.title}
                onClick={() => runTool(tool)}
              >
                {tool.label}
              </button>
            ))}
            {!draftId && (
              <button
                type="button"
                className={styles.loadButton}
                onClick={loadLatest}
                disabled={loading}
              >
                {loading ? <HexLoader length={4} label="Loading" /> : "Load latest draft"}
              </button>
            )}
          </div>

          <textarea
            ref={textareaRef}
            className={styles.textarea}
            placeholder="Write or paste your LinkedIn post here…"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setSendState("idle");
              setNotice(null);
            }}
          />

          <div className={styles.footer}>
            <span className={overLimit ? styles.countOver : styles.count}>
              {count.toLocaleString()} / {LINKEDIN_MAX_CHARS.toLocaleString()}
            </span>
            {draftId ? (
              <button
                type="button"
                className={styles.send}
                disabled={
                  text.trim().length === 0 ||
                  overLimit ||
                  sendState === "publishing" ||
                  sendState === "sent"
                }
                onClick={publishToLinkedIn}
              >
                {sendState === "publishing" ? (
                  <HexLoader length={5} label="Checking" tone="dark" />
                ) : sendState === "sent" ? (
                  "Publishing…"
                ) : (
                  "Publish to LinkedIn"
                )}
              </button>
            ) : (
              <button
                type="button"
                className={styles.send}
                disabled={text.trim().length === 0 || overLimit || sendState === "sending"}
                onClick={send}
              >
                {sendState === "sending" ? (
                  <HexLoader length={5} label="Sending" tone="dark" />
                ) : sendState === "sent" ? (
                  "Sent"
                ) : (
                  "Send through automation"
                )}
              </button>
            )}
          </div>

          {notice && (
            <p
              className={`${styles.notice} ${
                sendState === "error" || sendState === "blocked" ? styles.noticeError : ""
              }`}
            >
              {notice}
            </p>
          )}
        </div>
      </div>

      <div className={styles.outputPane}>
        <span className={styles.outputTitle}>Feed preview</span>
        <LinkedInPreview text={text} />
      </div>
    </motion.div>
  );
}
