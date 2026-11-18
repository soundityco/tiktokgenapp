import { describe, it, expect } from "vitest";
import { syllablesOf } from "@/lib/syllables";

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
