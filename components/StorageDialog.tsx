"use client";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { deleteDriveFile, driveQuota, listAppFolder, listAppVisible, type AppFile } from "@/lib/drive";
import { Modal } from "./ui";

type Kind = "copy" | "original" | "audio" | "photo" | "lut" | "other";
/** What a file of the app's folder is (its label at upload, else its name and type). */
export function kindOf(f: Pick<AppFile, "name" | "mimeType" | "appProperties">): Kind {
  const tag = f.appProperties?.tktgen;
  const mime = f.mimeType ?? "", name = f.name ?? "";
  if (tag === "copy") return "copy";
  if (tag === "audio") return "audio";
  if (tag === "photo") return "photo";
  if (/\.cube$/i.test(name)) return "lut";
  if (mime.startsWith("video/") || /\.(mp4|mov|m4v)$/i.test(name)) return "original";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("image/")) return "photo";
  return "other";
}

const fmt = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(b >= 1e10 ? 0 : 1)} Go` : b >= 1e6 ? `${Math.round(b / 1e6)} Mo` : `${Math.max(1, Math.round(b / 1e3))} Ko`);

/**
 * "Storage": the Drive at a glance, like a phone's storage page. One bar (RAW's part, the rest of the Drive,
 * the free space), then what RAW keeps there by kind; the video copies no video uses any more can go.
 */
export default function StorageDialog({ usedCopies, onClose }: {
  /** The Drive copies the workspace still points to (the others are left over). */
  usedCopies: Set<string>;
  onClose: () => void;
}) {
  const { t } = useT();
  const [quota, setQuota] = useState<{ used: number; limit: number | null } | null>(null);
  // What RAW put in the Drive's bin (still counted until Google empties it, 30 days), and its files left outside its
  // folder (an old flat Rollout file, a folder moved by hand).
  const [bin, setBin] = useState<AppFile[]>([]);
  const [elsewhere, setElsewhere] = useState<AppFile[]>([]);
  /** A deletion going on (which list, how far), then what it did (shown until the next one). */
  const [del, setDel] = useState<{ what: "bin" | "orphans"; done: number; of: number } | null>(null);
  const [delNote, setDelNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const [files, setFiles] = useState<AppFile[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => {
    setErr(null);
    void Promise.all([driveQuota(), listAppFolder(), listAppVisible(true).catch(() => []), listAppVisible(false).catch(() => [])])
      .then(([q, f, bin, all]) => {
        setQuota(q); setFiles(f); setBin(bin);
        const inTree = new Set(f.map((x) => x.id));
        setElsewhere(all.filter((x) => !inTree.has(x.id)));
      })
      .catch((e) => { console.warn("[storage]", e); setErr(t("Your Drive could not be read. Reconnect Google and try again.")); });
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const KINDS: { k: Kind; label: string; color: string }[] = [
    { k: "copy", label: t("Video copies"), color: "var(--video)" },
    { k: "original", label: t("Camera files"), color: "#6a55ff" },
    { k: "audio", label: t("Official audios"), color: "var(--music)" },
    { k: "photo", label: t("Photos"), color: "#ffa24d" },
    { k: "lut", label: t("Look LUTs"), color: "var(--lyrics)" },
    { k: "other", label: t("Other"), color: "var(--muted)" },
  ];
  const by = new Map<Kind, { n: number; size: number }>();
  for (const f of files ?? []) { const k = kindOf(f); const c = by.get(k) ?? { n: 0, size: 0 }; c.n++; c.size += f.size; by.set(k, c); }
  const rollout = [...by.values()].reduce((n, c) => n + c.size, 0);
  const orphans = (files ?? []).filter((f) => kindOf(f) === "copy" && !usedCopies.has(f.id));
  const orphanSize = orphans.reduce((n, f) => n + f.size, 0);
  const limit = quota?.limit ?? null;
  const pct = (b: number) => (limit ? `${Math.min(100, (b / limit) * 100)}%` : "0%");

  const binSize = bin.reduce((n, f) => n + f.size, 0), outSize = elsewhere.reduce((n, f) => n + f.size, 0);
  /**
   * Files deleted for good, a few at a time, the count going up; each one gone leaves the page at once (its list, the
   * bar); one refused never stops the others nor leaves the button spinning; at the end, what was freed.
   */
  const deleteAll = async (what: "bin" | "orphans", list: AppFile[]) => {
    if (del || !list.length) return;
    setDelNote(null);
    setDel({ what, done: 0, of: list.length });
    const gone = new Set<string>();
    let freed = 0, failed = 0, done = 0;
    const queue = [...list];
    const worker = async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        try { if (!(await deleteDriveFile(f.id))) throw new Error("refused"); gone.add(f.id); freed += f.size; }
        catch (e) { failed++; console.warn("[storage] not deleted", f.name, e); }
        done++;
        setDel({ what, done, of: list.length });
        const drop = (l: AppFile[]) => l.filter((x) => !gone.has(x.id));
        if (what === "bin") setBin(drop); else setFiles((l) => (l ? drop(l) : l));
        setQuota((q) => (q ? { ...q, used: Math.max(0, q.used - (gone.has(f!.id) ? f!.size : 0)) } : q));
      }
    };
    try { await Promise.all(Array.from({ length: Math.min(6, list.length) }, worker)); }
    finally {
      setDel(null);
      setDelNote(failed
        ? { text: t("{n} files deleted ({size} freed), {k} could not be: try again.", { n: gone.size, size: fmt(freed), k: failed }), bad: true }
        : { text: t("{n} files deleted for good: {size} freed (Google may take a few minutes to count it).", { n: gone.size, size: fmt(freed) }) });
      // (the Drive read again: what it says now)
      load();
    }
  };
  const emptyBin = () => deleteAll("bin", bin);
  const clean = () => deleteAll("orphans", orphans);

  return (
    <Modal title={t("Storage")} onClose={onClose}>
      {err ? <p className="notice bad xs">{err}</p> : !quota || !files ? (
        <div className="stack"><div className="storage-bar shine-box" /><p className="muted xs shine">{t("Reading your Drive…")}</p></div>
      ) : (
        <>
          {/* What matters: what RAW takes on the Drive; on the right, what is still free on it. */}
          <div className="storage-head">
            <span className="storage-big">{fmt(rollout)}</span>
            <span className="muted grow">{t("used by RAW on your Drive")}</span>
            <span className="storage-free">{limit ? t("{free} free of {total}", { free: fmt(Math.max(0, limit - quota.used)), total: fmt(limit) }) : t("No limit")}</span>
          </div>
          {/* RAW's kinds first (in their colours), then the rest of the Drive, then the free space. */}
          <div className="storage-bar" role="img" aria-label={t("{used} of {total} used", { used: fmt(quota.used), total: limit ? fmt(limit) : "∞" })}>
            {KINDS.map(({ k, color }) => { const c = by.get(k); return c && c.size ? <i key={k} style={{ width: pct(c.size), background: color }} /> : null; })}
            <i className="rest" style={{ width: pct(Math.max(0, quota.used - rollout)) }} />
          </div>
          <div className="storage-legend xs">
            <span><b className="dot" style={{ background: "linear-gradient(90deg, var(--video), var(--music))" }} />RAW · {fmt(rollout)}</span>
            <span><b className="dot rest" />{t("Rest of your Drive")} · {fmt(Math.max(0, quota.used - rollout))}</span>
            {limit && <span><b className="dot free" />{t("Free")} · {fmt(Math.max(0, limit - quota.used))}</span>}
          </div>
          <div className="storage-list">
            <span className="label">{t("In the RAW by aurare folder")}</span>
            {KINDS.filter(({ k }) => by.get(k)?.n).map(({ k, label, color }) => {
              const c = by.get(k)!;
              return (
                <div key={k} className="storage-row">
                  <b className="dot" style={{ background: color }} />
                  <span className="grow">{label}<span className="muted xs"> · {c.n}</span></span>
                  <span className="mono xs">{fmt(c.size)}</span>
                </div>
              );
            })}
            {!files.length && <p className="muted xs">{t("Nothing yet.")}</p>}
          </div>
          {/* Counted on the Drive too: what RAW sent to the bin (old audios, twins…) and its files outside its folder. */}
          {bin.length > 0 && (
            <div className="notice xs row" style={{ justifyContent: "space-between", gap: "var(--s2)" }}>
              <span>{t("In the Drive's bin: {n} files from RAW ({size}), still counted until Google empties it (30 days).", { n: bin.length, size: fmt(binSize) })}</span>
              <button className="btn sm" disabled={!!del} onClick={() => void emptyBin()}>{del?.what === "bin" ? t("Deleting… {n}/{of}", { n: del.done, of: del.of }) : t("Delete them for good")}</button>
            </div>
          )}
          {elsewhere.length > 0 && (
            <p className="muted xs">{t("Outside the RAW by aurare folder: {n} files made by the app ({size}), left where they are.", { n: elsewhere.length, size: fmt(outSize) })}</p>
          )}
          {orphans.length > 0 && (
            <div className="notice warn xs row" style={{ justifyContent: "space-between", gap: "var(--s2)" }}>
              <span>{t("{n} video copies are no longer used by any video ({size}).", { n: orphans.length, size: fmt(orphanSize) })}</span>
              <button className="btn sm" disabled={!!del} onClick={() => void clean()}>{del?.what === "orphans" ? t("Deleting… {n}/{of}", { n: del.done, of: del.of }) : t("Delete them")}</button>
            </div>
          )}
          {delNote && <p className={"notice xs" + (delNote.bad ? " bad" : " ok")}>{delNote.text}</p>}
          {/* A full Drive: said, with what can be done here. */}
          {limit && quota.used >= limit * 0.98 && <p className="notice bad xs">{t("Your Google Drive is full: new copies cannot be sent. Delete RAW's files in the bin above, or free space in Google Drive.")}</p>}
          <p className="muted xs">{t("The copies of a video go with it. Your camera files stay where you put them.")}</p>
        </>
      )}
      <div className="modal-foot"><button className="btn primary" onClick={onClose}>{t("Done")}</button></div>
    </Modal>
  );
}
