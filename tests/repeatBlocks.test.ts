import { describe, expect, it } from "vitest";
import { findRepeat, findRepeats, foldedFit, melFrames, repeatPeriod, repeatPeriodIn } from "@/lib/repeatBlocks";
import { FA_VOCAB, ctcStarts } from "@/lib/forcedAlign";

describe("findRepeat", () => {
  it("the longest group of lines repeated word for word three times or more", () => {
    const block = ["Tout mais pas ça", "Non", "Non", "Non", "Non", "Tout mais pas ça"];
    const lines = ["Don't you wanna try", "Wanna try", "Wanna try", ...block, ...block, ...block, ...block];
    expect(findRepeat(lines)).toEqual({ from: 3, unit: 6, times: 4 });
  });
  it("a chorus in the intro and again at the end: two blocks, each found", () => {
    const block = ["Tout mais pas ça", "Non", "Non", "Non", "Non", "Tout mais pas ça"];
    const lines = [...block, ...block, ...block, ...block, "J'ai eu le malheur", "Don't you wanna try", ...block, ...block, ...block, ...block];
    expect(findRepeats(lines)).toEqual([{ from: 0, unit: 6, times: 4 }, { from: 26, unit: 6, times: 4 }]);
  });
  it("nothing repeated three times: null", () => {
    expect(findRepeat(["a b", "c d", "a b", "c d"])).toBeNull();
  });
});

describe("repeatPeriod", () => {
  it("finds the period a sound repeats with", () => {
    // 2 s of a pattern (a chirp then noise), repeated 5 times
    const rate = 16000, len = 2 * rate, x = new Float32Array(len * 5);
    let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
    const unit = Float32Array.from({ length: len }, (_, i) => (i < len / 2 ? Math.sin(2 * Math.PI * (200 + 2000 * (i / len)) * (i / rate)) : rnd() * 0.3));
    for (let k = 0; k < 5; k++) x.set(unit, k * len);
    const p = repeatPeriod(melFrames(x), 1.2, 3)!;
    expect(p.period).toBeCloseTo(2, 1);
    expect(p.score).toBeGreaterThan(0.5);
  });
});

describe("repeatPeriodIn", () => {
  it("finds the period of copies that fill only part of the passage (an intro's instrumental before them)", () => {
    const rate = 16000, len = 2 * rate, lead = 6 * rate, x = new Float32Array(lead + len * 4);
    let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
    // (the intro before it moves, as a real one: notes that never come back; a passage that holds one sound is alike to
    // itself at any distance, no period stands out there: nothing is found, never a wrong one)
    for (let i = 0; i < lead; i++) x[i] = Math.sin(2 * Math.PI * (150 + 37 * Math.floor(i / 3000)) * (i / rate)) * 0.4 + rnd() * 0.05;
    // each copy a short tune of 8 notes (a sung line)
    const notes = [220, 330, 262, 392, 294, 440, 247, 349];
    const unit = Float32Array.from({ length: len }, (_, i) => Math.sin(2 * Math.PI * notes[Math.floor((i / len) * 8)] * (i / rate)) * 0.6);
    for (let k = 0; k < 4; k++) x.set(unit, lead + k * len);
    const p = repeatPeriodIn(melFrames(x), 1.7, 3, 4)!; // (pure tones are alike to each other: a range away from the half)
    expect(p.period).toBeCloseTo(2, 1);
    expect(p.at).toBeGreaterThan(5);
  });
});

describe("foldedFit", () => {
  it("copies heard faintly, each in part, are heard together: the start and the words of a copy", () => {
    const V = 31, P = 100, times = 3, T = 50 + P * times + 20;
    const e = new Float32Array(T * V).fill(-8);
    for (let t = 0; t < T; t++) e[t * V] = -0.05;
    // the block "non oui" starts at frame 50 + 10 in each copy; each copy lets one letter be heard
    const hits: [number, string][] = [[0, "n"], [3, "o"], [6, "n"], [40, "o"], [43, "u"], [46, "i"]];
    hits.forEach(([f, c], i) => { const at = 50 + 10 + (i % times) * P + f; e[at * V] = -3; e[at * V + FA_VOCAB[c]] = -0.3; });
    const toks = [..."nonoui"].map((c) => FA_VOCAB[c]), owner = [0, 0, 0, 1, 1, 1];
    const fit = foldedFit(e, T, V, 0.5, 2.0, P * 0.02, times, toks, owner, (f, n, v, tk) => ctcStarts(f, n, v, tk))!;
    expect(fit.start + fit.wordStart[0]).toBeCloseTo(1.2, 1); // frame 60
    expect(fit.wordStart[1] - fit.wordStart[0]).toBeCloseTo(0.8, 1);
  });
});
