"use client";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import type { Workspace } from "@/lib/types";
import { Modal } from "./ui";

interface Version { id: string; rev: number; savedAt: string; projects: number }

/**
 * Copies of the workspace kept by the server (one at most every 10 minutes, the last 30).
 * Restoring one goes through the normal save, and can be undone in this session.
 */
export default function VersionHistory({ onRestore, onClose }: { onRestore: (data: Workspace) => void; onClose: () => void }) {
  const { t, lang } = useT();
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ask, setAsk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/workspace/history")
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(); setVersions(j.versions); })
      .catch(() => setErr(t("The version history could not be loaded.")));
  }, [t]);

  const restore = async (id: string) => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/workspace/history?id=${encodeURIComponent(id)}`);
      const j = await r.json();
      if (!r.ok || j.data?.v !== 1 || !Array.isArray(j.data.projects)) throw new Error();
      onRestore(j.data as Workspace);
      onClose();
    } catch {
      setErr(t("This version could not be restored."));
    } finally {
      setBusy(false);
    }
  };

  const when = (iso: string) =>
    new Date(iso).toLocaleString(lang === "fr" ? "fr-FR" : "en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  return (
    <Modal title={t("Version history")} onClose={onClose}>
      <p className="muted xs">{t("A copy of your data is kept at most every 10 minutes while you work (the last 30). Restoring one replaces your current data; you can undo it right after.")}</p>
      {err && <p className="notice bad xs">{err}</p>}
      {!versions && !err && <p className="muted shine">{t("Loading…")}</p>}
      {versions && !versions.length && <p className="muted">{t("No version kept yet: they appear as you work.")}</p>}
      <div className="stack" style={{ maxHeight: "50dvh", overflow: "auto", gap: 4 }}>
        {versions?.map((v) => (
          <div key={v.id} className="item row nowrap">
            <span className="grow">
              <span>{when(v.savedAt)}</span>{" "}
              <span className="muted xs">{t("{n} projects", { n: v.projects })}</span>
            </span>
            {ask === v.id ? (
              <>
                <button className="btn sm primary" disabled={busy} onClick={() => void restore(v.id)}>{t("Replace my data")}</button>
                <button className="btn sm quiet" onClick={() => setAsk(null)}>{t("Cancel")}</button>
              </>
            ) : (
              <button className="btn sm" onClick={() => setAsk(v.id)}>{t("Restore")}</button>
            )}
          </div>
        ))}
      </div>
      <div className="modal-foot"><button className="btn" onClick={onClose}>{t("Close")}</button></div>
    </Modal>
  );
}
