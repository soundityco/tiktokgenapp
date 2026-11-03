import { describe, expect, it } from "vitest";
import { activeCue, alignLyrics, buildCues, cleanHeard, norm } from "@/lib/lyricsAlign";
import type { LyricWord } from "@/lib/types";

const w = (text: string, s: number, e: number, line?: number): LyricWord => ({ w: text, s, e, ...(line === undefined ? {} : { line }) });

const LYRICS = `Je marche seul dans la nuit
Les étoiles me regardent
Et je chante pour toi
Rien ne m'arrête`;

describe("alignLyrics", () => {
  it("keeps the written spelling and the heard timing, dropping the verses that were not sung", () => {
    const heard = [w("les", 10, 10.2), w("étoiles", 10.2, 10.8), w("me", 10.8, 10.9), w("regardes", 10.9, 11.5),
      w("et", 12, 12.1), w("je", 12.1, 12.3), w("chante", 12.3, 12.8), w("pour", 12.8, 13), w("toi", 13, 13.5)];
    const r = alignLyrics(LYRICS, heard)!;
    expect(r).not.toBeNull();
    expect(r.words.map((x) => x.w)).toEqual(["Les", "étoiles", "me", "regardent", "Et", "je", "chante", "pour", "toi"]);
    expect(r.words[3].s).toBeCloseTo(10.9);
    expect(r.words[0].line).toBe(1);
    expect(r.coverage).toBeGreaterThan(0.8);
  });

  it("gives a time to words the model missed, between their neighbours", () => {
    const heard = [w("je", 1, 1.2), w("marche", 1.2, 1.7), w("dans", 2.4, 2.6), w("la", 2.6, 2.7), w("nuit", 2.7, 3.2)];
    const r = alignLyrics(LYRICS, heard)!;
    expect(r.words.map((x) => x.w)).toEqual(["Je", "marche", "seul", "dans", "la", "nuit"]);
    const seul = r.words[2];
    expect(seul.s).toBeGreaterThanOrEqual(1.7 - 1e-6);
    expect(seul.e).toBeLessThanOrEqual(2.4 + 1e-6);
    for (let i = 1; i < r.words.length; i++) expect(r.words[i].s).toBeGreaterThanOrEqual(r.words[i - 1].s - 1e-6);
  });

  it("picks the right chorus when the text repeats", () => {
    const text = "refrain un\nrefrain deux\nrefrain trois\ncouplet autre chose\nrefrain un\nrefrain deux\nrefrain trois";
    const heard = [w("refrain", 5, 5.4), w("un", 5.4, 5.7), w("refrain", 6, 6.4), w("deux", 6.4, 6.8)];
    const r = alignLyrics(text, heard)!;
    expect(r.words).toHaveLength(4);
    expect(r.words.map((x) => x.line)).toEqual([0, 0, 1, 1]);
  });

  it("refuses lyrics that are not what was heard", () => {
    expect(alignLyrics(LYRICS, [w("completely", 0, 1), w("different", 1, 2), w("words", 2, 3)])).toBeNull();
    expect(alignLyrics("", [w("a", 0, 1)])).toBeNull();
  });
});

describe("buildCues", () => {
  const words: LyricWord[] = [
    w("Je", 0, 0.2, 0), w("marche", 0.2, 0.7, 0), w("seul", 0.7, 1.1, 0), w("dans", 1.1, 1.3, 0), w("la", 1.3, 1.4, 0), w("nuit", 1.4, 2, 0),
    w("Les", 3, 3.2, 1), w("étoiles", 3.2, 3.8, 1), w("me", 3.8, 3.9, 1), w("regardent", 3.9, 4.6, 1),
  ];

  it("word mode gives one caption per word, never a cut word", () => {
    const cues = buildCues(words, "word");
    expect(cues.map((c) => c.text)).toEqual(words.map((x) => x.w));
    expect(cues[0].end).toBeCloseTo(0.2); // held until the next word: no flicker
  });

  it("phrase mode follows the lyrics lines and breaks long lines in a balanced way", () => {
    const cues = buildCues(words, "phrase", { lineChars: 14 });
    expect(cues).toHaveLength(2);
    expect(cues[0].start).toBe(0);
    expect(cues[1].start).toBe(3);
    const lines = cues[0].text.split("\n");
    expect(lines.length).toBe(2);
    expect(cues[0].text.replace(/\n/g, " ")).toBe("Je marche seul dans la nuit");
    expect(lines[0].split(" ").pop()).not.toBe("la"); // never ends a line on an article
    expect(lines[0].split(" ").pop()).not.toBe("dans");
  });

  it("splits phrases at pauses when there is no lyrics line information", () => {
    const heard = [w("hey", 0, 0.3), w("you", 0.3, 0.6), w("there", 0.6, 1), w("another", 2, 2.4), w("one", 2.4, 2.8)];
    expect(buildCues(heard, "phrase").map((c) => c.text)).toEqual(["hey you there", "another one"]);
  });

  it("only keeps the words of the requested window", () => {
    const cues = buildCues(words, "word", { from: 2.5, to: 4 });
    expect(cues.map((c) => c.text)).toEqual(["Les", "étoiles", "me", "regardent"]);
  });

  it("finds the caption shown at a given time", () => {
    const cues = buildCues(words, "phrase", { lineChars: 40 });
    expect(activeCue(cues, 1)?.text).toContain("Je marche");
    expect(activeCue(cues, 2.1)?.text).toContain("Je marche"); // short hold after the last word
    expect(activeCue(cues, 2.9)).toBeNull();
    expect(activeCue(cues, 3.5)?.text).toContain("Les");
  });
});

describe("cleanHeard", () => {
  it("orders words, fixes missing ends and removes overlaps", () => {
    const r = cleanHeard([w(" b ", 1, NaN), w("a", 0, 5), w("", 2, 3)]);
    expect(r.map((x) => x.w)).toEqual(["a", "b"]);
    expect(r[0].e).toBeLessThanOrEqual(1);
    expect(r[1].e).toBeGreaterThan(r[1].s);
  });
  it("norm strips accents and punctuation", () => {
    expect(norm("L'Étoile,")).toBe("letoile");
  });
});
