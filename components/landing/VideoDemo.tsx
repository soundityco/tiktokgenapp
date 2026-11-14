"use client";
import { useEffect, useRef, useState } from "react";
import { defaultStyle } from "@/lib/defaults";
import { useT } from "@/lib/i18n";
import { drawStyledText } from "@/lib/render";
import { drawStage, PALETTES } from "./stagePhotos";

const LINES = {
  fr: { hook: "Écoute jusqu'au bout", lines: ["Je marche seul", "dans la nuit", "les lumières de la ville", "me suivent encore"] },
  en: { hook: "Listen till the end", lines: ["I walk alone", "through the night", "the city lights", "still follow me"] },
};
const STEP = 1.8; // seconds per line
const W = 540, H = 960;

/**
 * The home page's video: a take on stage (drawn in the browser), slowly pushed in, its hook at the top and its lyrics
 * line after line, as the video studio burns them; a player bar under it. It only runs while it is on screen (and
 * stands still for those who ask for less motion).
 */
export default function VideoDemo() {
  const { lang } = useT();
  const txt = LINES[lang === "fr" ? "fr" : "en"];
  const cv = useRef<HTMLCanvasElement>(null);
  const bg = useRef<HTMLCanvasElement | null>(null);
  const [time, setTime] = useState(0);
  const total = STEP * txt.lines.length;

  useEffect(() => {
    const b = document.createElement("canvas");
    b.width = W; b.height = H;
    drawStage(b, PALETTES[1], 42);
    bg.current = b;
  }, []);

  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const g = c.getContext("2d")!;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0, shown = false, start = performance.now(), last = 0;
    const frame = (now: number) => {
      const s = still ? STEP * 0.5 : ((now - start) / 1000) % total;
      const b = bg.current;
      if (b) {
        // Progressive zoom over the segment, around the centre.
        const k = 1 + 0.06 * (s / total);
        g.drawImage(b, (W - W * k) / 2, (H - H * k) / 2, W * k, H * k);
      }
      drawStyledText(g, txt.hook, { ...defaultStyle(), look: "box", y: 14, size: 30, color: "#111111", accent: "#ffffff" }, W, H);
      drawStyledText(g, txt.lines[Math.min(txt.lines.length - 1, Math.floor(s / STEP))], { ...defaultStyle(), y: 68, size: 40 }, W, H);
      last = s;
      setTime((v) => (Math.floor(v * 10) === Math.floor(s * 10) ? v : s)); // a tenth of a second is enough for the bar
      if (shown && !still) raf = requestAnimationFrame(frame);
    };
    const io = new IntersectionObserver(([e]) => {
      shown = e.isIntersecting;
      cancelAnimationFrame(raf);
      if (shown) { start = performance.now() - last * 1000; void document.fonts.ready.then(() => { raf = requestAnimationFrame(frame); }); }
    }, { threshold: 0.2 });
    io.observe(c);
    return () => { io.disconnect(); cancelAnimationFrame(raf); };
  }, [lang, txt, total]);

  const at = Math.floor(time);
  return (
    <div className="lp-video">
      <div className="lp-video-frame"><canvas ref={cv} width={W} height={H} aria-hidden /></div>
      <div className="lp-player" aria-hidden>
        <span className="lp-play"><svg width="12" height="12" viewBox="0 0 24 24"><path d="M7.5 4.6c0-1 1.1-1.6 2-1.1l10.3 6.4c.8.5.8 1.7 0 2.2L9.5 18.5c-.9.5-2-.1-2-1.1z" fill="currentColor" /></svg></span>
        <span className="lp-track"><i style={{ width: `${(time / total) * 100}%` }} /></span>
        <span className="mono">0:{String(at).padStart(2, "0")}</span>
      </div>
    </div>
  );
}
