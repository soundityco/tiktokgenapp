"use client";
import { useEffect, useState } from "react";
import { DriveItem, isAudio, isFolder, isImage, listFolder, searchDrive } from "@/lib/drive";
import { useT } from "@/lib/i18n";
import type { PicRef } from "@/lib/types";
import Icon from "./Icon";
import { Modal } from "./ui";

/**
 * Google Drive browser. Photos mode (carousel lists): tick photos or add a whole folder.
 * Audio mode (`onPick`): one click on an audio file picks it (the official audio of a release).
 */
export default function DriveBrowser({ onAdd, onPick, onClose }: {
  /** `folder` is set when a whole folder was added: the list then stays in sync with it. */
  onAdd?: (pics: PicRef[], toAll: boolean, folder?: { id: string; name: string }) => void;
  onPick?: (file: DriveItem) => void;
  onClose: () => void;
}) {
  const audio = !!onPick;
  const { t } = useT();
  const [path, setPath] = useState<{ id: string; name: string }[]>([{ id: "root", name: t("My Drive") }]);
  const [items, setItems] = useState<DriveItem[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [toAll, setToAll] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const cur = path[path.length - 1];
  const query = q.trim();

  useEffect(() => {
    let off = false;
    setLoading(true); setErr(null); setSel(new Set());
    const timer = setTimeout(() => {
      const kind = audio ? "audio" : "images";
      const run = query ? searchDrive(query, kind) : listFolder(cur.id, kind);
      run
        .then((r) => !off && setItems(r))
        .catch((e) => !off && setErr(e.message))
        .finally(() => !off && setLoading(false));
    }, query ? 250 : 0);
    return () => { off = true; clearTimeout(timer); };
  }, [cur.id, query]);

  const images = items.filter(isImage);
  const toRef = (i: DriveItem): PicRef => ({ id: i.id, name: i.name });
  const linkable = !query && cur.id !== "shared";
  const allSel = images.length > 0 && images.every((i) => sel.has(i.id));
  // Tick every photo first so you see what is being added, then add them.
  const addAll = () => {
    setSel(new Set(images.map((i) => i.id)));
    setAdding(true);
    setTimeout(() => { onAdd?.(images.map(toRef), toAll, linkable ? { id: cur.id, name: cur.name } : undefined); onClose(); }, 450);
  };
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <Modal title={audio ? t("Official audio from Google Drive") : t("Add photos from Google Drive")} onClose={onClose} wide>
      <div className="row">
        <button className="btn sm" onClick={() => { setQ(""); setPath([{ id: "root", name: t("My Drive") }]); }}>{t("My Drive")}</button>
        <button className="btn sm" onClick={() => { setQ(""); setPath([{ id: "shared", name: t("Shared with me") }]); }}>{t("Shared with me")}</button>
        <input className="input" style={{ width: 200 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Search your Drive")} aria-label={t("Search your Drive")} />
        <nav className="crumbs grow" aria-label={t("Folder path")}>
          {path.map((p, i) => (
            <span key={p.id} className="row" style={{ gap: 4, flex: "none" }}>
              {i > 0 && <span>/</span>}
              <button onClick={() => { setQ(""); setPath(path.slice(0, i + 1)); }}>{p.name}</button>
            </span>
          ))}
        </nav>
        {path.length > 1 && <button className="btn sm quiet" onClick={() => { setQ(""); setPath(path.slice(0, -1)); }}><Icon name="back" size={14} />{t("Back")}</button>}
      </div>
      {err && <p className="notice bad">{err}</p>}
      <div className="stack" style={{ maxHeight: "48dvh", overflow: "auto", gap: 4 }}>
        {loading && <p className="muted shine">{t("Loading…")}</p>}
        {!loading && !items.length && <p className="muted">{query ? t("No results.") : audio ? t("No folders or audio files here.") : t("No folders or photos here.")}</p>}
        {items.filter(isFolder).map((f) => (
          <button key={f.id} className="item" onClick={() => {
            if (query) {
              setQ("");
              setPath([{ id: "root", name: t("My Drive") }, { id: f.id, name: f.name }]);
            } else setPath([...path, { id: f.id, name: f.name }]);
          }}>
            <Icon name="folder" size={15} /><span className="grow truncate">{f.name}</span>
          </button>
        ))}
        {audio && items.filter(isAudio).map((f) => (
          <button key={f.id} className="item" onClick={() => { onPick!(f); onClose(); }}>
            <Icon name="play" size={14} /><span className="grow truncate">{f.name}</span>
          </button>
        ))}
        {!audio && images.length > 1 && (
          <label className="item">
            <input type="checkbox" checked={allSel} disabled={adding}
              onChange={() => setSel(allSel ? new Set() : new Set(images.map((i) => i.id)))} />
            <span className="grow muted">{t("Select all ({n})", { n: images.length })}</span>
          </label>
        )}
        {!audio && images.map((i) => (
          <label key={i.id} className="item">
            <input type="checkbox" checked={sel.has(i.id)} disabled={adding} onChange={() => toggle(i.id)} />
            <span className="grow truncate">{i.name}</span>
          </label>
        ))}
      </div>
      {audio ? (
        <>
          <p className="muted xs">{t("The audio stays in your Drive: the app keeps a copy on this device and gets it back from Drive on another computer.")}</p>
          <div className="modal-foot"><button className="btn quiet" onClick={onClose}>{t("Close")}</button></div>
        </>
      ) : (
      <>
      {linkable && images.length > 0 && <p className="muted xs">{t("Adding all the photos of a folder links it: photos you put in it later are added automatically.")}</p>}
      <label className="check"><input type="checkbox" checked={toAll} onChange={(e) => setToAll(e.target.checked)} />{t("Also copy them into the photo lists of the other slides")}</label>
      <div className="modal-foot">
        <button className="btn quiet" onClick={onClose}>{t("Close")}</button>
        <button className="btn" disabled={!sel.size || adding} onClick={() => { onAdd?.(images.filter((i) => sel.has(i.id)).map(toRef), toAll); onClose(); }}>
          {t("Add selected ({n})", { n: sel.size })}
        </button>
        <button className={"btn primary" + (adding ? " shine-box" : "")} disabled={!images.length || adding} onClick={addAll}>
          {adding ? t("Adding…") : query ? t("Add all {n} photos", { n: images.length }) : t("Add all {n} photos here", { n: images.length })}
        </button>
      </div>
      </>
      )}
    </Modal>
  );
}
