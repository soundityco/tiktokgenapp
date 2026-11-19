import { describe, expect, it } from "vitest";
import { buildCues, moveWordStart } from "../lib/lyricsAlign";
import type { LyricWord } from "../lib/types";

const words = (): LyricWord[] => [
  { w: "Je", s: 10, e: 10.3, line: 0 }, { w: "ne", s: 10.3, e: 10.6, line: 0 }, { w: "veux", s: 10.6, e: 11, line: 0 }, { w: "pas", s: 11, e: 11.5, line: 0 },
  { w: "Encore", s: 12, e: 12.6, line: 1 },
];

describe("word by word retouch", () => {
  it("moves a word's start between its neighbours, the word before ending there", () => {
    const all = words();
    const cue = buildCues(all, "phrase")[0];
    const out = moveWordStart(all, cue, 2, 10.8)!;
    expect(out[2].s).toBe(10.8);
    expect(out[1].e).toBe(10.8);
    expect(out[2].manual && out[1].manual).toBe(true);
    expect(out[0]).toBe(all[0]); // untouched words stay the same objects
  });
  it("never passes the word before nor the word after", () => {
    const all = words();
    const cue = buildCues(all, "phrase")[0];
    expect(moveWordStart(all, cue, 2, 9)![2].s).toBeCloseTo(10.35);
    expect(moveWordStart(all, cue, 2, 20)![2].s).toBeCloseTo(10.95);
  });
  it("leaves the line's first word to the line's own handle", () => {
    const all = words();
    const cue = buildCues(all, "phrase")[0];
    expect(moveWordStart(all, cue, 0, 9.5)).toBeNull();
  });
});
