/**
 * LinkedIn has no rich-text editor — the feed renders plain text only. The trick
 * every "LinkedIn formatter" (AuthoredUp, Taplio, …) uses is to swap ASCII letters
 * for their Unicode Mathematical Alphanumeric look-alikes, which survive as literal
 * characters wherever the post is pasted. This module is that swap, plus list
 * helpers, all built to toggle cleanly on a textarea selection.
 */

export type InlineStyle = "bold" | "italic" | "boldItalic" | "underline" | "strikethrough";
export type BlockStyle = "bullet" | "numbered";

/** Combining marks appended per-character for the two "styles" Unicode has no alphabet for. */
const UNDERLINE_MARK = "̲";
const STRIKE_MARK = "̵";

function buildAlphaMap(upperStart: number, lowerStart: number, digitStart?: number): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < 26; i += 1) {
    map.set(String.fromCharCode(65 + i), String.fromCodePoint(upperStart + i));
    map.set(String.fromCharCode(97 + i), String.fromCodePoint(lowerStart + i));
  }
  if (digitStart !== undefined) {
    for (let i = 0; i < 10; i += 1) {
      map.set(String.fromCharCode(48 + i), String.fromCodePoint(digitStart + i));
    }
  }
  return map;
}

// Sans-serif variants — LinkedIn's own font is sans-serif, so these blend in best.
const FORWARD: Record<Exclude<InlineStyle, "underline" | "strikethrough">, Map<string, string>> = {
  bold: buildAlphaMap(0x1d5d4, 0x1d5ee, 0x1d7ec),
  italic: buildAlphaMap(0x1d608, 0x1d622),
  boldItalic: buildAlphaMap(0x1d63c, 0x1d656),
};

/** Every styled code point back to its ASCII original, for stripping / re-styling. */
const REVERSE = new Map<string, string>();
for (const map of Object.values(FORWARD)) {
  for (const [plain, styled] of map) REVERSE.set(styled, plain);
}

/** Removes every style this module can apply, leaving plain ASCII. */
export function stripStyles(text: string): string {
  let out = "";
  for (const ch of text) {
    if (ch === UNDERLINE_MARK || ch === STRIKE_MARK) continue;
    out += REVERSE.get(ch) ?? ch;
  }
  return out;
}

function applyInline(plain: string, style: InlineStyle): string {
  if (style === "underline" || style === "strikethrough") {
    const mark = style === "underline" ? UNDERLINE_MARK : STRIKE_MARK;
    let out = "";
    for (const ch of plain) out += /\s/.test(ch) ? ch : ch + mark;
    return out;
  }
  const map = FORWARD[style];
  let out = "";
  for (const ch of plain) out += map.get(ch) ?? ch;
  return out;
}

/** True when `text` is already entirely in `style` (so the toolbar button should un-apply). */
function isFully(text: string, style: InlineStyle): boolean {
  const plain = stripStyles(text);
  return plain.length > 0 && applyInline(plain, style) === text;
}

/** Toggles an inline style over `selection`: plain → styled, already-styled → plain,
 *  other-styled → this style. */
export function toggleInline(selection: string, style: InlineStyle): string {
  if (isFully(selection, style)) return stripStyles(selection);
  return applyInline(stripStyles(selection), style);
}

const BULLET = "• ";
const NUMBERED = /^(\d+)\.\s/;

/** Toggles a list prefix on every non-empty line of `selection`. */
export function toggleBlock(selection: string, style: BlockStyle): string {
  const lines = selection.split("\n");
  const meaningful = lines.filter((l) => l.trim().length > 0);
  const allBulleted = meaningful.every((l) => l.trimStart().startsWith(BULLET));
  const allNumbered = meaningful.every((l) => NUMBERED.test(l.trimStart()));
  const remove = style === "bullet" ? allBulleted : allNumbered;

  let n = 0;
  return lines
    .map((line) => {
      if (line.trim().length === 0) return line;
      const bare = line.replace(NUMBERED, "").replace(BULLET, "").trimStart();
      if (remove) return bare;
      n += 1;
      return style === "bullet" ? `${BULLET}${bare}` : `${n}. ${bare}`;
    })
    .join("\n");
}

/** Code-point count — how LinkedIn itself measures a post against its 3000 limit. */
export function postLength(text: string): number {
  return [...text].length;
}

export const LINKEDIN_MAX_CHARS = 3000;

/** Where LinkedIn's feed drops a "…more" — roughly 3 lines or 210 characters. */
export function splitAtSeeMore(text: string): { head: string; rest: string } {
  const LIMIT = 210;
  const chars = [...text];
  let cut = -1;

  let lineBreaks = 0;
  for (let i = 0; i < chars.length; i += 1) {
    if (chars[i] === "\n") {
      lineBreaks += 1;
      if (lineBreaks === 3) {
        cut = i;
        break;
      }
    }
    if (i >= LIMIT) {
      cut = LIMIT;
      break;
    }
  }

  if (cut === -1) return { head: text, rest: "" };
  return { head: chars.slice(0, cut).join(""), rest: chars.slice(cut).join("") };
}
