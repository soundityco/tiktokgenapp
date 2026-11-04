/** Browser notifications for long jobs (sync, lyrics): the user can work in another tab meanwhile. */
export function canNotify(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

/** Ask once, from a click. Resolves quietly when the browser refuses. */
export async function askNotifyPermission(): Promise<void> {
  if (!canNotify() || Notification.permission !== "default") return;
  try { await Notification.requestPermission(); } catch { /* old Safari: callback API only */ }
}

export const notifyBlocked = (): boolean => canNotify() && Notification.permission === "denied";

let restoreTitle: (() => void) | null = null;
/** The tab title says it too, until the user comes back: works even when notifications are blocked. */
function flagTitle(title: string) {
  if (typeof document === "undefined") return;
  restoreTitle?.();
  const original = document.title;
  document.title = `✓ ${title} · ${original}`;
  const back = () => { if (!document.hidden) restoreTitle?.(); };
  restoreTitle = () => { document.title = original; document.removeEventListener("visibilitychange", back); window.removeEventListener("focus", back); restoreTitle = null; };
  document.addEventListener("visibilitychange", back);
  window.addEventListener("focus", back);
}

/** Shown only when the user is not looking at the app (other tab or other window). */
export function notify(title: string, body: string): void {
  if (typeof document !== "undefined" && !document.hidden && document.hasFocus()) return;
  flagTitle(title);
  if (!canNotify() || Notification.permission !== "granted") return;
  try {
    // A tag of its own per notification: a shared tag silently replaced the previous one, with no alert.
    const n = new Notification(title, { body, tag: `tktgen-${Date.now()}`, icon: "/icon.svg", requireInteraction: true });
    n.onclick = () => { window.focus(); n.close(); };
  } catch { /* some mobile browsers need a service worker */ }
}
