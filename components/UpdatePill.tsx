"use client";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { DESKTOP_DOWNLOADS, DESKTOP_LATEST, desktopApp, olderThan } from "@/lib/desktop";

const BUILD = process.env.NEXT_PUBLIC_BUILD ?? "dev";
const EVERY = 10 * 60 * 1000;

/**
 * A new version online (a push): a small pill, "New version · Reload" (the work saved first). In the desktop app, an
 * older app (the window itself, rarely changed) is offered its new installer. Never in development.
 */
export default function UpdatePill() {
  const { t } = useT();
  const [fresh, setFresh] = useState(false);
  const [shell, setShell] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const app = desktopApp();
    if (app && olderThan(app.version, DESKTOP_LATEST)) setShell(app.platform === "win32" ? DESKTOP_DOWNLOADS.windows : app.platform === "darwin" && app.arch === "x64" ? DESKTOP_DOWNLOADS.macIntel : DESKTOP_DOWNLOADS.macArm);
    if (BUILD === "dev") return;
    let last = 0;
    const check = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < 60_000) return;
      last = Date.now();
      void fetch("/api/version", { cache: "no-store" }).then((r) => r.json()).then((v: { build?: string }) => { if (v.build && v.build !== "dev" && v.build !== BUILD) setFresh(true); }).catch(() => {});
    };
    const id = window.setInterval(check, EVERY);
    document.addEventListener("visibilitychange", check);
    return () => { window.clearInterval(id); document.removeEventListener("visibilitychange", check); };
  }, []);
  if (hidden || (!fresh && !shell)) return null;
  const reload = async () => {
    // the work saved first (the studio answers this event), then the new version
    const waits: Promise<unknown>[] = [];
    window.dispatchEvent(new CustomEvent("rollout:flush", { detail: { wait: (p: Promise<unknown>) => waits.push(p) } }));
    await Promise.race([Promise.allSettled(waits), new Promise((r) => setTimeout(r, 5000))]);
    location.reload();
  };
  return (
    <div className="update-pill" role="status">
      {fresh
        ? <><span>{t("New version of RAW")}</span><button className="btn sm primary" onClick={() => void reload()}>{t("Reload")}</button></>
        : <><span>{t("New version of the app")}</span><a className="btn sm primary" href={shell!} target="_blank" rel="noreferrer">{t("Download")}</a></>}
      <button className="btn sm quiet icon" aria-label={t("Later")} onClick={() => setHidden(true)}>×</button>
    </div>
  );
}
