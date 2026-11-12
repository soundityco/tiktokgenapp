"use client";
import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { useT } from "@/lib/i18n";
import { sendFiles, shareThroughDrive, type SendState } from "@/lib/shareP2P";
import Icon from "./Icon";
import { Modal } from "./ui";

/** A phone or a tablet (a finger, no mouse): "send to my phone" makes no sense there, the phone's own share sheet does. */
export function useHandheld(): boolean {
  const [h, setH] = useState(false);
  useEffect(() => {
    const mq = matchMedia("(hover: none) and (pointer: coarse)");
    const f = () => setH(mq.matches);
    f();
    mq.addEventListener("change", f);
    return () => mq.removeEventListener("change", f);
  }, []);
  return h;
}

/**
 * "Send to my phone": a QR code to scan with the phone; the files go straight from this browser to the phone's
 * over the local network (no upload). If the two cannot reach each other, the files can go through the Drive.
 */
export default function ShareDialog({ title, caption, kind, build, onClose, place, bare }: {
  title: string;
  /** Its folder in the Drive when it goes that way: Rollout / Exports / <release> / <what · date>. */
  place?: { release: string; what: string };
  caption?: string;
  kind: "video" | "images";
  /** The files to send (made when the window opens: the pictures of a carousel, an exported video…). */
  build: () => Promise<{ name: string; blob: Blob }[]>;
  onClose: () => void;
  /** Inside another window (the export's): only its content and its buttons, the last one going back. */
  bare?: boolean;
}) {
  const { t } = useT();
  const [state, setState] = useState<SendState | { step: "building" } | { step: "error"; why: string }>({ step: "building" });
  const [qr, setQr] = useState<string | null>(null);
  const [drivePct, setDrivePct] = useState<number | null>(null);
  const [driveDone, setDriveDone] = useState(false);
  const files = useRef<{ name: string; blob: Blob }[]>([]);
  const ac = useRef(new AbortController());

  const handheld = useHandheld();
  /** On a phone: the phone's share sheet first (gallery, TikTok, a friend…); the QR code for another device after. */
  const [native, setNative] = useState<"choose" | "shared" | null>(null);
  const send = async (a: AbortController) => {
    try {
      await sendFiles(files.current, { kind, title, caption }, (s) => {
        setState(s);
        if (s.step === "waiting") void QRCode.toDataURL(s.url, { margin: 1, width: 480, color: { dark: "#0b0b10", light: "#f0eee8" } }).then(setQr);
      }, a.signal);
    } catch (e) {
      if (!a.signal.aborted) setState({ step: "error", why: e instanceof Error ? e.message : String(e) });
    }
  };
  useEffect(() => {
    // A new controller each time (React may mount the window twice in development: the first one is stopped).
    const a = new AbortController();
    ac.current = a;
    void (async () => {
      try {
        files.current = await build();
        if (a.signal.aborted) return;
        if (!files.current.length) { setState({ step: "error", why: t("Nothing to send yet.") }); return; }
        const sheet = matchMedia("(hover: none) and (pointer: coarse)").matches
          && !!navigator.canShare?.({ files: files.current.map((f) => new File([f.blob], f.name, { type: f.blob.type })) });
        if (sheet) { setNative("choose"); setState({ step: "opening" }); return; }
        await send(a);
      } catch (e) {
        if (!a.signal.aborted) setState({ step: "error", why: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => a.abort();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  /** The phone's share sheet (the caption copied first: TikTok does not take it from there). */
  const shareNative = async () => {
    if (caption) await navigator.clipboard?.writeText(caption).catch(() => {});
    try {
      await navigator.share({ files: files.current.map((f) => new File([f.blob], f.name, { type: f.blob.type })), title });
      setNative("shared");
    } catch { /* closed without choosing */ }
  };
  const toOtherDevice = () => { setNative(null); void send(ac.current); };

  const code = "code" in state ? state.code : undefined;
  const url = "url" in state ? state.url : undefined;
  const viaDrive = async () => {
    if (!code) return;
    setDrivePct(0);
    try { await shareThroughDrive(code, files.current, setDrivePct, ac.current.signal, place); setDriveDone(true); }
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

  const body = (
    <>
      <div className="stack share-send">
        {native ? (
          native === "shared"
            ? <p><Icon name="check" size={14} /> {t("Shared.")}{caption ? ` ${t("The caption is copied: paste it in TikTok.")}` : ""}</p>
            : <>
                <p>{t("Save it in your gallery, open it in TikTok or send it to a friend.")}</p>
                {caption && <p className="muted xs">{t("The caption is copied when you share: paste it in TikTok.")}</p>}
                <p className="muted xs">{files.current.length > 1 ? `${files.current.length} ${t("files")}${mb && ` · ${mb}`}` : mb}</p>
              </>
        ) : state.step === "building" || state.step === "opening" ? (
          <p className="shine">{state.step === "building" ? t("Preparing the files…") : t("Opening the link…")}</p>
        ) : state.step === "error" ? (
          <p className="notice bad xs">{t("The share could not start: {why}", { why: state.why })}</p>
        ) : state.step === "waiting" || state.step === "connecting" ? (
          <>
            <div className="share-qr">{qr ? <img src={qr} alt={t("QR code to scan with the phone")} /> : <div className="share-qr-skel shine-box" />}</div>
            {state.step === "waiting" && state.relay ? (
              <>
                <p>{handheld ? t("Scan it with the other device's camera.") : t("Scan it with your phone's camera.")}</p>
                {state.relay.pct < 1
                  ? <><p className="muted xs shine">{t("Getting the files ready… {n}% · you can scan now: the phone takes them as they come.", { n: Math.round(state.relay.pct * 100) })}</p><div className="bar export-bar shine-bar"><div style={{ width: `${state.relay.pct * 100}%` }} /></div></>
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
        {native === "choose" ? (<>
          <button className="btn left" onClick={toOtherDevice}><Icon name="share" size={14} />{t("Another device (QR code)")}</button>
          <button className="btn quiet" onClick={() => { ac.current.abort(); onClose(); }}>{bare ? t("Back") : t("Close")}</button>
          <button className="btn primary" onClick={() => void shareNative()}><Icon name="share" size={14} />{t("Share…")}</button>
        </>) : (<>
        {/* A computer that can share files: its own sheet (AirDrop only named on Apple). A phone has Share instead. */}
        {canNative && !native && !handheld && <button className="btn left" onClick={() => void navigator.share({ files: files.current.map((f) => new File([f.blob], f.name, { type: f.blob.type })), title }).catch(() => {})}>
          {/Mac|iPhone|iPad/.test(navigator.userAgent) ? t("Other ways (AirDrop…)") : t("Other ways…")}</button>}
        <button className="btn primary" onClick={() => { ac.current.abort(); onClose(); }}>{bare ? t("Back") : state.step === "done" || driveDone || native === "shared" ? t("Done") : t("Close")}</button>
        </>)}
      </div>
    </>
  );
  if (bare) return body;
  return <Modal title={native ? t("Share") : handheld ? t("Send to another device") : t("Send to my phone")} onClose={() => { ac.current.abort(); onClose(); }}>{body}</Modal>;
}
