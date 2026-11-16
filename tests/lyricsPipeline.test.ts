import { describe, expect, it } from "vitest";
import { afterBreaks, contextBefore, packedLines } from "@/lib/lyricsPipeline";
import type { LyricWord } from "@/lib/types";

const w = (text: string, s: number, line: number, extra: Partial<LyricWord> = {}): LyricWord => ({ w: text, s, e: s + 0.3, line, ...extra });

describe("afterBreaks", () => {
  it("a line hardly heard starting just before a cut in the production starts after it", () => {
    const words = [w("try", 60, 0), w("tout", 63.8, 1, { weak: true }), w("mais", 64.1, 1, { weak: true }), w("non", 67.3, 2, { weak: true })];
    const out = afterBreaks(words, [[64.75, 64.85]]);
    expect(out[1].s).toBeCloseTo(64.95);
    expect(out[2].s).toBeGreaterThan(out[1].s);
    expect(out[3]).toEqual(words[3]);
    expect(out[0]).toEqual(words[0]);
  });
  it("a line heard well stays, even before a cut", () => {
    const words = [w("tout", 63.8, 1), w("mais", 64.1, 1)];
    expect(afterBreaks(words, [[64.75, 64.85]])).toEqual(words);
  });
});

describe("contextBefore", () => {
  it("the last whole lines before the excerpt, as sentences, never a line cut in the middle", () => {
    const words = [w("Dans", 52, 0), w("tes", 52.3, 0), w("draps", 52.6, 0), w("Je", 55, 1), w("crois", 55.3, 1), w("non,", 57.6, 1), w("Don't", 59.8, 2)];
    expect(contextBefore(words, 56)).toBe("Dans tes draps.");
    expect(contextBefore(words, 58)).toBe("Dans tes draps. Je crois non.");
  });
});

describe("packedLines", () => {
  it("counts the lines shown less than 0.15 s before the next one", () => {
    expect(packedLines([w("a", 1, 0), w("b", 1.05, 1), w("c", 3, 2)])).toBe(1);
  });
});
