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
export function ctcStarts(emis: Float32Array, T: number, V: number, toks: number[]): Int32Array | null {
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
      const adv = prev[j - 1] + emis[row + toks[j - 1]];
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

/**
 * Every written word with its time, from the frames the model gave (`emis`, T × V log-probabilities). `written` = the
 * words of the lyrics with their line number. Words with no letter (numbers, signs) take the time right after the
 * word before. Null when the alignment cannot be done.
 */
export function alignWordsForced(emis: Float32Array, T: number, V: number, written: { w: string; line: number }[]): LyricWord[] | null {
  const toks: number[] = [];
  const owner: number[] = [];
  written.forEach((x, wi) => {
    for (const c of faNorm(x.w)) { const id = FA_VOCAB[c]; if (id !== undefined) { toks.push(id); owner.push(wi); } }
  });
  const starts = ctcStarts(emis, T, V, toks);
  if (!starts) return null;
  const s = new Array<number>(written.length).fill(Infinity);
  const e = new Array<number>(written.length).fill(0);
  for (let k = 0; k < toks.length; k++) {
    const at = starts[k] * FA_FRAME;
    const next = k + 1 < toks.length ? starts[k + 1] * FA_FRAME : at + 0.2;
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
