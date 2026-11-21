/**
 * The desktop app (desktop/: RAW in its own window, Mac and Windows): the same site, a little more able there. Its
 * preload script gives `window.rawDesktop`. The installers live in the GitHub releases of the repository (public),
 * downloaded straight from the site's buttons.
 */
export interface DesktopInfo { version: string; platform: string; arch: string; signIn?: () => void;
  /** "inset": no title bar, the site's top bar is the window's (1.1.0 on) */ frame?: string; full?: boolean; onFullScreen?: (cb: (on: boolean) => void) => void }
/** The desktop app's latest version: an older one installed is offered the new installer (UpdatePill). */
export const DESKTOP_LATEST = "1.1.0";
const RELEASES = "https://github.com/soundityco/tiktokgenapp/releases/latest/download/";
export const DESKTOP_DOWNLOADS = {
  macArm: RELEASES + "RAW-by-aurare-mac-arm64.dmg",
  macIntel: RELEASES + "RAW-by-aurare-mac-x64.dmg",
  windows: RELEASES + "RAW-by-aurare-windows.exe",
};
/** The desktop app running this page, else null (a browser). */
export const desktopApp = (): DesktopInfo | null =>
  typeof window !== "undefined" ? ((window as unknown as { rawDesktop?: DesktopInfo }).rawDesktop ?? null) : null;
/** a < b, versions "x.y.z". */
export const olderThan = (a: string, b: string): boolean => {
  const p = (v: string) => v.split(".").map((x) => parseInt(x, 10) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
};

/**
 * The installer for this computer, when the desktop app fits it (a Mac or a Windows PC, not already in the app; never a
 * phone): a Mac's chip read from its graphics card (an Intel or AMD one: an Intel Mac; Apple's: Apple's chip).
 */
export function desktopDownloadHere(): { href: string; os: "mac" | "windows" } | null {
  if (typeof window === "undefined" || desktopApp() || matchMedia("(hover: none)").matches) return null;
  const ua = navigator.userAgent;
  if (/Windows/.test(ua)) return { href: DESKTOP_DOWNLOADS.windows, os: "windows" };
  if (!/Macintosh|Mac OS X/.test(ua)) return null;
  let gpu = "";
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    gpu = gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "";
  } catch { /* unknown: Apple's chip, the Macs of today */ }
  return { href: /Intel|AMD|Radeon/i.test(gpu) ? DESKTOP_DOWNLOADS.macIntel : DESKTOP_DOWNLOADS.macArm, os: "mac" };
}
