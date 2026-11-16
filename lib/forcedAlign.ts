import type { LyricWord } from "./types";

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

/** Largest trellis (frames × letters) the alignment takes on: a few minutes of song. */
const MAX_CELLS = 450_000_000;

/**
 * The best path of the letters `toks` (ids, in order) through the frames: the frame each letter starts on, or null
 * when it cannot be done (more letters than frames, a trellis too big). `emis` = log-probabilities, T × V.
 */
export function ctcStarts(emis: Float32Array, T: number, V: number, toks: number[], bounds?: { lo: Int32Array; hi: Int32Array }): Int32Array | null {
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
      const stay = prev[j] + blank;
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
  written.forEach((x, wi) => {
    for (const c of faNorm(x.w)) { const id = FA_VOCAB[c]; if (id !== undefined) { toks.push(id); owner.push(wi); } }
  });
  let starts = ctcStarts(emis, T, V, toks);
  if (!starts) return null;
  let acc: { lo: Int32Array; hi: Int32Array } | undefined;
  for (let pass = 0; pass < 3; pass++) {
    const bounds = strayBounds(starts, toks.length, owner, written, T);
    if (!bounds) break;
    // The windows already set stay (a line put right must not go back when another is corrected).
    if (acc) for (let k = 0; k < toks.length; k++) { bounds.lo[k] = Math.max(bounds.lo[k], acc.lo[k]); bounds.hi[k] = Math.min(bounds.hi[k], acc.hi[k]); }
    const again = ctcStarts(emis, T, V, toks, bounds);
    if (!again) break;
    acc = bounds;
    starts = again;
  }
  return wordsOf(starts, toks.length, owner, written);
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
function strayBounds(starts: Int32Array, N: number, owner: number[], written: { w: string; line: number }[], T: number) {
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
      out.push({ w: x.w, s: s[wi], e: Math.max(e[wi], s[wi] + 0.05), line: x.line });
      last = out[out.length - 1].e;
    } else {
      // No letter to place: right after the word before, short.
      out.push({ w: x.w, s: last, e: last + 0.15, line: x.line });
      last += 0.15;
    }
  });
  return out;
}
