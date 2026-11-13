"use client";
import "./globals.css";
import { useEffect, useState } from "react";
import { errorText, reloadIfStale } from "@/lib/appError";

/**
 * The last resort, when even the app's frame failed: the same page as `error.tsx`, without the translations (the
 * browser's language decides).
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  const [reloading, setReloading] = useState(false);
  useEffect(() => { console.error(error); setReloading(reloadIfStale(error)); }, [error]);
  const fr = typeof navigator !== "undefined" && navigator.language?.startsWith("fr");
  return (
    <html lang={fr ? "fr" : "en"}>
      <body>
        {!reloading && (
          <main className="share-page">
            <div className="share-card stack">
              <h1 className="display">{fr ? "Un problème est survenu" : "Something went wrong"}</h1>
              <p className="muted">{fr ? "La page s'est arrêtée à cause d'une erreur. Recharge-la pour continuer." : "The page stopped because of an error. Reload it to go on."}</p>
              <pre className="notice bad xs error-text">{errorText(error)}</pre>
              <div className="row"><button className="btn primary" onClick={() => location.reload()}>{fr ? "Recharger" : "Reload"}</button></div>
            </div>
          </main>
        )}
      </body>
    </html>
  );
}
