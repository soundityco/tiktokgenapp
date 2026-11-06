"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { useT } from "@/lib/i18n";
import { receiveFiles, type ReceiveState } from "@/lib/shareP2P";
import Wordmark from "@/components/Wordmark";
import Icon from "@/components/Icon";

/**
 * The phone's page, opened by the QR code shown on the computer (no sign-in): the files arrive straight from the
 * computer, then go to the phone's gallery (share sheet) and the caption to the clipboard.
 */
export default function SharePage() {
  const { t } = useT();
  const { code } = useParams<{ code: string }>();
  const [s, setS] = useState<ReceiveState>({ step: "opening" });
  const [copied, setCopied] = useState(false);
  // Once per link: a share takes one answer (React may run this twice in development).
  const started = useRef<string | null>(null);
  useEffect(() => {
    if (started.current === code) return;
    started.current = code;
    void receiveFiles(code, setS).catch(() => setS({ step: "expired" }));
  }, [code]);

  const meta = "meta" in s ? s.meta : null;
  const files = s.step === "done" ? s.files : [];
  const urls = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);
  const canShare = files.length > 0 && typeof navigator !== "undefined" && !!navigator.canShare?.({ files });
  const save = () => void navigator.share({ files }).catch(() => {});
  const copy = async () => { if (!meta?.caption) return; try { await navigator.clipboard.writeText(meta.caption); setCopied(true); } catch { /* not allowed */ } };
  const mb = meta ? Math.max(1, Math.round(meta.files.reduce((n, f) => n + f.size, 0) / 1e6)) : 0;

  return (
    <main className="share-page">
      <div className="share-card stack">
        <Wordmark height={18} />
        {s.step === "expired" ? (
          <p className="notice warn">{t("This link has expired or was already used. Show a new QR code on the computer.")}</p>
        ) : s.step === "opening" ? (
          <p className="shine">{t("Opening…")}</p>
        ) : (
          <>
            <h1 className="display">{meta?.title}</h1>
            <p className="muted xs">{meta?.kind === "video" ? t("Video") : t("{n} pictures", { n: meta?.files.length ?? 0 })} · {mb} Mo</p>
            {s.step === "connecting" && <p className="shine">{t("Connecting to the computer…")}</p>}
            {s.step === "waiting-drive" && <p className="notice warn xs">{t("No direct link with the computer (another network?). On the computer, choose “Send through my Drive”: the download will show here.")}</p>}
            {s.step === "receiving" && (
              <>
                <p className="shine">{t("Receiving… {n}%", { n: Math.round(s.pct * 100) })}</p>
                <div className="bar export-bar shine-bar"><div style={{ width: `${s.pct * 100}%` }} /></div>
                <p className="muted xs">{t("Keep this page open.")}</p>
              </>
            )}
            {s.step === "done" && (
              <>
                {meta?.kind === "video" && urls[0] && <video className="share-preview" src={urls[0]} controls playsInline muted />}
                {meta?.kind === "images" && <div className="share-thumbs">{urls.map((u, i) => <img key={i} src={u} alt="" />)}</div>}
                {canShare
                  ? <button className="btn primary big" onClick={save}><Icon name="download" />{meta?.kind === "video" ? t("Save the video") : t("Save the pictures")}</button>
                  : <div className="stack">{files.map((f, i) => <a key={i} className="btn" href={urls[i]} download={f.name}><Icon name="download" />{f.name}</a>)}</div>}
              </>
            )}
            {s.step === "drive" && meta?.drive && (
              <div className="stack">
                <p className="muted xs">{t("Sent through the Drive: open each file, then save it.")}</p>
                {meta.drive.map((d) => (
                  <a key={d.id} className="btn primary big" href={`https://drive.google.com/file/d/${d.id}/view`} target="_blank" rel="noreferrer"><Icon name="download" />{d.name}</a>
                ))}
              </div>
            )}
            {meta?.caption && (
              <div className="share-caption stack">
                <span className="label">{t("Caption and hashtags")}</span>
                <p>{meta.caption}</p>
                <button className="btn big" onClick={() => void copy()}><Icon name={copied ? "check" : "copy"} />{copied ? t("Copied: paste it in TikTok") : t("Copy the caption")}</button>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
