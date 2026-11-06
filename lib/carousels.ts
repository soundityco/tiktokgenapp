import type { CarouselSetup, Project, SlideCfg } from "./types";
import { uid } from "./defaults";

/**
 * Several carousels per release. The open one lives in the project's own fields (slides, generated,
 * selectedSlide, caption, captionPoolId), so everything that edits "the carousel" keeps working as before;
 * `carousels` keeps every carousel, the open one's entry being refreshed from those fields when needed.
 */
export const FIRST_CAROUSEL = "main";

const snapshot = (p: Project, base: Pick<CarouselSetup, "id" | "name">): CarouselSetup => ({
  ...base,
  slides: p.slides,
  generated: p.generated,
  selectedSlide: p.selectedSlide,
  caption: p.caption,
  captionPoolId: p.captionPoolId,
});

/** Every carousel of the release, the open one up to date. Older projects have one, "Carousel 1". */
export function carouselsOf(p: Project): CarouselSetup[] {
  const id = p.carouselId ?? FIRST_CAROUSEL;
  const list = p.carousels?.length ? p.carousels : [{ id, name: "Carousel 1" } as CarouselSetup];
  return list.map((c) => (c.id === id ? snapshot(p, c) : c));
}

export const currentCarouselId = (p: Project) => p.carouselId ?? p.carousels?.[0]?.id ?? FIRST_CAROUSEL;

/** Opens another carousel: the current one is kept in the list, the chosen one comes into the project's fields. */
export function openCarousel(p: Project, id: string, list = carouselsOf(p)): Project {
  const c = list.find((x) => x.id === id) ?? list[0];
  return {
    ...p, carousels: list, carouselId: c.id,
    slides: c.slides, generated: c.generated, selectedSlide: Math.min(c.selectedSlide, Math.max(0, c.slides.length - 1)),
    caption: c.caption, captionPoolId: c.captionPoolId,
  };
}

/** Next free "Carousel N". */
function nextName(list: CarouselSetup[]) {
  let n = list.length + 1;
  while (list.some((c) => c.name === `Carousel ${n}`)) n++;
  return `Carousel ${n}`;
}

const cloneSlides = (slides: SlideCfg[]): SlideCfg[] =>
  slides.map((s) => ({ ...s, id: uid(), pic: { ...s.pic }, style: { ...s.style } }));

/** A new carousel: the same slides set-up (format, lists, styles), not generated yet, unlocked. */
export function addCarousel(p: Project): Project {
  const list = carouselsOf(p);
  const id = uid();
  const fresh: CarouselSetup = {
    id, name: nextName(list),
    slides: cloneSlides(p.slides).map((s) => ({ ...s, locked: false })),
    generated: null, selectedSlide: 0, caption: "", captionPoolId: p.captionPoolId,
  };
  return openCarousel(p, id, [...list, fresh]);
}

/** A copy of the open carousel, drawn texts and photos included: to try a variation and keep the original. */
export function duplicateCarousel(p: Project, copyLabel: string): Project {
  const list = carouselsOf(p);
  const cur = list.find((c) => c.id === currentCarouselId(p)) ?? list[0];
  const id = uid();
  const copy: CarouselSetup = {
    ...cur, id, name: `${cur.name} ${copyLabel}`,
    slides: cloneSlides(cur.slides),
    generated: cur.generated ? cur.generated.map((g) => ({ ...g })) : null,
  };
  const at = list.indexOf(cur) + 1;
  return openCarousel(p, id, [...list.slice(0, at), copy, ...list.slice(at)]);
}

export function renameCarousel(p: Project, name: string): Project {
  const id = currentCarouselId(p);
  return { ...p, carousels: carouselsOf(p).map((c) => (c.id === id ? { ...c, name } : c)), carouselId: id };
}

/** Deletes the open carousel (never the last one) and opens its neighbour. */
export function deleteCarousel(p: Project): Project {
  const list = carouselsOf(p);
  if (list.length < 2) return p;
  const i = list.findIndex((c) => c.id === currentCarouselId(p));
  const rest = list.filter((_, k) => k !== i);
  return openCarousel(p, rest[Math.min(Math.max(0, i - 1), rest.length - 1)].id, rest);
}

/** Applies a change to the slides of every carousel of the release (a list deleted, ids remapped…). */
export function mapAllSlides(p: Project, fn: (s: SlideCfg) => SlideCfg): Project {
  return {
    ...p,
    slides: p.slides.map(fn),
    carousels: p.carousels?.map((c) => ({ ...c, slides: c.slides.map(fn) })),
  };
}
