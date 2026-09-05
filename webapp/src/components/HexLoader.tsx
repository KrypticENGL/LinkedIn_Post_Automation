import { useEffect, useState } from "react";
import styles from "./HexLoader.module.css";

const HEX_DIGITS = "0123456789ABCDEF";

function randomHex(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += HEX_DIGITS[Math.floor(Math.random() * HEX_DIGITS.length)];
  return out;
}

type Props = {
  /** How many hex digits to scramble. */
  length?: number;
  /** Announced to screen readers in place of the visual noise. */
  label?: string;
  /** "accent" (default) is the glowing green look for dark surfaces; "dark" drops the
   *  glow and switches to the button's own near-black text color, for use on a bright
   *  accent-colored background (e.g. the submit button) where "accent" would be
   *  nearly invisible. */
  tone?: "accent" | "dark";
};

/**
 * A scrambling hex readout — the "processing" indicator for anywhere the app is
 * waiting on a real network call (a draft submission, a command, a page's initial
 * fetch). Fits the retro-terminal aesthetic already in BackgroundFX rather than a
 * generic spinner or "Loading…" text.
 */
export function HexLoader({ length = 6, label = "Loading", tone = "accent" }: Props) {
  const [text, setText] = useState(() => randomHex(length));

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(() => setText(randomHex(length)), 70);
    return () => clearInterval(id);
  }, [length]);

  return (
    <span className={`${styles.root} ${tone === "dark" ? styles.dark : ""}`} role="status" aria-label={label}>
      <span className={styles.prefix} aria-hidden="true">
        0x
      </span>
      <span className={styles.hex} aria-hidden="true">
        {text}
      </span>
    </span>
  );
}
