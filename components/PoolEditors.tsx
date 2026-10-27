"use client";
import { useEffect, useRef, useState } from "react";
import { textItems } from "@/lib/generate";
import { loadDriveImage } from "@/lib/drive";
import type { PicPool, PicRef, TextPool } from "@/lib/types";
import { Modal } from "./ui";

function Thumb({ id, name }: { id: string; name: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => e[0].isIntersecting && (setVisible(true), io.disconnect()), { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let off = false;
    loadDriveImage(id).then((img) => {
      const c = ref.current;
      if (off || !c) return;
      const s = Math.max(120 / img.width, 120 / img.height);
      c.width = 120; c.height = 120;
      c.getContext("2d")!.drawImage(img, (120 - img.width * s) / 2, (120 - img.height * s) / 2, img.width * s, img.height * s);
    }).catch(() => {});
    return () => { off = true; };
  }, [visible, id]);
  return <div ref={holder} className="thumb" title={name}><canvas ref={ref} /></div>;
}

interface Common { onClose: () => void; onDelete: () => void }

export function TextPoolEditor(p: Common & { pool: TextPool; onChange: (fn: (t: TextPool) => TextPool) => void; onExtract: () => void }) {
  const { pool } = p;
  const file = useRef<HTMLInputElement>(null);
  const n = textItems(pool).length;
  return (
    <Modal title="Text pool" onClose={p.onClose} wide>
      <div className="two">
        <label className="f">Name<input className="input" value={pool.name} onChange={(e) => p.onChange((t) => ({ ...t, name: e.target.value }))} /></label>
        <label className="f">Scope
          <select className="input" value={pool.scope} onChange={(e) => p.onChange((t) => ({ ...t, scope: e.target.value as "shared" | "project" }))}>
            <option value="shared">Shared by all projects</option>
            <option value="project">Only this project</option>
          </select>
        </label>
      </div>
      <label className="f">Kind
        <select className="input" value={pool.kind} onChange={(e) => p.onChange((t) => ({ ...t, kind: e.target.value as "hooks" | "block" }))}>
          <option value="hooks">One text per line (hooks)</option>
          <option value="block">Lyrics block</option>
        </select>
      </label>
      <textarea className="input" rows={14} value={pool.text} onChange={(e) => p.onChange((t) => ({ ...t, text: e.target.value }))}
        placeholder={pool.kind === "hooks" ? "One hook per line. Use | to force a line break on the slide." : "Paste the whole text. It is placed on the slide line by line, exactly as typed."} />
      <div className="row">
        <span className="muted grow">{pool.kind === "hooks" ? `${n} text${n === 1 ? "" : "s"}` : n ? "1 block" : "Empty"}</span>
        <input ref={file} type="file" accept=".txt,text/plain" hidden onChange={async (e) => {
          const f = e.target.files?.[0];
          if (f) { const t = await f.text(); p.onChange((x) => ({ ...x, text: x.text.trim() ? x.text.replace(/\s+$/, "") + "\n" + t : t })); }
          e.target.value = "";
        }} />
        <button className="btn" onClick={() => file.current?.click()}>Import .txt</button>
        {pool.kind === "hooks" && <button className="btn" onClick={p.onExtract}>Extract from screenshots</button>}
        <button className="btn" onClick={p.onDelete}>🗑 Delete pool</button>
        <button className="btn red" onClick={p.onClose}>Done</button>
      </div>
    </Modal>
  );
}

export function PicPoolEditor(p: Common & { pool: PicPool; onChange: (fn: (t: PicPool) => PicPool) => void; onBrowse: () => void }) {
  const { pool } = p;
  return (
    <Modal title="Picture pool" onClose={p.onClose} wide>
      <div className="two">
        <label className="f">Name<input className="input" value={pool.name} onChange={(e) => p.onChange((t) => ({ ...t, name: e.target.value }))} /></label>
        <label className="f">Scope
          <select className="input" value={pool.scope} onChange={(e) => p.onChange((t) => ({ ...t, scope: e.target.value as "shared" | "project" }))}>
            <option value="shared">Shared by all projects</option>
            <option value="project">Only this project</option>
          </select>
        </label>
      </div>
      <div className="row">
        <button className="btn red" onClick={p.onBrowse}>Add from Google Drive</button>
        <span className="muted grow">{pool.pics.length} picture{pool.pics.length === 1 ? "" : "s"} (they stay in your Drive)</span>
        <button className="btn" disabled={!pool.pics.length} onClick={() => p.onChange((t) => ({ ...t, pics: [] }))}>Remove all</button>
      </div>
      {!pool.pics.length && <p className="muted" style={{ margin: 0 }}>Pick a folder in your Drive and add all its pictures in one click.</p>}
      <div className="thumbs" style={{ maxHeight: "46dvh", overflow: "auto" }}>
        {pool.pics.map((pic) => (
          <div key={pic.id} style={{ position: "relative" }}>
            <Thumb id={pic.id} name={pic.name} />
            <button className="del-x" aria-label={`Remove ${pic.name}`} style={{ position: "absolute", top: 2, right: 2, background: "rgba(0,0,0,.7)", border: 0, borderRadius: 999, width: 20, height: 20, padding: 0 }}
              onClick={() => p.onChange((t) => ({ ...t, pics: t.pics.filter((x: PicRef) => x.id !== pic.id) }))}>×</button>
          </div>
        ))}
      </div>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={p.onDelete}>🗑 Delete pool</button>
        <button className="btn red" onClick={p.onClose}>Done</button>
      </div>
    </Modal>
  );
}
