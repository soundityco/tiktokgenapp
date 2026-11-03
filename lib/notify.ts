/** Browser notifications for long jobs (sync, lyrics): the user can work in another tab meanwhile. */
export function canNotify(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

/** Ask once, from a click. Resolves quietly when the browser refuses. */
export async function askNotifyPermission(): Promise<void> {
  if (!canNotify() || Notification.permission !== "default") return;
  try { await Notification.requestPermission(); } catch { /* old Safari: callback API only */ }
}

/** Shown only when the user is not looking at the app (other tab or other window). */
export function notify(title: string, body: string): void {
  if (!canNotify() || Notification.permission !== "granted") return;
  if (typeof document !== "undefined" && !document.hidden && document.hasFocus()) return;
  try {
    const n = new Notification(title, { body, tag: "tktgen-job", icon: "/icon.svg" });
    n.onclick = () => { window.focus(); n.close(); };
  } catch { /* some mobile browsers need a service worker */ }
}
