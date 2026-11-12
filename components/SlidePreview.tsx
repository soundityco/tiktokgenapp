"use client";
import { useEffect, useRef } from "react";
import { useT } from "@/lib/i18n";
import { renderSlide } from "@/lib/render";
import { useDriveImage } from "@/lib/useImage";
import type { GenSlide, SlideCfg } from "@/lib/types";
import Icon from "./Icon";

/**
 * Full-size look at a slide as it will be exported: no TikTok zones, no guides.
 * Space or Escape closes it, the arrow keys go to the previous / next slide.
 */
export default function SlidePreview({
  index, total, cfg, gen, fontsReady, onNav, onClose,
}: {
  index: number;
  total: number;
  cfg: SlideCfg;
  gen: GenSlide | undefined;
  fontsReady: boolean;
  onNav: (to: number) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const { img } = useDriveImage(gen?.picId ?? null);
  const cv = useRef<HTMLCanvasElement>(null);
  const keys = useRef({ index, total, onNav, onClose });
  keys.current = { index, total, onNav, onClose };

  useEffect(() => {
    if (cv.current) renderSlide(cv.current, cfg, img, gen?.text ?? "");
  }, [cfg, img, gen?.text, fontsReady]);

  // Like the video's full screen: the picture glides from its slide to here, and back to its slide when it closes
  // (the cross, Space, Escape, a tap beside, or dragged down far enough). The dark, the bar and the cross fade with it.
  const ov = useRef<HTMLDivElement>(null);
  const bg = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const xBtn = useRef<HTMLButtonElement>(null);
  const closing = useRef(false);
  const card = () => document.querySelector<HTMLCanvasElement>(".card.sel .cv-wrap canvas.cv");
  const fades = () => [bg.current, bar.current, xBtn.current].filter((x): x is HTMLDivElement | HTMLButtonElement => !!x);
  /** The transform (origin top left) that puts the picture over `to`. */
  const over = (to: DOMRect) => {
    const c = cv.current!;
    const prev = c.style.transform;
    c.style.transform = "none";
    const base = c.getBoundingClientRect();
    c.style.transform = prev;
    return `translate(${to.left - base.left}px, ${to.top - base.top}px) scale(${to.width / Math.max(1, base.width)})`;
  };
  const close = () => {
    if (closing.current) return;
    closing.current = true;
    const c = cv.current, small = card();
    if (!c || !small) { onClose(); return; }
    const from = getComputedStyle(c).transform;
    for (const a of c.getAnimations()) a.cancel();
    c.style.transform = "";
    const a = c.animate([{ transform: from === "none" ? "none" : from }, { transform: over(small.getBoundingClientRect()) }],
      { duration: 280, easing: "cubic-bezier(.2,.8,.2,1)", fill: "forwards" });
    for (const el of fades()) el.animate([{ opacity: getComputedStyle(el).opacity }, { opacity: 0 }], { duration: 240, fill: "forwards" });
    a.onfinish = onClose;
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  // Opening (once the picture is drawn at its size): from the slide to here.
  useEffect(() => {
    // Measured on the next frame (the picture laid out at its size), nothing else moving it.
    const raf = requestAnimationFrame(() => {
      const c = cv.current, small = card();
      ov.current?.classList.add("in");
      if (!c || !small) return;
      for (const a of c.getAnimations()) a.cancel();
      c.animate([{ transform: over(small.getBoundingClientRect()) }, { transform: "none" }], { duration: 300, easing: "cubic-bezier(.2,.8,.2,1)" });
      for (const el of fades()) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300 });
    });
    return () => cancelAnimationFrame(raf);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const c = keys.current;
      if (e.key === " " || e.key === "Escape") { e.preventDefault(); closeRef.current(); }
      else if (e.key === "ArrowLeft" && c.index > 0) { e.preventDefault(); c.onNav(c.index - 1); }
      else if (e.key === "ArrowRight" && c.index < c.total - 1) { e.preventDefault(); c.onNav(c.index + 1); }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  // Dragged down the picture follows and shrinks, the dark thins out; let go far enough it goes back to its slide.
  // Dragged sideways: the previous / next slide.
  const drag = useRef<{ x: number; y: number; dx: number; dy: number; axis: "x" | "y" | null } | null>(null);
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
      d.axis = Math.abs(d.dx) > Math.abs(d.dy) ? "x" : "y";
    }
    if (d.axis === "x") {
      const k = keys.current;
      const end = (d.dx > 0 && k.index === 0) || (d.dx < 0 && k.index === k.total - 1);
      c.style.transform = `translateX(${end ? d.dx * 0.25 : d.dx}px)`; // no slide that way: it resists
      return;
    }
    const dy = Math.max(0, d.dy);
    const k = 1 - Math.min(0.3, dy / 1000);
    // Shrinks around its centre (the transform's origin is the top left, for the glide).
    c.style.transform = dy ? `translate(${d.dx * 0.4 + (c.offsetWidth * (1 - k)) / 2}px, ${dy + (c.offsetHeight * (1 - k)) / 2}px) scale(${k})` : "";
    const o = String(Math.max(0.25, 1 - dy / 500));
    for (const el of fades()) el.style.opacity = o;
  };
  const up = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current, c = e.currentTarget;
    drag.current = null;
    if (!d || !d.axis) return;
    if (d.axis === "y" && d.dy > 90) { close(); return; }
    const k = keys.current;
    const to = d.axis === "x" && Math.abs(d.dx) > 60 ? k.index + (d.dx < 0 ? 1 : -1) : k.index;
    if (to !== k.index && to >= 0 && to < k.total) {
      // The next one: this slide goes out on its side, the new one comes in from the other.
      const dir = d.dx < 0 ? 1 : -1;
      const out = c.animate([{ transform: c.style.transform }, { transform: `translateX(${-dir * window.innerWidth * 0.6}px)`, opacity: 0 }], { duration: 160, easing: "ease-in", fill: "forwards" });
      out.onfinish = () => {
        k.onNav(to);
        c.style.transform = "";
        // Once the new slide is drawn.
        requestAnimationFrame(() => {
          out.cancel();
          c.animate([{ transform: `translateX(${dir * window.innerWidth * 0.6}px)`, opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 220, easing: "cubic-bezier(.2,.8,.2,1)" });
        });
      };
      return;
    }
    c.animate([{ transform: c.style.transform || "none" }, { transform: "none" }], { duration: 200, easing: "ease-out" });
    c.style.transform = "";
    for (const el of fades()) el.style.opacity = "";
  };

  return (
    <div ref={ov} className="ov preview-ov" role="dialog" aria-modal="true" aria-label={t("Slide {n}", { n: index + 1 })} onClick={close}>
      <div ref={bg} className="preview-bg" aria-hidden />
      <div className="preview" onClick={(e) => e.stopPropagation()}>
        {/* The cross at the picture's top right, the video's full screen one. */}
        <div className="preview-pic">
          <canvas ref={cv} className="preview-canvas" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
          <button ref={xBtn} className="pv-close" aria-label={t("Close")} onClick={close}><Icon name="x" size={18} /></button>
        </div>
        <div ref={bar} className="preview-bar">
          <button className="btn sm quiet icon" aria-label={t("Previous slide")} disabled={index === 0} onClick={() => onNav(index - 1)}><Icon name="back" size={14} /></button>
          <span className="mono xs">{String(index + 1).padStart(2, "0")} / {String(total).padStart(2, "0")}</span>
          <button className="btn sm quiet icon flip" aria-label={t("Next slide")} disabled={index === total - 1} onClick={() => onNav(index + 1)}><Icon name="back" size={14} /></button>
          <span className="muted xs grow preview-hint">{t("Space or Esc to close · ← → to browse")}</span>
        </div>
      </div>
    </div>
  );
}
