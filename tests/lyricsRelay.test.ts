import { describe, expect, it } from "vitest";
import { mergeHeard, noSpeech, relayWeakLines } from "@/lib/lyricsRelay";
import { wordsFromSegments } from "@/lib/lyricsAlign";
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
    const out = relayWeakLines(words, wordsFromSegments([{ w: "Tout mais pas ça, non, non, tout mais pas ça", s: 10, e: 14 }]), 20);
    expect(out[0]).toEqual(words[0]);
    expect(out[2].s).toBeCloseTo(10, 0);
    expect(out[6].s).toBeGreaterThan(out[2].s);
    expect(out[8].s).toBeGreaterThan(out[7].s);
    expect(out[11].s).toBeLessThan(14.1);
    expect(out[2].doubt).toBeUndefined(); // found in a phrase: no longer to check
    // the line before lasts until the passage starts now
    expect(out[1].e).toBeGreaterThan(2.5);
  });
  it("a first word that took the break before it starts just before the next word", () => {
    const heard = [{ w: "tout", s: 10, e: 10.7 }, { w: "mais", s: 10.9, e: 11.1 }, { w: "pas", s: 11.1, e: 11.3 }, { w: "ça", s: 11.3, e: 11.6 },
      { w: "non", s: 12, e: 12.3 }, { w: "non", s: 12.5, e: 12.8 }, { w: "tout", s: 13, e: 13.2 }, { w: "mais", s: 13.2, e: 13.4 }, { w: "pas", s: 13.4, e: 13.6 }, { w: "ça", s: 13.6, e: 13.9 }];
    const out = relayWeakLines(words, heard, 20);
    expect(out[2].s).toBeCloseTo(10.65, 1); // "tout" 10 → 10.9 − 0.25
    expect(out[3].s).toBeCloseTo(10.9, 1);
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

describe("mergeHeard", () => {
  it("words heard one by one where there are some, the phrases' words only where there are none", () => {
    const byWord = [{ w: "tout", s: 10, e: 10.3 }, { w: "mais", s: 10.4, e: 10.6 }];
    const byPhrase = [{ w: "tout", s: 9.8, e: 10.2 }, { w: "non", s: 20, e: 20.3 }];
    expect(mergeHeard(byWord, byPhrase).map((x) => x.s)).toEqual([10, 10.4, 20]);
    expect(mergeHeard([], byPhrase)).toEqual(byPhrase);
  });
});
