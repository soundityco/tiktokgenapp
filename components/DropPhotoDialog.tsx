"use client";
import { useEffect, useMemo, useState } from "react";
import { useT } from "@/lib/i18n";
import type { PicPool } from "@/lib/types";
import { Modal } from "./ui";

const LAST = "tktgen-drop-list";
/** "" = in no list; "new" = a new list. */
export type DropChoice = { list: string; newName?: string; /** The same picture already in the Drive: used as is. */ reuse?: string };

/** A picture dropped or pasted on a slide: which photo list of the Drive it also goes into, if any. */
export default function DropPhotoDialog({ blob, slide, pools, canDrive, busy, onConfirm, onClose, findSame }: {
  /** Looks for this exact picture in the Drive (lists and TkTgen folder). */
  findSame: () => Promise<string | null>;
  blob: Blob;
  slide: number;
  pools: PicPool[];
  /** The app may save files in the user's Drive (else: this device only, no list). */
  canDrive: boolean;
  busy: boolean;
  onConfirm: (c: DropChoice) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const url = useMemo(() => URL.createObjectURL(blob), [blob]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  const [list, setList] = useState(() => {
    try { const v = localStorage.getItem(LAST) ?? ""; return v === "new" || pools.some((p) => p.id === v) ? v : ""; } catch { return ""; }
  });
  const [newName, setNewName] = useState("Pinterest");
  // Already in the Drive? Then it is used from there, nothing is sent twice.
  const [same, setSame] = useState<string | null | undefined>(canDrive ? undefined : null);
  useEffect(() => {
    if (!canDrive) { setSame(null); return; }
    setSame(undefined); // checking: the photo is not sent again before we know
    let off = false;
    void findSame().then((id) => { if (!off) setSame(id); }).catch(() => { if (!off) setSame(null); });
    return () => { off = true; };
  }, [canDrive]); // eslint-disable-line react-hooks/exhaustive-deps
  const inPool = same ? pools.find((p) => p.pics.some((x) => x.id === same)) : undefined;
  useEffect(() => { if (inPool) setList(inPool.id); }, [inPool?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const ok = list !== "new" || !!newName.trim();
  const confirm = () => {
    if (!ok || busy) return;
    try { localStorage.setItem(LAST, list); } catch { /* private mode */ }
    // A list that already holds it: not added again.
    const target = canDrive && !(inPool && list === inPool.id) ? list : "";
    onConfirm({ list: target, newName: list === "new" ? newName.trim() : undefined, reuse: same ?? undefined });
  };
  return (
    <Modal title={t("Photo for slide {n}", { n: slide + 1 })} onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); confirm(); }}>
        <img src={url} alt="" className="drop-preview" />
        {same === undefined && <p className="muted xs"><span className="spin-dot" style={{ width: 10, height: 10, marginRight: 6 }} />{t("Checking whether you already have it…")}</p>}
        {same && (
          <p className="notice xs">{inPool
            ? t("You already have it, in the list “{name}”: it is picked from there, nothing is sent again.", { name: inPool.name })
            : t("You already have it in your Drive: it is picked from there, nothing is sent again.")}</p>
        )}
        {canDrive ? (
          <>
            <label className="field">{t("Also add it to a photo list of your Drive?")}
              <select className="input" value={list} onChange={(e) => setList(e.target.value)}>
                <option value="">{t("No, only this slide")}</option>
                {pools.map((p) => <option key={p.id} value={p.id}>{p.name} · {t("{n} photos", { n: p.pics.length })}</option>)}
                <option value="new">{t("New list…")}</option>
              </select>
            </label>
            {list === "new" && (
              <label className="field">{t("Name of the new list")}
                <input className="input" autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} />
              </label>
            )}
            <p className="muted xs">{t("The picture is saved in the TkTgen folder of your Drive: the slide shows it on every device, and a list can draw it again.")}</p>
          </>
        ) : (
          <p className="muted xs">{t("Reconnect Google to keep it in your Drive: for now it stays on this device only.")}</p>
        )}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn quiet" onClick={onClose}>{t("Cancel")}</button>
          <button type="submit" className="btn primary" disabled={!ok || busy || same === undefined}>
            {busy ? t("Saving…") : same ? t("Use the one I have") : t("Use this photo")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
