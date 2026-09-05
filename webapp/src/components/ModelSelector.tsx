import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { ModelInfo } from "../data/types";
import { ApiError, getModel, setModel as apiSetModel } from "../lib/api";
import styles from "./ModelSelector.module.css";

/**
 * Self-contained: reads and writes the bot's actual active Gemini model (the same
 * global setting /model changes in Telegram) rather than a per-post choice, because
 * that's the only kind of "model" the backend has. See src/miniapp/router.ts.
 */
export function ModelSelector() {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<ModelInfo | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customValue, setCustomValue] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    getModel()
      .then((data) => !cancelled && setInfo(data))
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : "Could not load the model"));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function choose(model: string) {
    setSaving(true);
    setError(null);
    try {
      setInfo(await apiSetModel(model));
      setOpen(false);
      setShowCustom(false);
      setCustomValue("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not switch model");
    } finally {
      setSaving(false);
    }
  }

  function onCustomSubmit(e: FormEvent) {
    e.preventDefault();
    if (customValue.trim()) void choose(customValue.trim());
  }

  const activeModel = info?.active ?? info?.default ?? null;
  const label = error && !info ? "Model unavailable" : saving ? "Switching…" : (activeModel ?? "Loading…");
  const options = info ? [...new Set([info.default, info.fallback])] : [];

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={!info && !error}
      >
        <span className={styles.dot} />
        {label}
        <svg className={styles.chevron} width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && info && (
        <ul className={styles.menu} role="listbox">
          {options.map((model) => (
            <li key={model}>
              <button
                type="button"
                className={`${styles.option} ${model === activeModel ? styles.optionActive : ""}`}
                role="option"
                aria-selected={model === activeModel}
                disabled={saving}
                onClick={() => choose(model)}
              >
                <span className={styles.optionLabel}>{model}</span>
                <span className={styles.optionNote}>
                  {model === info.default ? "default" : model === info.fallback ? "fallback" : ""}
                </span>
              </button>
            </li>
          ))}

          <li>
            {showCustom ? (
              <form className={styles.customForm} onSubmit={onCustomSubmit}>
                <input
                  autoFocus
                  className={styles.customInput}
                  placeholder="any model name Gemini accepts"
                  value={customValue}
                  disabled={saving}
                  onChange={(e) => setCustomValue(e.target.value)}
                />
              </form>
            ) : (
              <button type="button" className={styles.option} onClick={() => setShowCustom(true)}>
                <span className={styles.optionLabel}>Custom…</span>
              </button>
            )}
          </li>

          {error && <li className={styles.errorRow}>{error}</li>}
        </ul>
      )}
    </div>
  );
}
