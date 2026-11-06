"use client";
import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { useT } from "@/lib/i18n";
import { sendFiles, shareThroughDrive, type SendState } from "@/lib/shareP2P";
import Icon from "./Icon";
import { Modal } from "./ui";

/**
 * "Send to my phone": a QR code to scan with the phone; the files go straight from this browser to the phone's
 * over the local network (no upload). If the two cannot reach each other, the files can go through the Drive.
 */
export default function ShareDialog({ title, caption, kind, build, onClose }: {
  title: string;
  caption?: string;
  kind: "video" | "images";
  /** The files to send (made when the window opens: the pictures of a carousel, an exported video…). */
  build: () => Promise<{ name: string; blob: Blob }[]>;
  onClose: () => void;
}) {
  const { t } = useT();
  const [state, setState] = useState<SendState | { step: "building" } | { step: "error"; why: string }>({ step: "building" });
  const [qr, setQr] = useState<string | null>(null);
  const [drivePct, setDrivePct] = useState<number | null>(null);
  const [driveDone, setDriveDone] = useState(false);
  const files = useRef<{ name: string; blob: Blob }[]>([]);
  const ac = useRef(new AbortController());

  useEffect(() => {
    // A new controller each time (React may mount the window twice in development: the first one is stopped).
    const a = new AbortController();
    ac.current = a;
    void (async () => {
      try {
        files.current = await build();
        if (a.signal.aborted) return;
        if (!files.current.length) { setState({ step: "error", why: t("Nothing to send yet.") }); return; }
        await sendFiles(files.current, { kind, title, caption }, (s) => {
          setState(s);
          if (s.step === "waiting") void QRCode.toDataURL(s.url, { margin: 1, width: 480, color: { dark: "#0b0b10", light: "#f0eee8" } }).then(setQr);
        }, a.signal);
      } catch (e) {
        if (!a.signal.aborted) setState({ step: "error", why: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => a.abort();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const code = "code" in state ? state.code : undefined;
  const url = "url" in state ? state.url : undefined;
  const viaDrive = async () => {
    if (!code) return;
    setDrivePct(0);
    try { await shareThroughDrive(code, files.current, setDrivePct, ac.current.signal); setDriveDone(true); }
    catch (e) { setState({ step: "error", why: e instanceof Error ? e.message : String(e) }); }
    finally { setDrivePct(null); }
  };
  // No direct link: the files go through the Drive by themselves (the phone is waiting for them).
  const triedDrive = useRef(false);
  useEffect(() => {
    if (state.step !== "failed" || !code || triedDrive.current) return;
    triedDrive.current = true;
    void viaDrive();
  }, [state.step, code]); // eslint-disable-line react-hooks/exhaustive-deps
  const size = files.current.reduce((n, f) => n + f.blob.size, 0);
  const mb = size ? `${Math.max(1, Math.round(size / 1e6))} Mo` : "";
  const canNative = typeof navigator !== "undefined" && files.current.length > 0
    && !!navigator.canShare?.({ files: files.current.map((f) => new File([f.blob], f.name, { type: f.blob.type })) });

  return (
    <Modal title={t("Send to my phone")} onClose={() => { ac.current.abort(); onClose(); }}>
      <div className="stack share-send">
        {state.step === "building" || state.step === "opening" ? (
          <p className="shine">{state.step === "building" ? t("Preparing the files…") : t("Opening the link…")}</p>
        ) : state.step === "error" ? (
          <p className="notice bad xs">{t("The share could not start: {why}", { why: state.why })}</p>
        ) : state.step === "waiting" || state.step === "connecting" ? (
          <>
            <div className="share-qr">{qr ? <img src={qr} alt={t("QR code to scan with the phone")} /> : <div className="share-qr-skel shine-box" />}</div>
            {state.step === "waiting" && state.relay ? (
              <>
                <p>{t("Scan it with your phone's camera.")}</p>
                {state.relay.pct < 1
                  ? <><p className="muted xs shine">{t("Getting the files ready… {n}%", { n: Math.round(state.relay.pct * 100) })}</p><div className="bar export-bar shine-bar"><div style={{ width: `${state.relay.pct * 100}%` }} /></div></>
                  : <p className="muted xs"><Icon name="check" size={12} /> {t("Files ready, waiting for the phone.")}</p>}
                <p className="muted xs">{t("The files stay a few minutes on Rollout's side, deleted as soon as the phone has them. The link works 10 minutes, for one phone.")} {mb && `· ${files.current.length} ${t("files")} · ${mb}`}</p>
              </>
            ) : (
              <>
                <p className={state.step === "connecting" ? "shine" : undefined}>{state.step === "connecting" ? t("Phone found, connecting…") : t("Scan it with your phone's camera, on the same Wi-Fi.")}</p>
                <p className="muted xs">{t("The files go straight to the phone over your network, nothing is uploaded. The link works 10 minutes, for one phone.")} {mb && `· ${files.current.length} ${t("files")} · ${mb}`}</p>
              </>
            )}
          </>
        ) : state.step === "sending" ? (
          <>
            <p className="shine">{t("Sending to the phone… {n}%", { n: Math.round(state.pct * 100) })}</p>
            <div className="bar export-bar shine-bar"><div style={{ width: `${state.pct * 100}%` }} /></div>
          </>
        ) : state.step === "expired" ? (
          <p className="notice warn xs">{t("The link has expired. Close this window and open it again.")}</p>
        ) : state.step === "done" ? (
          <p><Icon name="check" size={14} /> {t("On the phone: save it there, and copy the caption.")}</p>
        ) : (
          <>
            <p className="muted xs">{t("No direct link between the computer and the phone (a Wi-Fi that keeps devices apart, or another network): the files go through your Drive instead.")}</p>
            {driveDone ? <p><Icon name="check" size={14} /> {t("Sent through your Drive: the phone shows the files now.")}</p>
              : drivePct !== null ? <><p className="shine">{t("Sending to your Drive… {n}%", { n: Math.round(drivePct * 100) })}</p><div className="bar export-bar shine-bar"><div style={{ width: `${drivePct * 100}%` }} /></div></>
              : code ? <div><button className="btn primary" onClick={() => void viaDrive()}>{t("Send through my Drive instead")}</button></div> : null}
          </>
        )}
        {url && state.step !== "done" && <p className="muted xs share-url">{url}</p>}
      </div>
      <div className="modal-foot">
        {canNative && <button className="btn left" onClick={() => void navigator.share({ files: files.current.map((f) => new File([f.blob], f.name, { type: f.blob.type })), title }).catch(() => {})}>{t("Other ways (AirDrop…)")}</button>}
        <button className="btn primary" onClick={() => { ac.current.abort(); onClose(); }}>{state.step === "done" || driveDone ? t("Done") : t("Close")}</button>
      </div>
    </Modal>
  );
}
