import { describe, expect, it } from "vitest";
import { groupByWords, themeOfText, themesOf, WORD_GROUP } from "@/lib/themes";

describe("themes found locally", () => {
  const cases: [string, string | null][] = [
    ["Ton nouveau son préféré sort à minuit (en toute modestie évidemment)", "soon"],
    ["C'est un son qui parle de comment une histoire t'a fait grandir et changer en bien, même si elle a dû se terminer. Juste un gros merci en fait <3", "story"],
    ["Le son est enfin dispo, lien en bio", "out-now"],
    ["Out now on all platforms", "out-now"],
    ["J'ai pleuré en écrivant ce refrain", "emotional"],
    ["POV : tu réécoutes ses vocaux à 3h du mat", "pov"],
    ["Tu préfères le couplet ou le refrain ?", "engage"],
    ["Enregistré en une nuit au studio", "behind"],
    ["Le son à écouter en voiture la nuit", "reco"],
    ["Sortie vendredi, pre-save en bio", "soon"],
    ["Bonjour", null],
  ];
  for (const [text, id] of cases) it(`${text.slice(0, 40)}… → ${id}`, () => expect(themeOfText(text)).toBe(id));

  it("texts no theme fits are grouped by the words they share", () => {
    const g = groupByWords(["Rouler sous la pluie", "La pluie de Paris", "Bonjour", "Paris la nuit", "Rouler encore"]);
    expect(g).toHaveLength(1);
    expect(g[0].items).toEqual([0, 1, 3, 4]);
    expect(["pluie", "paris", "rouler"]).toContain(g[0].name);
  });

  it("a theme set by hand wins; the rest found, else grouped, else other", () => {
    const texts = ["Sort demain soir", "Pluie fine", "Encore la pluie", "Bonjour"];
    const out = themesOf(texts, (t) => t, { "Sort demain soir": "Mes annonces" });
    expect(out).toEqual(["Mes annonces", WORD_GROUP + "pluie", WORD_GROUP + "pluie", ""]);
  });
});

describe("the local model's themes", () => {
  it("win over the lexicon, lose to a theme set by hand; \"\" means no theme (then word groups)", () => {
    const texts = ["Sort demain soir", "Ce son est dingue", "Rien à voir", "Pluie fine", "Encore la pluie"];
    const out = themesOf(texts, (t) => t, { "Ce son est dingue": "Mes favoris" }, { "Sort demain soir": "pride", "Ce son est dingue": "pride", "Rien à voir": "", "Pluie fine": "", "Encore la pluie": "" });
    expect(out).toEqual(["pride", "Mes favoris", "", WORD_GROUP + "pluie", WORD_GROUP + "pluie"]);
  });
  it("every theme has examples for the model, plus the off-topic ones", async () => {
    const { THEMES, THEME_EXAMPLES } = await import("@/lib/themes");
    for (const th of THEMES) expect(THEME_EXAMPLES[th.id]?.length ?? 0).toBeGreaterThan(3);
    expect(THEME_EXAMPLES.none.length).toBeGreaterThan(3);
  });
});
