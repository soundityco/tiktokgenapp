"use client";

import { useEffect, useRef, useState } from "react";
import Icon from "@/components/Icon";

/** One pass of the scene (s): it loops. */
const T = 12;
/** The song's lines: when each starts and ends (s); its words lit in turn inside it. */
const LINES = [
  { a: 0.6, b: 3.4, text: "we were dancing in the dark" },
  { a: 3.6, b: 6.2, text: "every light was ours" },
  { a: 6.6, b: 9.2, text: "say my name again" },
  { a: 9.4, b: 11.6, text: "one more time" },
];
/** The multicam: which camera from when (camera 1 the base, 2 and 3 on it). */
const SHOTS = [{ at: 0, cam: 1 }, { at: 4, cam: 2 }, { at: 7.6, cam: 3 }, { at: 10.2, cam: 1 }];
const HOOK = { a: 0, b: 3.2 };

/** The song's sound, made up (the same every time): its lowest and highest point per column, louder on the beat. */
function envelope(n: number): { lo: number[]; hi: number[] } {
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const lo: number[] = [], hi: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = i / n, beat = Math.pow(Math.abs(Math.sin(x * Math.PI * 26)), 4), drop = x > 0.3 ? 1 : 0.55;
    const v = Math.min(1, (0.16 + 0.6 * beat + 0.28 * rnd()) * drop);
    hi.push(v * (0.85 + 0.15 * rnd())); lo.push(-v * (0.85 + 0.15 * rnd()));
  }
  return { lo, hi };
}
const ENV = envelope(900);
const FILM = "M4 5h16v14H4zM8 5v14M16 5v14M4 9h4M4 15h4M16 9h4M16 15h4";

/**
 * The video studio, playing (the home page's product shot), drawn with the app's own timeline: the same markup and
 * classes as VideoStudio (tl-stack, lyric-track, cue, video-clip, tl-head) and the same waveform drawing as its
 * paintWave (filled, the playhead's glow, the video's band with its number), so it is the app's to the pixel. Left,
 * the 9:16 preview: the lyrics as a phrase, its words lighting in turn, the camera changing with the cuts. Runs only
 * while on screen; with reduced motion, a still.
 */
export default function StudioScene({ labels }: { labels: { video: string; hookText: string; synced: string; placed: string; takes: string[] } }) {
  const box = useRef<HTMLDivElement>(null);
  const wave = useRef<HTMLCanvasElement>(null);
  const head = useRef<HTMLSpanElement>(null);
  const [now, setNow] = useState({ line: 0, word: 2, shot: 0, hook: true, x: 0 });
  const seen = useRef("");
  useEffect(() => {
    const el = box.current, c = wave.current;
    if (!el || !c) return;
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue("--accent").trim(), white = css.getPropertyValue("--accent-hi").trim();
    const film = new Path2D(FILM);
    const draw = (t: number) => {
      const W = c.clientWidth, H = c.clientHeight, dpr = window.devicePixelRatio || 1;
      if (!W) return;
      if (c.width !== Math.round(W * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
      const g = c.getContext("2d")!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = "#16161c"; g.fillRect(0, 0, W, H);
      // the video's band (camera 1, the one set) and its number, the segment's faint ground (here the whole view)
      g.fillStyle = accent; g.globalAlpha = 0.14; g.fillRect(0, 0, W, H); g.globalAlpha = 1; g.fillRect(0, 0, W, 15);
      g.fillStyle = g.strokeStyle = "#0c0c0e";
      g.save(); g.translate(5, 2.5); g.scale(10 / 24, 10 / 24); g.lineWidth = 2.4; g.lineJoin = "round"; g.stroke(film); g.restore();
      g.font = "600 10px ui-monospace, 'JetBrains Mono', monospace"; g.textBaseline = "middle";
      g.fillText(`${labels.video.toLocaleUpperCase()} 1`, 19, 8);
      g.fillStyle = accent; g.globalAlpha = 0.09; g.fillRect(0, 15, W, H - 15); g.globalAlpha = 1;
      // the filled waveform (one shape), white around the playhead
      const top = 17, room = H - top - 6, mid = top + room / 2, half = room / 2, n = ENV.hi.length;
      g.beginPath();
      for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * W, y = mid - Math.max(0.5, ENV.hi[i] * half); if (i) g.lineTo(x, y); else g.moveTo(x, y); }
      for (let i = n - 1; i >= 0; i--) g.lineTo((i / (n - 1)) * W, mid + Math.max(0.5, -ENV.lo[i] * half));
      g.closePath(); g.fillStyle = "#6f6e78"; g.fill();
      const hx = (t / T) * W, glow = g.createLinearGradient(hx - 70, 0, hx + 70, 0);
      glow.addColorStop(0, "rgba(255,255,255,0)"); glow.addColorStop(0.5, white); glow.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = glow; g.fill();
    };
    const paint = (t: number) => {
      draw(t);
      if (head.current) {
        head.current.style.left = `calc(6px + (100% - 12px) * ${t / T})`;
        const name = el.querySelector<HTMLElement>(".video-clip.on .truncate");
        if (name) name.style.setProperty("--hx", `${head.current.getBoundingClientRect().left - name.getBoundingClientRect().left}px`);
      }
      const li = LINES.findIndex((l) => t >= l.a && t < l.b), l = LINES[li];
      const word = l ? Math.min(l.text.split(" ").length - 1, Math.floor(((t - l.a) / (l.b - l.a)) * l.text.split(" ").length)) : -1;
      const shot = SHOTS.reduce((k, s, i) => (t >= s.at ? i : k), 0), hook = t >= HOOK.a && t < HOOK.b;
      const key = `${li}|${word}|${shot}|${hook}|${Math.round(t * 12)}`;
      if (key !== seen.current) { seen.current = key; setNow({ line: li, word, shot, hook, x: t }); }
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { paint(1.9); return; }
    let raf = 0, t0 = performance.now(), on = false, at = 0;
    const tick = (ms: number) => { at = ((ms - t0) / 1000) % T; paint(at); raf = requestAnimationFrame(tick); };
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !on) { on = true; t0 = performance.now() - at * 1000; raf = requestAnimationFrame(tick); }
      else if (!e.isIntersecting && on) { on = false; cancelAnimationFrame(raf); }
    });
    io.observe(el);
    paint(0);
    return () => { io.disconnect(); cancelAnimationFrame(raf); };
  }, [labels.video]);

  const pct = (s: number) => `${(s / T) * 100}%`;
  const clip = (a: number, b: number) => ({ left: pct(a), width: pct(b - a) });
  const hx = (a: number, b: number) => `${Math.min(1, Math.max(0, (now.x - a) / (b - a))) * 100}%`;
  const line = LINES[now.line], cam = SHOTS[now.shot].cam;
  return (
    <div className="lp-scene" ref={box} aria-hidden>
      <div className={`lp-scene-preview cam-${cam}`}>
        <span className="lp-post-ground"><i /><i /><i /></span>
        <span className="lp-post-grain" />
        {now.hook && <span className="lp-scene-hook">{labels.hookText}</span>}
        {line && (
          <span className="lp-scene-lyric" key={now.line}>
            {line.text.split(" ").map((w, k) => <span key={k} className={k <= now.word ? "lit" : ""}>{w} </span>)}
          </span>
        )}
        <span className="lp-scene-cam mono">CAM {cam}</span>
      </div>
      <div className="lp-scene-side">
        <div className="lp-scene-status"><span className="lp-scene-chip">✓ {labels.synced}</span><span className="lp-scene-chip gold">✓ {labels.placed}</span></div>
        {/* The app's timeline, with its own classes. */}
        <div className="tl-stack lp-tl">
          <div className="wave-wrap"><canvas ref={wave} className="wave" /></div>
          {/* As VideoStudio draws them: text clips are buttons (their content centred), the playing one lit (.on: its
              text glowing under the playhead, --hx) with its bar on its left (.cue-bar-glow); a video clip's name glows. */}
          <div className="lyric-track hook-track"><div className="track-content">
            <button tabIndex={-1} className={"cue" + (now.hook ? " on" : "")} data-text={labels.hookText} style={{ ...clip(HOOK.a, HOOK.b), ...(now.hook ? { ["--hx" as string]: hx(HOOK.a, HOOK.b) } : null) }}>
              <span className="cue-ico"><Icon name="sparkle" size={11} /></span>{labels.hookText}
            </button>
            {now.hook && <span className="cue-bar-glow" style={{ left: pct(HOOK.a) }} />}
          </div></div>
          <div className="lyric-track lyrics-track"><div className="track-content">
            {LINES.map((l, i) => (
              <button key={i} tabIndex={-1} className={"cue" + (i === now.line ? " on" : "")} data-text={l.text} style={{ ...clip(l.a, l.b), ...(i === now.line ? { ["--hx" as string]: hx(l.a, l.b) } : null) }}>
                <span className="cue-ico"><Icon name="type" size={11} /></span>{l.text}
              </button>
            ))}
            {line && <span className="cue-bar-glow" style={{ left: pct(line.a) }} />}
          </div></div>
          <div className="video-block">
            {[3, 2, 1].map((k) => (
              <div key={k} className="lyric-track video-track"><div className="track-content">
                {SHOTS.map((s, i) => s.cam === k && (
                  <div key={i} className={`cue video-clip cam-${k - 1}` + (i === now.shot ? " on" : "")} style={clip(s.at, SHOTS[i + 1]?.at ?? T)}>
                    <span className="vc-name"><span className="cue-ico"><Icon name="film" size={11} /></span><b className="vc-no">{k}</b>
                      <span className="truncate" data-text={labels.takes[k - 1]}>{labels.takes[k - 1]}</span></span>
                  </div>
                ))}
                {SHOTS[now.shot].cam === k && <span className={`cue-bar-glow cam-glow cam-${k - 1}`} style={{ left: pct(SHOTS[now.shot].at) }} />}
              </div></div>
            ))}
          </div>
          <span className="tl-head" ref={head} />
        </div>
      </div>
    </div>
  );
}
