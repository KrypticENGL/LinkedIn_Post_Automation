export type SlashCommand = {
  id: string;
  label: string;
  hint: string;
  /** Text inserted into the composer when the command is picked. */
  insert: string;
  group: "compose" | "control";
};

/**
 * Only commands the backend actually implements — see src/miniapp/router.ts (/model)
 * and NewPost.tsx's own client-side handling of /cancel and /help. Revision commands
 * like /text, /image, /tone don't apply here: those only make sense on a draft that
 * already exists, which happens in Telegram's review loop, not this composer.
 */
export const SLASH_COMMANDS: SlashCommand[] = [
  { id: "model", label: "/model", hint: "Switch the LLM the bot uses", insert: "/model ", group: "compose" },
  { id: "cancel", label: "/cancel", hint: "Clear this composer", insert: "/cancel", group: "control" },
  { id: "help", label: "/help", hint: "What Sigmσid does", insert: "/help", group: "control" },
];
