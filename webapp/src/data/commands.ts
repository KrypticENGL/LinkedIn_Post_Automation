export type SlashCommand = {
  id: string;
  label: string;
  hint: string;
  /** Text inserted into the composer when the command is picked. */
  insert: string;
  group: "compose" | "status" | "account" | "control";
};

/**
 * Every command the bot has (see src/commands/index.ts and the bot's own /help),
 * except the ones tied to a specific draft's inline keyboard (approve/reject/confirm)
 * — those only make sense as a Telegram button on a specific message, not a typed
 * command here. Submitting one of these from the composer calls the same backend
 * function as its Telegram counterpart — see NewPost.tsx's handleSubmit.
 */
export const SLASH_COMMANDS: SlashCommand[] = [
  { id: "topics", label: "/topics", hint: "Fetch today's hot topics now", insert: "/topics", group: "compose" },
  { id: "model", label: "/model", hint: "See or switch the Gemini model", insert: "/model ", group: "compose" },

  { id: "test", label: "/test", hint: "Is the backend live, and how much quota is left", insert: "/test", group: "status" },
  { id: "status", label: "/status", hint: "What's in flight", insert: "/status", group: "status" },
  { id: "recent", label: "/recent", hint: "The last few drafts", insert: "/recent", group: "status" },
  { id: "usage", label: "/usage", hint: "Gemini token usage", insert: "/usage", group: "status" },

  { id: "auth", label: "/auth", hint: "Connect or reconnect LinkedIn", insert: "/auth", group: "account" },
  { id: "whoami", label: "/whoami", hint: "Which LinkedIn account is connected", insert: "/whoami", group: "account" },
  { id: "deauth", label: "/deauth", hint: "Release the connected LinkedIn account", insert: "/deauth", group: "account" },

  { id: "retry", label: "/retry", hint: "Retry publishing the last failed draft", insert: "/retry", group: "control" },
  { id: "cancel", label: "/cancel", hint: "Stop waiting for a reply", insert: "/cancel", group: "control" },
  { id: "help", label: "/help", hint: "What Sigmσid does", insert: "/help", group: "control" },
];
