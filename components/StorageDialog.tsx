"use client";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { deleteDriveFile, driveQuota, listAppFolder, type AppFile } from "@/lib/drive";
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
 * "Storage": the Drive at a glance, like a phone's storage page. One bar (Rollout's part, the rest of the Drive,
 * the free space), then what Rollout keeps there by kind; the video copies no video uses any more can go.
 */
export default function StorageDialog({ usedCopies, onClose }: {
  /** The Drive copies the workspace still points to (the others are left over). */
  usedCopies: Set<string>;
  onClose: () => void;
}) {
  const { t } = useT();
  const [quota, setQuota] = useState<{ used: number; limit: number | null } | null>(null);
  const [files, setFiles] = useState<AppFile[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const load = () => {
    setErr(null);
    void Promise.all([driveQuota(), listAppFolder()])
      .then(([q, f]) => { setQuota(q); setFiles(f); })
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

  const clean = async () => {
    setCleaning(true);
    for (const f of orphans) await deleteDriveFile(f.id);
    setCleaning(false);
    load();
  };

  return (
    <Modal title={t("Storage")} onClose={onClose}>
      {err ? <p className="notice bad xs">{err}</p> : !quota || !files ? (
        <div className="stack"><div className="storage-bar shine-box" /><p className="muted xs shine">{t("Reading your Drive…")}</p></div>
      ) : (
        <>
          {/* What matters: what Rollout takes on the Drive; on the right, what is still free on it. */}
          <div className="storage-head">
            <span className="storage-big">{fmt(rollout)}</span>
            <span className="muted grow">{t("used by Rollout on your Drive")}</span>
            <span className="storage-free">{limit ? t("{free} free of {total}", { free: fmt(Math.max(0, limit - quota.used)), total: fmt(limit) }) : t("No limit")}</span>
          </div>
          {/* Rollout's kinds first (in their colours), then the rest of the Drive, then the free space. */}
          <div className="storage-bar" role="img" aria-label={t("{used} of {total} used", { used: fmt(quota.used), total: limit ? fmt(limit) : "∞" })}>
            {KINDS.map(({ k, color }) => { const c = by.get(k); return c && c.size ? <i key={k} style={{ width: pct(c.size), background: color }} /> : null; })}
            <i className="rest" style={{ width: pct(Math.max(0, quota.used - rollout)) }} />
          </div>
          <div className="storage-legend xs">
            <span><b className="dot" style={{ background: "linear-gradient(90deg, var(--video), var(--music))" }} />Rollout · {fmt(rollout)}</span>
            <span><b className="dot rest" />{t("Rest of your Drive")} · {fmt(Math.max(0, quota.used - rollout))}</span>
            {limit && <span><b className="dot free" />{t("Free")} · {fmt(Math.max(0, limit - quota.used))}</span>}
          </div>
          <div className="storage-list">
            <span className="label">{t("In the Rollout folder")}</span>
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
          {orphans.length > 0 && (
            <div className="notice warn xs row" style={{ justifyContent: "space-between", gap: "var(--s2)" }}>
              <span>{t("{n} video copies are no longer used by any video ({size}).", { n: orphans.length, size: fmt(orphanSize) })}</span>
              <button className="btn sm" disabled={cleaning} onClick={() => void clean()}>{cleaning ? t("Deleting…") : t("Delete them")}</button>
            </div>
          )}
          <p className="muted xs">{t("The copies of a video go with it. Your camera files stay where you put them.")}</p>
        </>
      )}
      <div className="modal-foot"><button className="btn primary" onClick={onClose}>{t("Done")}</button></div>
    </Modal>
  );
}
