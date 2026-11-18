import type { LyricWord } from "./types";
import { syllableSpans } from "./syllables";

/**
 * Forced alignment: the written lyrics are known, so nothing has to be recognised, only placed. A CTC model
 * (MMS-300M, wav2vec2) says, frame by frame (20 ms), how likely each letter is; the best path through them that spells
 * the written text, in order, gives the time of every letter, so of every word. Unlike speech recognition it does not
 * depend on the words being understood over the beat, and a repeated chorus is no harder than anything else.
 */

/** The letters the model knows (lowercase a-z and the apostrophe), by id; id 0 is the blank. */
export const FA_VOCAB: Record<string, number> = {
  a: 4, i: 5, e: 6, n: 7, o: 8, u: 9, t: 10, s: 11, r: 12, m: 13, k: 14, l: 15, d: 16, g: 17, h: 18, y: 19, b: 20, p: 21,
  w: 22, c: 23, v: 24, j: 25, z: 26, f: 27, "'": 28, q: 29, x: 30,
};
/** Seconds per frame of the model. */
export const FA_FRAME = 0.02;

/** A word as the model reads it: lowercase letters and apostrophes, no accents. Empty for "…", "4", "?!". */
export function faNorm(w: string): string {
  return w.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[’‘`´]/g, "'").replace(/œ/g, "oe").replace(/æ/g, "ae").replace(/ß/g, "ss").replace(/ø/g, "o").replace(/đ/g, "d").replace(/ł/g, "l")
    .replace(/[^a-z']/g, "");
}

/**
 * Cost of a blank frame inside a line (log-probability per 20 ms frame). Measured: 0.05 puts WANNA TRY's "Qu'est-ce qui
 * m'arrive" and its hook on the voice (0.7 s and 2.8 s early without it), sombr 53 → 61 % of lines within 0.5 s, the
 * other songs unchanged; more starts to hurt (Temper City 85 → 75 % at 0.15).
 */
export const FA_TUNE = { lineBlank: 0.05, unheard: 0.03, lead: 0.04, far: 0.4, french: true, weakLine: 0.3, deafRun: 0.12, clearLetter: 0.6 };

/** Lyrics in French (the letters of French spelling are far from its sounds): checked on frequent words and accents. */
export function looksFrench(words: string[]): boolean {
  const common = new Set(["je", "tu", "il", "elle", "on", "nous", "vous", "que", "qui", "pas", "les", "des", "est", "dans", "pour", "mais", "avec", "moi", "toi", "une", "et", "de", "la", "le", "ce", "ne", "plus", "tout", "comme", "sur"]);
  let hits = 0;
  for (const w of words) if (common.has(w) || /[éèêàùçâîôœ]/.test(w)) hits++;
  return words.length > 0 && hits / words.length > 0.15;
}

/**
 * A French word as it sounds, in the model's letters (it writes what it hears: "comprends" is heard "compran"): the
 * nasal "en"/"em" heard "an"/"am", the silent endings (s, t, d, x, z, p; "est") dropped. Only used to place the words;
 * the lyrics shown keep their spelling.
 */
export function frenchSound(w: string): string {
  let x = w;
  if (x === "est" || x.endsWith("'est")) x = x.slice(0, -2); // est → e, qu'est → qu'e
  if (x.length > 2) x = x.replace(/([aeiouy]|n|r|e)[stdxzp]+$/, "$1"); // pas → pa, draps → dra, comprends → compren
  if (x.length > 2 && /ent$/.test(w) && !/(ment|vent|dent|lent|cent)$/.test(w)) x = x.replace(/en$/, "e"); // ils chantent → chante
  x = x.replace(/(^|[^i])e([nm])(?=[^aeiouyn m]|$)/g, "$1a$2"); // comprends → compran, enlacée → anlacée (not "rien")
  return x || w;
}

/** Largest trellis (frames × letters) the alignment takes on: a few minutes of song. */
const MAX_CELLS = 450_000_000;

/**
 * The best path of the letters `toks` (ids, in order) through the frames: the frame each letter starts on, or null
 * when it cannot be done (more letters than frames, a trellis too big). `emis` = log-probabilities, T × V.
 */
export function ctcStarts(emis: Float32Array, T: number, V: number, toks: number[], bounds?: { lo: Int32Array; hi: Int32Array }, inLine?: Uint8Array): Int32Array | null {
  const N = toks.length;
  if (!N || T < N + 1 || (T * (N + 1)) > MAX_CELLS) return null;
  const W = N + 1;
  const bp = new Uint8Array(T * W); // 1: the letter j was emitted at this frame (else the blank was)
  let prev = new Float32Array(W).fill(-1e9);
  let cur = new Float32Array(W);
  prev[0] = 0;
  for (let t = 1; t < T; t++) {
    const row = (t - 1) * V;
    const blank = emis[row];
    cur[0] = prev[0] + blank;
    for (let j = 1; j <= N; j++) {
      // Inside a line the letters hug each other: a blank costs a little there (not between two lines), so the letters the
      // model does not hear (silent ones: the "s t" of "qu'est") stay with the rest of their line instead of sliding back
      // to the end of the line before.
      const stay = prev[j] + blank - (inLine && inLine[j] ? FA_TUNE.lineBlank : 0);
      // `bounds`: the frames a letter may be sung on (a word kept near the rest of its line).
      const ok = !bounds || ((t - 1) >= bounds.lo[j - 1] && (t - 1) <= bounds.hi[j - 1]);
      const adv = ok ? prev[j - 1] + emis[row + toks[j - 1]] : -1e9;
      if (adv > stay) { cur[j] = adv; bp[t * W + j] = 1; } else cur[j] = stay;
    }
    const sw = prev; prev = cur; cur = sw;
  }
  if (prev[N] < -1e8) return null;
  const start = new Int32Array(N).fill(-1);
  let j = N;
  for (let t = T - 1; t > 0 && j > 0; t--) {
    if (bp[t * W + j] === 1) { start[j - 1] = t - 1; j--; }
  }
  return j === 0 ? start : null;
}

/** Longest gap, in seconds, that can separate two words of one sung line. */
const MAX_GAP = 4;
const FPS = 1 / FA_FRAME;

/**
 * Every written word with its time, from the frames the model gave (`emis`, T × V log-probabilities). `written` = the
 * words of the lyrics with their line number. Words with no letter (numbers, signs) take the time right after the
 * word before. Null when the alignment cannot be done.
 *
 * Sung material that is not in the text (a hook repeated more than written, ad-libs) can pull the first words of a
 * line away from the rest of it. A line whose words end up far apart is aligned again with its stray words kept near
 * the main part of the line.
 */
export function alignWordsForced(emis: Float32Array, T: number, V: number, written: { w: string; line: number }[]): LyricWord[] | null {
  const toks: number[] = [];
  const owner: number[] = [];
  const french = FA_TUNE.french && looksFrench(written.map((x) => faNorm(x.w)));
  written.forEach((x, wi) => {
    const n = faNorm(x.w);
    for (const c of french ? frenchSound(n) : n) { const id = FA_VOCAB[c]; if (id !== undefined) { toks.push(id); owner.push(wi); } }
  });
  // State j (j letters done) is inside a line when letter j and letter j+1 belong to the same line.
  const inLine = new Uint8Array(toks.length + 1);
  for (let j = 1; j < toks.length; j++) inLine[j] = written[owner[j - 1]].line === written[owner[j]].line ? 1 : 0;
  let starts = ctcStarts(emis, T, V, toks, undefined, inLine);
  if (!starts) return null;
  const strayed = new Set<number>();
  let acc: { lo: Int32Array; hi: Int32Array } | undefined;
  for (let pass = 0; pass < 3; pass++) {
    const bounds = strayBounds(starts, toks.length, owner, written, T, strayed);
    if (!bounds) break;
    // The windows already set stay (a line put right must not go back when another is corrected).
    if (acc) for (let k = 0; k < toks.length; k++) { bounds.lo[k] = Math.max(bounds.lo[k], acc.lo[k]); bounds.hi[k] = Math.min(bounds.hi[k], acc.hi[k]); }
    const again = ctcStarts(emis, T, V, toks, bounds, inLine);
    if (!again) break;
    acc = bounds;
    starts = again;
  }
  // French only: swallowed syllables (elisions) are a French thing; in English a soft start ("I wish") is a true start.
  if (french) starts = startOnHeard(starts, toks, owner, written, emis, V);
  const words = wordsOf(starts, toks.length, owner, written);
  const bad = doubtfulLines(starts, toks, owner, written, emis, V, strayed);
  // Lines the model hardly heard (mean probability of their letters under FA_TUNE.weakLine): the relay may retime them.
  const sum = new Map<number, [number, number]>();
  const clear = new Set<number>(); // a letter heard clearly (the "t" of "Don't" at the hook's start): the line holds its place
  for (let k = 0; k < toks.length; k++) {
    const l = written[owner[k]].line, p = Math.exp(emis[starts[k] * V + toks[k]]);
    const c = sum.get(l) ?? [0, 0]; c[0] += p; c[1]++; sum.set(l, c);
    if (p > FA_TUNE.clearLetter) clear.add(l);
  }
  // Only whole passages hardly heard (the mean over all their letters under FA_TUNE.deafRun): fast rap is half heard
  // line after line and its alignment is still better than the speech model's phrases.
  const weak = new Set<number>();
  const order = [...sum.keys()];
  for (let i = 0; i < order.length;) {
    const low = (l: number) => { const [a, n] = sum.get(l)!; return a / n < FA_TUNE.weakLine; };
    if (!low(order[i])) { i++; continue; }
    let j = i, a = 0, n = 0;
    while (j < order.length && low(order[j])) { const [x, y] = sum.get(order[j])!; a += x; n += y; j++; }
    // (a letter heard clearly keeps a line out, as the "t" of a hook's "Don't" — not in a long passage hardly heard, where
    // one such letter shows up by chance in almost every line: a singer the model follows badly all along)
    if (a / n < FA_TUNE.deafRun) for (let k = i; k < j; k++) if (j - i >= 4 || !clear.has(order[k])) weak.add(order[k]);
    i = j;
  }
  return words.map((x) => {
    const l = x.line ?? -1;
    const c = sum.get(l);
    return { ...x, conf: c ? +(c[0] / c[1]).toFixed(3) : 0, ...(bad.has(l) ? { doubt: true } : null), ...(weak.has(l) ? { weak: true } : null) };
  });
}

/**
 * Per line: its letters, its pace (letters per second, up to the start of the next line: lines packed on top of each
 * other are the sign of a passage the model did not hear) and the mean log-probability of its letters on the path.
 */
export function lineStats(starts: Int32Array, toks: number[], owner: number[], written: { w: string; line: number }[], emis: Float32Array, V: number) {
  const acc = new Map<number, { letters: number; first: number; last: number; sum: number }>();
  for (let k = 0; k < toks.length; k++) {
    const line = written[owner[k]].line;
    const st = acc.get(line) ?? { letters: 0, first: Infinity, last: 0, sum: 0 };
    st.letters++;
    st.first = Math.min(st.first, starts[k]);
    st.last = Math.max(st.last, starts[k]);
    st.sum += emis[starts[k] * V + toks[k]];
    acc.set(line, st);
  }
  const lines = [...acc.keys()].sort((x, y) => x - y);
  const out = new Map<number, { letters: number; rate: number; conf: number }>();
  lines.forEach((line, i) => {
    const st = acc.get(line)!;
    const nextFirst = i + 1 < lines.length ? acc.get(lines[i + 1])!.first : st.last + 0.5 * FPS;
    out.set(line, { letters: st.letters, rate: st.letters / Math.max(0.1, (nextFirst - st.first) * FA_FRAME), conf: st.sum / st.letters });
  });
  return out;
}

/** Fastest believable pace, in letters per second up to the next line (measured: 24 at most on good rap, packed lines 30 to 50). */
const MAX_RATE = 26;

/** The lines whose place is doubtful: packed on the next one (a passage the model did not hear), or words that had strayed. */
function doubtfulLines(starts: Int32Array, toks: number[], owner: number[], written: { w: string; line: number }[], emis: Float32Array, V: number, strayed: Set<number>) {
  const bad = new Set<number>(strayed);
  for (const [line, st] of lineStats(starts, toks, owner, written, emis, V)) {
    if (st.letters >= 3 && st.rate > MAX_RATE) bad.add(line);
  }
  return bad;
}

/**
 * A line starts where its letters begin to be heard: the letters at its start the model did not hear at all (under
 * FA_TUNE.unheard: a syllable swallowed, "Qu'est-ce qui" sung "s'qui") have nothing to hold on to, and the path leaves
 * them anywhere after the line before, often on its last held note. When they were left far from the first letter
 * heard after them, they come right before it. A soft start that is still heard a little stays where it is.
 */
function startOnHeard(starts: Int32Array, toks: number[], owner: number[], written: { w: string; line: number }[], emis: Float32Array, V: number): Int32Array {
  const out = Int32Array.from(starts);
  const unheard = Math.log(FA_TUNE.unheard);
  const step = Math.max(1, Math.round(FA_TUNE.lead / FA_FRAME));
  for (let a = 0; a < toks.length;) {
    let b = a;
    while (b < toks.length && written[owner[b]].line === written[owner[a]].line) b++;
    let k = a;
    while (k < b && emis[starts[k] * V + toks[k]] < unheard) k++;
    if (k > a && k < b && (starts[k] - starts[a]) * FA_FRAME > FA_TUNE.far) {
      const floor = a > 0 ? out[a - 1] + 1 : 0;
      for (let j = a; j < k; j++) out[j] = Math.max(floor + (j - a), out[j], starts[k] - (k - j) * step);
    }
    a = b;
  }
  return out;
}

/** First and last frame of each word (from its letters), -1 for a word with no letter. */
function wordSpans(starts: Int32Array, owner: number[], n: number) {
  const first = new Array<number>(n).fill(-1), last = new Array<number>(n).fill(-1);
  for (let k = 0; k < starts.length; k++) {
    const o = owner[k];
    if (first[o] < 0) first[o] = starts[k];
    last[o] = starts[k];
  }
  return { first, last };
}

/** Frame windows for the letters of the words that strayed from their line, null when no line has strayed. */
function strayBounds(starts: Int32Array, N: number, owner: number[], written: { w: string; line: number }[], T: number, strayed: Set<number>) {
  const { first, last } = wordSpans(starts, owner, written.length);
  const lo = new Int32Array(N).fill(0), hi = new Int32Array(N).fill(T);
  let any = false;
  for (let a = 0; a < written.length;) {
    let b = a;
    while (b < written.length && written[b].line === written[a].line) b++;
    const ids: number[] = [];
    for (let w = a; w < b; w++) if (first[w] >= 0) ids.push(w);
    // The parts of the line, cut where two words are more than MAX_GAP apart.
    const parts: number[][] = [];
    for (const w of ids) {
      const cur = parts[parts.length - 1];
      if (cur && first[w] - last[cur[cur.length - 1]] > MAX_GAP * FPS) parts.push([w]);
      else if (cur) cur.push(w);
      else parts.push([w]);
    }
    if (parts.length > 1) {
      any = true;
      strayed.add(written[a].line);
      // The main part: the one with the most letters.
      const letters = (p: number[]) => p.reduce((n, w) => n + owner.filter((o) => o === w).length, 0);
      const main = parts.reduce((m, p) => (letters(p) > letters(m) ? p : m));
      const ms = first[main[0]], me = last[main[main.length - 1]];
      const ofWord = (w: number, from: number, to: number) => { for (let k = 0; k < owner.length; k++) if (owner[k] === w) { lo[k] = from; hi[k] = to; } };
      for (const p of parts) {
        for (let q = 0; q < p.length; q++) {
          const w = p[q];
          if (p === main) { ofWord(w, Math.max(0, ms - FPS), me + FPS); continue; }
          if (first[p[0]] < ms) {
            // Before the main part: within a second or so per word of it, ending at its start.
            const behind = main[0] - w;
            ofWord(w, Math.max(0, ms - Math.round(FPS * (behind + 0.5))), ms);
          } else {
            const ahead = w - main[main.length - 1];
            ofWord(w, me, Math.min(T, me + Math.round(FPS * (ahead + 0.5))));
          }
        }
      }
    }
    a = b;
  }
  return any ? { lo, hi } : null;
}

/** How long the last word of a line stays, at most: a held note, not the next line's time. */
const HOLD = 1.0;

/**
 * One line's words placed again inside its own span (`from`..`to`, s), on the model's letters there only. Where the line
 * is is already known (the alignment, the relay, the artist's arrows); inside a short span the letters are easy to
 * follow, where over the whole song a hard passage got its words piled up or spread evenly (a hook drowned in effects,
 * a line sung fast then slow). The line keeps its start (its first word starts at `from`) and its end; each word keeps
 * its other fields (`manual`, `until`…). Null when the span is too short for its letters.
 */
export function wordsInSpan(emis: Float32Array, T: number, V: number, line: LyricWord[], from: number, to: number, french = looksFrench(line.map((x) => faNorm(x.w)))): { words: LyricWord[]; heard: number } | null {
  const f0 = Math.max(0, Math.floor(from / FA_FRAME)), f1 = Math.min(T, Math.ceil(to / FA_FRAME)), n = f1 - f0;
  const toks: number[] = [], owner: number[] = [];
  line.forEach((x, wi) => { const w = faNorm(x.w); for (const c of french ? frenchSound(w) : w) { const id = FA_VOCAB[c]; if (id !== undefined) { toks.push(id); owner.push(wi); } } });
  if (line.length < 2 || !toks.length || n < toks.length + 2) return null;
  // (its first letter at its start, give or take 0.24 s: the line's start is trusted)
  const lo = new Int32Array(toks.length), hi = new Int32Array(toks.length).fill(n - 1);
  hi[0] = Math.min(n - 1, 12);
  const st = ctcStarts(emis.subarray(f0 * V, f1 * V), n, V, toks, { lo, hi });
  if (!st) return null;
  const placed = wordsOf(st, toks.length, owner, line.map((x) => ({ w: x.w, line: x.line ?? 0 })));
  const base = f0 * FA_FRAME;
  // How well the model hears it there: the mean probability of its letters on the path (0..1).
  let heard = 0;
  for (let k = 0; k < toks.length; k++) heard += Math.exp(emis[(f0 + st[k]) * V + toks[k]]);
  // When each syllable of each word starts: the first letter of each syllable of the word as the model reads it (its
  // sound for French), mapped onto the syllables as written (one for one, else by rank).
  const firstTok: number[] = []; // word -> its first token
  owner.forEach((o, k) => { if (firstTok[o] === undefined) firstTok[o] = k; });
  const sylTimes = (wi: number): number[] | null => {
    const n = faNorm(line[wi].w), sound = french ? frenchSound(n) : n;
    const shown = syllableSpans(line[wi].w).length;
    if (shown < 2 || firstTok[wi] === undefined) return null;
    // the letters of the sound that are tokens, in order: their place in `sound`
    const at: number[] = [];
    [...sound].forEach((c, ci) => { if (FA_VOCAB[c] !== undefined) at.push(ci); });
    const spans = syllableSpans(sound);
    if (spans.length < 2) return null;
    const starts = spans.map(([a]) => { const q = at.findIndex((ci) => ci >= a); return q < 0 ? null : base + st[firstTok[wi] + q] * FA_FRAME; });
    if (starts.some((x) => x === null)) return null;
    const pick = (k: number) => starts[shown === spans.length ? k : Math.round((k * (spans.length - 1)) / (shown - 1))]!;
    return Array.from({ length: shown }, (_, k) => pick(k));
  };
  let prev = from;
  const words = line.map((x, i) => {
    const s = i === 0 ? from : Math.max(prev + 0.01, Math.min(to - 0.05, base + placed[i].s));
    const e = Math.max(s + 0.05, Math.min(to, base + placed[i].e));
    prev = s;
    const t = sylTimes(i);
    // (as fractions of the word, increasing, the first 0; none when they make no sense)
    const sy = t ? t.map((v) => Math.min(0.95, Math.max(0, (v - s) / (e - s)))).map((v, k, a) => (k === 0 ? 0 : Math.max(v, a[k - 1] + 0.02))) : null;
    const { sy: _old, ...rest } = x;
    return { ...rest, s: Math.round(s * 1000) / 1000, e: Math.round(e * 1000) / 1000, ...(sy && sy[sy.length - 1] < 0.98 ? { sy: sy.map((v) => Math.round(v * 1000) / 1000) } : {}) };
  });
  return { words, heard: heard / toks.length };
}

function wordsOf(starts: Int32Array, N: number, owner: number[], written: { w: string; line: number }[]): LyricWord[] {
  const s = new Array<number>(written.length).fill(Infinity);
  const e = new Array<number>(written.length).fill(0);
  for (let k = 0; k < N; k++) {
    const at = starts[k] * FA_FRAME;
    const next = k + 1 < N ? starts[k + 1] * FA_FRAME : at + 0.2;
    const o = owner[k];
    s[o] = Math.min(s[o], at);
    e[o] = Math.max(e[o], Math.min(next, at + 0.4));
  }
  const out: LyricWord[] = [];
  let last = 0;
  written.forEach((x, wi) => {
    if (Number.isFinite(s[wi])) {
      out.push({ w: x.w, s: s[wi], e: Math.max(e[wi], s[wi] + 0.05), line: x.line, exact: true });
      last = out[out.length - 1].e;
    } else {
      // No letter to place: right after the word before, short.
      out.push({ w: x.w, s: last, e: last + 0.15, line: x.line, exact: true });
      last += 0.15;
    }
  });
  // The last word of a line is held (a note, a breath): it stays up to a second, never into the next line.
  for (let i = 0; i < out.length; i++) {
    if (i + 1 < out.length && out[i + 1].line === out[i].line) continue;
    const nextStart = i + 1 < out.length ? out[i + 1].s : Infinity;
    // (a final letter that landed late, on the next line's attack, does not stretch it: capped at HOLD)
    out[i] = { ...out[i], e: Math.max(out[i].s + 0.1, Math.min(out[i].s + HOLD, nextStart - 0.04)) };
  }
  return out;
}

