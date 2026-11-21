"use client";
import { useEffect, useState } from "react";
import { DESKTOP_DOWNLOADS, desktopApp } from "@/lib/desktop";

/**
 * The desktop app's downloads, under the sign-in (home): the computer's own first (Mac or Windows), the other one next to
 * it; nothing on a phone or inside the app itself. The file comes straight from the release (no page in between).
 */
export default function DesktopLinks({ labels }: { labels: { lead: string; mac: string; intel: string; windows: string } }) {
  const [os, setOs] = useState<"mac" | "win" | "other" | null>(null);
  useEffect(() => {
    if (desktopApp() || matchMedia("(hover: none)").matches) { setOs(null); return; }
    const ua = navigator.userAgent;
    setOs(/Macintosh|Mac OS X/.test(ua) ? "mac" : /Windows/.test(ua) ? "win" : "other");
  }, []);
  if (!os) return null;
  const mac = <a key="mac" href={DESKTOP_DOWNLOADS.macArm} download>{labels.mac}</a>;
  const intel = <a key="intel" className="lp-dl-minor" href={DESKTOP_DOWNLOADS.macIntel} download>{labels.intel}</a>;
  const win = <a key="win" href={DESKTOP_DOWNLOADS.windows} download>{labels.windows}</a>;
  const order = os === "win" ? [win, mac, intel] : [mac, intel, win];
  return (
    <p className="lp-dl mono">
      <span>{labels.lead}</span>
      {order.map((a, i) => <span key={i} className="lp-dl-item">{a}</span>)}
    </p>
  );
}
