import { describe, expect, it } from "vitest";
import { buildCues, clearWordTiming, hasWordTiming, keepManual, retimeCue, retimeWordCue, shiftCue, syllables } from "@/lib/lyricsAlign";
import type { LyricWord } from "@/lib/types";

// Two phrases: "merci d'avoir été là" (0–2 s), then "pour moi" (3–4 s).
const W = (): LyricWord[] => [
  { w: "merci", s: 0, e: 0.5, line: 0 }, { w: "d'avoir", s: 0.6, e: 1.0, line: 0 }, { w: "été", s: 1.1, e: 1.5, line: 0 }, { w: "là", s: 1.6, e: 2.0, line: 0 },
  { w: "pour", s: 3.0, e: 3.4, line: 1 }, { w: "moi", s: 3.5, e: 4.0, line: 1 },
];
const phrases = (ws: LyricWord[]) => buildCues(ws, "phrase").map((c) => [c.text.replace(/\n/g, " "), c.start, c.end]);

describe("word-by-word timing, apart from the phrases", () => {
  it("a word retouched word by word never moves its phrase", () => {
    const ws = W();
    const before = phrases(ws);
    const cues = buildCues(ws, "word");
    const out = retimeWordCue(ws, cues, 1, "start", 0.3)!; // later: d'avoir appears at 0.9
    expect(out).not.toBeNull();
    expect(phrases(out)).toEqual(before);
    const moved = out.find((x) => x.w === "d'avoir")!;
    expect(moved.s).toBe(0.6);
    expect(moved.ws).toBe(0.9);
    expect(buildCues(out, "word")[1].start).toBe(0.9);
    // Earlier: merci leaves when d'avoir comes (its phrase timing untouched).
    const earlier = retimeWordCue(ws, cues, 1, "start", -0.3)!;
    expect(earlier.find((x) => x.w === "merci")!.wu).toBe(0.3);
    expect(phrases(earlier)).toEqual(before);
    // Its end later: the next word comes then.
    const longer = retimeWordCue(ws, cues, 1, "end", 0.4)!;
    expect(buildCues(longer, "word")[2].start).toBe(longer.find((x) => x.w === "d'avoir")!.wu);
    expect(phrases(longer)).toEqual(before);
    expect(hasWordTiming(out)).toBe(true);
    expect(hasWordTiming(clearWordTiming(out))).toBe(false);
  });
  it("a phrase retouched takes its word retouches with it", () => {
    const base = W();
    let ws = retimeWordCue(base, buildCues(base, "word"), 0, "start", 0.1)!;
    const first = buildCues(ws, "phrase")[0];
    ws = shiftCue(ws, first, 1);
    expect(ws.find((x) => x.w === "merci")!.ws).toBe(1.1);
    expect(buildCues(ws, "word")[0].start).toBe(1.1);
  });
  it("the phrases' own retouches still work as before", () => {
    const ws = W();
    const out = retimeCue(ws, buildCues(ws, "phrase"), 1, "start", -0.2)!;
    expect(buildCues(out, "phrase")[1].start).toBe(2.8);
  });
  it("spread: the words share their phrase by syllables, inside its real start and end", () => {
    const cues = buildCues(W(), "word", { wordTiming: "even" });
    expect(cues[0].start).toBe(0);
    const last = cues.find((c) => c.text === "là")!;
    expect(last.words[0].e).toBe(2);
    // merci (2) d'avoir (2) été (2) là (1): 7 syllables over 2 s
    expect(cues[1].start).toBeCloseTo((2 / 7) * 2, 2);
    expect(syllables("été")).toBe(2);
  });
  it("a retouch made word by word wins over the spread", () => {
    const base = W();
    const ws = retimeWordCue(base, buildCues(base, "word", { wordTiming: "even" }), 2, "start", 0.2)!;
    const shown = buildCues(ws, "word", { wordTiming: "even" })[2];
    expect(shown.start).toBeCloseTo(buildCues(W(), "word", { wordTiming: "even" })[2].start + 0.2, 2);
  });
  it("placing the lyrics again keeps the word-by-word retouches", () => {
    const base = W();
    const ws = retimeWordCue(base, buildCues(base, "word"), 3, "start", 0.1)!;
    const again = keepManual(ws, W());
    expect(again.find((x) => x.w === "là")!.ws).toBe(1.7);
  });
});
