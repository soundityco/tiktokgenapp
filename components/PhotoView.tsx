"use client";
import { useT } from "@/lib/i18n";
import type { PicRef } from "@/lib/types";
import { FullView } from "./FullView";
import Icon from "./Icon";
import { usePhotos } from "./SlidePreview";

/** A side of the picture drawn full screen, at most (a big camera photo stays light). */
const MAX = 2400;

/**
 * A photo of a list full screen: the carousel's own full screen (`FullView`): it glides from its thumbnail, swipe or
 * ← → for the previous / next one, dragged down or Escape to close; its name and its number under it.
 */
export default function PhotoView({ pics, index, onNav, onClose, thumb }: {
  pics: PicRef[];
  index: number;
  onNav: (to: number) => void;
  onClose: () => void;
  /** The thumbnail of photo `i` in the list: where it glides from and back to. */
  thumb: (i: number) => HTMLElement | null;
}) {
  const { t } = useT();
  const photo = usePhotos([pics[index]?.id, pics[index - 1]?.id, pics[index + 1]?.id]);
  const paint = (c: HTMLCanvasElement, i: number) => {
    const img = photo(pics[i]?.id);
    if (!img) { if (!c.width) { c.width = 1080; c.height = 1350; } c.getContext("2d")?.clearRect(0, 0, c.width, c.height); return; }
    // Big enough to fill the screen (a small web image too, smoothed), never more than MAX.
    const long = Math.max(img.width, img.height), k = Math.min(MAX / long, Math.max(1, 1600 / long));
    const w = Math.round(img.width * k), h = Math.round(img.height * k);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext("2d");
    if (g) { g.imageSmoothingQuality = "high"; g.drawImage(img, 0, 0, w, h); }
  };
  const total = pics.length;
  return (
    <FullView label={pics[index]?.name ?? t("Photo")}
      source={() => thumb(index)}
      draw={(c) => paint(c, index)}
      drawSide={(c, dir) => paint(c, index + dir)}
      sideKey={index}
      onClose={onClose}
      onSide={(dir) => onNav(index + dir)}
      sideOk={(dir) => index + dir >= 0 && index + dir < total}
      bar={<>
        <button className="btn sm quiet icon" aria-label={t("Previous photo")} disabled={index === 0} onClick={() => onNav(index - 1)}><Icon name="back" size={14} /></button>
        <span className="mono xs">{String(index + 1).padStart(2, "0")} / {String(total).padStart(2, "0")}</span>
        <button className="btn sm quiet icon flip" aria-label={t("Next photo")} disabled={index === total - 1} onClick={() => onNav(index + 1)}><Icon name="back" size={14} /></button>
        <span className="muted xs grow truncate preview-hint">{pics[index]?.name}</span>
      </>} />
  );
}
