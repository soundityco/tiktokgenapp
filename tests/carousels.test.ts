import { describe, expect, it } from "vitest";
import { addCarousel, carouselsOf, currentCarouselId, deleteCarousel, duplicateCarousel, openCarousel, renameCarousel, mapAllSlides } from "@/lib/carousels";
import { joinCaptions, splitCaptions, textItems } from "@/lib/generate";
import type { Project } from "@/lib/types";

const slide = (id: string) => ({ id, locked: true, textSource: { kind: "none" }, picPoolId: "pics", format: "9:16", pic: {}, style: {} }) as any;
const base = (): Project => ({
  id: "p", name: "Release", slides: [slide("a"), slide("b")], lyrics: [], lyricsSectionId: null,
  generated: [{ text: "one", picId: "x" }, { text: "two", picId: "y" }], selectedSlide: 1, videos: [],
  caption: "first caption #a", captionPoolId: "caps",
});

describe("carousels of a release", () => {
  it("an older project has one carousel made of its own fields", () => {
    const list = carouselsOf(base());
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("Carousel 1");
    expect(list[0].generated?.[0].text).toBe("one");
  });

  it("a new carousel keeps the set-up, not the drawn content, and opens", () => {
    const p = addCarousel(base());
    expect(carouselsOf(p)).toHaveLength(2);
    expect(p.generated).toBeNull();
    expect(p.slides).toHaveLength(2);
    expect(p.slides.every((s) => !s.locked)).toBe(true);
    expect(p.caption).toBe("");
    expect(p.captionPoolId).toBe("caps");
    // the first one is kept as it was
    const first = openCarousel(p, carouselsOf(p)[0].id);
    expect(first.generated?.[1].text).toBe("two");
    expect(first.caption).toBe("first caption #a");
  });

  it("edits made on the open carousel are kept when switching back and forth", () => {
    let p = addCarousel(base());
    const second = currentCarouselId(p);
    p = { ...p, caption: "second caption", generated: [{ text: "new", picId: null }, { text: "new2", picId: null }] };
    p = openCarousel(p, carouselsOf(p)[0].id);
    expect(p.caption).toBe("first caption #a");
    p = openCarousel(p, second);
    expect(p.caption).toBe("second caption");
    expect(p.generated?.[0].text).toBe("new");
  });

  it("duplicates with the drawn content, renames, deletes (never the last)", () => {
    let p = duplicateCarousel(base(), "(copy)");
    expect(carouselsOf(p).map((c) => c.name)).toEqual(["Carousel 1", "Carousel 1 (copy)"]);
    expect(p.generated?.[0].text).toBe("one");
    p = renameCarousel(p, "Pinterest");
    expect(carouselsOf(p)[1].name).toBe("Pinterest");
    p = deleteCarousel(p);
    expect(carouselsOf(p)).toHaveLength(1);
    expect(deleteCarousel(p)).toBe(p);
  });

  it("a change to the slides reaches every carousel", () => {
    let p = addCarousel(base());
    p = mapAllSlides(p, (s) => ({ ...s, picPoolId: null }));
    expect(carouselsOf(p).every((c) => c.slides.every((s) => s.picPoolId === null))).toBe(true);
  });
});

describe("captions lists", () => {
  it("captions are separated by a --- line, empty lines inside them kept", () => {
    const pool = { id: "c", name: "Caps", scope: "shared", kind: "captions", text: "Out now 🔥\n\n#newmusic #rap\n---\nLink in bio\n\n\n#music\n" } as any;
    expect(textItems(pool)).toEqual(["Out now 🔥\n\n#newmusic #rap", "Link in bio\n\n\n#music"]);
    expect(splitCaptions(joinCaptions(textItems(pool)))).toEqual(textItems(pool));
  });
  it("a text with no --- line (a .txt imported) is cut on empty lines", () => {
    expect(splitCaptions("One\n#a\n\nTwo\n#b")).toEqual(["One\n#a", "Two\n#b"]);
  });
});
