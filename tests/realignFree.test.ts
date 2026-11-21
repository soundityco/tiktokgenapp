import { describe, expect, it } from "vitest";
import { FA_VOCAB } from "@/lib/forcedAlign";
import { realignFree } from "@/lib/lyricsPipeline";
import type { LyricWord } from "@/lib/types";

const V = 31;
/** Blank likely everywhere, except the letters of `hits` ([frame, letter]), 20 ms frames. */
function emis(T: number, hits: [number, string][]) {
  const e = new Float32Array(T * V).fill(-8);
  for (let t = 0; t < T; t++) e[t * V] = -0.01;
  for (const [t, c] of hits) { e[t * V] = -8; e[t * V + FA_VOCAB[c]] = -0.01; }
  return e;
}
const sung = (at: number, word: string): [number, string][] => [...word].map((c, i) => [at + i * 3, c]);

describe("realignFree", () => {
  it("a free line between two locked ones goes where it is sung in their room, not glued to the one before", () => {
    // "ok" sung at 6.0 s, "yeah" at 6.6 s; the locked lines end at 1 s and start at 10 s
    const T = 600;
    const em = { frames: emis(T, [...sung(300, "ok"), ...sung(330, "yeah")]), T, V };
    const words: LyricWord[] = [
      { w: "Avant", s: 0.2, e: 1, line: 0, lock: true },
      { w: "OK,", s: 1.02, e: 1.2, line: 1 }, { w: "yeah", s: 1.2, e: 1.5, line: 1 }, // (as fitted against the line before)
      { w: "Après", s: 10, e: 10.8, line: 2, lock: true },
    ];
    const out = realignFree(words, em);
    const ok = out.find((x) => x.w === "OK,")!, yeah = out.find((x) => x.w === "yeah")!;
    expect(ok.s).toBeGreaterThan(5.8); expect(ok.s).toBeLessThan(6.2);
    expect(yeah.s).toBeGreaterThan(6.4); expect(yeah.s).toBeLessThan(6.8);
    // the locked lines do not move
    expect(out.find((x) => x.w === "Avant")).toMatchObject({ s: 0.2, e: 1 });
    expect(out.find((x) => x.w === "Après")).toMatchObject({ s: 10, e: 10.8 });
  });
  it("nothing locked: unchanged", () => {
    const words: LyricWord[] = [{ w: "a", s: 1, e: 2, line: 0 }];
    expect(realignFree(words, { frames: emis(200, []), T: 200, V })).toBe(words);
  });
});
