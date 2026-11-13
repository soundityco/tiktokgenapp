import { describe, expect, it } from "vitest";
import { clampPic, drawMatte, matteName, snapPic } from "../lib/render";
import { defaultPic } from "../lib/defaults";

const bars = (W: number, H: number, r?: number) => {
  const got: number[][] = [];
  drawMatte({ set fillStyle(_: string) {}, fillRect: (...a: number[]) => got.push(a) } as unknown as CanvasRenderingContext2D, W, H, r);
  return got;
};

describe("black bars to a picture format", () => {
  it("a wider format on a vertical slide: bars above and under, the middle at that format", () => {
    const [top, bottom] = bars(1080, 1920, 16 / 9);
    const shown = bottom[1] - top[3];
    expect(Math.abs(1080 / shown - 16 / 9)).toBeLessThan(0.01);
    expect(top[3]).toBe(1920 - bottom[1]); // centred
  });
  it("a narrower format on a horizontal video: bars on its sides", () => {
    const [left, right] = bars(1920, 1080, 4 / 3);
    expect(left).toEqual([0, 0, 240, 1080]);
    expect(right[0]).toBe(1680);
  });
  it("none, or the frame's own format: nothing drawn", () => {
    expect(bars(1080, 1920)).toEqual([]);
    expect(bars(1920, 1080, 16 / 9)).toEqual([]);
  });
  it("names", () => { expect(matteName(2.39)).toBe("2.39:1"); expect(matteName(16 / 9)).toBe("16:9"); expect(matteName(1)).toBe("1:1"); });
  it("a photo the size of the slide moves while it still covers the part between the bars", () => {
    const pic = { ...defaultPic(), oy: 0.3 };
    // No bars: it covers the slide exactly, it cannot move.
    expect(clampPic(pic, 1080, 1920, 1080, 1920).oy).toBe(0);
    // 2.39:1 bars: 452 px shown out of 1920, it can go up or down by (1920 - 452) / 2.
    expect(clampPic({ ...pic, matte: 2.39 }, 1080, 1920, 1080, 1920).oy).toBeCloseTo(0.3);
    expect(clampPic({ ...pic, oy: 0.5, matte: 2.39 }, 1080, 1920, 1080, 1920).oy).toBeCloseTo((1920 - 1080 / 2.39) / 2 / 1920, 3);
  });
  it("a dragged picture's centre snaps to the middle lines", () => {
    expect(snapPic(0.01, 0.2)).toEqual({ ox: 0, oy: 0.2, v: true, h: false });
    expect(snapPic(0.1, -0.012)).toEqual({ ox: 0.1, oy: 0, v: false, h: true });
  });
});
