import type { LyricWord } from "./types";
import { alignSong, norm } from "./lyricsAlign";

/** A phrase the speech model heard, with the decoder's own times (they stay right where its word times collapse). */
export interface Phrase { w: string; s: number; e: number }

/** What the speech model says when it hears no words in a window of music: not a phrase. */
export function noSpeech(text: string): boolean {
  const x = text.trim().toLowerCase();
  return !norm(x) || /^[*([]?\s*(musique|music|applaudissements|rires)\s*[*)\]]?\.?$/.test(x) || /^(thank you|thanks for watching|merci d'avoir regardé|merci\.?)\W*$/.test(x) || /sous-?titr/.test(x);
}

/** First word longer than this (seconds, up to the next word): it took the gap before it; it then lasts FIRST_WORD. */
const FIRST_LONG = 0.6, FIRST_WORD = 0.25;
/** A line moves to its phrase only when they disagree by more than this (seconds). */
const MOVE = 0.5;

/**
 * Words heard one by one (their own times) and words of phrases (spread inside each phrase): the first where there are
 * some, the second only over the stretches with none (more than GAP_WORDS seconds without a word heard one by one).
 */
export function mergeHeard(byWord: LyricWord[], byPhrase: LyricWord[]): LyricWord[] {
  if (!byWord.length) return byPhrase;
  const ws = [...byWord].sort((a, b) => a.s - b.s);
  const near = (t: number) => ws.some((x) => Math.abs(x.s - t) < 2);
  return [...ws, ...byPhrase.filter((x) => !near(x.s) && (x.s > ws[ws.length - 1].e + 1 || x.e < ws[0].s - 1))].sort((a, b) => a.s - b.s);
}

/**
 * The relay: where the alignment hardly heard a run of lines (a hook or a chorus drowned in effects: words marked
 * `weak`, some of them packed, `doubt`), the speech model's phrases are used instead: the run's lines are placed on
 * their words (alignSong), each line found there taking that time. Lines the alignment heard are never touched.
 */
export function relayWeakLines(words: LyricWord[], heardWords: LyricWord[], duration: number): LyricWord[] {
  type L = { line: number; idx: number[]; weak: boolean; doubt: boolean };
  const lines: L[] = [];
  words.forEach((w, i) => {
    const last = lines[lines.length - 1];
    if (last && last.line === w.line) { last.idx.push(i); last.weak ||= !!w.weak; last.doubt ||= !!w.doubt; }
    else lines.push({ line: w.line ?? -1, idx: [i], weak: !!w.weak, doubt: !!w.doubt });
  });
  const out = words.slice();
  const hw = heardWords.filter((p) => norm(p.w)).sort((a, b) => a.s - b.s);
  for (let i = 0; i < lines.length;) {
    if (!lines[i].weak) { i++; continue; }
    let j = i;
    while (j < lines.length && lines[j].weak) j++;
    const run = lines.slice(i, j);
    if (run.some((l) => l.doubt)) {
      const lo = i > 0 ? words[lines[i - 1].idx[lines[i - 1].idx.length - 1]].e : 0;
      const hi = j < lines.length ? words[lines[j].idx[0]].s : duration;
      // (a word heard before the line before ends is that line's, not the passage's)
      // The passage's lines placed on the words heard there (a phrase can hold several lines: "Tout mais pas ça,
      // non, non, non, non, tout mais pas ça" is six of them), as the speech model's words used to be placed.
      const heard = hw.filter((p) => p.s >= lo - 0.1 && p.s < hi);
      const text = run.map((l) => l.idx.map((x) => words[x].w).join(" ")).join("\n");
      const placed = heard.length ? alignSong(text, heard) : null;
      if (placed && placed.words.length === run.reduce((n, l) => n + l.idx.length, 0)) {
        const heardAt = new Set(heard.map((h) => h.s));
        let q = 0;
        const by = run.map((l) => l.idx.map(() => placed.words[q++]));
        // The alignment is finer than the phrases: a line not piled up keeps its own time when they agree within MOVE.
        const keep = run.map((l, k) => !l.doubt && Math.abs(words[l.idx[0]].s - by[k][0].s) <= MOVE);
        // ...and never against the order of the lines around it as they now are.
        run.forEach((l, k) => {
          if (!keep[k]) return;
          const own = words[l.idx[0]].s;
          const prev = k > 0 ? (keep[k - 1] ? words[run[k - 1].idx[0]].s : by[k - 1][0].s) : -Infinity;
          const next = k + 1 < run.length ? by[k + 1][0].s : Infinity;
          if (own <= prev || own >= next) keep[k] = false;
        });
        run.forEach((l, k) => {
          if (keep[k]) return;
          const found = by[k].some((x) => heardAt.has(x.s));
          l.idx.forEach((x, m) => {
            const r = by[k][m];
            out[x] = { ...words[x], s: r.s, e: Math.max(r.s + 0.05, r.e), doubt: found ? undefined : true };
          });
        });
        // A line's first word that seems to last long (over FIRST_LONG up to the next word) took the silence or the music
        // before it (after a break in the beat, the first sung word is placed early): it starts just before the next word.
        run.forEach((l, k) => {
          if (keep[k] || l.idx.length < 2) return;
          const a0 = out[l.idx[0]], a1 = out[l.idx[1]];
          if (a1.s - a0.s > FIRST_LONG) out[l.idx[0]] = { ...a0, s: a1.s - FIRST_WORD, e: a1.s };
        });
        // Each moved line lasts until the next one (a held end, as the alignment's lines).
        run.forEach((l, k) => {
          const lastI = l.idx[l.idx.length - 1];
          const next = k + 1 < run.length ? out[run[k + 1].idx[0]].s : hi;
          const end = Math.min(next - 0.04, out[lastI].s + 1.2);
          if (!keep[k] && end > out[lastI].e) out[lastI] = { ...out[lastI], e: end };
        });
        // The line before the passage lasts until it starts now (it was cut by the lines piled up after it).
        if (i > 0) {
          const last = lines[i - 1].idx[lines[i - 1].idx.length - 1];
          const first = out[run[0].idx[0]].s;
          out[last] = { ...out[last], e: Math.max(out[last].e, Math.min(out[last].s + 1.2, first - 0.04)) };
        }
      }
    }
    i = j;
  }
  return out;
}
