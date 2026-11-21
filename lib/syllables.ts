/**
 * Written syllables of a word (French and English), as character ranges of the word as written: "vouloir" → vou|loir,
 * "malheur" → mal|heur, "j'aimerais" → j'ai|me|rais, "revoir" → re|voir. Used to light a word syllable by syllable in
 * the "lit" lyrics, each syllable at the time the alignment heard it.
 *
 * Rules: a syllable has one vowel group (its nucleus: "ou", "oi", "eau"…); one consonant between two nuclei goes with
 * the next ("vou-loir"), two are split ("mal-heur") unless they hold together ("ch", "tr", "bl"…: "ma-chine",
 * "pa-trie"), of three or more the last one (or the last two holding together) go with the next. A final mute "e"
 * ("-e", "-es": "rêve", "enlacée", "times"; not "-ent", "mo-ment") stays with the syllable before; the "u" of "qu" is no vowel. Signs (apostrophes, commas,
 * "?") stay with their syllable. Never fewer than one range: a word with no vowel is one syllable.
 */

const VOWEL = /[aeiouyàâäéèêëîïôöùûüÿœæ]/i;
/** Two consonants that start a syllable together. */
const CLUSTERS = new Set(["bl", "br", "cl", "cr", "dr", "fl", "fr", "gl", "gr", "pl", "pr", "tr", "vr", "ch", "ph", "th", "gn", "sh", "wh", "qu", "gu"]);

/**
 * A word said letter by letter: "OK" (o-kay), an acronym in capitals with no vowel ("DJ", "TV", "PNL"): its letters
 * as character ranges (a sign after the last letter stays with it), else null.
 */
export function spelledOut(word: string): [number, number][] | null {
  const letters = [...word].map((c, i) => (/\p{L}/u.test(c) ? i : -1)).filter((i) => i >= 0);
  const bare = letters.map((i) => [...word][i]).join("");
  if (!/^ok$/i.test(bare) && !(/^[A-Z]{2,4}$/.test(bare) && !VOWEL.test(bare))) return null;
  const n = [...word].length;
  return letters.map((i, k) => [k === 0 ? 0 : i, k + 1 < letters.length ? letters[k + 1] : n] as [number, number]);
}

/** The syllables of `word` as [start, end) character ranges covering the whole word. */
export function syllableSpans(word: string): [number, number][] {
  const spelled = spelledOut(word);
  if (spelled) return spelled;
  const chars = [...word];
  const isL = (c: string) => /\p{L}/u.test(c);
  // which letters are vowels: "u" after "q" or "g" before a vowel is a consonant ("qui", "guerre"); "y" between vowels
  // too ("voyage")
  const vow = chars.map((c, i) => {
    if (!VOWEL.test(c)) return false;
    const l = c.toLowerCase(), prev = chars[i - 1]?.toLowerCase(), next = chars[i + 1];
    if (l === "u" && (prev === "q" || (prev === "g" && next && VOWEL.test(next)))) return false; // ("qu" always: "qu'est")
    if (l === "y" && prev && VOWEL.test(prev) && next && VOWEL.test(next)) return false;
    return true;
  });
  // nuclei: runs of vowels (an accented é/è followed by another vowel is two: "cré-er", "po-ème")
  const nuclei: [number, number][] = [];
  for (let i = 0; i < chars.length; i++) {
    if (!vow[i]) continue;
    let j = i + 1;
    while (j < chars.length && vow[j] && !/[éè]/i.test(chars[j - 1])) j++;
    nuclei.push([i, j]);
    i = j - 1;
  }
  // a final mute "e" (then nothing or "s"): with the syllable before
  if (nuclei.length > 1) {
    const [a, b] = nuclei[nuclei.length - 1];
    const tail = chars.slice(b).filter(isL).join("").toLowerCase();
    // (after a consonant, "rêve", or a vowel, "enlacée", "joue")
    if (b - a === 1 && chars[a].toLowerCase() === "e" && /^(|s)$/.test(tail) && a > 0) nuclei.pop();
  }
  if (nuclei.length <= 1) return [[0, chars.length]];
  // the cuts: in the consonants between two nuclei
  const cuts: number[] = [];
  for (let k = 0; k + 1 < nuclei.length; k++) {
    const from = nuclei[k][1], to = nuclei[k + 1][0];
    const cons: number[] = [];
    for (let i = from; i < to; i++) if (isL(chars[i])) cons.push(i);
    let cut: number;
    if (cons.length === 0) cut = to; // two nuclei side by side ("cré-er")
    else if (cons.length === 1) cut = cons[0];
    else {
      const last2 = (chars[cons[cons.length - 2]] + chars[cons[cons.length - 1]]).toLowerCase();
      cut = CLUSTERS.has(last2) ? cons[cons.length - 2] : cons[cons.length - 1];
    }
    // (a sign right before the cut, an apostrophe, stays with the syllable before)
    cuts.push(cut);
  }
  const spans: [number, number][] = [];
  let at = 0;
  for (const c of cuts) { spans.push([at, c]); at = c; }
  spans.push([at, chars.length]);
  // as string offsets (a character may take two code units)
  const off = [0];
  for (const c of chars) off.push(off[off.length - 1] + c.length);
  return spans.map(([a, b]) => [off[a], off[b]]);
}

/** The syllables of a word as strings (for tests and display). */
export const syllablesOf = (word: string) => syllableSpans(word).map(([a, b]) => word.slice(a, b));
