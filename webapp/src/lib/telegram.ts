/** Minimal shape of window.Telegram.WebApp — only what this app actually calls. */
type TelegramWebApp = {
  initData: string;
  ready: () => void;
  expand: () => void;
  colorScheme: "light" | "dark";
  openLink: (url: string) => void;
};

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

function getWebApp(): TelegramWebApp | null {
  return window.Telegram?.WebApp ?? null;
}

/** Call once on mount. No-ops outside an actual Telegram Mini App shell. */
export function initTelegramWebApp(): void {
  const webApp = getWebApp();
  if (!webApp) return;
  webApp.ready();
  webApp.expand();
}

/** The signed payload every API request authenticates with — see src/miniapp/auth.ts. */
export function getInitData(): string {
  return getWebApp()?.initData ?? "";
}

export function isInsideTelegram(): boolean {
  return getWebApp() !== null;
}

/** Opens an external URL — via Telegram's own link handler inside the Mini App shell,
 *  falling back to a normal new tab everywhere else (e.g. local dev in a browser). */
export function openLink(url: string): void {
  const webApp = getWebApp();
  if (webApp) {
    webApp.openLink(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
