import { describe, it, expect } from "vitest";
import { syllableSpans, syllablesOf } from "@/lib/syllables";

describe("written syllables", () => {
  const cases: [string, string[]][] = [
    ["vouloir", ["vou", "loir"]],
    ["malheur", ["mal", "heur"]],
    ["revoir", ["re", "voir"]],
    ["j’aimerais", ["j’ai", "me", "rais"]],
    ["rêve", ["rêve"]],
    ["enlacée", ["en", "la", "cée"]],
    ["comprends", ["com", "prends"]],
    ["machine", ["ma", "chine"]],
    ["patrie", ["pa", "trie"]],
    ["créer", ["cré", "er"]],
    ["qu’est", ["qu’est"]],
    ["revenir,", ["re", "ve", "nir,"]],
    ["wanna", ["wan", "na"]],
    ["dancing", ["dan", "cing"]],
    ["again", ["a", "gain"]],
    ["try?", ["try?"]],
    ["Non", ["Non"]],
    ["voyage", ["vo", "yage"]],
    ["times", ["times"]],
    ["moment", ["mo", "ment"]],
    ["danses", ["danses"]],
    ["arrive,", ["ar", "rive,"]],
  ];
  for (const [w, want] of cases) it(w, () => expect(syllablesOf(w)).toEqual(want));
});

describe("words said letter by letter", () => {
  it("OK is two syllables, O|K, a sign kept with the last", () => {
    expect(syllableSpans("OK")).toEqual([[0, 1], [1, 2]]);
    expect(syllableSpans("OK,")).toEqual([[0, 1], [1, 3]]);
    expect(syllableSpans("ok")).toEqual([[0, 1], [1, 2]]);
  });
  it("an acronym in capitals with no vowel, one syllable a letter; a word in capitals stays as it is", () => {
    expect(syllableSpans("DJ")).toHaveLength(2);
    expect(syllableSpans("PNL")).toHaveLength(3);
    expect(syllableSpans("YEAH")).toHaveLength(1);
    expect(syllableSpans("NON")).toHaveLength(1);
  });
});
