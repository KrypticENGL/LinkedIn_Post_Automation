import { motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { HexLoader } from "../components/HexLoader";
import { LinkedInPreview } from "../components/LinkedInPreview";
import { useSpotlight } from "../hooks/useSpotlight";
import { ApiError, getLatestDraft, sendComposedPost } from "../lib/api";
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
  { kind: "inline", style: "bold", label: "𝗕", title: "Bold" },
  { kind: "inline", style: "italic", label: "𝘐", title: "Italic" },
  { kind: "inline", style: "boldItalic", label: "𝘽", title: "Bold italic" },
  { kind: "inline", style: "underline", label: "U̲", title: "Underline" },
  { kind: "inline", style: "strikethrough", label: "S̵", title: "Strikethrough" },
  { kind: "block", style: "bullet", label: "•", title: "Bulleted list" },
  { kind: "block", style: "numbered", label: "1.", title: "Numbered list" },
  { kind: "clear", label: "⌫", title: "Clear formatting" },
];

type SendState = "idle" | "sending" | "sent" | "error";

function readStored(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function PostEditor() {
  const [text, setText] = useState(readStored);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [sendState, setSendState] = useState<SendState>("idle");

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { ref: cardRef, onPointerMove } = useSpotlight<HTMLDivElement>();

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, text);
    } catch {
      // Private mode or storage disabled — the editor still works, it just won't persist.
    }
  }, [text]);

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

  return (
    <motion.div
      className={styles.page}
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className={styles.inputPane}>
        <div className={styles.header}>
          <h1 className={styles.title}>Preview &amp; edit the post</h1>
          <p className={styles.subtitle}>
            Load the latest generated draft, format it with real LinkedIn-safe styling, and see exactly how the
            feed will render it. When it's right, send it straight into the approval loop.
          </p>
        </div>

        <div ref={cardRef} className={styles.card} onPointerMove={onPointerMove}>
          <div className={styles.toolbar}>
            {TOOLS.map((tool) => (
              <button
                key={tool.title}
                type="button"
                className={styles.toolButton}
                title={tool.title}
                aria-label={tool.title}
                onClick={() => runTool(tool)}
              >
                {tool.label}
              </button>
            ))}
            <button
              type="button"
              className={styles.loadButton}
              onClick={loadLatest}
              disabled={loading}
            >
              {loading ? <HexLoader length={4} label="Loading" /> : "Load latest draft"}
            </button>
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
            <button
              type="button"
              className={styles.send}
              disabled={text.trim().length === 0 || overLimit || sendState === "sending"}
              onClick={send}
            >
              {sendState === "sending" ? (
                <HexLoader length={5} label="Sending" tone="dark" />
              ) : sendState === "sent" ? (
                "Sent ✓"
              ) : (
                "Send through automation"
              )}
            </button>
          </div>

          {notice && (
            <p className={`${styles.notice} ${sendState === "error" ? styles.noticeError : ""}`}>{notice}</p>
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
