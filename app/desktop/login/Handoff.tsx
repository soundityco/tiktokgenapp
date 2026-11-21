"use client";
import { useEffect, useState } from "react";

/** The session handed to the desktop app: a code asked for, then its link (rawaurare://auth) opened. */
export default function Handoff({ state, labels }: { state: string; labels: { wait: string; done: string; open: string; fail: string } }) {
  const [link, setLink] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let off = false;
    void fetch(`/api/desktop/code?state=${encodeURIComponent(state)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(({ code }) => {
        if (off) return;
        const to = `rawaurare://auth?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
        setLink(to);
        window.location.href = to;
      })
      .catch(() => { if (!off) setFailed(true); });
    return () => { off = true; };
  }, [state]);
  if (failed) return <p>{labels.fail}</p>;
  if (!link) return <p className="muted">{labels.wait}</p>;
  return (
    <>
      <p>{labels.done}</p>
      <a className="btn" href={link}>{labels.open}</a>
    </>
  );
}
