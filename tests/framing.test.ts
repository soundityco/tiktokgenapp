import { describe, expect, it } from "vitest";
import { mergeFolder } from "../lib/drive";
import { aacConfig } from "../lib/exportVideo";
import { codecLabel, rotationOf } from "../lib/videoSource";
import { clampPic, zoomPic } from "../lib/render";
import { defaultPic } from "../lib/defaults";
import type { PicRef } from "../lib/types";

const img = (id: string) => ({ id, name: id + ".jpg", mimeType: "image/jpeg" });

describe("mergeFolder (linked Drive folders)", () => {
  const pics: PicRef[] = [
    { id: "a", name: "a.jpg", folder: "F" },
    { id: "b", name: "b.jpg", folder: "F" },
    { id: "m", name: "m.jpg" }, // added by hand
  ];
  it("adds new photos and drops the ones gone from the folder", () => {
    const r = mergeFolder(pics, "F", [img("a"), img("c")]);
    expect(r.map((p) => p.id)).toEqual(["a", "m", "c"]);
    expect(r[2].folder).toBe("F");
  });
  it("returns the same array when nothing changed", () => {
    expect(mergeFolder(pics, "F", [img("a"), img("b")])).toBe(pics);
  });
  it("does not bring back photos removed by hand, nor duplicate hand-added ones", () => {
    const r = mergeFolder(pics, "F", [img("a"), img("b"), img("x"), img("m")], ["x"]);
    expect(r).toBe(pics);
  });
  it("leaves photos of other folders alone", () => {
    expect(mergeFolder(pics, "G", [])).toBe(pics);
  });
});

describe("photo framing", () => {
  // Square photo on a 9:16 canvas, fill: 1920 px wide at zoom 1, so it can move 420 px each way.
  const W = 1080, H = 1920;
  it("keeps the offset where the photo still covers the canvas", () => {
    const p = clampPic({ ...defaultPic(), ox: -2, oy: 1 }, 1000, 1000, W, H);
    expect(p.ox).toBeCloseTo(-420 / W);
    expect(p.oy).toBe(0);
  });
  it("lets a photo smaller than the canvas move inside it", () => {
    const p = clampPic({ ...defaultPic(), zoom: 0.5, ox: 1, oy: 1 }, 1000, 1000, W, H);
    expect(p.ox).toBeCloseTo((W - 960) / 2 / W);
    expect(p.oy).toBeCloseTo((H - 960) / 2 / H);
  });
  it("zooms around the centre of the canvas", () => {
    const p = zoomPic({ ...defaultPic(), zoom: 1, ox: 0.1, oy: -0.05 }, 2);
    expect(p).toMatchObject({ zoom: 2, ox: 0.2, oy: -0.1 });
  });
});

describe("aacConfig (sound of the exported MP4)", () => {
  it("writes the AAC-LC AudioSpecificConfig players need", () => {
    expect([...aacConfig(44100, 2)]).toEqual([0x12, 0x10]);
    expect([...aacConfig(48000, 2)]).toEqual([0x11, 0x90]);
    expect([...aacConfig(48000, 1)]).toEqual([0x11, 0x88]);
  });
});

describe("rotationOf (phone videos stored turned)", () => {
  const F = 65536;
  it("reads the rotation from the track matrix", () => {
    expect(rotationOf([F, 0, 0, 0, F, 0, 0, 0, 0x40000000])).toBe(0);
    expect(rotationOf([0, F, 0, -F, 0, 0, 0, 0, 0x40000000])).toBe(90); // iPhone portrait
    expect(rotationOf([-F, 0, 0, 0, -F, 0, 0, 0, 0x40000000])).toBe(180);
    expect(rotationOf([0, -F, 0, F, 0, 0, 0, 0, 0x40000000])).toBe(270);
  });
});

describe("codecLabel", () => {
  it("names the formats of pro cameras", () => {
    expect(codecLabel("avc1.7a1033")).toMatch(/4:2:2 10-bit/);
    expect(codecLabel("avc1.640028")).toMatch(/^H.264 High ·/);
    expect(codecLabel("hvc1.4.10.L153.90")).toMatch(/4:2:2/);
  });
});
