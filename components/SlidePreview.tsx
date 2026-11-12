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

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const c = keys.current;
      if (e.key === " " || e.key === "Escape") { e.preventDefault(); c.onClose(); }
      else if (e.key === "ArrowLeft" && c.index > 0) { e.preventDefault(); c.onNav(c.index - 1); }
      else if (e.key === "ArrowRight" && c.index < c.total - 1) { e.preventDefault(); c.onNav(c.index + 1); }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  // Like the video's full screen: dragged down the picture follows, shrinks and the dark thins out; let go far enough
  // it closes. Dragged sideways: the previous / next slide.
  const ov = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, dx: 0, dy: 0 };
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current, c = e.currentTarget;
    if (!d) return;
    d.dx = e.clientX - d.x;
    d.dy = e.clientY - d.y;
    if (Math.abs(d.dx) > Math.abs(d.dy)) { c.style.transform = `translateX(${d.dx}px)`; return; }
    const dy = Math.max(0, d.dy);
    c.style.transform = dy ? `translate(${d.dx * 0.4}px, ${dy}px) scale(${1 - Math.min(0.3, dy / 1000)})` : "";
    if (ov.current) ov.current.style.opacity = String(Math.max(0.35, 1 - dy / 500));
  };
  const up = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current, c = e.currentTarget;
    drag.current = null;
    if (!d) return;
    const side = Math.abs(d.dx) > Math.abs(d.dy);
    if (!side && d.dy > 90) {
      // Let go far enough: the picture goes on down as the window fades, then it closes.
      c.animate([{ transform: c.style.transform }, { transform: `translate(${d.dx * 0.4}px, ${d.dy + 160}px) scale(.7)`, opacity: 0 }], { duration: 200, easing: "ease-in", fill: "forwards" });
      ov.current?.animate([{ opacity: ov.current.style.opacity || "1" }, { opacity: 0 }], { duration: 200, fill: "forwards" }).addEventListener("finish", onClose);
      return;
    }
    const k = keys.current;
    const to = side && Math.abs(d.dx) > 60 ? k.index + (d.dx < 0 ? 1 : -1) : k.index;
    c.animate([{ transform: c.style.transform || "none" }, { transform: "none" }], { duration: 200, easing: "ease-out" });
    c.style.transform = "";
    if (ov.current) ov.current.style.opacity = "";
    if (to !== k.index && to >= 0 && to < k.total) k.onNav(to);
  };

  return (
    <div ref={ov} className="ov preview-ov" role="dialog" aria-modal="true" aria-label={t("Slide {n}", { n: index + 1 })} onClick={onClose}>
      <div className="preview" onClick={(e) => e.stopPropagation()}>
        {/* The cross at the picture's top right, the video's full screen one. */}
        <div className="preview-pic">
          <canvas ref={cv} className="preview-canvas" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
          <button className="pv-close" aria-label={t("Close")} onClick={onClose}><Icon name="x" size={18} /></button>
        </div>
        <div className="preview-bar">
          <button className="btn sm quiet icon" aria-label={t("Previous slide")} disabled={index === 0} onClick={() => onNav(index - 1)}><Icon name="back" size={14} /></button>
          <span className="mono xs">{String(index + 1).padStart(2, "0")} / {String(total).padStart(2, "0")}</span>
          <button className="btn sm quiet icon flip" aria-label={t("Next slide")} disabled={index === total - 1} onClick={() => onNav(index + 1)}><Icon name="back" size={14} /></button>
          <span className="muted xs grow preview-hint">{t("Space or Esc to close · ← → to browse")}</span>
        </div>
      </div>
    </div>
  );
}
