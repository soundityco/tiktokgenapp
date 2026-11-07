"use client";
import { useEffect, useState } from "react";

/** Chrome's install prompt, kept from the moment it comes (often before the studio shows). */
type Prompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
let deferred: Prompt | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((f) => f());

const standalone = () => typeof window !== "undefined"
  && (matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);
const ios = () => typeof navigator !== "undefined"
  && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

/** Registers the service worker, so the browser offers to install Rollout as an app (its icon, its own window). */
export default function InstallApp() {
  useEffect(() => {
    const keep = (e: Event) => { e.preventDefault(); deferred = e as Prompt; changed(); };
    const done = () => { deferred = null; changed(); };
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
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    listeners.add(f);
    setOnIos(ios() && !standalone());
    return () => { listeners.delete(f); };
  }, []);
  const canInstall = !!deferred || onIos;
  const install = async () => {
    if (deferred) { const d = deferred; await d.prompt(); await d.userChoice.catch(() => null); deferred = null; changed(); return; }
    if (onIos) setIosHelp(true);
  };
  return { canInstall, install, iosHelp, closeIosHelp: () => setIosHelp(false) };
}
