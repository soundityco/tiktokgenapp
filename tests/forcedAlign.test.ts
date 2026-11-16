import { describe, expect, it } from "vitest";
import { FA_VOCAB, alignWordsForced, ctcStarts, faNorm } from "@/lib/forcedAlign";

const V = 31;
/** Frames where the blank is likely, except the letters of `hits` ([frame, letter]). */
function emis(T: number, hits: [number, string][]) {
  const e = new Float32Array(T * V).fill(-8);
  for (let t = 0; t < T; t++) e[t * V] = -0.01;
  for (const [t, c] of hits) { e[t * V] = -8; e[t * V + FA_VOCAB[c]] = -0.01; }
  return e;
}

describe("faNorm", () => {
  it("lowercase letters and apostrophes, no accents", () => {
    expect(faNorm("Enlacée")).toBe("enlacee");
    expect(faNorm("J’ai")).toBe("j'ai");
    expect(faNorm("cœur")).toBe("coeur");
    expect(faNorm("4")).toBe("");
    expect(faNorm("(Oh)")).toBe("oh");
  });
});

describe("ctcStarts", () => {
  it("finds the frame of each letter, in order", () => {
    const e = emis(60, [[10, "a"], [20, "b"], [40, "c"]]);
    expect([...ctcStarts(e, 60, V, [FA_VOCAB.a, FA_VOCAB.b, FA_VOCAB.c])!]).toEqual([10, 20, 40]);
  });
  it("null when there are more letters than frames", () => {
    expect(ctcStarts(emis(2, []), 2, V, [4, 5, 6])).toBeNull();
  });
});

describe("alignWordsForced", () => {
  it("every written word keeps its spelling and gets its time; a word with no letter follows the one before", () => {
    const e = emis(200, [[20, "n"], [22, "o"], [23, "n"], [100, "o"], [102, "u"], [104, "i"]]);
    const words = alignWordsForced(e, 200, V, [{ w: "Non", line: 0 }, { w: "4", line: 0 }, { w: "Oui", line: 1 }])!;
    expect(words.map((x) => x.w)).toEqual(["Non", "4", "Oui"]);
    expect(words[0].s).toBeCloseTo(0.4);
    expect(words[1].s).toBeGreaterThanOrEqual(words[0].e - 1e-6);
    expect(words[2].s).toBeCloseTo(2.0);
    expect(words[2].line).toBe(1);
    expect(words.every((x) => x.e > x.s)).toBe(true);
    expect(words.some((x) => x.doubt)).toBe(false);
  });
  it("the same word sung four times is placed four times", () => {
    const hits: [number, string][] = [];
    [10, 50, 90, 130].forEach((f) => { hits.push([f, "n"], [f + 2, "o"], [f + 4, "n"]); });
    const words = alignWordsForced(emis(200, hits), 200, V, Array.from({ length: 4 }, () => ({ w: "Non", line: 0 })))!;
    expect(words.map((x) => Math.round(x.s * 50))).toEqual([10, 50, 90, 130]);
  });
});

describe("a word that strayed from its line", () => {
  it("is brought back next to the rest of the line", () => {
    // "a" sounds at 0.2 s (sung material that is not in the text) and again at 8 s, right before "b".
    const e = emis(600, [[10, "a"], [400, "a"], [410, "b"], [420, "o"]]);
    const words = alignWordsForced(e, 600, V, [{ w: "A", line: 0 }, { w: "Bo", line: 0 }])!;
    expect(words[0].s).toBeCloseTo(8, 0);
    expect(words[1].s).toBeCloseTo(8.2, 0);
    expect(words.every((x) => x.doubt)).toBe(true); // a line that had to be pulled back is one to check
  });
});

describe("lines to check", () => {
  it("lines packed on top of each other are marked, the others are not", () => {
    // Line 0 sung normally, then four lines of "non" all within a few frames.
    const written = [{ w: "abc", line: 0 }, ...[1, 2, 3, 4].map((l) => ({ w: "non", line: l }))];
    const words = alignWordsForced(emis(300, [[10, "a"], [14, "b"], [18, "c"], [100, "n"], [101, "o"], [102, "n"], [103, "n"], [104, "o"], [105, "n"], [106, "n"], [107, "o"], [108, "n"], [109, "n"], [110, "o"], [111, "n"]]), 300, V, written)!;
    expect(words[0].doubt).toBeUndefined();
    expect(words.slice(1).some((x) => x.doubt)).toBe(true);
  });
});
