import { useEffect, useRef, useState } from "react";
import { AVAILABLE_MODELS } from "../data/mock";
import styles from "./ModelSelector.module.css";

type Props = {
  value: string;
  onChange: (model: string) => void;
};

export function ModelSelector({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const active = AVAILABLE_MODELS.find((m) => m.id === value) ?? AVAILABLE_MODELS[0];

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

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={styles.dot} />
        {active.label}
        <svg className={styles.chevron} width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <ul className={styles.menu} role="listbox">
          {AVAILABLE_MODELS.map((model) => (
            <li key={model.id}>
              <button
                type="button"
                className={`${styles.option} ${model.id === value ? styles.optionActive : ""}`}
                role="option"
                aria-selected={model.id === value}
                onClick={() => {
                  onChange(model.id);
                  setOpen(false);
                }}
              >
                <span className={styles.optionLabel}>{model.label}</span>
                <span className={styles.optionNote}>{model.note}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
