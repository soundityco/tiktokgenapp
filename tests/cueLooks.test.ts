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

describe("a phrase lit word by word (the lit captions)", () => {
  it("counts the words sung: whole at once, or the one being sung for its part when filling", async () => {
    const { litWords } = await import("@/lib/render");
    const ws = [{ s: 1, e: 1.5 }, { s: 1.6, e: 2.6 }, { s: 3, e: 3.4 }];
    expect(litWords(ws, 0.5, false)).toBe(0);
    expect(litWords(ws, 1.2, false)).toBe(1);
    expect(litWords(ws, 1.7, false)).toBe(2);
    expect(litWords(ws, 2.1, true)).toBeCloseTo(1.5, 5);
    expect(litWords(ws, 2.8, true)).toBe(2);
    expect(litWords(ws, 9, true)).toBe(3);
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
