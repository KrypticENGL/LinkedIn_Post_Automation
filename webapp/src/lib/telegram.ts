/** Minimal shape of window.Telegram.WebApp — only what this app actually calls. */
type TelegramWebApp = {
  initData: string;
  ready: () => void;
  expand: () => void;
  colorScheme: "light" | "dark";
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
