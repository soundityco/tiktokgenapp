"use client";
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Icon from "./Icon";
import { useT } from "@/lib/i18n";

/** One movement for every glide (the picture and what fades with it go together). */
const EASE = "cubic-bezier(.2,.8,.2,1)";
const OPEN_MS = 300;
const CLOSE_MS = 280;

/**
 * A picture of the page full screen, the same in both studios (the video's preview, a carousel slide): a blurred
 * dark, the picture with its cross at its top right, a bar under it. The picture glides from its place in the page
 * to the middle and back to it when it closes (the cross, Escape, a tap beside, or dragged down far enough), the dark,
 * the bar and the cross fading with it. Dragged down it follows and shrinks; dragged sideways (`onSide`, the
 * carousel) the next or previous one comes in. A tap on it: `onTap`.
 * The picture is the page's own canvas copied as it is drawn (the video playing, scrubbing…), or drawn by `draw`.
 */
export function FullView({ source, draw, onClose, onTap, onSide, sideOk, closeOnSpace, player, label, bar, children }: {
  /** The page's canvas: where the picture glides from and back to (and what is copied when there is no `draw`). */
  source: () => HTMLCanvasElement | null;
  /** Draws the picture itself (a slide at its full size); called again when it changes. */
  draw?: (c: HTMLCanvasElement) => void;
  onClose: () => void;
  onTap?: () => void;
  /** Sideways: 1 the next one, -1 the previous one. */
  onSide?: (dir: 1 | -1) => void;
  /** Whether there is one that way (else the picture resists). */
  sideOk?: (dir: 1 | -1) => boolean;
  /** Space closes it too (the carousel: Space opened it). */
  closeOnSpace?: boolean;
  /** A player stays under the picture (the video's): room is kept for it. */
  player?: boolean;
  /** What the window is (for screen readers). */
  label: string;
  /** Under the picture: the video's name, the slide's number and arrows… */
  bar?: ReactNode;
  /** Over everything (a player…). */
  children?: ReactNode;
}) {
  const { t } = useT();
  const big = useRef<HTMLCanvasElement>(null);
  const bg = useRef<HTMLDivElement>(null);
  const barEl = useRef<HTMLDivElement>(null);
  const xBtn = useRef<HTMLButtonElement>(null);
  /** The blurred dark, the bar and the cross: they fade while the picture glides. */
  const fades = () => [bg.current, barEl.current, xBtn.current].filter((x): x is HTMLDivElement | HTMLButtonElement => !!x);
  const closing = useRef(false);
  const drag = useRef<{ x: number; y: number; dx: number; dy: number; axis: "x" | "y" | null } | null>(null);
  const props = useRef({ onSide, sideOk, onClose, draw });
  props.current = { onSide, sideOk, onClose, draw };
  const can = (dir: 1 | -1) => !!props.current.onSide && (props.current.sideOk?.(dir) ?? true);

  /** The transform (origin top left) that puts the picture over `to` (page pixels). */
  const over = (to: DOMRect) => {
    const c = big.current!;
    const prev = c.style.transform;
    c.style.transform = "none";
    const base = c.getBoundingClientRect();
    c.style.transform = prev;
    return `translate(${to.left - base.left}px, ${to.top - base.top}px) scale(${to.width / Math.max(1, base.width)})`;
  };
  const close = () => {
    if (closing.current) return;
    closing.current = true;
    const c = big.current, small = source();
    if (!c || !small) { props.current.onClose(); return; }
    const from = getComputedStyle(c).transform;
    for (const a of c.getAnimations()) a.cancel();
    c.style.transform = "";
    const a = c.animate([{ transform: from === "none" ? "none" : from }, { transform: over(small.getBoundingClientRect()) }],
      { duration: CLOSE_MS, easing: EASE, fill: "forwards" });
    for (const el of fades()) el.animate([{ opacity: getComputedStyle(el).opacity }, { opacity: 0 }], { duration: CLOSE_MS - 40, easing: EASE, fill: "forwards" });
    a.onfinish = () => props.current.onClose();
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  /** Its picture: drawn by `draw`, else copied from the page's canvas. */
  const paint = () => {
    const c = big.current, small = source();
    if (!c) return;
    if (props.current.draw) { props.current.draw(c); return; }
    if (small && small.width) {
      if (c.width !== small.width || c.height !== small.height) { c.width = small.width; c.height = small.height; }
      c.getContext("2d")?.drawImage(small, 0, 0);
    }
  };

  // Opening: from its place in the page to the middle, the dark, the bar and the cross coming in with it (same
  // movement, same time). Measured at the picture's size, nothing else moving it (React may run this twice).
  useLayoutEffect(() => {
    const c = big.current, small = source();
    paint();
    if (!c || !small) return;
    for (const a of c.getAnimations()) a.cancel();
    c.animate([{ transform: over(small.getBoundingClientRect()) }, { transform: "none" }], { duration: OPEN_MS, easing: EASE });
    for (const el of fades()) {
      for (const a of el.getAnimations()) a.cancel();
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: OPEN_MS, easing: EASE });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Drawn by the page: again when it changes. Copied: at each frame (the video playing, scrubbing…).
  useEffect(() => { if (draw) paint(); }); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (draw) return;
    let raf = 0;
    const loop = () => { paint(); raf = requestAnimationFrame(loop); };
    loop();
    return () => cancelAnimationFrame(raf);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" || (closeOnSpace && e.key === " ")) { e.preventDefault(); closeRef.current(); }
      else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        const dir: 1 | -1 = e.key === "ArrowRight" ? 1 : -1;
        if (can(dir)) { e.preventDefault(); props.current.onSide!(dir); }
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (closing.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, dx: 0, dy: 0, axis: null };
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current, c = e.currentTarget;
    if (!d) return;
    d.dx = e.clientX - d.x;
    d.dy = e.clientY - d.y;
    // The way is chosen once, after a few pixels (a sideways swipe is never taken for a pull down).
    if (!d.axis) {
      if (Math.hypot(d.dx, d.dy) < 10) return;
      d.axis = onSide && Math.abs(d.dx) > Math.abs(d.dy) ? "x" : "y";
    }
    if (d.axis === "x") {
      // None that way: it resists.
      c.style.transform = `translateX(${can(d.dx < 0 ? 1 : -1) ? d.dx : d.dx * 0.25}px)`;
      return;
    }
    // Down: it follows, shrinks around its centre (the origin is its top left, for the glide), the dark thins out.
    const dy = Math.max(0, d.dy);
    const k = 1 - Math.min(0.3, dy / 1000);
    c.style.transform = dy ? `translate(${d.dx * 0.4 + (c.offsetWidth * (1 - k)) / 2}px, ${dy + (c.offsetHeight * (1 - k)) / 2}px) scale(${k})` : "";
    const o = String(Math.max(0.25, 1 - dy / 500));
    for (const el of fades()) el.style.opacity = o;
  };
  const up = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current, c = e.currentTarget;
    drag.current = null;
    if (!d) return;
    if (!d.axis) { c.style.transform = ""; onTap?.(); return; } // a tap
    if (d.axis === "y" && d.dy > 90) { close(); return; } // let go far enough: back to its place
    const dir: 1 | -1 = d.dx < 0 ? 1 : -1;
    if (d.axis === "x" && Math.abs(d.dx) > 60 && can(dir)) {
      // The next one: this one goes out on its side, the new one comes in from the other.
      const out = c.animate([{ transform: c.style.transform }, { transform: `translateX(${-dir * window.innerWidth * 0.6}px)`, opacity: 0 }], { duration: 160, easing: "ease-in", fill: "forwards" });
      out.onfinish = () => {
        props.current.onSide!(dir);
        c.style.transform = "";
        requestAnimationFrame(() => { // once the new one is drawn
          out.cancel();
          c.animate([{ transform: `translateX(${dir * window.innerWidth * 0.6}px)`, opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 220, easing: EASE });
        });
      };
      return;
    }
    // Not far enough: back to the middle.
    c.animate([{ transform: c.style.transform || "none" }, { transform: "none" }], { duration: 200, easing: "ease-out" });
    c.style.transform = "";
    for (const el of fades()) el.style.opacity = "";
  };

  return createPortal(
    <div className={"pv-full-layer" + (player ? " has-player" : "")} role="dialog" aria-modal="true" aria-label={label}>
      <div ref={bg} className="preview-bg" onClick={close} aria-hidden />
      <div className="pv-full-box">
        <div className="preview-pic">
          <canvas ref={big} className="pv-full-cv" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
          <button ref={xBtn} className="pv-close" aria-label={t("Close")} onClick={close}><Icon name="x" size={18} /></button>
        </div>
        {bar && <div ref={barEl} className="preview-bar">{bar}</div>}
      </div>
      {children}
    </div>, document.body);
}
