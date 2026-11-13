"use client";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { errorText, reloadIfStale } from "@/lib/appError";

/** A page stopped by an error: said plainly, its message shown (to copy and report), a way back. */
export default function AppError({ error }: { error: Error & { digest?: string } }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const [reloading, setReloading] = useState(false);
  useEffect(() => {
    console.error(error);
    setReloading(reloadIfStale(error));
  }, [error]);
  const text = errorText(error);
  if (reloading) return null;
  return (
    <main className="share-page">
      <div className="share-card stack">
        <h1 className="display">{t("Something went wrong")}</h1>
        <p className="muted">{t("The page stopped because of an error. Reload it to go on.")}</p>
        <pre className="notice bad xs error-text">{text}</pre>
        <div className="row">
          <button className="btn primary" onClick={() => location.reload()}>{t("Reload")}</button>
          <button className="btn" onClick={() => { void navigator.clipboard?.writeText(text).then(() => setCopied(true)).catch(() => {}); }}>{copied ? t("Copied") : t("Copy the error")}</button>
        </div>
      </div>
    </main>
  );
}
