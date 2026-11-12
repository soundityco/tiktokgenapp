"use client";
import { useT } from "@/lib/i18n";
import { renderSlide } from "@/lib/render";
import { useEffect, useState } from "react";
import { loadDriveImage } from "@/lib/drive";
import type { Img } from "@/lib/render";
import type { GenSlide, SlideCfg } from "@/lib/types";
import { FullView } from "./FullView";
import Icon from "./Icon";

/** The photos of these slides, kept once loaded (the next one's is ready when it becomes the one shown: no flash). */
function usePhotos(ids: (string | null | undefined)[]) {
  const [got, setGot] = useState<Map<string, Img>>(() => new Map());
  const key = ids.filter(Boolean).join("|");
  useEffect(() => {
    let off = false;
    for (const id of ids) {
      if (!id || got.has(id)) continue;
      loadDriveImage(id).then((i) => { if (!off) setGot((m) => new Map(m).set(id, i)); }).catch(() => {});
    }
    return () => { off = true; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return (id: string | null | undefined) => (id ? got.get(id) ?? null : null);
}

/**
 * A slide full screen, as it will be exported (no TikTok zones, no guides): the shared full screen (`FullView`, the
 * video's too), the slide drawn at its full size, its number and arrows under it. Space or Escape closes it, the arrow
 * keys or a swipe go to the previous / next slide.
 */
export default function SlidePreview({
  index, total, slides, gens, fontsReady, onNav, onClose,
}: {
  index: number;
  total: number;
  slides: SlideCfg[];
  gens: (GenSlide | undefined)[];
  fontsReady: boolean;
  onNav: (to: number) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  // This slide and its neighbours (drawn beside it while swiped).
  const photo = usePhotos([gens[index]?.picId, gens[index - 1]?.picId, gens[index + 1]?.picId]);
  void fontsReady; // a new render once the fonts are there draws it again
  return (
    <FullView label={t("Slide {n}", { n: index + 1 })} closeOnSpace
      source={() => document.querySelector<HTMLCanvasElement>(".card.sel .cv-wrap canvas.cv")}
      draw={(c) => { renderSlide(c, slides[index], photo(gens[index]?.picId), gens[index]?.text ?? ""); }}
      drawSide={(c, dir) => { const i = index + dir; if (slides[i]) renderSlide(c, slides[i], photo(gens[i]?.picId), gens[i]?.text ?? ""); }}
      sideKey={index}
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
