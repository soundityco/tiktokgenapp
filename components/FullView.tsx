"use client";
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Icon from "./Icon";
import { useT } from "@/lib/i18n";

/**
 * A picture of the page (the video's preview, a slide) full screen, shared by both studios. It glides from its
 * place in the page to the whole screen and back; it follows the finger or the mouse: dragged down it shrinks and
 * the black thins out, let go far enough it goes on to its place (Escape and the cross too). Dragged sideways
 * (`onSide`, the carousel): the next or previous one. A tap: `onTap`. The picture shown is the page's own canvas,
 * copied as it is drawn (playing, scrubbing…).
 */
export function FullView({ source, onClose, onTap, onSide, children }: {
  /** The page's canvas shown full screen (also where it glides from and back to). */
  source: () => HTMLCanvasElement | null;
  onClose: () => void;
  onTap?: () => void;
  /** Sideways: 1 the next one, -1 the previous one. */
  onSide?: (dir: 1 | -1) => void;
  /** Over the picture (a player…). */
  children?: ReactNode;
}) {
  const { t } = useT();
  const layer = useRef<HTMLDivElement>(null);
  const big = useRef<HTMLCanvasElement>(null);
  const closing = useRef(false);
  const drag = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);

  /** The transform that puts the full-screen picture over `to` (page pixels). */
  const over = (to: DOMRect) => {
    const c = big.current!;
    const prev = c.style.transform;
    c.style.transform = "none";
    const base = c.getBoundingClientRect();
    c.style.transform = prev;
    const k = to.width / Math.max(1, base.width);
    return `translate(${to.left - base.left}px, ${to.top - base.top}px) scale(${k})`;
  };
  const close = () => {
    const c = big.current, small = source();
    if (closing.current) return;
    closing.current = true;
    if (!c || !small) { onClose(); return; }
    const from = getComputedStyle(c).transform;
    c.style.transform = "";
    const a = c.animate([{ transform: from === "none" ? "none" : from, transformOrigin: "0 0" }, { transform: over(small.getBoundingClientRect()), transformOrigin: "0 0" }],
      { duration: 280, easing: "cubic-bezier(.2,.8,.2,1)", fill: "forwards" });
    layer.current?.animate([{ backgroundColor: getComputedStyle(layer.current).backgroundColor }, { backgroundColor: "rgba(0,0,0,0)" }], { duration: 280, fill: "forwards" });
    a.onfinish = onClose;
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  // Opening: from the picture's place in the page to the whole screen (the animation lets go once done, so a drag
  // then moves the picture itself).
  useLayoutEffect(() => {
    const c = big.current, small = source();
    if (!c || !small) return;
    c.animate([{ transform: over(small.getBoundingClientRect()), transformOrigin: "0 0" }, { transform: "none", transformOrigin: "0 0" }],
      { duration: 300, easing: "cubic-bezier(.2,.8,.2,1)" });
    layer.current?.animate([{ backgroundColor: "rgba(0,0,0,0)" }, { backgroundColor: "rgba(0,0,0,1)" }], { duration: 300 });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The page's picture, copied as it is drawn.
  useEffect(() => {
    let raf = 0;
    const copy = () => {
      const c = big.current, small = source();
      if (c && small && small.width) {
        if (c.width !== small.width || c.height !== small.height) { c.width = small.width; c.height = small.height; }
        c.getContext("2d")?.drawImage(small, 0, 0);
      }
      raf = requestAnimationFrame(copy);
    };
    copy();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); closeRef.current(); }
      else if (onSide && (e.key === "ArrowRight" || e.key === "ArrowLeft")) { e.preventDefault(); onSide(e.key === "ArrowRight" ? 1 : -1); }
    };
    window.addEventListener("keydown", key);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("keydown", key); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (closing.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, dx: 0, dy: 0 };
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current, c = e.currentTarget;
    if (!d) return;
    d.dx = e.clientX - d.x;
    d.dy = e.clientY - d.y;
    const side = !!onSide && Math.abs(d.dx) > Math.abs(d.dy);
    if (side) { c.style.transform = `translateX(${d.dx}px)`; return; }
    const dy = Math.max(0, d.dy);
    // Down: the picture follows, shrinks a little, and the black thins out.
    c.style.transform = dy ? `translate(${d.dx * 0.4}px, ${dy}px) scale(${1 - Math.min(0.3, dy / 1000)})` : "";
    if (layer.current) layer.current.style.backgroundColor = `rgba(0,0,0,${Math.max(0.25, 1 - dy / 500)})`;
  };
  const up = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current, c = e.currentTarget;
    drag.current = null;
    if (!d) return;
    const side = !!onSide && Math.abs(d.dx) > Math.abs(d.dy);
    if (side && Math.abs(d.dx) > 60) {
      // The next one: the picture slides out on its side, the new one comes in from the other.
      const dir: 1 | -1 = d.dx < 0 ? 1 : -1;
      const out = c.animate([{ transform: c.style.transform }, { transform: `translateX(${-dir * window.innerWidth * 0.6}px)`, opacity: 0 }], { duration: 160, easing: "ease-in" });
      out.onfinish = () => {
        c.style.transform = "";
        onSide!(dir);
        c.animate([{ transform: `translateX(${dir * window.innerWidth * 0.6}px)`, opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 200, easing: "cubic-bezier(.2,.8,.2,1)" });
      };
      return;
    }
    if (!side && d.dy > 90) { close(); return; } // let go far enough: on to its place
    if (Math.abs(d.dx) > 6 || Math.abs(d.dy) > 6) {
      // Not far enough: back to the full screen.
      c.animate([{ transform: c.style.transform || "none" }, { transform: "none" }], { duration: 200, easing: "ease-out" });
      c.style.transform = "";
      if (layer.current) layer.current.style.backgroundColor = "";
      return;
    }
    c.style.transform = "";
    onTap?.();
  };

  return createPortal(
    <div ref={layer} className="pv-full-layer">
      <canvas ref={big} className="pv-full-cv" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      <button className="pv-close" aria-label={t("Close")} onClick={close}><Icon name="x" size={18} /></button>
      {children}
    </div>, document.body);
}
