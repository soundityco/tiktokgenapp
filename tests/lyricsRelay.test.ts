import { describe, expect, it } from "vitest";
import { noSpeech, relayWeakLines } from "@/lib/lyricsRelay";
import type { LyricWord } from "@/lib/types";

const w = (text: string, s: number, line: number, extra: Partial<LyricWord> = {}): LyricWord => ({ w: text, s, e: s + 0.05, line, exact: true, ...extra });

describe("relayWeakLines", () => {
  // A line heard, then a passage the alignment hardly heard: its lines piled up right after it.
  const words: LyricWord[] = [
    w("je", 2, 0), w("chante", 2.4, 0),
    ...["tout", "mais", "pas", "ça"].map((x, i) => w(x, 3 + i * 0.01, 1, { weak: true, doubt: true })),
    w("non", 3.05, 2, { weak: true, doubt: true }), w("non", 3.06, 3, { weak: true, doubt: true }),
    ...["tout", "mais", "pas", "ça"].map((x, i) => w(x, 3.1 + i * 0.01, 4, { weak: true, doubt: true })),
  ];
  it("the passage's lines go on the speech model's phrases (one phrase can hold several lines), heard lines stay", () => {
    const out = relayWeakLines(words, [{ w: "Tout mais pas ça, non, non, tout mais pas ça", s: 10, e: 14 }], 20);
    expect(out[0]).toEqual(words[0]);
    expect(out[2].s).toBeCloseTo(10, 0);
    expect(out[6].s).toBeGreaterThan(out[2].s);
    expect(out[8].s).toBeGreaterThan(out[7].s);
    expect(out[11].s).toBeLessThan(14.1);
    expect(out[2].doubt).toBeUndefined(); // found in a phrase: no longer to check
    // the line before lasts until the passage starts now
    expect(out[1].e).toBeGreaterThan(2.5);
  });
  it("nothing heard by the speech model either: nothing moves", () => {
    expect(relayWeakLines(words, [], 20)).toEqual(words);
  });
});

describe("noSpeech", () => {
  it("what the model says over music without words is no phrase", () => {
    for (const x of ["...", "Thank you.", "*musique*", "Musique", "Sous-titrage ST' 501", "Merci d'avoir regardé"]) expect(noSpeech(x)).toBe(true);
    for (const x of ["Don't you wanna try", "Non, non", "merci pour tout"]) expect(noSpeech(x)).toBe(false);
  });
});
