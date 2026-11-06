/**
 * Themes of the hooks and texts of a list, found here, without any AI: a lexicon of the ways artists promote a
 * song (French and English), each phrase with a weight; the text goes to the theme that scores best. The texts
 * that match no theme are grouped by the words they share, and the group is named after its main word.
 */

export interface ThemeDef { id: string; label: string; rules: [RegExp, number][] }

/** Lower case, no accents, apostrophes straight: the patterns below are written that way. */
export const plainText = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[’`´]/g, "'").replace(/\s+/g, " ").trim();

const R = (src: string, w: number): [RegExp, number] => [new RegExp(src, "u"), w];

/** The themes, most specific first (on a tie, the first one wins). Labels are English (translated on screen). */
export const THEMES: ThemeDef[] = [
  { id: "soon", label: "Coming soon", rules: [
    R("\\b(sort|sortira|arrive|debarque|tombe|drop(pe)?)\\b.{0,25}\\b(minuit|demain|vendredi|ce soir|bientot|dans \\d+|le \\d+|cette semaine|lundi|mardi|mercredi|jeudi|samedi|dimanche)", 5),
    R("\\b(bientot|tres vite|coming soon|soon|dans \\d+ (jours?|heures?|h)|j-\\d+|d-\\d+|countdown|compte a rebours)\\b", 4),
    R("\\b(a minuit|demain|ce vendredi|vendredi|ce soir)\\b", 2.5),
    R("\\b(pre-?save|presave|teaser|extrait|snippet|en avant-premiere|avant[- ]premiere)\\b", 3.5),
    R("\\b(out (on|this|tomorrow|friday|at midnight)|drops? (on|tomorrow|friday|at)|dropping|releasing)\\b", 4.5),
    R("\\b(vous etes prets|t'es pret|tu es pret|get ready|are you ready)\\b", 2),
  ] },
  { id: "out-now", label: "Out now", rules: [
    R("\\b(est (enfin )?(sorti|dispo|disponible|la)|vient de sortir|enfin (sorti|dispo|la)|deja dispo|maintenant dispo|disponible (partout|maintenant))\\b", 5),
    R("\\b(dispo|disponible|out now|is out|it's out|now available|available now|on all platforms|sur toutes les plateformes)\\b", 4),
    R("\\b(streame?z?|streaming|ecoute[zr]?|lien en bio|link in bio|spotify|deezer|apple music|youtube)\\b", 2.5),
    R("\\b(nouveau son|nouveau single|nouvel? (album|ep|projet|titre)|new (song|single|track|music|ep|album))\\b", 1.5),
  ] },
  { id: "emotional", label: "Emotional", rules: [
    R("\\b(coeur|pleur\\w*|larmes?|souffr\\w*|rupture|seul(e)?|solitude|manque[sr]?|triste\\w*|tristesse|douleur|blessure|deuil|perdu|angoisse\\w*|peur|depression|guerir|gueri|cicatrices?|chagrin)\\b", 3),
    R("\\b(aime[rs]?|amour|je t'aime|mon ex|ton ex|l'ex|histoire d'amour|relation|quitte[rs]?|oublier|souvenirs?|nostalgi\\w*)\\b", 2.5),
    R("\\b(heart|cry(ing)?|tears|broke|breakup|lonely|alone|miss (you|her|him)|hurt|pain|heal(ing)?|grief|lost|love|ex)\\b", 2.5),
    R("\\b(m'a (fait|change|sauve)|grandir|j'ai compris|merci d'avoir|ce que j'ai vecu|vecu|pour toi qui)\\b", 2),
  ] },
  { id: "story", label: "The story behind it", rules: [
    R("\\b(ce son|cette chanson|ce morceau|ce titre|this song|this track)\\b.{0,25}\\b(parle|raconte|est ne|vient|ecrit|about|is about|tells)\\b", 5),
    R("\\b(parle de|raconte|histoire vraie|true story|inspire de|based on|ecrit (pour|apres|quand|en)|i wrote (this|it))\\b", 3.5),
    R("\\b(l'histoire|une histoire|mon histoire|the story)\\b", 2),
  ] },
  { id: "behind", label: "Behind the scenes", rules: [
    R("\\b(studio|session|enregistr\\w*|prod|instru|beat|maquette|demo|compose\\w*|mix|master|clip|tournage|backstage|coulisses?|making of|behind the scenes)\\b", 3),
    R("\\b(en \\d+ (minutes?|heures?|nuits?|jours?)|in \\d+ (minutes?|hours?|days?)|premiere prise|first take|one take)\\b", 2.5),
  ] },
  { id: "pov", label: "POV / situation", rules: [
    R("^(pov|p\\.o\\.v)\\b", 6),
    R("\\b(pov|quand tu|toi quand|le moment ou|la fois ou|when you|me when|that moment when|si toi aussi|toi aussi tu)\\b", 3),
  ] },
  { id: "humour", label: "Humour", rules: [
    R("\\b(en toute modestie|evidemment|bien sur|tkt|t'inquiete|aucun rapport|mdr|ptdr|lol|jpp|personne :|no one:|nobody:|humble|modestly|obviously)\\b", 3.5),
    R("(😂|🤣|😭|💀|🙃|🤡)", 2.5),
  ] },
  { id: "pride", label: "Hype / confidence", rules: [
    R("\\b(son prefere|ton (nouveau )?son prefere|meilleur(e)? (son|morceau|titre)|tube|hit|pepite|classique|banger|frappe|sous-?cote|underrated|your (new )?favou?rite (song|track)|best song|masterpiece)\\b", 4),
    R("\\b(prepare[zs]?-vous|tu vas (l')?adorer|tu vas pas t'en remettre|you'?re not ready|you will love)\\b", 3),
  ] },
  { id: "engage", label: "Question / call to action", rules: [
    R("\\?\\s*$", 2.5),
    R("\\b(dis[- ]moi|dites[- ]moi|commente\\w*|en commentaire|tag(ue)? (quelqu'un|ton|ta|un)|partage\\w*|abonne\\w*|duo|duet|stitch|comment|tag someone|tell me|which one|lequel|laquelle|tu preferes)\\b", 3.5),
  ] },
  { id: "reco", label: "For who / when to listen", rules: [
    R("\\b(a ecouter|son a (mettre|ecouter)|pour (ta|tes|les|ceux|celles|toi qui)|si tu aimes|si t'aimes|playlist|a mettre (en|dans)|for (your|those|anyone)|if you like|songs? for|to listen (to )?when)\\b", 3.5),
    R("\\b(en voiture|sous la douche|la nuit|a 3h|au lever|en soiree|road ?trip|late night|in the car)\\b", 2),
  ] },
];

const THRESHOLD = 2.5;

/** The scores of one text for every theme. */
export function themeScores(text: string): { id: string; score: number }[] {
  const s = plainText(text.replace(/\|/g, " "));
  return THEMES.map((th) => ({ id: th.id, score: th.rules.reduce((sum, [re, w]) => sum + (re.test(s) ? w : 0), 0) }));
}

/** The theme a text speaks of (its id), or null when nothing in the lexicon fits well enough. */
export function themeOfText(text: string): string | null {
  let best: { id: string; score: number } | null = null;
  for (const x of themeScores(text)) if (x.score >= THRESHOLD && (!best || x.score > best.score)) best = x;
  return best?.id ?? null;
}

// ---------- the texts no theme fits: grouped by the words they share ----------

const STOP = new Set(("a au aux avec ce ces c'est cette d de des du elle en et eux il ils je j'ai la le les leur lui ma mais me mes moi mon ne nos notre nous on ou par pas pour qu que qui sa se ses si son sur ta te tes toi ton tu un une vos votre vous y est etre ai as avait fait faire tout tous tres plus bien comme quand dans meme encore aussi alors " +
  "the a an and or but of to in on at for with is are was be been it its this that these those i you he she we they me my your our their his her not no so just than then there here what who how all any can will would").split(" "));
const words = (s: string) => plainText(s.replace(/\|/g, " ")).replace(/[^\p{L}\p{N}' ]+/gu, " ").split(/[ ']+/).filter((w) => w.length > 2 && !STOP.has(w));
/** A word and its plural / feminine land together. */
const stem = (w: string) => w.replace(/(es|s|e|x)$/, "");

/**
 * Groups texts by the words they share (two texts sharing a meaningful word, rare in the list, go together).
 * Each group of two or more is named after its most shared word; single texts stay apart.
 */
export function groupByWords(texts: string[]): { name: string; items: number[] }[] {
  const bags = texts.map((t) => new Set(words(t).map(stem)));
  const df = new Map<string, number>();
  bags.forEach((b) => b.forEach((w) => df.set(w, (df.get(w) ?? 0) + 1)));
  // Union-find on texts sharing a word that is neither unique nor in most of the list.
  const parent = texts.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const limit = Math.max(2, Math.ceil(texts.length * 0.4));
  const byWord = new Map<string, number[]>();
  bags.forEach((b, i) => b.forEach((w) => { const n = df.get(w)!; if (n >= 2 && n <= limit) byWord.set(w, [...(byWord.get(w) ?? []), i]); }));
  for (const ids of byWord.values()) for (const i of ids.slice(1)) parent[find(i)] = find(ids[0]);
  const groups = new Map<number, number[]>();
  texts.forEach((_, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), i]));
  return [...groups.values()].filter((g) => g.length >= 2).map((items) => {
    const count = new Map<string, number>();
    items.forEach((i) => bags[i].forEach((w) => { if ((df.get(w) ?? 0) >= 2) count.set(w, (count.get(w) ?? 0) + 1); }));
    // The most shared word; on a tie the longest (more telling), then the first in the alphabet.
    const top = [...count.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))[0]?.[0] ?? "";
    // The word as written in the first text that holds it (not its stem).
    const shown = items.map((i) => words(texts[i]).find((w) => stem(w) === top)).find(Boolean) ?? top;
    return { name: shown, items };
  });
}

/** Key of a hand-set theme: "group:<word>" for a word group, else a theme id or a name typed by the user. */
export const WORD_GROUP = "group:";

/**
 * The theme of every text of a list: set by hand (`manual`, by text key) first, else found in the lexicon,
 * else its word group, else "" (other).
 */
export function themesOf(texts: string[], keyOf: (t: string) => string, manual: Record<string, string> = {}): string[] {
  const out = texts.map((t) => manual[keyOf(t)] ?? themeOfText(t) ?? "");
  const rest = out.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
  for (const g of groupByWords(rest.map((i) => texts[i]))) for (const k of g.items) out[rest[k]] = WORD_GROUP + g.name;
  return out;
}

/** A theme as shown: the lexicon's (translated), a word group ("« pluie »"), a name typed, or "Other". */
export function themeLabel(id: string, t: (s: string, p?: Record<string, string | number>) => string): string {
  if (!id) return t("Other");
  if (id.startsWith(WORD_GROUP)) return t("About “{word}”", { word: id.slice(WORD_GROUP.length) });
  const def = THEMES.find((x) => x.id === id);
  return def ? t(def.label) : id;
}

/** The themes of a list, the biggest first ("other" last), with their texts' indexes. */
export function themeGroups(themes: string[]): { id: string; items: number[] }[] {
  const m = new Map<string, number[]>();
  themes.forEach((id, i) => m.set(id, [...(m.get(id) ?? []), i]));
  return [...m.entries()].map(([id, items]) => ({ id, items })).sort((a, b) => (a.id === "") === (b.id === "") ? b.items.length - a.items.length : a.id === "" ? 1 : -1);
}
