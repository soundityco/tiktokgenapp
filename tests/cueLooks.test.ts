import { describe, expect, it } from "vitest";
import { cueKey, cueStyle, styleDiff, wordKeys } from "@/lib/cueLooks";
import { buildCues } from "@/lib/lyricsAlign";
import type { LyricWord, TextStyle } from "@/lib/types";

const words = (): LyricWord[] => [
  { w: "Wanna", s: 1, e: 1.4, line: 0 }, { w: "try", s: 1.4, e: 1.8, line: 0 },
  { w: "Wanna", s: 3, e: 3.4, line: 1 }, { w: "try", s: 3.4, e: 3.8, line: 1 },
  { w: "oh", s: 6, e: 6.5 },
];
const base = { font: "inter", look: "outline", case: "asis", size: 60, width: 80, lineHeight: 1.1, align: "center", color: "#fff", accent: "#000", x: 50, y: 70 } as unknown as TextStyle;

describe("caption keys", () => {
  it("the same word in two lines has two keys; a word without a line is keyed by its time", () => {
    const k = wordKeys(words());
    expect([...k.values()]).toEqual(["0.0", "0.1", "1.0", "1.1", "t60"]);
  });
  it("the key survives a new timing of the same lyrics", () => {
    const a = words(), b = words().map((w) => ({ ...w, s: w.s + 0.3, e: w.e + 0.3 }));
    const ka = wordKeys(a), kb = wordKeys(b);
    const ca = buildCues(a, "word"), cb = buildCues(b, "word");
    expect(ca.slice(0, 4).map((c) => cueKey(c, "word", ka))).toEqual(cb.slice(0, 4).map((c) => cueKey(c, "word", kb)));
  });
  it("a word and the phrase it starts are two captions", () => {
    const w = words(), k = wordKeys(w);
    expect(cueKey(buildCues(w, "word")[0], "word", k)).toBe("word:0.0");
    expect(cueKey(buildCues(w, "phrase")[0], "phrase", k)).toBe("phrase:0.0");
  });
});

describe("a caption's own look", () => {
  it("only what differs is kept, and drawn over the lyrics' style", () => {
    const own = styleDiff(base, { ...base, size: 90, color: "#f00" });
    expect(own).toEqual({ size: 90, color: "#f00" });
    expect(cueStyle(base, own)).toEqual({ ...base, size: 90, color: "#f00" });
    expect(cueStyle(base, undefined)).toBe(base);
  });
});

describe("a line tapped (the tap mode)", () => {
  it("is put between the two taps, its words keeping their rhythm, retouched and no longer to check", async () => {
    const { placeLine } = await import("@/lib/lyricsAlign");
    const ws: LyricWord[] = [
      { w: "Wanna", s: 1, e: 1.4, line: 0, doubt: true }, { w: "try", s: 1.4, e: 2, line: 0, doubt: true },
      { w: "oh", s: 5, e: 5.5, line: 1 },
    ];
    const cue = buildCues(ws, "phrase")[0];
    const out = placeLine(ws, cue, 10, 12);
    expect(out[0]).toMatchObject({ s: 10, manual: true, doubt: undefined });
    // (the line as shown: from its first word to its end; each word moved in the same proportion into 10–12 s)
    const k = 2 / (cue.end - cue.start);
    expect(out[1].s).toBeCloseTo(10 + (1.4 - cue.start) * k, 3);
    expect(out[1].e).toBeCloseTo(10 + (2 - cue.start) * k, 3);
    expect(out[1].e).toBeLessThanOrEqual(12.001);
    expect(out[2]).toBe(ws[2]);
  });
});

describe("a locked line (syllables)", () => {
  it("keeps its words where they are and gets its syllables' times", async () => {
    const { inLines } = await import("@/lib/lyricsPipeline");
    const { FA_VOCAB } = await import("@/lib/forcedAlign");
    const V = Math.max(...Object.values(FA_VOCAB)) + 1, T = 500;
    const frames = new Float32Array(T * V).fill(Math.log(1e-4));
    // "je vouloir" heard from 1.0 s: j e at 1.0-1.2, v o u from 1.3, l o i r from 1.7
    const at: [string, number][] = [["j", 50], ["e", 55], ["v", 65], ["o", 68], ["u", 71], ["l", 85], ["o", 88], ["i", 91], ["r", 94]];
    for (const [c, f0] of at) for (let f = f0; f < f0 + 3; f++) frames[f * V + FA_VOCAB[c]] = 0;
    const ws: LyricWord[] = [{ w: "je", s: 1, e: 1.25, line: 0, lock: true }, { w: "vouloir", s: 1.3, e: 2, line: 0, lock: true }, { w: "fin", s: 4, e: 4.5, line: 1 }];
    const out = inLines(ws, { frames, T, V }, true);
    expect(out[1]).toMatchObject({ s: 1.3, e: 2, lock: true });
    expect(out[1].sy?.length).toBe(2);
    expect(out[1].sy![1]).toBeGreaterThan(0.4);
    expect(out[1].sy![1]).toBeLessThan(0.75);
  });
});

describe("Andy's hook « Don't you wanna try? » and « Wanna try » (unlocked to fix)", () => {
  it("no word drags nor two start together; « Wanna try » takes its locked twin's rhythm", async () => {
    const { inLines } = await import("@/lib/lyricsPipeline");
    const { FA_VOCAB } = await import("@/lib/forcedAlign");
    const V = Math.max(...Object.values(FA_VOCAB)) + 1, T = 4000;
    const em = { frames: new Float32Array(T * V).fill(Math.log(1 / V)), T, V }; // hardly heard
    const ws: LyricWord[] = [
      { w: "Don’t", line: 22, s: 60.02, e: 60.898, manual: true }, { w: "you", line: 22, s: 60.898, e: 60.969, manual: true },
      { w: "wanna", line: 22, s: 60.945, e: 61.107, manual: true }, { w: "try?", line: 22, s: 61.107, e: 61.25, until: 61.55, manual: true },
      { w: "Wanna", line: 23, s: 62.36, e: 62.758, manual: true, lock: true }, { w: "try", line: 23, s: 62.758, e: 62.89, until: 63.079, manual: true, lock: true },
      { w: "Wanna", line: 24, s: 63.156, e: 63.206, manual: true }, { w: "try", line: 24, s: 63.166, e: 63.216, until: 64.65, manual: true },
      { w: "Tout", line: 25, s: 65.58, e: 65.68, manual: true, lock: true },
    ];
    const out = inLines(ws, em, true);
    const hook = out.slice(0, 4).map((x) => x.s);
    expect(hook[0]).toBe(60.02);
    hook.slice(1).forEach((v, i) => expect(v - hook[i]).toBeGreaterThan(0.15)); // none together, « Don't » no longer dragging
    expect(hook[1] - hook[0]).toBeLessThan(0.6);
    expect(out[6].s).toBe(63.156);
    expect(out[7].s - out[6].s).toBeGreaterThan(0.3); // « try » after « Wanna », as in the line before
    expect(out.slice(4, 6).map((x) => x.s)).toEqual([62.36, 62.758]); // the locked one untouched
    expect(out[2].sy).toEqual([0, 0.5]); // « wan » then « na », lit one after the other
  });
});

describe("a word said again in a line (even rhythm)", () => {
  it("evens out « Non, non, non, non » with the first two eaten together", async () => {
    const { evenRepeats } = await import("@/lib/lyricsPipeline");
    const line: LyricWord[] = [
      { w: "Non,", line: 1, s: 17.52, e: 17.61 }, { w: "non,", line: 1, s: 17.61, e: 17.99 },
      { w: "non,", line: 1, s: 18.04, e: 18.19 }, { w: "non", line: 1, s: 18.25, e: 18.41 },
    ];
    const out = evenRepeats(line, 17.4)!;
    const gaps = out.slice(1).map((x, i) => x.s - out[i].s);
    gaps.forEach((g) => expect(g).toBeCloseTo((18.25 - 17.52) / 3, 2)); // even, from its start to its last word
    expect(out[0].s).toBe(17.52);
    expect(out[3].s).toBe(18.25);
    expect(evenRepeats([{ w: "tout", s: 1, e: 1.2 }, { w: "mais", s: 1.2, e: 1.4 }, { w: "pas", s: 1.4, e: 1.6 }], 0)).toBeNull();
  });
});

describe("Andy's intro « Non, non, non, non » (two words eaten together)", () => {
  it("takes the rhythm of the same line locked in the final chorus, its start and end kept", async () => {
    const { inLines } = await import("@/lib/lyricsPipeline");
    const { FA_VOCAB } = await import("@/lib/forcedAlign");
    const V = Math.max(...Object.values(FA_VOCAB)) + 1, T = 4500;
    const em = { frames: new Float32Array(T * V).fill(Math.log(1 / V)), T, V }; // nothing heard
    const ws: LyricWord[] = [
      { w: "Non,", line: 1, s: 17.52, e: 17.61, manual: true }, { w: "non,", line: 1, s: 17.61, e: 17.993, manual: true },
      { w: "non,", line: 1, s: 18.043, e: 18.194, until: 18.39, manual: true }, { w: "non", line: 1, s: 18.252, e: 18.412, until: 18.47, manual: true },
      { w: "Tout", line: 2, s: 18.47, e: 18.8, manual: true, lock: true },
      { w: "Non,", line: 26, s: 66.2, e: 66.44, manual: true, lock: true }, { w: "non,", line: 26, s: 66.48, e: 66.801, manual: true, lock: true },
      { w: "non,", line: 26, s: 66.841, e: 67.061, manual: true, lock: true }, { w: "non", line: 26, s: 67.101, e: 67.389, manual: true, lock: true },
      { w: "Tout", line: 27, s: 67.301, e: 67.441, manual: true, lock: true },
    ];
    const out = inLines(ws, em, true);
    const non = out.slice(0, 4).map((x) => x.s);
    expect(non[0]).toBe(17.52);
    const gaps = non.slice(1).map((v, i) => v - non[i]);
    gaps.forEach((g) => expect(g).toBeGreaterThan(0.18)); // no two eaten together
    expect(out[4].s).toBe(18.47); // the locked line after: untouched
    expect(out.slice(5).map((x) => x.s)).toEqual([66.2, 66.48, 66.841, 67.101, 67.301]);
  });
});

describe("a hardly heard line with a twin heard well (a chorus)", () => {
  it("takes its twin's rhythm", async () => {
    const { inLines } = await import("@/lib/lyricsPipeline");
    const { FA_VOCAB } = await import("@/lib/forcedAlign");
    const V = Math.max(...Object.values(FA_VOCAB)) + 1, T = 2000;
    const frames = new Float32Array(T * V).fill(Math.log(1e-4));
    // the first copy heard clearly: its letters, one a frame from 1.0 s ("toutmaispasa")
    const letters = [..."toutmaispasa"];
    letters.forEach((c, i) => { for (let f = 50 + i * 6; f < 56 + i * 6; f++) frames[f * V + FA_VOCAB[c]] = 0; });
    const em = { frames, T, V };
    const ws: LyricWord[] = [
      { w: "tout", s: 1, e: 1.3, line: 0 }, { w: "mais", s: 1.3, e: 1.6, line: 0 }, { w: "pas", s: 1.6, e: 1.9, line: 0 }, { w: "ça", s: 1.9, e: 2.4, line: 0 },
      { w: "tout", s: 10, e: 12, line: 1 }, { w: "mais", s: 12, e: 12.02, line: 1 }, { w: "pas", s: 12.02, e: 12.04, line: 1 }, { w: "ça", s: 12.04, e: 12.3, line: 1 },
      { w: "fin", s: 20, e: 20.5, line: 2 },
    ];
    const out = inLines(ws, em, false);
    const a = out.slice(0, 4).map((x) => x.s - out[0].s), b = out.slice(4, 8).map((x) => x.s - out[4].s);
    b.forEach((v, i) => expect(v).toBeCloseTo(a[i], 2));
  });
});

describe("lines piled on one instant (a repeated Non)", () => {
  it("share the room up to the next line; lines in time stay", async () => {
    const { unpileLines } = await import("@/lib/lyricsPipeline");
    const ws: LyricWord[] = [
      { w: "Non", s: 17.64, e: 17.9, line: 1 }, { w: "Non", s: 17.66, e: 17.9, line: 2 },
      { w: "Non", s: 18.16, e: 18.4, line: 3 }, { w: "Non", s: 18.42, e: 18.6, line: 4 },
    ];
    const out = unpileLines(ws);
    expect(out[0].s).toBe(17.64);
    expect(out[1].s).toBeCloseTo(17.9, 2);
    expect(out[2].s).toBe(18.16);
    expect(out[3].s).toBe(18.42);
  });
});

describe("locked lines (padlock)", () => {
  it("stay as they are when the lyrics are placed again from scratch; the others take the new placing", async () => {
    const { keepLocked } = await import("@/lib/lyricsAlign");
    const prev: LyricWord[] = [
      { w: "one", s: 1, e: 1.4, line: 0, lock: true }, { w: "two", s: 1.5, e: 2, line: 0, lock: true },
      { w: "three", s: 3, e: 3.5, line: 1, manual: true },
    ];
    const next: LyricWord[] = [{ w: "one", s: 1.3, e: 1.6, line: 0 }, { w: "two", s: 1.7, e: 2.1, line: 0 }, { w: "three", s: 3.4, e: 3.8, line: 1 }];
    const out = keepLocked(prev, next);
    expect(out.map((x) => x.s)).toEqual([1, 1.5, 3.4]);
    expect(out[0].lock).toBe(true);
  });
  it("a locked line keeps its times when the text is edited (re-placed on what was heard)", async () => {
    const { keepManual } = await import("@/lib/lyricsAlign");
    const prev: LyricWord[] = [{ w: "one", s: 1, e: 1.4, line: 0, lock: true }, { w: "two", s: 3, e: 3.5, line: 1 }];
    const next: LyricWord[] = [{ w: "one", s: 1.6, e: 2, line: 0 }, { w: "two", s: 3.2, e: 3.6, line: 1 }];
    const out = keepManual(prev, next);
    expect(out[0]).toMatchObject({ s: 1, e: 1.4, lock: true });
    expect(out[1].s).toBe(3.2);
  });
  it("the lines placed again never go over a locked line nor past it (the text's order)", async () => {
    const { keepLocked } = await import("@/lib/lyricsAlign");
    const prev: LyricWord[] = [
      { w: "a", s: 1, e: 1.5, line: 0 }, { w: "locked", s: 5, e: 6, line: 1, lock: true }, { w: "c", s: 7, e: 7.5, line: 2 },
    ];
    // the new placing puts line 0 over the locked line, line 2 before it
    const next: LyricWord[] = [{ w: "a", s: 5.5, e: 6.5, line: 0 }, { w: "locked", s: 2, e: 3, line: 1 }, { w: "c", s: 4, e: 4.5, line: 2 }];
    const out = keepLocked(prev, next);
    const at = (w: string) => out.find((x) => x.w === w)!;
    expect(at("locked").s).toBe(5);
    expect(at("a").e).toBeLessThanOrEqual(4.98 + 1e-9);
    expect(at("c").s).toBeGreaterThanOrEqual(6.02 - 1e-9);
    expect(at("a").e - at("a").s).toBeCloseTo(1, 5);
  });
});

describe("a line the model hardly hears (inLines)", () => {
  it("its words dragging or piled up share it by syllables; words that look sung stay", async () => {
    const { inLines } = await import("@/lib/lyricsPipeline");
    const { FA_VOCAB } = await import("@/lib/forcedAlign");
    const V = Math.max(...Object.values(FA_VOCAB)) + 1, T = 500;
    const em = { frames: new Float32Array(T * V).fill(Math.log(1 / V)), T, V }; // nothing heard anywhere
    const off: LyricWord[] = [
      { w: "Don't", s: 1, e: 3, line: 0 }, { w: "you", s: 3, e: 3.02, line: 0 }, { w: "wanna", s: 3.02, e: 3.04, line: 0 }, { w: "try", s: 3.04, e: 3.3, line: 0 },
      { w: "next", s: 5, e: 5.4, line: 1 },
    ];
    const out = inLines(off, em, false);
    expect(out[0].s).toBe(1);
    expect(out[1].s - out[0].s).toBeLessThan(0.6); // "Don't" no longer drags
    expect(out[2].s - out[1].s).toBeGreaterThan(0.2); // nor are the others piled
    const sung: LyricWord[] = [{ w: "tout", s: 1, e: 1.3, line: 0 }, { w: "mais", s: 1.3, e: 1.6, line: 0 }, { w: "pas", s: 1.6, e: 1.9, line: 0 }, { w: "ça", s: 1.9, e: 2.4, line: 0 }];
    expect(inLines(sung, em, true)).toEqual(sung);
  });
});

describe("first letter capital (sentence case)", () => {
  it("capitalises the sentence, not each line of it; the English I stays", async () => {
    const { sentenceCase } = await import("@/lib/render");
    expect(sentenceCase("DON'T YOU WANNA\nTRY ? i'll try")).toBe("Don't you wanna\ntry ? I'll try");
    expect(sentenceCase("on se perd. dans la nuit\n\nencore")).toBe("On se perd. Dans la nuit\n\nEncore");
    expect(sentenceCase("« oui » dit-il")).toBe("« Oui » dit-il");
  });
});

describe("signs standing alone in the written lyrics (French spacing)", () => {
  it("go with their word, joined by a no-break space: never dropped", async () => {
    const { splitWords } = await import("@/lib/lyricsAlign");
    expect(splitWords("J'ai eu le malheur de te revoir ?\n« oui » !").map((x) => x.w)).toEqual(
      ["J'ai", "eu", "le", "malheur", "de", "te", "revoir\u00a0?", "«\u00a0oui\u00a0»\u00a0!"]);
  });
});

describe("a word lit syllable by syllable (its syllables heard)", () => {
  it("lights « vou » then « loir », each at its time", async () => {
    const { litWords, LIT_LEAD: L } = await import("@/lib/render");
    const ws = [{ w: "vouloir", s: 1, e: 2, sy: [0, 0.5] }];
    expect(litWords(ws, 1.2 - L, false)).toBeCloseTo(3 / 7, 5); // « vou »
    expect(litWords(ws, 1.6 - L, false)).toBe(1); // « vou » + « loir »
    expect(litWords(ws, 1.05 - L, true)).toBeLessThan(3 / 7); // filling « vou »
    // no syllable heard: evenly (« wan » then « na »)
    expect(litWords([{ w: "wanna", s: 1, e: 2 }], 1.2 - L, false)).toBeCloseTo(3 / 5, 5);
  });
});

describe("a phrase lit word by word (the lit captions)", () => {
  it("counts the words sung: whole at once, or the one being sung for its part when filling", async () => {
    const { litWords, LIT_LEAD: L } = await import("@/lib/render");
    const ws = [{ s: 1, e: 1.5 }, { s: 1.6, e: 2.6 }, { s: 3, e: 3.4 }];
    expect(litWords(ws, 0.5, false)).toBe(0);
    expect(litWords(ws, 1 - L - 0.01, false)).toBe(0);
    expect(litWords(ws, 1 - L + 0.01, false)).toBe(1); // lit a hair before it is sung
    expect(litWords(ws, 1.7 - L, false)).toBe(2);
    expect(litWords(ws, 1.85 - L, true)).toBeCloseTo(1.5, 5); // filling: over 0.5 s at most
    expect(litWords(ws, 2.2 - L, true)).toBe(2);
    expect(litWords(ws, 9, true)).toBe(3);
  });
});

describe("a line across the segment's edge", () => {
  it("is kept whole in the segment's lyrics (never trimmed to the edge)", () => {
    const ws: LyricWord[] = [{ w: "one", s: 9, e: 9.5, line: 0 }, { w: "two", s: 9.6, e: 10.4, line: 0 }, { w: "three", s: 10.5, e: 11, line: 0 }];
    const cs = buildCues(ws, "phrase", { from: 10, to: 20 });
    expect(cs).toHaveLength(1);
    expect(cs[0].start).toBe(9);
    expect(cs[0].words).toHaveLength(3);
  });
});

describe("a line dragged whole", () => {
  it("keeps its length, stays between its neighbours, and the line before keeps its end", async () => {
    const { moveCueBy } = await import("@/lib/lyricsAlign");
    const ws: LyricWord[] = [
      { w: "one", s: 1, e: 1.5, line: 0 }, { w: "two", s: 1.6, e: 2, line: 0 },
      { w: "three", s: 3, e: 3.5, line: 1 }, { w: "four", s: 3.6, e: 4, line: 1 },
      { w: "five", s: 8, e: 8.5, line: 2 },
    ];
    const cs = buildCues(ws, "phrase");
    const len = cs[1].end - cs[1].start, before = cs[0].end;
    const out = moveCueBy(ws, cs, 1, 1.5)!;
    const after = buildCues(out, "phrase");
    expect(after[1].start).toBeCloseTo(cs[1].start + 1.5, 3);
    expect(after[1].end - after[1].start).toBeCloseTo(len, 3);
    expect(after[0].end).toBeCloseTo(before, 3);
    // never over the next line
    const far = buildCues(moveCueBy(ws, cs, 1, 100)!, "phrase");
    expect(far[1].end).toBeLessThanOrEqual(cs[2].start + 1e-6);
  });
});

describe("a line moved later by the ↓ arrow", () => {
  it("leaves the line before at its own end (never stretched to the moved line)", async () => {
    const { placeLine, setCueEnd } = await import("@/lib/lyricsAlign");
    let ws: LyricWord[] = [
      { w: "Wanna", s: 1, e: 1.4, line: 0 }, { w: "try", s: 1.4, e: 2, line: 0 },
      { w: "oh", s: 2.3, e: 2.8, line: 1 },
    ];
    let cs = buildCues(ws, "phrase");
    const before = cs[0].end;
    ws = placeLine(ws, cs[1], 5, 5.5);
    cs = buildCues(ws, "phrase");
    ws = setCueEnd(ws, cs[0], Math.max(cs[0].start + 0.1, Math.min(before, 5 - 0.04)));
    cs = buildCues(ws, "phrase");
    expect(cs[0].end).toBeCloseTo(before, 3);
    expect(cs[1].start).toBe(5);
  });
});

describe("a line's end shortened", () => {
  it("before its last word starts: the words drawn into what is left, the end kept (never glued back to the next)", async () => {
    const { setCueEnd, repairOrder } = await import("@/lib/lyricsAlign");
    const ws: LyricWord[] = [
      { w: "Tout", s: 1, e: 1.3, line: 0 }, { w: "mais", s: 1.3, e: 1.6, line: 0 }, { w: "ça", s: 1.6, e: 2.4, line: 0 },
      { w: "Non", s: 2.6, e: 3, line: 1 },
    ];
    let words = ws;
    for (let k = 0; k < 12; k++) {
      const c = buildCues(words, "phrase")[0];
      words = repairOrder(setCueEnd(words, c, Math.max(c.start + 0.2, c.end - 0.1)));
    }
    const c = buildCues(words, "phrase")[0];
    expect(c.end).toBeLessThan(1.5);
    expect(c.end).toBeLessThan(buildCues(words, "phrase")[1].start - 0.5);
  });
});
