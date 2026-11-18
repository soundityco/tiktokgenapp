/**
 * Tags of the hooks and texts of a list, found here, without any AI: a lexicon of the ways artists promote a song
 * (French and English), each phrase with a weight. A text gets every tag that scores enough (several at once: a
 * teaser can also be a POV), the strongest first, three at most. The texts no tag fits are grouped by the words
 * they share, and the group is named after its main word.
 *
 * The tags, each with one clear meaning (a text gets it when this is what it does):
 *   when the song comes out — soon (announces it: a date, a countdown, pre-save, a teaser); out-now (it is out:
 *     available, link in bio, go stream it);
 *   what it talks about — emotional (a feeling: love, heartbreak, missing someone, loneliness, healing); story (what
 *     the song is about, why or when it was written); behind (how it was made: studio, writing, takes, other
 *     versions); lyric (puts a line, a verse, the chorus forward); compare (sounds like someone or something: an
 *     artist, a genre, an era, "X + Y =");
 *   how it grabs — pov (puts the viewer in a scene: POV, when you…); humour (a joke, irony, false modesty);
 *   pride (hype: your new favourite song, a banger, you're not ready); curiosity (keeps them till a moment: wait
 *   for the chorus, till the end, at 0:15, a twist); underdog (an unknown gem or artist: nobody talks about it,
 *   small artist, give it a chance); goal (a goal or a thank-you with the fans: if this gets 1000 likes, help me,
 *   thanks for the 10k streams); engage (asks something of them: a question, comment, tag, duet); reco (who it is
 *   for or when to play it: at night in the car, for your summer playlist).
 */

export interface ThemeDef { id: string; label: string; rules: [RegExp, number][] }

/** Lower case, no accents, apostrophes straight: the patterns below are written that way. */
export const plainText = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[’`´]/g, "'").replace(/[“”«»]/g, "\"").replace(/\s+/g, " ").trim();

const R = (src: string, w: number): [RegExp, number] => [new RegExp(src, "u"), w];

/** The lexicon's version: the tags found by the local model with an older one are found again. */
export const THEMES_VERSION = 2;

/** The tags found automatically, most specific first (on a tie, the first one comes first). Labels are English
 *  (translated on screen). */
export const THEMES: ThemeDef[] = [
  { id: "soon", label: "Coming soon", rules: [
    R("\\b(sort|sortira|arrive|debarque|tombe|drop(pe)?|dispo|disponible|en ligne)\\b.{0,25}\\b(minuit|demain|vendredi|ce soir|bientot|dans \\d+|le \\d+|cette semaine|lundi|mardi|mercredi|jeudi|samedi|dimanche|\\d{1,2}h)", 6),
    R("\\b(ce soir|demain|vendredi|minuit) ?(a )?\\d{1,2} ?h\\d{0,2}\\b|\\b\\d{1,2}h\\d{0,2}\\b.{0,15}(soyez la|rdv|rendez-vous)|\\b(soyez la|rdv|rendez-vous)\\b", 3.5),
    R("\\b(bientot|tres vite|coming soon|soon|dans \\d+ (jours?|heures?|h)|j-\\d+|d-\\d+|countdown|compte a rebours)\\b", 4),
    R("\\bplus que \\d+ ?(h|heures?|jours?|j|dodos?)\\b", 5),
    R("\\b(a minuit|ce vendredi|vendredi prochain)\\b", 2.5),
    R("\\b(pre-?save|presave|pre-?add|teaser|en avant-premiere|avant[- ]premiere|inedit|unreleased)\\b", 3.5),
    R("\\b(out (on|this|tomorrow|friday|at midnight|next)|drops? (on|tomorrow|friday|at|next)|dropping|releasing|coming out)\\b", 4.5),
    R("\\b(vous etes prets|t'es pret|tu es pret|get ready|are you ready|je le sors (ou|quand)|je sors (ce|le) son (ou|quand)|should i (drop|release))\\b", 3),
  ] },
  { id: "out-now", label: "Out now", rules: [
    R("\\b(est (enfin )?(sorti|dispo|disponible|la)|vient de sortir|enfin (sorti|dispo|la)|deja dispo|maintenant dispo|disponible (partout|maintenant)|c'est (le jour j|sorti)|il est (sorti|la)|ca y est)\\b", 5),
    R("\\b(out now|is out|it's out|now available|available now|on all platforms|sur toutes les plateformes|partout (sur|en streaming))\\b", 4.5),
    R("\\b(streame?z?|en streaming|lien en bio|link in bio|spotify|deezer|apple music)\\b", 2.5),
  ] },
  { id: "emotional", label: "Emotional", rules: [
    R("\\b(coeur (brise|en miettes)|pleur\\w*|larmes?|souffr\\w*|rupture|solitude|tu me manques|il me manque|elle me manque|triste\\w*|chagrin|douleur|blessure|deuil|angoisse\\w*|depression|guerir|gueri|cicatrices?|m'en remettre|s'en remettre|tourner la page)\\b", 3.5),
    R("\\b(je t'aime|amour|aime[rs]?|mon ex|ton ex|son ex|l'ex|histoire d'amour|relation|quitte[rs]?|oublier|souvenirs?|nostalgi\\w*|seul(e)? (le soir|la nuit|ce soir)|abandon\\w*)\\b", 2.5),
    R("\\b(heartbreak|heartbroken|broken heart|cry(ing)?|tears|breakup|break up|lonely|miss (you|her|him)|hurt(s|ing)?|pain|heal(ing)?|grief|my ex|your ex|in love|love song|moved on|move on)\\b", 3),
    R("(💔|🥀|😢|🥺)", 2.5),
  ] },
  { id: "story", label: "The story behind it", rules: [
    R("\\b(ce son|cette chanson|ce morceau|ce titre|this song|this track)\\b.{0,25}\\b(parle|raconte|est ne|vient|ecrit|about|is about|tells|was written)\\b", 5),
    R("\\b((?<!ne )parle de|raconte|histoire vraie|true story|inspire de|based on|ecrit (pour|apres|quand|en|le jour)|j'ai ecrit (ce|ca|cette)|i wrote (this|it)|wrote this (after|when|for)|dedie a|dedicated to)\\b", 4),
    R("\\b(l'histoire|une histoire|mon histoire|the story|pour mon pere|pour ma mere|pour ma grand-mere|for my (dad|mom|mum|grandma))\\b", 2.5),
  ] },
  { id: "behind", label: "Behind the scenes", rules: [
    R("\\b(studio|session|enregistr\\w*|prod|instru|beat|maquette|demo|compose\\w*|mix|master|clip|tournage|backstage|coulisses?|making of|behind the scenes|recording|producing)\\b", 3),
    R("\\b(en \\d+ (minutes?|heures?|nuits?|jours?)|in \\d+ (minutes?|hours?|days?)|premiere prise|first take|one take|en une prise|au telephone|voice memo|memo vocal)\\b", 3),
    R("\\b(version (piano|acoustique|guitare|live|a capella|acapella|slowed|speed ?up)|acoustic version|piano version|live version|stripped)\\b", 3.5),
  ] },
  { id: "lyric", label: "A line from the song", rules: [
    R("\\b(cette (phrase|ligne|punchline|rime|parole|phase)|ce (passage|couplet|vers|pont|bridge|texte)|ces paroles|les paroles|ecoute(z)? (bien )?les paroles|la punchline|cette punch)\\b", 4),
    R("\\b(this (line|lyric|verse|bridge|part)|the lyrics|these lyrics|that line|lyrics)\\b", 4),
    R("\\b(ce refrain|le refrain|the chorus|this chorus)\\b", 2),
    R("^[\"']|[\"']$|^.{0,40}:\\s*[\"']", 1.5),
  ] },
  { id: "compare", label: "Sounds like", rules: [
    R("^[^+=]{2,40}\\+[^+=]{2,40}(=|\\+)", 6),
    R("\\b(si .{2,30} et .{2,30} (avaient|faisaient|chantaient)|if .{2,30} and .{2,30} (had|made))\\b", 6),
    R("\\b(pour les fans de|si tu aimes|si t'aimes|si t'ecoutes|si tu ecoutes|ca sonne comme|on dirait (du|un son de|une chanson de)|dans le style de|style (annees )?\\d{2,4}|vibe (annees )?\\d{2,4}|sounds like|if you like|for fans of|meets|reminds? (me|you) of|mix entre|melange (de|entre)|croise de|la version \\w+ de)\\b", 4),
    R("\\b(annees (80|90|2000)|80s|90s|2000s|y2k|old school|a l'ancienne)\\b", 2.5),
  ] },
  { id: "pov", label: "POV / situation", rules: [
    R("^(pov|p\\.o\\.v)\\b", 6),
    R("\\b(pov|quand tu|toi quand|le moment ou|la fois ou|when you|me when|you when|that moment when|si toi aussi|toi aussi tu|celui qui|celle qui|the girl who|the guy who)\\b", 3),
  ] },
  { id: "humour", label: "Humour", rules: [
    R("\\b(en toute modestie|evidemment|bien sur que|tkt|t'inquiete|aucun rapport|mdr|ptdr|lol|jpp|humble|modestly|obviously|spoiler|mytho)\\b", 3.5),
    R("(^|\\s)(personne|no one|nobody) ?:", 4),
    R("\\((non|no|ou pas|jk|je rigole)\\)|\\bje rigole\\b|\\bjust kidding\\b", 4),
    R("(😂|🤣|😭|💀|🙃|🤡)", 2.5),
  ] },
  { id: "pride", label: "Hype / confidence", rules: [
    R("\\b(son prefere|ton (nouveau )?son prefere|ta (nouvelle )?chanson preferee|meilleur(e)? (son|morceau|titre|chanson)|tube|hit|classique|banger|frappe|dingue|criminel|chef[- ]d'oeuvre|your (new )?favou?rite (song|track)|best song|masterpiece|fire|goes hard)\\b", 4),
    R("\\b(prepare[zs]?-vous|tu vas (l')?adorer|tu vas pas t'en remettre|tu vas le (chanter|saigner|mettre en boucle)|en boucle|on repeat|you'?re not ready|you will love|va tout casser|va exploser)\\b", 3.5),
  ] },
  { id: "curiosity", label: "Listen till the end", rules: [
    R("\\b(attends?(-moi)? (bien )?(la fin|le refrain|le drop|la suite|le pont|le bridge|\\d)|ecoute(z)? jusqu'(a|au) (la fin|bout)|jusqu'au bout|jusqu'a la fin|reste(z)? jusqu'|regarde(z)? jusqu'|wait for (it|the)|till the end|until the end|to the end|wait till|stay till|personne (ne )?s'attendait|plot twist|retournement|la fin va)\\b", 5),
    R("\\b(le drop|the drop|a \\d:\\d\\d|at \\d:\\d\\d|0:\\d\\d|a la \\d+e? seconde|second \\d+)\\b", 3),
  ] },
  { id: "underdog", label: "Hidden gem / indie artist", rules: [
    R("\\b(personne (ne )?(parle|connait|ecoute)|personne n'(en )?parle|personne ne connait|aucune vue|0 vues?|peu de vues|petit artiste|artiste (inde|independant|emergent)|sous-?cote|pepite|meconnu|nobody (talks|knows|listens)|no one (talks|knows|listens)|underrated|hidden gem|small artist|independent artist|indie artist|donne(z)? (lui|moi|leur) (une )?chance|give (it|me) a chance|deserves? more)\\b", 4.5),
    R("\\b(commence la musique|debut(e|ant)|premier son|mon premier|first song|i'?m new|just started)\\b", 3),
  ] },
  { id: "goal", label: "Goal / support", rules: [
    R("\\b(si (ce|cette) (tiktok|video|post|son)|si on (atteint|arrive a|fait)|si (ca|cette video|ce tiktok) fait|objectif|aide[zr]?[- ]moi|j'ai besoin de (vous|toi)|soutien|soutenez|faites[- ]le (tourner|exploser)|faut que (ca|ce son) (tourne|explose)|help (me|this)|if this (gets|hits|reaches)|goal|support)\\b", 4.5),
    R("\\b(merci (pour|a vous|pour les)|\\d+ ?k? (likes|vues|streams|abonnes|followers)|thank you for)\\b", 3),
  ] },
  { id: "engage", label: "Question / call to action", rules: [
    R("\\?\\s*$", 2.5),
    R("\\b(dis[- ]moi|dites[- ]moi|commente\\w*|en commentaire|tag(ue)? (quelqu'un|ton|ta|un|une)|identifie|partage\\w*|abonne\\w*|duo|duet|stitch|comment (below|down|your)|drop a comment|tag someone|tell me|which one|lequel|laquelle|tu preferes|vous preferez|note (le|ce|de)|rate (it|this))\\b", 3.5),
  ] },
  { id: "reco", label: "For who / when to listen", rules: [
    R("\\b(a ecouter|son a (mettre|ecouter)|pour (ta|tes|ton) (playlist|soiree|route|voiture|trajet)|pour les (soirees|nuits|matins|trajets)|playlist|a mettre (en|dans)|for (your|those|anyone)|songs? for|to listen (to )?when|pour ceux qui|pour celles qui|pour toi qui)\\b", 3.5),
    R("\\b(en voiture|sous la douche|la nuit|a 3h|au lever|en soiree|road ?trip|late night|in the car|en ete|cet ete|summer)\\b", 2),
  ] },
];

/** Enough for a tag; and from how far behind the best a second or third one still goes with it. */
const THRESHOLD = 2.5;
const MAX_TAGS = 3;

/** The scores of one text for every tag. */
export function themeScores(text: string): { id: string; score: number }[] {
  const s = plainText(text.replace(/\|/g, " "));
  return THEMES.map((th) => ({ id: th.id, score: th.rules.reduce((sum, [re, w]) => sum + (re.test(s) ? w : 0), 0) }));
}

/** The tags of a text in the lexicon, the strongest first (none when nothing fits well enough). */
export function lexTags(text: string): string[] {
  return themeScores(text).filter((x) => x.score >= THRESHOLD).sort((a, b) => b.score - a.score).slice(0, MAX_TAGS).map((x) => x.id);
}

// ---------- the texts no theme fits: grouped by the words they share ----------

const STOP = new Set(("a au aux avec ce ces c'est cette d de des du elle en et eux il ils je j'ai la le les leur lui ma mais me mes moi mon ne nos notre nous on ou par pas pour qu que qui sa se ses si son sur ta te tes toi ton tu un une vos votre vous y est etre ai as avait fait faire tout tous tres plus bien comme quand dans meme encore aussi alors " +
  "the a an and or but of to in on at for with is are was be been it its this that these those i you he she we they me my your our their his her not no so just than then there here what who how all any can will would " +
  // The words every promo hook has (a group named after them says nothing).
  "son sons morceau morceaux titre titres chanson chansons musique single nouveau nouvelle nouvel song songs track tracks music new tiktok video").split(" "));
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
 * The tags of every text of a list found automatically: its theme set by hand (`manual`, by text key, the old single
 * theme) first, else the local model's tags (`ai`, when it ran on the list), else an older single theme of the model
 * (`oldAi`) with the lexicon's, else the lexicon's; the texts left without any are grouped by the words they share
 * ("group:<word>"), else [] (other).
 */
export function tagsOf(texts: string[], keyOf: (t: string) => string, manual: Record<string, string> = {}, ai: Record<string, string[]> = {}, oldAi: Record<string, string> = {}): string[][] {
  const out = texts.map((t) => {
    const k = keyOf(t);
    if (k in manual) return manual[k] ? [manual[k]] : [];
    if (k in ai) return ai[k];
    if (k in oldAi) return [...new Set([...(oldAi[k] ? [oldAi[k]] : []), ...lexTags(t)])].slice(0, MAX_TAGS);
    return lexTags(t);
  });
  const rest = out.map((v, i) => (v.length ? -1 : i)).filter((i) => i >= 0);
  for (const g of groupByWords(rest.map((i) => texts[i]))) for (const k of g.items) out[rest[k]] = [WORD_GROUP + g.name];
  return out;
}

/** A theme as shown: the lexicon's (translated), a word group ("« pluie »"), a name typed, or "Other". */
export function themeLabel(id: string, t: (s: string, p?: Record<string, string | number>) => string): string {
  if (!id) return t("Other");
  if (id.startsWith(WORD_GROUP)) return t("About “{word}”", { word: id.slice(WORD_GROUP.length) });
  const def = THEMES.find((x) => x.id === id);
  return def ? t(def.label) : id;
}

// ---------- the local model (public/themes/worker.js) ----------

/** How much a lexicon point weighs next to the model's score (tuned on promo hooks, see tests). */
export const LEX_WEIGHT = 0.3;
/**
 * Examples of each tag for the sentence model (French and English): a text is close in meaning to the examples of
 * the tags it gets. "none": everyday sentences, so a text about nothing of the kind is left out.
 */
export const THEME_EXAMPLES: Record<string, string[]> = {
  soon: ["Rendez-vous vendredi", "Vendredi, tout change", "Le son sort bientôt", "Mon nouveau titre arrive vendredi à minuit", "Plus que 3 jours avant la sortie", "Pre-save le lien en bio, ça sort demain", "Teaser du prochain son", "Je le sors ou pas ?", "New song dropping this friday", "Coming soon", "Countdown before the release"],
  "out-now": ["Le son est enfin disponible", "Mon nouveau single est sorti, va l'écouter", "Dispo partout maintenant", "Lien en bio pour l'écouter", "Ça y est, il est sorti", "C'est le jour J, il est là", "Out now on all platforms", "My new song is out", "Go stream it now"],
  emotional: ["J'ai pleuré en l'écrivant", "Pour ceux qui ont le cœur brisé", "Je pensais pas m'en remettre", "Tu me manques encore", "J'ai jamais réussi à l'oublier", "Ce sentiment quand tu te sens seul", "This song broke me", "Heartbreak hits different at night", "Missing someone who moved on"],
  story: ["Ce son raconte une histoire vraie", "Je l'ai écrit après une période difficile", "L'histoire derrière ce morceau", "Ce titre parle de mon père", "J'ai écrit cette chanson le jour où elle est partie", "Ce son je l'ai écrit pour ma petite sœur", "The story behind this song", "I wrote this after the worst year of my life"],
  behind: ["En studio en train d'enregistrer", "Comment j'ai fait l'instru", "Les coulisses du clip", "Première prise au micro", "Making of du son", "Version piano voix", "Version acoustique inédite", "La démo du son sur mon téléphone", "Studio session", "Recording the vocals"],
  lyric: ["Cette phrase me tue à chaque fois", "Écoute bien les paroles du deuxième couplet", "La punchline de ce son", "Ce passage est le plus vrai que j'ai écrit", "Les paroles de ce refrain", "This line hits so hard", "The lyrics in the bridge", "Read the lyrics"],
  compare: ["On me dit que je chante comme Adele", "Benson Boone + marguerite =", "Si Stromae et Angèle avaient fait un son ensemble", "Pour les fans de Billie Eilish", "Si tu aimes Damso, écoute ça", "Ça sonne comme du Daft Punk", "Un son des années 2000 en 2025", "Drake meets afrobeat", "If you like Frank Ocean you'll like this", "For fans of Arctic Monkeys", "Taylor Swift x Lana Del Rey"],
  pov: ["POV : tu réécoutes ses messages à 3h du matin", "Quand tu tombes sur ce son par hasard", "Toi quand le refrain arrive", "Le moment où tu réalises que c'est fini", "POV you just got dumped", "Me when the beat drops", "When you finally let go"],
  humour: ["Mon chien déteste mes sons", "Le son le plus humble de l'année (non)", "En toute modestie c'est un chef d'œuvre", "Personne : moi qui chante sous la douche", "Mdr j'ai écrit ça en 5 minutes", "Ma mère dit que c'est mon meilleur son, donc c'est vrai", "Nobody: me making a song about my cat", "Obviously the best song ever written (I'm biased)"],
  pride: ["Ton nouveau son préféré", "Le meilleur son que j'ai jamais fait", "Ce son va tout casser", "Un banger, rien à dire", "Ce refrain est criminel", "Tu vas le mettre en boucle", "Your new favourite song", "This one goes hard", "You're not ready for this"],
  curiosity: ["Attends le refrain", "Écoute jusqu'au bout", "Attends la fin, personne s'attendait à ça", "Le drop à 0:15", "Reste jusqu'à la fin", "Wait for the chorus", "Wait for it…", "Watch till the end"],
  underdog: ["Personne ne parle de ce son", "Je suis un petit artiste indépendant", "Ce son mérite plus de vues", "Donne une chance à ce son", "Le son le plus sous-coté de l'année", "Nobody knows this song", "Small artist, please give me a chance", "This deserves more streams"],
  goal: ["Si ce tiktok fait 1000 likes je sors le son", "Aidez-moi à faire tourner ce son", "Objectif 10 000 streams", "Merci pour les 100 000 vues", "J'ai besoin de vous pour que ce son explose", "If this gets 10k likes I'll drop it", "Help this song blow up", "Thank you for 1 million streams"],
  engage: ["Dis-moi en commentaire ce que tu en penses", "Couplet ou refrain, tu préfères quoi ?", "Tag quelqu'un qui doit écouter ça", "Fais un duo avec moi", "Note ce son sur 10", "Which part is your favourite?", "Duet this with your best friend", "Comment your favourite line"],
  reco: ["Le son à écouter en voiture la nuit", "À mettre dans ta playlist d'été", "Pour ceux qui ont besoin de se sentir moins seuls", "Le son parfait pour ta soirée", "À écouter sous la pluie", "Song for late night drives", "For anyone going through a breakup", "Add this to your summer playlist"],
  none: ["Je vais faire les courses", "Il pleut ce matin", "Le match de foot hier soir", "J'ai mangé une pizza", "Good morning everyone", "La météo de demain", "Mon chien est mignon", "Salut ça va", "Lyon", "Je suis fatigué aujourd'hui"],
};

/** The model's tags (scores relative to the text's own, see public/themes/worker.js): the best one, plus the ones
 *  this high; the lexicon's ones the model does not contradict (at least this); tuned on promo hooks (see tests). */
const MODEL_ALSO = 2, MODEL_AGREES = 0;
/** A lexicon score this strong (a POV, an "X + Y =", a date) always gives its tag, whatever the model says. */
const LEX_SURE = 4.5;

/**
 * A text's tags from the model's scores (per tag, with the lexicon already counted in) and the lexicon's: the best
 * one, plus the others high enough; none when the best is "none" (the text speaks of nothing of the kind); then the
 * lexicon's, when it is sure or the model agrees. Three at most, the strongest first.
 */
export function pickTags(scores: Record<string, number>, lex: Record<string, number> = {}): string[] {
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const best = ranked[0];
  const out: string[] = [];
  if (best && best[0] !== "none") for (const [id, s] of ranked) if (id !== "none" && (id === best[0] || s >= MODEL_ALSO)) out.push(id);
  const lexOk = Object.entries(lex).filter(([id, v]) => v >= LEX_SURE || (v >= THRESHOLD && (scores[id] ?? -Infinity) >= MODEL_AGREES))
    .sort((a, b) => b[1] - a[1]).map(([id]) => id);
  return [...new Set([...out.slice(0, MAX_TAGS), ...lexOk])].slice(0, MAX_TAGS);
}

/**
 * The examples the model reads for a list: the built-in ones, plus the texts tagged by hand in this list (each of
 * their tags learns from them, a tag of your own too: two texts at least), so the texts added later get them.
 */
export function examplesFor(texts: string[], ownTags: string[][]): Record<string, string[]> {
  const ex: Record<string, string[]> = Object.fromEntries(Object.entries(THEME_EXAMPLES).map(([k, v]) => [k, [...v]]));
  const mine = new Map<string, string[]>();
  ownTags.forEach((tags, i) => tags.forEach((tag) => { if (tag && !tag.startsWith(WORD_GROUP)) mine.set(tag, [...(mine.get(tag) ?? []), texts[i].replace(/\|/g, " ")]); }));
  for (const [tag, list] of mine) {
    if (ex[tag]) ex[tag].push(...list.slice(0, 12));
    else if (list.length >= 2) ex[tag] = list.slice(0, 12);
  }
  return ex;
}
