"use client";
import { useEffect, useRef, useState } from "react";
import { hookKey, textItems } from "@/lib/generate";
import { loadDriveImage } from "@/lib/drive";
import { useT } from "@/lib/i18n";
import { thumbnailLink } from "@/lib/thumb";
import type { PicPool, PicRef, TextPool } from "@/lib/types";
import Icon from "./Icon";
import { Modal, ScopeSelect } from "./ui";

function Thumb({ id, name }: { id: string; name: string }) {
  const holder = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => e[0].isIntersecting && (setVisible(true), io.disconnect()), { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  // 1) Google's own thumbnail (tiny). 2) If unavailable, decode the picture and draw a small version.
  useEffect(() => {
    if (!visible) return;
    let off = false;
    thumbnailLink(id).then((l) => !off && (l ? setSrc(l) : setFallback(true)));
    return () => { off = true; };
  }, [visible, id]);
  useEffect(() => {
    if (!fallback) return;
    let off = false;
    loadDriveImage(id).then((img) => {
      const c = cv.current;
      if (off || !c) return;
      const s = Math.max(120 / img.width, 120 / img.height);
      c.width = 120; c.height = 120;
      c.getContext("2d")!.drawImage(img, (120 - img.width * s) / 2, (120 - img.height * s) / 2, img.width * s, img.height * s);
    }).catch(() => {});
    return () => { off = true; };
  }, [fallback, id]);

  return (
    <div ref={holder} className="thumb" title={name}>
      {fallback ? <canvas ref={cv} /> : src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" referrerPolicy="no-referrer" onError={() => setFallback(true)} />
      ) : null}
    </div>
  );
}

interface Common { onClose: () => void; onDelete: () => void }

export function TextPoolEditor(p: Common & { pool: TextPool; onChange: (fn: (t: TextPool) => TextPool) => void; onImport: () => void; onRefreshViews?: () => void; viewsBusy?: boolean }) {
  const { t } = useT();
  const { pool } = p;
  const file = useRef<HTMLInputElement>(null);
  const n = textItems(pool).length;
  const perf = pool.kind === "hooks" && pool.views
    ? textItems(pool)
        .map((text) => ({ text, views: pool.views?.[hookKey(text)] ?? 0 }))
        .filter((x) => x.views > 0)
        .sort((a, b) => b.views - a.views)
        .slice(0, 8)
    : [];
  return (
    <Modal title={t("Text list")} onClose={p.onClose} wide>
      <div className="cols2">
        <label className="field">{t("Name")}<input className="input" value={pool.name} onChange={(e) => p.onChange((x) => ({ ...x, name: e.target.value }))} /></label>
        <ScopeSelect value={pool.scope} onChange={(v) => p.onChange((x) => ({ ...x, scope: v }))} />
      </div>
      <label className="field">{t("Type")}
        <select className="input" value={pool.kind} onChange={(e) => p.onChange((x) => ({ ...x, kind: e.target.value as "hooks" | "block" }))}>
          <option value="hooks">{t("One text per line")}</option>
          <option value="block">{t("Lyrics block")}</option>
        </select>
      </label>
      <textarea className="input" rows={12} aria-label={t("Texts")} value={pool.text} onChange={(e) => p.onChange((x) => ({ ...x, text: e.target.value }))}
        placeholder={pool.kind === "hooks" ? t("One text per line. Use | to force a line break on the slide.") : t("Paste the whole text. It is placed on the slide line by line, exactly as typed.")} />
      {perf.length > 0 && (
        <details className="sec">
          <summary>{t("Best hooks by views")}</summary>
          <div className="body">
            {perf.map((row) => (
              <div className="row" key={row.text}>
                <span className="grow truncate">{row.text}</span>
                <span className="muted xs">{t("{n} views", { n: row.views.toLocaleString("en-US") })}</span>
              </div>
            ))}
          </div>
        </details>
      )}
      <div className="row">
        <span className="muted grow">{pool.kind === "hooks" ? t("{n} texts", { n }) : n ? t("1 block") : t("Empty")}</span>
        <input ref={file} type="file" accept=".txt,text/plain" hidden onChange={async (e) => {
          const f = e.target.files?.[0];
          if (f) { const txt = await f.text(); p.onChange((x) => ({ ...x, text: x.text.trim() ? x.text.replace(/\s+$/, "") + "\n" + txt : txt })); }
          e.target.value = "";
        }} />
        <button className="btn sm" onClick={() => file.current?.click()}>{t("Import .txt")}</button>
        {pool.kind === "hooks" && <button className="btn sm" onClick={p.onImport}>{t("Import hooks…")}</button>}
        {pool.kind === "hooks" && p.onRefreshViews && Object.keys(pool.views ?? {}).length > 0 && (
          <button className="btn sm" onClick={p.onRefreshViews} disabled={p.viewsBusy}>
            {p.viewsBusy ? t("Updating…") : t("Update views")}
          </button>
        )}
      </div>
      <div className="modal-foot">
        <button className="btn quiet danger left" onClick={p.onDelete}>{t("Delete list")}</button>
        <button className="btn primary" onClick={p.onClose}>{t("Done")}</button>
      </div>
    </Modal>
  );
}

export function PicPoolEditor(p: Common & { pool: PicPool; onChange: (fn: (t: PicPool) => PicPool) => void; onBrowse: () => void; onSync: (manual: boolean) => void }) {
  const { t } = useT();
  const { pool } = p;
  const folders = pool.folders ?? [];
  const onSync = useRef(p.onSync);
  useEffect(() => { onSync.current(false); }, [pool.id]); // fresh photos each time the list is opened
  const unlink = (id: string) => p.onChange((x) => ({
    ...x,
    folders: (x.folders ?? []).filter((f) => f.id !== id),
    pics: x.pics.map((y) => (y.folder === id ? { id: y.id, name: y.name } : y)),
  }));
  const remove = (pic: PicRef) => p.onChange((x) => ({
    ...x,
    pics: x.pics.filter((y) => y.id !== pic.id),
    ...(pic.folder ? { excluded: [...(x.excluded ?? []), pic.id] } : {}),
  }));
  return (
    <Modal title={t("Photo list")} onClose={p.onClose} wide>
      <div className="cols2">
        <label className="field">{t("Name")}<input className="input" value={pool.name} onChange={(e) => p.onChange((x) => ({ ...x, name: e.target.value }))} /></label>
        <ScopeSelect value={pool.scope} onChange={(v) => p.onChange((x) => ({ ...x, scope: v }))} />
      </div>
      <div className="row">
        <button className="btn primary" onClick={p.onBrowse}><Icon name="folder" />{t("Add from Google Drive")}</button>
        <span className="muted grow">{t("{n} photos (they stay in your Drive)", { n: pool.pics.length })}</span>
        <button className="btn sm" disabled={!pool.pics.length} onClick={() => p.onChange((x) => ({ ...x, pics: [], folders: [], excluded: [] }))}>{t("Remove all")}</button>
      </div>
      {folders.length > 0 && (
        <div className="row">
          <span className="muted xs">{t("Linked folders:")}</span>
          {folders.map((f) => (
            <span key={f.id} className="row nowrap" style={{ gap: 2 }}>
              <Icon name="folder" size={13} /><span className="xs">{f.name}</span>
              <button className="btn sm quiet icon" aria-label={t("Unlink {name}", { name: f.name })} title={t("Unlink {name}", { name: f.name })} onClick={() => unlink(f.id)}><Icon name="x" size={11} /></button>
            </span>
          ))}
          <button className="btn sm" onClick={() => p.onSync(true)}>{t("Sync with Drive")}</button>
        </div>
      )}
      {!pool.pics.length && <p className="muted">{t("Pick a folder in your Drive and add all its photos in one click.")}</p>}
      <div className="thumbs" style={{ maxHeight: "46dvh", overflow: "auto" }}>
        {pool.pics.map((pic) => (
          <div key={pic.id} className="thumb-wrap">
            <Thumb id={pic.id} name={pic.name} />
            <button className="x" aria-label={t("Remove {name}", { name: pic.name })}
              onClick={() => remove(pic)}><Icon name="x" size={12} /></button>
          </div>
        ))}
      </div>
      <div className="modal-foot">
        <button className="btn quiet danger left" onClick={p.onDelete}>{t("Delete list")}</button>
        <button className="btn primary" onClick={p.onClose}>{t("Done")}</button>
      </div>
    </Modal>
  );
}
