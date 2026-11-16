import { describe, expect, it } from "vitest";
import { afterBreaks, contextBefore, packedLines, spreadPacked } from "@/lib/lyricsPipeline";
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

describe("spreadPacked", () => {
  it("lines hardly heard piled up after a line, then free time: they share it (the line before too), by letters", () => {
    const words = [
      w("Don't", 59.84, 0), w("you", 60, 0), w("wanna", 60.1, 0), w("try", 60.3, 0),
      w("Wanna", 60.46, 1, { weak: true }), w("try", 60.7, 1, { weak: true }),
      w("Wanna", 60.9, 2, { weak: true }), w("try", 61.1, 2, { weak: true }),
      w("Tout", 65.05, 3),
    ];
    const out = spreadPacked(words);
    expect(out[0].s).toBeCloseTo(59.84);
    expect(out[4].s).toBeGreaterThan(62);
    expect(out[6].s).toBeGreaterThan(63.3);
    expect(out[7].e).toBeLessThan(65.05);
    expect(out[8]).toEqual(words[8]);
  });
  it("lines heard, or piled up with no free time after them: nothing moves", () => {
    const heard = [w("a", 1, 0), w("b", 1.2, 1), w("c", 5, 2)];
    expect(spreadPacked(heard)).toEqual(heard);
    const busy = [w("a", 1, 0, { weak: true }), w("b", 1.2, 1, { weak: true }), w("c", 1.9, 2)];
    expect(spreadPacked(busy)).toEqual(busy);
  });
});
