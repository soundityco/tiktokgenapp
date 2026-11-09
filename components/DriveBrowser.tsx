"use client";
import { useEffect, useRef, useState } from "react";
import type { DriveItem } from "@/lib/drive";
import { useT } from "@/lib/i18n";
import { pickDriveFiles } from "@/lib/picker";
import type { PicRef } from "@/lib/types";
import { Modal } from "./ui";

/**
 * Files from Google Drive, chosen in Google's own picker (the app then reads only those files, with `drive.file`:
 * no permission to read the whole Drive). Photos mode (carousel lists): several photos at once, for this list or
 * every list of the slides. Audio mode (`onPick`): one audio file (the official audio of a release), the picker
 * opens at once.
 */
export default function DriveBrowser({ onAdd, onPick, onClose }: {
  onAdd?: (pics: PicRef[], toAll: boolean) => void;
  onPick?: (file: DriveItem) => void;
  onClose: () => void;
}) {
  const audio = !!onPick;
  const { t, lang } = useT();
  const [toAll, setToAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const open = async () => {
    setBusy(true); setErr(null);
    try {
      const files = await pickDriveFiles({
        kind: audio ? "audio" : "images", multi: !audio, lang,
        title: audio ? t("Official audio from Google Drive") : t("Add photos from Google Drive"),
      });
      if (!files.length) { if (audio) onClose(); return; }
      if (audio) onPick!(files[0]);
      else onAdd?.(files.map((f) => ({ id: f.id, name: f.name })), toAll);
      onClose();
    } catch (e) {
      console.warn("[picker]", e);
      setErr(t("Google Drive could not open. Check your connection and try again."));
    } finally {
      setBusy(false);
    }
  };
  // The audio has nothing to set first: straight to the picker.
  const started = useRef(false);
  useEffect(() => { if (audio && !started.current) { started.current = true; void open(); } }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Modal title={audio ? t("Official audio from Google Drive") : t("Add photos from Google Drive")} onClose={onClose}>
      {err && <p className="notice bad">{err}</p>}
      {audio ? (
        <p className="muted xs">{t("The audio stays in your Drive: the app keeps a copy on this device and gets it back from Drive on another computer.")}</p>
      ) : (
        <>
          <p className="muted">{t("Google Drive opens: choose your photos there (several at once with Shift or Ctrl / Cmd, or a long press on a phone).")}</p>
          <label className="check"><input type="checkbox" checked={toAll} onChange={(e) => setToAll(e.target.checked)} />{t("Also copy them into the photo lists of the other slides")}</label>
        </>
      )}
      <div className="modal-foot">
        <button className="btn quiet" onClick={onClose}>{t("Close")}</button>
        <button className={"btn primary" + (busy ? " shine-box" : "")} disabled={busy} onClick={() => void open()}>
          {audio ? t("Open Google Drive") : t("Choose in Google Drive")}
        </button>
      </div>
    </Modal>
  );
}
