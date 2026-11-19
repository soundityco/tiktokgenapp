import { describe, expect, it } from "vitest";
import { isOff, joinAt, onWindows, piecesOf, splitAt, togglePiece, wholeAgain } from "../lib/clipParts";

describe("clip parts", () => {
  it("cuts a clip and turns a piece off, the clip staying whole", () => {
    let p = splitAt({}, 4, 0, 10);
    p = splitAt(p, 6, 0, 10);
    expect(piecesOf(p, 0, 10)).toEqual([[0, 4], [4, 6], [6, 10]]);
    p = togglePiece(p, 5, 0, 10);
    expect(p.offParts).toEqual([[4, 6]]);
    expect(isOff(p, 3.9)).toBe(false);
    expect(isOff(p, 4)).toBe(true);
    expect(isOff(p, 5.99)).toBe(true);
    expect(isOff(p, 6)).toBe(false);
    p = togglePiece(p, 5, 0, 10);
    expect(p.offParts).toBeUndefined();
  });
  it("never cuts on another cut or at the edges", () => {
    const p = splitAt({}, 4, 0, 10);
    expect(splitAt(p, 4.05, 0, 10)).toBe(p);
    expect(splitAt(p, 0.05, 0, 10)).toBe(p);
    expect(splitAt(p, 9.95, 0, 10)).toBe(p);
  });
  it("joining two pieces keeps them off only if both were", () => {
    let p = splitAt(splitAt({}, 4, 0, 10), 6, 0, 10);
    p = togglePiece(p, 5, 0, 10);
    const j = joinAt(p, 6, 0.2, 0, 10);
    expect(j.splits).toEqual([4]);
    expect(j.offParts).toBeUndefined();
    p = togglePiece(p, 8, 0, 10);
    expect(p.offParts).toEqual([[4, 10]]);
    expect(joinAt(p, 6, 0.2, 0, 10).offParts).toEqual([[4, 10]]);
    expect(wholeAgain(p)).toEqual({ splits: undefined, offParts: undefined });
  });
  it("gives the windows where the clip is on, in official time", () => {
    const p = togglePiece(splitAt(splitAt({}, 4, 0, 10), 6, 0, 10), 5, 0, 10);
    expect(onWindows(p, 20, 30, 20)).toEqual([[20, 24], [26, 30]]);
    expect(onWindows({}, 20, 30, 20)).toEqual([[20, 30]]);
  });
});
