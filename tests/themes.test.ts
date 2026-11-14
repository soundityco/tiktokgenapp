import { describe, expect, it } from "vitest";
import { examplesFor, groupByWords, lexTags, pickTags, tagsOf, THEME_EXAMPLES, THEMES, WORD_GROUP } from "@/lib/themes";

describe("tags found locally (the lexicon)", () => {
  // Each hook: its tags, the main one first (a hook can do several things: announce and joke).
  const CASES: [string, string[]][] = [
    ["Benson Boone + marguerite =", ["compare"]],
    ["Si Stromae et Angèle avaient fait un son ensemble", ["compare"]],
    ["Pour les fans de Billie Eilish 🖤", ["compare"]],
    ["Ton nouveau son préféré sort à minuit (en toute modestie évidemment)", ["soon", "pride", "humour"]],
    ["Sortie vendredi, pre-save en bio", ["soon"]],
    ["Plus que 3 dodos avant la sortie", ["soon"]],
    ["Je le sors ou pas ?", ["soon", "engage"]],
    ["Le son est enfin dispo, lien en bio", ["out-now"]],
    ["Ça y est il est sorti, va le streamer", ["out-now"]],
    ["Out now on all platforms", ["out-now"]],
    ["J'ai pleuré en écrivant ce refrain", ["emotional", "lyric"]],
    ["Pour ceux qui ont le cœur brisé ce soir", ["emotional", "reco"]],
    ["Tu me manques encore", ["emotional"]],
    ["Ce son parle de mon père", ["story"]],
    ["J'ai écrit ce son le jour où elle est partie", ["story", "emotional"]],
    ["Enregistré en une nuit au studio", ["behind"]],
    ["Version piano voix de mon prochain son", ["behind"]],
    ["Cette phrase me détruit à chaque fois", ["lyric"]],
    ["Écoute bien les paroles du deuxième couplet", ["lyric"]],
    ["POV : tu réécoutes ses vocaux à 3h du mat", ["pov"]],
    ["Quand tu tombes sur ce son par hasard", ["pov"]],
    ["Le son le plus humble de l'année (non)", ["humour"]],
    ["Personne : moi qui chante sous la douche", ["humour"]],
    ["Ce refrain est criminel", ["pride", "lyric"]],
    ["Un banger, rien à dire", ["pride"]],
    ["Attends le refrain", ["curiosity"]],
    ["Écoute jusqu'au bout, personne s'attendait à ça", ["curiosity"]],
    ["Le drop à 0:15 🔥", ["curiosity"]],
    ["Personne ne parle de ce son", ["underdog"]],
    ["Petit artiste indé, donne une chance à ce son", ["underdog"]],
    ["Si ce tiktok fait 1000 likes je sors le son", ["goal", "soon"]],
    ["Merci pour les 100k streams 🙏", ["goal"]],
    ["Aidez-moi à faire tourner ce son", ["goal"]],
    ["Tu préfères le couplet ou le refrain ?", ["engage"]],
    ["Tag quelqu'un qui doit écouter ça", ["engage"]],
    ["Le son à écouter en voiture la nuit", ["reco"]],
    ["À mettre dans ta playlist d'été", ["reco"]],
    ["Comment j'ai fait l'instru en 10 minutes", ["behind"]],
    ["Nobody talks about this song", ["underdog"]],
    ["Wait for the chorus", ["curiosity"]],
    ["If this gets 10k likes I'll drop it", ["goal", "soon"]],
    ["Your new favourite song", ["pride"]],
    ["Bonjour", []],
  ];
  for (const [text, want] of CASES) it(`${text.slice(0, 40)}… → ${want.join(", ") || "none"}`, () => {
    const got = lexTags(text);
    if (!want.length) return expect(got).toEqual([]);
    expect(want).toContain(got[0]);
    for (const g of got) expect(want).toContain(g);
  });
  it("three tags at most, the strongest first", () => {
    expect(lexTags("Ton nouveau son préféré sort à minuit (en toute modestie évidemment)")).toEqual(["soon", "pride", "humour"]);
  });
  it("the French « comment » is not a call to comment", () => expect(lexTags("Comment j'ai fait l'instru en 10 minutes")).not.toContain("engage"));
});

describe("texts without a tag", () => {
  it("are grouped by the words they share", () => {
    const g = groupByWords(["Rouler sous la pluie", "La pluie de Paris", "Bonjour", "Paris la nuit", "Rouler encore"]);
    expect(g).toHaveLength(1);
    expect(g[0].items).toEqual([0, 1, 3, 4]);
    expect(["pluie", "paris", "rouler"]).toContain(g[0].name);
  });
  it("never by the words every hook has (son, morceau, song…)", () => {
    expect(groupByWords(["Un morceau pour Léa", "Ce morceau pour Tom", "Mon morceau du lundi"])).toEqual([]);
  });
});

describe("the tags of a list", () => {
  const key = (t: string) => t;
  it("a theme set by hand wins; then the lexicon, else a word group, else none", () => {
    const out = tagsOf(["Sort demain soir", "Pluie fine", "Encore la pluie", "Bonjour"], key, { "Sort demain soir": "Mes annonces" });
    expect(out).toEqual([["Mes annonces"], [WORD_GROUP + "pluie"], [WORD_GROUP + "pluie"], []]);
  });
  it("the model's tags (several, or none) win over the lexicon, an older single theme of the model goes with the lexicon's", () => {
    const out = tagsOf(["Sort demain soir", "Rien à voir", "POV : il pleut"], key, {}, { "Sort demain soir": ["pride", "soon"], "Rien à voir": [] }, { "POV : il pleut": "emotional" });
    expect(out).toEqual([["pride", "soon"], [], ["emotional", "pov"]]);
  });
});

describe("the model's tags", () => {
  it("the best one, the others high enough, none when it speaks of nothing of the kind", () => {
    expect(pickTags({ soon: 4.4, pride: 2.8, humour: 1.8, none: 0 })).toEqual(["soon", "pride"]);
    expect(pickTags({ none: 2.1, pride: 1.2 })).toEqual([]);
    expect(pickTags({ story: 1.5, emotional: 1.4 })).toEqual(["story"]);
  });
  it("the lexicon's tags when it is sure, or when the model does not contradict them", () => {
    expect(pickTags({ none: 3, pov: -1 }, { pov: 6 })).toEqual(["pov"]);
    expect(pickTags({ soon: 4.1, engage: 0.5 }, { soon: 3, engage: 2.5 })).toEqual(["soon", "engage"]);
    expect(pickTags({ soon: 4.1, engage: -0.4 }, { engage: 2.5 })).toEqual(["soon"]);
  });
  it("every tag has examples for the model, plus the off-topic ones", () => {
    for (const th of THEMES) expect(THEME_EXAMPLES[th.id]?.length ?? 0).toBeGreaterThan(5);
    expect(THEME_EXAMPLES.none.length).toBeGreaterThan(5);
  });
  it("learns from the texts tagged by hand: a tag of your own (two texts at least), more examples for a built-in one", () => {
    const ex = examplesFor(["A|b", "C", "D", "E"], [["Ma série"], ["Ma série", "pov"], ["Solo"], []]);
    expect(ex["Ma série"]).toEqual(["A b", "C"]);
    expect(ex.Solo).toBeUndefined();
    expect(ex.pov.at(-1)).toBe("C");
    expect(THEME_EXAMPLES.pov).not.toContain("C");
  });
});
