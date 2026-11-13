import { describe, expect, it } from "vitest";
import { defaultPic } from "../lib/defaults";
import { coversFrame, sharpEnough } from "../lib/photoAI";

const fill = defaultPic(); // the slide's default: fill (crop), zoom 1
const fit = { ...fill, framing: "fit" as const };

describe("which photo AI options a slide offers", () => {
  it("Sharper: offered under 1600 px on the short side (a 1080 image can be blurry), not above", () => {
    expect(sharpEnough(300, 300)).toBe(false);
    expect(sharpEnough(1080, 1920)).toBe(false);
    expect(sharpEnough(1500, 2400)).toBe(false);
    expect(sharpEnough(1600, 2400)).toBe(true);
    expect(sharpEnough(4000, 3000)).toBe(true);
  });
  it("Fill: offered only when the photo leaves empty edges on the slide", () => {
    // Cropped by the slide (fill), whatever its shape: it fills it, nothing offered.
    expect(coversFrame({ width: 1080, height: 1920 }, fill, 1080, 1920)).toBe(true);
    expect(coversFrame({ width: 1000, height: 1000 }, fill, 1080, 1920)).toBe(true);
    expect(coversFrame({ width: 1000, height: 1000 }, { ...fill, zoom: 1.4, ox: 0.1 }, 1080, 1920)).toBe(true);
    // Whole (bars), zoomed out, a horizontal one shown whole: empty edges to fill.
    expect(coversFrame({ width: 1000, height: 1000 }, fit, 1080, 1920)).toBe(false);
    expect(coversFrame({ width: 1080, height: 1920 }, { ...fill, zoom: 0.7 }, 1080, 1920)).toBe(false);
    expect(coversFrame({ width: 1920, height: 1080 }, fit, 1080, 1920)).toBe(false);
    // The slide's own shape shown whole: it fills it too.
    expect(coversFrame({ width: 540, height: 960 }, fit, 1080, 1920)).toBe(true);
  });
});
