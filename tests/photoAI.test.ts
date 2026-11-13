import { describe, expect, it } from "vitest";
import { defaultPic } from "../lib/defaults";
import { coversFrame, fillFraming, sharpEnough } from "../lib/photoAI";

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
  it("Fill: a photo of the slide's shape has nothing to fill, whatever the framing", () => {
    expect(fillFraming({ width: 1080, height: 1920 }, fill, 1080, 1920)).toBeNull();
    expect(fillFraming({ width: 540, height: 960 }, fit, 1080, 1920)).toBeNull();
  });
  it("Fill: a square photo cropped by the slide (fill) is filled shown whole, in the middle", () => {
    expect(coversFrame({ width: 1000, height: 1000 }, fill, 1080, 1920)).toBe(true);
    expect(fillFraming({ width: 1000, height: 1000 }, { ...fill, zoom: 1.4, ox: 0.1 }, 1080, 1920)).toEqual({ ...fill, framing: "fit", zoom: 1, ox: 0, oy: 0 });
  });
  it("Fill: a photo leaving empty edges (whole, zoomed out, moved) is filled as it is placed", () => {
    expect(fillFraming({ width: 1000, height: 1000 }, fit, 1080, 1920)).toEqual(fit);
    const out = { ...fill, zoom: 0.7 };
    expect(fillFraming({ width: 1080, height: 1920 }, out, 1080, 1920)).toEqual(out);
    // A horizontal photo on a vertical slide, shown whole: bands above and under.
    expect(coversFrame({ width: 1920, height: 1080 }, fit, 1080, 1920)).toBe(false);
  });
});
