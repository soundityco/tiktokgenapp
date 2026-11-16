import { describe, expect, it } from "vitest";
import { noSpeech, relayWeakLines } from "@/lib/lyricsRelay";
import type { LyricWord } from "@/lib/types";

const w = (text: string, s: number, line: number, extra: Partial<LyricWord> = {}): LyricWord => ({ w: text, s, e: s + 0.05, line, exact: true, ...extra });

describe("relayWeakLines", () => {
  const words: LyricWord[] = [
    w("je", 2, 0), w("chante", 2.4, 0),
    // a passage the alignment hardly heard: its lines piled up right after the line before
    w("bonjour", 3.0, 1, { weak: true, doubt: true }), w("toi", 3.05, 1, { weak: true, doubt: true }),
    w("encore", 3.1, 2, { weak: true, doubt: true }),
    w("salut", 3.15, 3, { weak: true, doubt: true }),
  ];
  it("lines found in the speech model's phrases take their time, the others share the time between, heard lines stay", () => {
    const out = relayWeakLines(words, [{ w: "Bonjour toi", s: 12, e: 13 }, { w: "Salut", s: 15, e: 16 }], 20);
    expect(out[0]).toEqual(words[0]);
    expect(out[2].s).toBeCloseTo(12);
    expect(out[5].s).toBeCloseTo(15);
    expect(out[4].s).toBeGreaterThan(12);
    expect(out[4].s).toBeLessThan(15);
    expect(out[2].doubt).toBeUndefined(); // matched: no longer to check
    expect(out[4].doubt).toBe(true); // placed between: still to check
  });
  it("nothing heard by the speech model either: nothing moves", () => {
    expect(relayWeakLines(words, [], 20)).toEqual(words);
  });
  it("a line the alignment placed within a second of its phrase keeps its own (finer) time", () => {
    // (line 1 not packed: a packed line always goes to its phrase)
    const near = words.map((x) => (x.line === 1 ? { ...x, s: x.s + 8.5, doubt: undefined } : x.line ? { ...x, s: x.s + 9 } : x));
    const out = relayWeakLines(near, [{ w: "Bonjour toi", s: 12, e: 13 }], 20);
    expect(out[2].s).toBeCloseTo(11.5);
  });
});

describe("noSpeech", () => {
  it("what the model says over music without words is no phrase", () => {
    for (const x of ["...", "Thank you.", "*musique*", "Musique", "Sous-titrage ST' 501", "Merci d'avoir regardé"]) expect(noSpeech(x)).toBe(true);
    for (const x of ["Don't you wanna try", "Non, non", "merci pour tout"]) expect(noSpeech(x)).toBe(false);
  });
});
