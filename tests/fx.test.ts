import { describe, expect, it } from "vitest";
import { fxAt, heldFrame, newFx, strobeOn } from "@/lib/fx";

describe("effect clips", () => {
  it("a flash shows its colour count times over the clip, each for its share", () => {
    const c = { ...newFx("strobe", 10, "a"), to: 10.5, strobe: { color: "#fff", count: 5, on: 0.5 } };
    // each turn is 0.1 s: shown the first 0.05 s of it
    expect([10.01, 10.06, 10.11, 10.16, 10.49].map((t) => strobeOn(c, t))).toEqual([true, false, true, false, false]);
  });
  it("only the clips running then, the end excluded", () => {
    const a = newFx("zoom", 1, "a"), b = newFx("shutter", 1.5, "b");
    expect(fxAt([a, b], 1.2).map((x) => x.id)).toEqual(["a"]);
    expect(fxAt([a, b], 1.7).map((x) => x.id)).toEqual(["a", "b"]);
    expect(fxAt([a, b], 2).map((x) => x.id)).toEqual(["b"]);
  });
  it("a held frame changes at the lower frame rate", () => {
    const c = newFx("shutter", 0, "s");
    expect([0, 0.1, 0.124, 0.126, 0.25].map((t) => heldFrame(c, t, 8))).toEqual([0, 0, 0, 1, 2]);
  });
});

describe("effect layers", () => {
  it("a layer cut in two keeps its effects on both halves", async () => {
    const { splitFx } = await import("@/lib/fx");
    const c = { ...newFx("zoom", 2, "a"), to: 4 };
    const two = splitFx(c, 3, "b")!;
    expect(two.map((x) => [x.id, x.from, x.to, !!x.zoom])).toEqual([["a", 2, 3, true], ["b", 3, 4, true]]);
    expect(splitFx(c, 2.01, "x")).toBeNull();
  });
  it("a layer turned off is not drawn; the higher tracks come after the lower ones", () => {
    const a = { ...newFx("zoom", 0, "a"), track: 2 }, b = newFx("strobe", 0, "b"), c = { ...newFx("shutter", 0, "c"), track: 1, off: true };
    expect(fxAt([a, b, c], 0.2).map((x) => x.id)).toEqual(["b", "a"]);
  });
  it("a new layer is empty: its effects are chosen afterwards", () => {
    const e = newFx("empty", 1, "e", 1);
    expect([e.strobe, e.zoom, e.shutter, e.track]).toEqual([undefined, undefined, undefined, 1]);
  });
});
