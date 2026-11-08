"use client";
import { useEffect, useState } from "react";

/** Chrome's install prompt, kept from the moment it comes (often before the studio shows). */
type Prompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
let deferred: Prompt | null = null;
/** The app was installed on this device (seen from the browser: same storage as the installed app, except on iPhone). */
const INSTALLED = "tktgen-installed";
const markInstalled = () => { try { localStorage.setItem(INSTALLED, "1"); } catch { /* private mode */ } };
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((f) => f());

const standalone = () => typeof window !== "undefined"
  && (matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);
const ios = () => typeof navigator !== "undefined"
  && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

/** Registers the service worker, so the browser offers to install Rollout as an app (its icon, its own window). */
export default function InstallApp() {
  useEffect(() => {
    // The width a scrollbar takes here (0 with the Mac's floating scrollbars): the scrolling columns take it off
    // their right padding, so their two sides stay even (see --sbw in globals.css).
    const d = document.createElement("div");
    d.style.cssText = "position:absolute;top:-999px;width:100px;height:100px;overflow:scroll";
    document.body.appendChild(d);
    document.documentElement.style.setProperty("--sbw", `${d.offsetWidth - d.clientWidth}px`);
    d.remove();
  }, []);
  useEffect(() => {
    const keep = (e: Event) => { e.preventDefault(); deferred = e as Prompt; changed(); };
    const done = () => { deferred = null; markInstalled(); changed(); };
    // Opened as the installed app: say so for the browser too (it shares this storage).
    if (standalone()) markInstalled();
    window.addEventListener("beforeinstallprompt", keep);
    window.addEventListener("appinstalled", done);
    if ("serviceWorker" in navigator && location.hostname !== "localhost") {
      navigator.serviceWorker.register("/sw.js").catch(() => { /* not installable here: the site works the same */ });
    }
    return () => { window.removeEventListener("beforeinstallprompt", keep); window.removeEventListener("appinstalled", done); };
  }, []);
  return null;
}

/** "Install the app": the browser's own prompt (Chrome, Edge, Android), or how to do it on an iPhone. */
export function useInstall() {
  const [, tick] = useState(0);
  const [iosHelp, setIosHelp] = useState(false);
  const [onIos, setOnIos] = useState(false);
  const [inApp, setInApp] = useState(false);
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    listeners.add(f);
    setOnIos(ios() && !standalone());
    setInApp(standalone());
    let seen = false;
    try { seen = localStorage.getItem(INSTALLED) === "1"; } catch { /* private mode */ }
    setInstalled(seen);
    // Chrome can also tell, through the manifest's related_applications (itself).
    const nav = navigator as Navigator & { getInstalledRelatedApps?: () => Promise<unknown[]> };
    nav.getInstalledRelatedApps?.().then((a) => { if (a.length) { markInstalled(); setInstalled(true); } }).catch(() => {});
    return () => { listeners.delete(f); };
  }, []);
  // A prompt means it is not installed (any more): it was uninstalled since.
  if (deferred && installed) { try { localStorage.removeItem(INSTALLED); } catch { /* private mode */ } }
  const isInstalled = installed && !deferred;
  /** Nothing to show inside the installed app; "installed" in the browser; else the install. */
  const canInstall = !inApp && !isInstalled && (!!deferred || onIos);
  const install = async () => {
    if (deferred) { const d = deferred; await d.prompt(); await d.userChoice.catch(() => null); deferred = null; changed(); return; }
    if (onIos) setIosHelp(true);
  };
  return { canInstall, installed: !inApp && isInstalled, install, iosHelp, closeIosHelp: () => setIosHelp(false) };
}
