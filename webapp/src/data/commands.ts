export type SlashCommand = {
  id: string;
  label: string;
  hint: string;
  /** Text inserted into the composer when the command is picked. */
  insert: string;
  group: "compose" | "revise" | "control";
};

/**
 * Adapted from the bot's real vocabulary: /model (src/telegram/handlers.ts),
 * the text/image/both revision scopes (src/db/schema.ts REVISION_SCOPES), and
 * /cancel, /help.
 */
export const SLASH_COMMANDS: SlashCommand[] = [
  { id: "model", label: "/model", hint: "Switch the LLM for this post", insert: "/model ", group: "compose" },
  { id: "tone", label: "/tone", hint: "Set the voice — bold, warm, dry, technical", insert: "/tone ", group: "compose" },
  { id: "hook", label: "/hook", hint: "Rewrite just the opening line", insert: "/hook ", group: "revise" },
  { id: "text", label: "/text", hint: "Revise the post text only", insert: "/text ", group: "revise" },
  { id: "image", label: "/image", hint: "Regenerate the image only", insert: "/image ", group: "revise" },
  { id: "both", label: "/both", hint: "Revise text and image together", insert: "/both ", group: "revise" },
  { id: "shorten", label: "/shorten", hint: "Cut it down", insert: "/shorten", group: "revise" },
  { id: "schedule", label: "/schedule", hint: "Queue for later instead of now", insert: "/schedule ", group: "control" },
  { id: "cancel", label: "/cancel", hint: "Clear this draft", insert: "/cancel", group: "control" },
  { id: "help", label: "/help", hint: "What can Sigmσid do", insert: "/help", group: "control" },
];
