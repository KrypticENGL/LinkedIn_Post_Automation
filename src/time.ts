/**
 * Midnight today in `timeZone`, as an absolute instant. Derived by subtracting the
 * elapsed local time-of-day from now, so it stays correct without a timezone library.
 */
export function startOfDayIn(timeZone: string): Date {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const at = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const elapsed = at("hour") * 3_600_000 + at("minute") * 60_000 + at("second") * 1000;
  return new Date(now.getTime() - elapsed);
}

/**
 * Coarse "4d 2h" / "3h 12m" for uptimes and countdowns — never more than two units,
 * because nobody reading a status message cares about the seconds.
 */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}
