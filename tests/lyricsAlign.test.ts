import { describe, expect, it } from "vitest";
import { activeCue, alignLyrics, alignSong, buildCues, cleanHeard, norm, parseLyrics, partHeader, keepManual, repairOrder, retimeCue, rewriteCue, setCueEnd, shiftCue, splitCue } from "@/lib/lyricsAlign";
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

  it("places a whole song on a badly heard track: exact text, heard timing", () => {
    const song = Array.from({ length: 12 }, (_, k) => `ligne numero ${k} avec des mots chantes`).join("\n");
    const truth = song.split(/\s+/);
    const heard: LyricWord[] = [w("yeah", 0, 0.3), w("ouais", 0.4, 0.7)]; // ad-libs before the song
    truth.forEach((x, i) => {
      if (i % 5 === 2) return; // missed word
      const said = i % 7 === 3 ? "bla" : i % 4 === 1 ? x + "e" : x; // misheard, slightly misheard
      heard.push(w(said, 2 + i * 0.4, 2 + i * 0.4 + 0.3));
    });
    const r = alignLyrics(song, heard, 0.2)!;
    expect(r).not.toBeNull();
    expect(r.words.map((x) => x.w)).toEqual(truth);
    expect(r.words[1].s).toBeCloseTo(2.4);
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

  it("moves one line earlier or later, the others stay", () => {
    const cues = buildCues(words, "phrase", { lineChars: 40 });
    const moved = buildCues(shiftCue(words, cues[1], -0.3), "phrase", { lineChars: 40 });
    expect(moved[1].start).toBeCloseTo(2.7);
    expect(moved[1].text).toBe(cues[1].text);
    expect(moved[0].start).toBe(cues[0].start);
  });

  it("ends a line when set by hand, and keeps it when the line moves", () => {
    const cues = buildCues(words, "phrase", { lineChars: 40 });
    const cut = setCueEnd(words, cues[0], 1.6);
    expect(buildCues(cut, "phrase", { lineChars: 40 })[0].end).toBeCloseTo(1.6);
    const later = buildCues(shiftCue(cut, buildCues(cut, "phrase", { lineChars: 40 })[0], 0.2), "phrase", { lineChars: 40 });
    expect(later[0].end).toBeCloseTo(1.8);
  });

  it("+ on the end of a line glued to the next one makes the next one come later", () => {
    const o = { lineChars: 40 };
    // Two lines back to back: the first stays on screen until the second.
    const glued = [w("un", 0, 0.4, 0), w("deux", 0.4, 0.9, 0), w("trois", 1.1, 1.5, 1), w("quatre", 1.5, 2.2, 1)];
    const cues = buildCues(glued, "phrase", o);
    expect(cues[0].end).toBeCloseTo(cues[1].start);
    const out = retimeCue(glued, cues, 0, "end", 0.1)!;
    const after = buildCues(out, "phrase", o);
    expect(after[0].end).toBeCloseTo(cues[0].end + 0.1);
    expect(after[1].start).toBeCloseTo(cues[1].start + 0.1);
    expect(after[1].end).toBeCloseTo(cues[1].end); // the next line still leaves when it did
    // Pushed far: the next line is squeezed, it never passes the line after it, its words stay in order.
    const three = [...glued, w("cinq", 2.2, 2.6, 2), w("six", 2.6, 3.0, 2)];
    let ws = three;
    for (let k = 0; k < 8; k++) ws = retimeCue(ws, buildCues(ws, "phrase", o), 1, "end", 0.1) ?? ws;
    const c3 = buildCues(three, "phrase", o);
    for (let k = 0; k < 8; k++) ws = retimeCue(ws, buildCues(ws, "phrase", o), 0, "end", 0.1) ?? ws;
    const after3 = buildCues(ws, "phrase", o);
    expect(after3.map((c) => c.text)).toEqual(c3.map((c) => c.text));
    expect(after3[1].start).toBeLessThan(after3[2].start);
    expect(after3[1].end - after3[1].start).toBeGreaterThanOrEqual(0.19);
    // − on the start of the second line: the first one leaves sooner.
    const back = buildCues(retimeCue(glued, cues, 1, "start", -0.1)!, "phrase", o);
    expect(back[1].start).toBeCloseTo(cues[1].start - 0.1);
    expect(back[0].end).toBeCloseTo(back[1].start);
  });

  it("puts words saved out of the order of the text back in place", () => {
    // "mois" (line 0) was pushed after "Oh" (line 1), with an end before its new start.
    const broken = [w("depuis", 1.6, 1.8, 0), w("des", 1.8, 2.0, 0), { ...w("mois", 2.2, 2.4, 0), until: 2.1 }, w("Oh", 2.1, 2.3, 1), w("non", 2.5, 2.8, 1)];
    const fixed = repairOrder(broken);
    expect(buildCues(fixed, "phrase", { lineChars: 40 }).map((c) => c.text)).toEqual(["depuis des mois", "Oh non"]);
    expect(repairOrder(fixed)).toBe(fixed);
    expect(repairOrder(words)).toBe(words);
  });

  it("keeps the lines retimed by hand when the lyrics are placed again", () => {
    const cues = buildCues(words, "phrase", { lineChars: 40 });
    const shifted = shiftCue(words, cues[1], 0.4);
    const mine = setCueEnd(shifted, buildCues(shifted, "phrase", { lineChars: 40 })[1], 5.5);
    // Placed anew from the audio, with a word added at the start: the automatic timing is back everywhere but on the retouched line.
    const fresh = [w("Oh", 0, 0.1, 0), ...words.map((x) => ({ ...x, s: x.s + 0.05, e: x.e + 0.05 }))];
    const kept = buildCues(keepManual(mine, fresh), "phrase", { lineChars: 40 });
    expect(kept[1].start).toBeCloseTo(3.4);
    expect(kept[1].end).toBeCloseTo(5.5);
    expect(kept[0].start).toBe(0);
    expect(kept[0].text.startsWith("Oh")).toBe(true);
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

describe("parseLyrics (lyrics pasted as found online)", () => {
  it("recognises part titles, in French and English, with or without brackets", () => {
    for (const h of ["[Refrain]", "Couplet 1 :", "[Couplet 2 : Artiste]", "(Chorus)", "Pré-refrain", "[Pre-Chorus]", "Verse 2", "HOOK", "[Bridge]", "Pont", "Outro", "[Refrain x2]", "Refrain final"]) {
      expect(partHeader(h), h).not.toBeNull();
    }
    for (const l of ["Je refrain mes envies", "Hook me up tonight", "Verse after verse I fall", "(Ooh ooh)", "Le refrain de ma vie"]) {
      expect(partHeader(l), l).toBeNull();
    }
    expect(partHeader("[Refrain x2]")!.times).toBe(2);
  });

  it("removes the titles, writes out repeated parts and lines marked (x2)", () => {
    const r = parseLyrics(`[Couplet 1]
Je marche seul
Dans la nuit

[Refrain]
Oh oh je chante
Pour toi (x2)

[Couplet 2]
Les étoiles brillent

[Refrain]

[Outro]
Fin`);
    expect(r.text.split("\n")).toEqual([
      "Je marche seul", "Dans la nuit",
      "Oh oh je chante", "Pour toi", "Pour toi",
      "Les étoiles brillent",
      "Oh oh je chante", "Pour toi", "Pour toi",
      "Fin",
    ]);
    expect(r.parts).toEqual(["Couplet 1", "Refrain", "Couplet 2", "Refrain", "Outro"]);
  });

  it("repeats a part announced with x2", () => {
    expect(parseLyrics("[Hook x2]\nOn y va\nEncore").text.split("\n")).toEqual(["On y va", "Encore", "On y va", "Encore"]);
  });
});

describe("alignSong (whole song on the whole track)", () => {
  it("keeps every written word, even where the start of the song was badly heard", () => {
    const song = Array.from({ length: 10 }, (_, k) => `ligne ${k} avec des mots chantes ici`).join("\n");
    const truth = song.split(/\s+/);
    const heard: LyricWord[] = [w("merci", 0, 0.3)];
    truth.forEach((x, i) => {
      const said = i < 12 ? "zzz" + i : i % 6 === 2 ? "bla" : x; // the first two lines are not recognised at all
      if (i % 9 !== 4) heard.push(w(said, 2 + i * 0.4, 2 + i * 0.4 + 0.3));
    });
    const r = alignSong(song, heard)!;
    expect(r).not.toBeNull();
    expect(r.words.map((x) => x.w)).toEqual(truth);
    for (let i = 1; i < r.words.length; i++) expect(r.words[i].s).toBeGreaterThanOrEqual(r.words[i - 1].s - 1e-6);
    expect(r.words[30].s).toBeCloseTo(2 + 30 * 0.4);
  });

  it("does not invent a placement for unrelated lyrics", () => {
    const heard = "the quick brown fox jumps over the lazy dog again and again".split(" ").map((x, i) => w(x, i, i + 0.4));
    expect(alignSong("je marche seul dans la nuit\nles étoiles me regardent", heard)).toBeNull();
  });
});

describe("words the model did not hear", () => {
  it("are kept and stay on screen long enough, even with no room between their neighbours", () => {
    const heard = ["tu", "as", "fait", "le", "vide", "tout", "ce", "mal"].map((w, i) => ({ w, s: i * 0.3, e: i * 0.3 + 0.3 }));
    const r = alignSong("Tu as fait le vide de tout ce mal", heard)!;
    expect(r.words.map((x) => x.w).join(" ")).toBe("Tu as fait le vide de tout ce mal");
    const de = r.words.find((x) => x.w === "de")!;
    expect(de.e - de.s).toBeGreaterThanOrEqual(0.149);
    const vide = r.words.find((x) => x.w === "vide")!;
    expect(vide.e).toBeLessThanOrEqual(de.s + 1e-9);
  });
});

describe("captions retouched by hand", () => {
  const words = ["tu", "as", "fait", "le", "vide", "tout", "ce", "mal"].map((w, i) => ({ w, s: i * 0.3, e: i * 0.3 + 0.28, line: 3 }));
  const cue = buildCues(words, "phrase", { lineChars: 40 })[0];
  it("a line written again gets its missing word, spread over the caption", () => {
    const out = rewriteCue(words, cue, "tu as fait le vide de tout ce mal");
    expect(out.map((x) => x.w).join(" ")).toBe("tu as fait le vide de tout ce mal");
    expect(out.every((x) => x.manual && x.line === 3)).toBe(true);
    expect(out[0].s).toBe(0);
  });
  it("a line cut in two becomes two captions", () => {
    const out = splitCue(words, cue, 5);
    const cues = buildCues(out, "phrase", { lineChars: 40 });
    expect(cues.map((c) => c.text)).toEqual(["tu as fait le vide", "tout ce mal"]);
  });
  it("the cut stays when the lyrics are placed again", () => {
    const cut = splitCue(words, cue, 5);
    const again = words.map((x) => ({ ...x }));
    const kept = keepManual(cut, again);
    expect(buildCues(kept, "phrase", { lineChars: 40 }).length).toBe(2);
  });
});

describe("a line retimed by hand, placed again with a word it did not have", () => {
  it("the new word sits inside its line, between its neighbours, long enough to be seen", () => {
    // Before: the line without "de", moved 0.5 s later by hand.
    const prev = ["tu", "as", "fait", "le", "vide", "tout", "ce", "mal"].map((x, i) => ({ w: x, s: 0.5 + i * 0.3, e: 0.5 + i * 0.3 + 0.3, line: 2, manual: true }));
    // Placed again: "de" at the model's time (where the line was before it was moved).
    const next = ["tu", "as", "fait", "le", "vide", "de", "tout", "ce", "mal"].map((x, i) => ({ w: x, s: i * 0.28, e: i * 0.28 + 0.27, line: 2 }));
    const out = keepManual(prev, next);
    expect(out.map((x) => x.w).join(" ")).toBe("tu as fait le vide de tout ce mal");
    const de = out.find((x) => x.w === "de")!;
    expect(de.e - de.s).toBeGreaterThanOrEqual(0.149);
    expect(buildCues(out, "phrase", { lineChars: 60 }).map((c) => c.text)).toEqual(["tu as fait le vide de tout ce mal"]);
  });
});
