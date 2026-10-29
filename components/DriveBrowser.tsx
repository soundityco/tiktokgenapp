"use client";
import { useEffect, useState } from "react";
import { DriveItem, isFolder, isImage, listFolder } from "@/lib/drive";
import { useT } from "@/lib/i18n";
import type { PicRef } from "@/lib/types";
import { Modal } from "./ui";

export default function DriveBrowser({ onAdd, onClose }: { onAdd: (pics: PicRef[], toAll: boolean) => void; onClose: () => void }) {
  const { t } = useT();
  const [path, setPath] = useState<{ id: string; name: string }[]>([{ id: "root", name: t("My Drive") }]);
  const [items, setItems] = useState<DriveItem[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [toAll, setToAll] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const cur = path[path.length - 1];

  useEffect(() => {
    let off = false;
    setLoading(true); setErr(null); setSel(new Set());
    listFolder(cur.id)
      .then((r) => !off && setItems(r))
      .catch((e) => !off && setErr(e.message))
      .finally(() => !off && setLoading(false));
    return () => { off = true; };
  }, [cur.id]);

  const images = items.filter(isImage);
  const toRef = (i: DriveItem): PicRef => ({ id: i.id, name: i.name });
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <Modal title={t("Add photos from Google Drive")} onClose={onClose} wide>
      <div className="row">
        <button className="btn sm" onClick={() => setPath([{ id: "root", name: t("My Drive") }])}>{t("My Drive")}</button>
        <button className="btn sm" onClick={() => setPath([{ id: "shared", name: t("Shared with me") }])}>{t("Shared with me")}</button>
        <span className="muted xs grow truncate">{path.map((p) => p.name).join(" / ")}</span>
        {path.length > 1 && <button className="btn sm quiet" onClick={() => setPath(path.slice(0, -1))}>← {t("Back")}</button>}
      </div>
      {err && <p className="notice bad">{err}</p>}
      <div className="stack" style={{ maxHeight: "48dvh", overflow: "auto", gap: 4 }}>
        {loading && <p className="muted">{t("Loading…")}</p>}
        {!loading && !items.length && <p className="muted">{t("No folders or photos here.")}</p>}
        {items.filter(isFolder).map((f) => (
          <button key={f.id} className="item" onClick={() => setPath([...path, { id: f.id, name: f.name }])}>
            <span>📁</span><span className="grow truncate">{f.name}</span>
          </button>
        ))}
        {images.map((i) => (
          <label key={i.id} className="item">
            <input type="checkbox" checked={sel.has(i.id)} onChange={() => toggle(i.id)} />
            <span className="grow truncate">{i.name}</span>
          </label>
        ))}
      </div>
      <label className="check"><input type="checkbox" checked={toAll} onChange={(e) => setToAll(e.target.checked)} />{t("Also add them to the photo lists of all slides in this project")}</label>
      <div className="modal-foot">
        <button className="btn quiet" onClick={onClose}>{t("Close")}</button>
        <button className="btn" disabled={!sel.size} onClick={() => { onAdd(images.filter((i) => sel.has(i.id)).map(toRef), toAll); onClose(); }}>
          {t("Add selected ({n})", { n: sel.size })}
        </button>
        <button className="btn primary" disabled={!images.length} onClick={() => { onAdd(images.map(toRef), toAll); onClose(); }}>
          {t("Add all {n} photos here", { n: images.length })}
        </button>
      </div>
    </Modal>
  );
}
