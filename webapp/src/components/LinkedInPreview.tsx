import { Fragment, useMemo, useState } from "react";
import { postLength, splitAtSeeMore } from "../lib/linkedinFormat";
import styles from "./LinkedInPreview.module.css";

type Props = {
  text: string;
  authorName?: string;
  authorHeadline?: string;
};

/** #hashtags, @mentions and bare URLs get LinkedIn's link colour; everything else is plain. */
const TOKEN = /(#[\p{L}\p{N}_]+|@[\p{L}\p{N}_.-]+|https?:\/\/\S+)/gu;

function renderRich(text: string, keyPrefix: string) {
  const parts = text.split(TOKEN);
  return parts.map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    if (i % 2 === 1) {
      return (
        <span key={key} className={styles.link}>
          {part}
        </span>
      );
    }
    return <Fragment key={key}>{part}</Fragment>;
  });
}

/** LinkedIn's post-visibility marker — a plain outline globe, not an emoji. */
function GlobeIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 16 16" width="12" height="12" aria-hidden>
      <circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <path
        d="M8 1.6c2.1 2 2.1 10.8 0 12.8M8 1.6c-2.1 2-2.1 10.8 0 12.8M1.7 8h12.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
      />
    </svg>
  );
}

/** The reaction pile, as a single flat like glyph rather than an emoji run. */
function ReactionIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <circle cx="8" cy="8" r="8" fill="#378fe9" />
      <path
        d="M4.6 7.2h1.5v4.4H4.6zM7 6.9l1.7-3.2c.3-.6 1.2-.4 1.2.3v1.9h1.9c.5 0 .9.5.7 1l-.9 3.2c-.1.5-.5.8-1 .8H7z"
        fill="#fff"
      />
    </svg>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

export function LinkedInPreview({
  text,
  authorName = "Your Name",
  authorHeadline = "The post exactly as LinkedIn will render it",
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const { head, rest } = useMemo(() => splitAtSeeMore(text), [text]);
  const hasMore = rest.length > 0;
  const count = postLength(text);

  return (
    <div className={styles.wrap}>
      <article className={styles.card} aria-label="LinkedIn post preview">
        <header className={styles.head}>
          <div className={styles.avatar} aria-hidden>
            {initials(authorName) || "in"}
          </div>
          <div className={styles.meta}>
            <div className={styles.name}>
              {authorName} <span className={styles.degree}>· 1st</span>
            </div>
            <div className={styles.headline}>{authorHeadline}</div>
            <div className={styles.sub}>
              Now · <GlobeIcon />
            </div>
          </div>
          <div className={styles.ellipsis} aria-hidden>
            ···
          </div>
        </header>

        <div className={styles.body}>
          {text.trim().length === 0 ? (
            <span className={styles.placeholder}>Your post preview will appear here…</span>
          ) : (
            <>
              {renderRich(expanded || !hasMore ? text : head, "b")}
              {hasMore && !expanded && (
                <>
                  <span aria-hidden>… </span>
                  <button type="button" className={styles.more} onClick={() => setExpanded(true)}>
                    more
                  </button>
                </>
              )}
            </>
          )}
        </div>

        <div className={styles.stats}>
          {count > 0 && (
            <>
              <ReactionIcon />
              <span>You and 42 others</span>
            </>
          )}
        </div>

        <footer className={styles.actions}>
          {["Like", "Comment", "Repost", "Send"].map((label) => (
            <span key={label} className={styles.action}>
              {label}
            </span>
          ))}
        </footer>
      </article>

      <div className={styles.footNote}>
        <span className={count > 3000 ? styles.countOver : styles.count}>
          {count.toLocaleString()} / 3,000 characters
        </span>
        {count > 3000 && <span className={styles.countOver}>· over LinkedIn's limit</span>}
        {count > 210 && <span className={styles.countHint}>· “…more” cutoff shown above</span>}
      </div>
    </div>
  );
}
