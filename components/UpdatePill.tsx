"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Icon from "./Icon";
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
  // the top bar's slot, looked for each second while there is something to say (the studio mounts after this, a phone)
  const [slot, setSlot] = useState<Element | null>(null);
  const showing = !hidden && (fresh || !!shell);
  useEffect(() => {
    if (!showing) return;
    const find = () => setSlot((cur) => { const el = matchMedia("(max-width: 640px)").matches ? null : document.querySelector(".update-slot"); return el === cur ? cur : el; });
    find();
    const id = window.setInterval(find, 1000);
    return () => window.clearInterval(id);
  }, [showing]);
  if (!showing) return null;
  const reload = async () => {
    // the work saved first (the studio answers this event), then the new version
    const waits: Promise<unknown>[] = [];
    window.dispatchEvent(new CustomEvent("rollout:flush", { detail: { wait: (p: Promise<unknown>) => waits.push(p) } }));
    await Promise.race([Promise.allSettled(waits), new Promise((r) => setTimeout(r, 5000))]);
    location.reload();
  };
  // In the studio's top bar on a computer (left of the account), as an app tells an update; elsewhere (a phone, a page
  // without the bar) at the bottom. The button is Generate's, small.
  const chip = (
    <div className={"update-chip" + (slot ? "" : " floating")} role="status">
      <span className="update-dot" aria-hidden />
      <span className="update-txt">{fresh ? t("New version of RAW") : t("New version of the app")}</span>
      {fresh
        ? <button className="btn sm primary gen-btn" onClick={() => void reload()}>{t("Reload")}</button>
        : <a className="btn sm primary gen-btn" href={shell!} target="_blank" rel="noreferrer">{t("Download")}</a>}
      <button className="btn sm quiet icon update-x" aria-label={t("Later")} title={t("Later")} onClick={() => setHidden(true)}><Icon name="x" size={13} /></button>
    </div>
  );
  return slot ? createPortal(chip, slot) : chip;
}
