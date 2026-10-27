"use client";
import { useEffect, useState } from "react";
import { DriveItem, isFolder, isImage, listFolder } from "@/lib/drive";
import type { PicRef } from "@/lib/types";
import { Modal } from "./ui";

export default function DriveBrowser({ onAdd, onClose }: { onAdd: (pics: PicRef[]) => void; onClose: () => void }) {
  const [path, setPath] = useState<{ id: string; name: string }[]>([{ id: "root", name: "My Drive" }]);
  const [items, setItems] = useState<DriveItem[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
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
    <Modal title="Add pictures from Google Drive" onClose={onClose} wide>
      <div className="row">
        <button className="btn sm" onClick={() => setPath([{ id: "root", name: "My Drive" }])}>My Drive</button>
        <button className="btn sm" onClick={() => setPath([{ id: "shared", name: "Shared with me" }])}>Shared with me</button>
        <span className="muted grow" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
          {path.map((p) => p.name).join(" / ")}
        </span>
        {path.length > 1 && <button className="btn sm" onClick={() => setPath(path.slice(0, -1))}>← Back</button>}
      </div>
      {err && <p className="badge bad" style={{ whiteSpace: "normal" }}>{err}</p>}
      <div style={{ maxHeight: "50dvh", overflow: "auto", display: "grid", gap: 4 }}>
        {loading && <p className="muted">Loading…</p>}
        {!loading && !items.length && <p className="muted">No folders or pictures here.</p>}
        {items.filter(isFolder).map((f) => (
          <button key={f.id} className="pool" onClick={() => setPath([...path, { id: f.id, name: f.name }])}>
            <span>📁</span><span className="grow" style={{ textAlign: "left" }}>{f.name}</span>
          </button>
        ))}
        {images.map((i) => (
          <label key={i.id} className="pool">
            <input type="checkbox" checked={sel.has(i.id)} onChange={() => toggle(i.id)} />
            <span className="grow" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{i.name}</span>
          </label>
        ))}
      </div>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={onClose}>Close</button>
        <button className="btn" disabled={!sel.size} onClick={() => { onAdd(images.filter((i) => sel.has(i.id)).map(toRef)); onClose(); }}>
          Add selected ({sel.size})
        </button>
        <button className="btn red" disabled={!images.length} onClick={() => { onAdd(images.map(toRef)); onClose(); }}>
          Add all {images.length} pictures here
        </button>
      </div>
    </Modal>
  );
}
