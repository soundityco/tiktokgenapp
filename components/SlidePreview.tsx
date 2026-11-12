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

  return (
    <div className="ov preview-ov" role="dialog" aria-modal="true" aria-label={t("Slide {n}", { n: index + 1 })} onClick={onClose}>
      <div className="preview" onClick={(e) => e.stopPropagation()}>
        {/* The cross at the picture's top right, the video's full screen one. */}
        <div className="preview-pic">
          <canvas ref={cv} className="preview-canvas" />
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
