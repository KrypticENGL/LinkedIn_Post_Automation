import { AnimatePresence, motion } from "framer-motion";
import { useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { ModelSelector } from "../components/ModelSelector";
import { SlashMenu } from "../components/SlashMenu";
import { SLASH_COMMANDS, type SlashCommand } from "../data/commands";
import { useSpotlight } from "../hooks/useSpotlight";
import { ApiError, createPost, getModel, runCommand, setModel } from "../lib/api";
import { openLink } from "../lib/telegram";
import styles from "./NewPost.module.css";

const NAV_KEYS = new Set(["ArrowUp", "ArrowDown", "Enter", "Escape", "Tab"]);

/** Every command id that maps to a real backend action — see data/commands.ts. */
const KNOWN_COMMANDS = new Set(SLASH_COMMANDS.map((c) => c.id));

type Entry = { id: string; command: string; html: string; url?: string; tone: "success" | "error" | "info" };

function parseCommand(text: string): { name: string; arg: string } | null {
  const match = /^\/([a-zA-Z]+)(?:\s+(.*))?$/.exec(text.trim());
  if (!match) return null;
  return { name: match[1].toLowerCase(), arg: (match[2] ?? "").trim() };
}

export function NewPost() {
  const [value, setValue] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { ref: cardRef, onPointerMove } = useSpotlight<HTMLDivElement>();

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return SLASH_COMMANDS.filter((c) => c.id.startsWith(q));
  }, [query]);

  const activeIndex = Math.max(0, filtered.findIndex((c) => c.id === activeId));
  const parsedCommand = parseCommand(value);

  function pushEntry(entry: Omit<Entry, "id">) {
    setEntries((prev) => [{ ...entry, id: crypto.randomUUID() }, ...prev].slice(0, 20));
  }

  function syncSlashState(el: HTMLTextAreaElement) {
    const pos = el.selectionStart ?? el.value.length;
    const uptoCaret = el.value.slice(0, pos);
    const match = /(?:^|\s)\/([a-zA-Z]*)$/.exec(uptoCaret);
    if (match) {
      setQuery(match[1]);
      setMenuOpen(true);
      setActiveId((prev) => prev ?? null);
    } else {
      setMenuOpen(false);
    }
  }

  function resizeTextarea(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 360)}px`;
  }

  function clearComposer() {
    setValue("");
    requestAnimationFrame(() => {
      if (textareaRef.current) resizeTextarea(textareaRef.current);
    });
  }

  function selectCommand(cmd: SlashCommand) {
    const el = textareaRef.current;
    if (!el) return;
    const pos = el.selectionStart ?? el.value.length;
    const slashStart = pos - 1 - query.length;
    const before = value.slice(0, Math.max(0, slashStart));
    const after = value.slice(pos);
    const next = `${before}${cmd.insert}${after}`;
    setValue(next);
    setMenuOpen(false);
    setActiveId(null);
    requestAnimationFrame(() => {
      el.focus();
      const caret = before.length + cmd.insert.length;
      el.selectionStart = el.selectionEnd = caret;
      resizeTextarea(el);
    });
  }

  function openCommandPalette() {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    const pos = el.selectionStart ?? value.length;
    const before = value.slice(0, pos);
    const after = value.slice(pos);
    const insert = before.length > 0 && !/\s$/.test(before) ? " /" : "/";
    const next = before + insert + after;
    setValue(next);
    requestAnimationFrame(() => {
      const caret = before.length + insert.length;
      el.selectionStart = el.selectionEnd = caret;
      syncSlashState(el);
      resizeTextarea(el);
    });
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (!menuOpen || filtered.length === 0) return;
    if (!NAV_KEYS.has(e.key)) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = filtered[Math.min(activeIndex + 1, filtered.length - 1)];
      setActiveId(next.id);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = filtered[Math.max(activeIndex - 1, 0)];
      setActiveId(next.id);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      selectCommand(filtered[activeIndex] ?? filtered[0]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setMenuOpen(false);
    }
  }

  async function runModelCommand(text: string, arg: string) {
    setSubmitting(true);
    try {
      if (!arg) {
        const info = await getModel();
        const lines = [
          `Using <code>${info.active ?? info.default}</code>` +
            (info.active ? " — an override, not the env default." : " — the env default."),
          `Fallback stays <code>${info.fallback}</code> either way.`,
          "",
          "To switch: <code>/model gemini-2.5-pro</code> (any model name Google's API accepts).",
        ];
        pushEntry({ command: text, html: lines.join("\n"), tone: "info" });
      } else {
        const info = await setModel(arg);
        const html =
          info.active === null
            ? `Back to the default model: <code>${info.default}</code>`
            : `Switched to <code>${info.active}</code>. Topics, posts, and moderation all use it now — ` +
              `<code>/model default</code> to go back to <code>${info.default}</code>.`;
        pushEntry({ command: text, html, tone: "success" });
        clearComposer();
      }
    } catch (err) {
      pushEntry({
        command: text,
        html: err instanceof ApiError ? err.message : "Could not reach the model endpoint",
        tone: "error",
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function runKnownCommand(text: string, name: string) {
    setSubmitting(true);
    try {
      const reply = await runCommand(name);
      pushEntry({
        command: text,
        html: reply.html,
        url: reply.url,
        tone: name === "topics" || name === "retry" ? "success" : "info",
      });
      if (name === "auth" && reply.url) openLink(reply.url);
      clearComposer();
    } catch (err) {
      pushEntry({
        command: text,
        html: err instanceof ApiError ? err.message : `Could not run /${name}`,
        tone: "error",
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmit() {
    const text = value.trim();
    if (!text || submitting) return;

    const parsed = parseCommand(text);
    if (parsed) {
      if (parsed.name === "model") {
        await runModelCommand(text, parsed.arg);
        return;
      }
      if (KNOWN_COMMANDS.has(parsed.name)) {
        await runKnownCommand(text, parsed.name);
        return;
      }
      pushEntry({ command: text, html: `Unknown command: /${parsed.name}`, tone: "error" });
      return;
    }

    setSubmitting(true);
    try {
      await createPost(text);
      pushEntry({ command: text, html: "Sent — check Telegram for the draft.", tone: "success" });
      clearComposer();
    } catch (err) {
      pushEntry({
        command: text,
        html: err instanceof ApiError ? err.message : "Could not start the draft",
        tone: "error",
      });
    } finally {
      setSubmitting(false);
    }
  }

  const submitLabel = submitting
    ? "Working…"
    : parsedCommand && KNOWN_COMMANDS.has(parsedCommand.name)
      ? `Run /${parsedCommand.name}`
      : "Draft post";

  return (
    <motion.div
      className={styles.page}
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className={styles.header}>
        <h1 className={styles.title}>What's today's post about?</h1>
        <p className={styles.subtitle}>
          Give it a topic or a rough angle. Sigmσid drafts, generates an image, and sends it back for your review —
          nothing reaches LinkedIn without your confirmation.
        </p>
      </div>

      <div
        ref={cardRef}
        className={styles.card}
        onPointerMove={onPointerMove}
      >
        <div className={styles.composer}>
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            placeholder="e.g. why most B2B marketing teams still ship in silos… (type / for commands)"
            rows={1}
            value={value}
            disabled={submitting}
            onChange={(e) => {
              setValue(e.target.value);
              syncSlashState(e.target);
              resizeTextarea(e.target);
            }}
            onClick={(e) => syncSlashState(e.currentTarget)}
            onKeyUp={(e) => {
              if (!NAV_KEYS.has(e.key)) syncSlashState(e.currentTarget);
            }}
            onKeyDown={onKeyDown}
          />

          <AnimatePresence>
            {menuOpen && (
              <SlashMenu
                commands={filtered}
                activeId={filtered[activeIndex]?.id ?? null}
                onHover={setActiveId}
                onSelect={selectCommand}
                onClose={() => setMenuOpen(false)}
              />
            )}
          </AnimatePresence>
        </div>

        <div className={styles.toolbar}>
          <div className={styles.toolbarLeft}>
            <ModelSelector />
            <button type="button" className={styles.commandsButton} onClick={openCommandPalette}>
              <span className={styles.slashIcon}>/</span>
              Commands
            </button>
          </div>

          <button
            type="button"
            className={styles.submit}
            disabled={value.trim().length === 0 || submitting}
            onClick={handleSubmit}
          >
            {submitLabel}
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path
                d="M2 7H12M12 7L7.5 2.5M12 7L7.5 11.5"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>

      <div className={styles.transcript}>
        <AnimatePresence initial={false}>
          {entries.map((entry) => (
            <motion.div
              key={entry.id}
              className={`${styles.entry} ${styles[entry.tone]}`}
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
            >
              <div className={styles.entryCommand}>{entry.command}</div>
              <div className={styles.entryBody} dangerouslySetInnerHTML={{ __html: entry.html }} />
              {entry.url && (
                <button type="button" className={styles.entryLink} onClick={() => openLink(entry.url!)}>
                  Open LinkedIn
                </button>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
