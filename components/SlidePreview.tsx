"use client";
import { useT } from "@/lib/i18n";
import { renderSlide } from "@/lib/render";
import { useDriveImage } from "@/lib/useImage";
import type { GenSlide, SlideCfg } from "@/lib/types";
import { FullView } from "./FullView";
import Icon from "./Icon";

/**
 * A slide full screen, as it will be exported (no TikTok zones, no guides): the shared full screen (`FullView`, the
 * video's too), the slide drawn at its full size, its number and arrows under it. Space or Escape closes it, the arrow
 * keys or a swipe go to the previous / next slide.
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
  void fontsReady; // a new render once the fonts are there draws it again
  return (
    <FullView label={t("Slide {n}", { n: index + 1 })} closeOnSpace
      source={() => document.querySelector<HTMLCanvasElement>(".card.sel .cv-wrap canvas.cv")}
      draw={(c) => { renderSlide(c, cfg, img, gen?.text ?? ""); }}
      onClose={onClose}
      onSide={(dir) => onNav(index + dir)}
      sideOk={(dir) => index + dir >= 0 && index + dir < total}
      bar={<>
        <button className="btn sm quiet icon" aria-label={t("Previous slide")} disabled={index === 0} onClick={() => onNav(index - 1)}><Icon name="back" size={14} /></button>
        <span className="mono xs">{String(index + 1).padStart(2, "0")} / {String(total).padStart(2, "0")}</span>
        <button className="btn sm quiet icon flip" aria-label={t("Next slide")} disabled={index === total - 1} onClick={() => onNav(index + 1)}><Icon name="back" size={14} /></button>
        <span className="muted xs grow preview-hint">{t("Space or Esc to close · ← → to browse")}</span>
      </>} />
  );
}
