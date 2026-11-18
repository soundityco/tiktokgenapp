"use client";

import { useEffect, useRef, useState } from "react";

/** One pass of the scene (s): it loops. */
const T = 12;
/** The song's lines in the scene: when each starts and ends (s), its words even inside it. */
const LINES = [
  { a: 0.6, b: 3.4, text: "we were dancing in the dark" },
  { a: 3.6, b: 6.2, text: "every light was ours" },
  { a: 6.6, b: 9.2, text: "say my name again" },
  { a: 9.4, b: 11.6, text: "one more time" },
];
/** The cameras' shots (the multicam): which plays from when. */
const SHOTS = [{ at: 0, cam: 1 }, { at: 4, cam: 2 }, { at: 7.6, cam: 3 }, { at: 10.2, cam: 1 }];
const HOOK = { a: 0, b: 3.2 };

/** A filled waveform (as the app draws it, Ableton-like): the same every time (a fixed seed), louder in the chorus. */
function wavePath(w: number, h: number): string {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const n = 220, mid = h / 2, top: string[] = [], bottom: string[] = [];
  for (let i = 0; i <= n; i++) {
    const x = (i / n) * w, beat = Math.pow(Math.abs(Math.sin((i / n) * Math.PI * 24)), 3);
    const swell = 0.35 + 0.65 * Math.min(1, Math.max(0, (i / n - 0.45) * 3)) * 0.6 + 0.25;
    const v = Math.min(1, (0.18 + 0.55 * beat + 0.27 * rnd()) * swell);
    top.push(`${x.toFixed(1)},${(mid - v * mid * 0.92).toFixed(1)}`);
    bottom.unshift(`${x.toFixed(1)},${(mid + v * mid * 0.92 * (0.85 + 0.15 * rnd())).toFixed(1)}`);
  }
  return `M${top.join("L")}L${bottom.join("L")}Z`;
}

/**
 * The video studio, drawn and playing (the home page's product shot): the 9:16 preview with the lyrics lighting word
 * by word and the camera changing, the waveform, the hook, the lyrics and three cameras on the timeline, one playhead.
 * Runs only while on screen (and not at all with reduced motion: a still at a chosen moment).
 */
export default function StudioScene({ labels }: { labels: { hook: string; lyrics: string; cam: string; hookText: string; synced: string; placed: string } }) {
  const box = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState({ line: 0, word: 2, cam: 1, shot: 0, hook: true });
  const seen = useRef("");
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0, t0 = performance.now(), on = false;
    const paint = (t: number) => {
      el.style.setProperty("--p", String(t / T));
      const li = LINES.findIndex((l) => t >= l.a && t < l.b);
      const l = LINES[li];
      const word = l ? Math.min(l.text.split(" ").length - 1, Math.floor(((t - l.a) / (l.b - l.a)) * l.text.split(" ").length)) : -1;
      const shot = SHOTS.reduce((k, s, i) => (t >= s.at ? i : k), 0), cam = SHOTS[shot].cam;
      const hook = t >= HOOK.a && t < HOOK.b;
      const key = `${li}|${word}|${shot}|${hook}`;
      if (key !== seen.current) { seen.current = key; setNow({ line: li, word, cam, shot, hook }); }
    };
    if (still) { paint(1.9); return; }
    const tick = (ms: number) => { paint(((ms - t0) / 1000) % T); raf = requestAnimationFrame(tick); };
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !on) { on = true; t0 = performance.now() - (Number(el.style.getPropertyValue("--p") || 0) * T * 1000); raf = requestAnimationFrame(tick); }
      else if (!e.isIntersecting && on) { on = false; cancelAnimationFrame(raf); }
    });
    io.observe(el);
    return () => { io.disconnect(); cancelAnimationFrame(raf); };
  }, []);
  const pct = (s: number) => `${(s / T) * 100}%`;
  const line = LINES[now.line];
  return (
    <div className="lp-scene" ref={box} aria-hidden>
      <div className="lp-scene-bar"><i /><i /><i /><span className="mono">RAW · {labels.cam} {now.cam}</span></div>
      <div className="lp-scene-body">
        <div className={`lp-scene-preview cam-${now.cam}`}>
          <span className="lp-post-ground"><i /><i /><i /></span>
          <span className="lp-post-grain" />
          {now.hook && <span className="lp-scene-hook">{labels.hookText}</span>}
          {line && (
            <span className="lp-scene-lyric" key={now.line}>
              {line.text.split(" ").map((w, k) => <span key={k} className={k <= now.word ? "lit" : ""}>{w} </span>)}
            </span>
          )}
          <span className="lp-scene-cam mono">CAM {now.cam}</span>
        </div>
        <div className="lp-scene-tl">
          <div className="lp-scene-status"><span className="lp-scene-chip">✓ {labels.synced}</span><span className="lp-scene-chip gold">✓ {labels.placed}</span></div>
          <svg className="lp-scene-wave" viewBox="0 0 600 70" preserveAspectRatio="none"><path d={wavePath(600, 70)} /></svg>
          <div className="lp-scene-row hook">
            <span className="lp-scene-clip" style={{ left: pct(HOOK.a), width: pct(HOOK.b - HOOK.a) }}>✦ {labels.hookText}</span>
          </div>
          <div className="lp-scene-row lyrics">
            {LINES.map((l, i) => (
              <span key={i} className={"lp-scene-clip" + (i === now.line ? " on" : "")} style={{ left: pct(l.a), width: pct(l.b - l.a) }}>T {l.text}</span>
            ))}
          </div>
          {[3, 2, 1].map((cam) => (
            <div key={cam} className={`lp-scene-row video cam-${cam}`}>
              {SHOTS.map((s, i) => s.cam === cam && (
                <span key={i} className={"lp-scene-clip" + (i === now.shot ? " on" : "")}
                  style={{ left: pct(s.at), width: pct((SHOTS[i + 1]?.at ?? T) - s.at) }}>▣ {labels.cam} {cam}</span>
              ))}
            </div>
          ))}
          <span className="lp-scene-head" />
        </div>
      </div>
    </div>
  );
}
