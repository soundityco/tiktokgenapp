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
