import type { LyricWord } from "./types";
import { norm, similarity } from "./lyricsAlign";

/** A phrase the speech model heard, with the decoder's own times (they stay right where its word times collapse). */
export interface Phrase { w: string; s: number; e: number }

const GAP = 3; // letters' worth of time between two lines
/** A line moves to its phrase only when they disagree by more than this (seconds). */
const MOVE = 1;

/** Share of the line's words found in the phrase (a word close enough counts: "enlacée" / "enlacé"). */
function matchScore(line: string[], phrase: string[]): number {
  if (!line.length || !phrase.length) return 0;
  let hit = 0;
  for (const w of line) if (phrase.some((p) => p === w || similarity(w, p) >= 0.6)) hit++;
  return hit / line.length;
}

/**
 * The relay: where the alignment hardly heard a run of lines (a hook or a chorus drowned in effects: words marked
 * `weak`, some of them packed, `doubt`), the speech model's phrases are used instead. A line whose words are found in a
 * phrase, in order, starts with it; the others share the time between those starts, by their letters. Lines the
 * alignment heard are never touched.
 */
export function relayWeakLines(words: LyricWord[], phrases: Phrase[], duration: number): LyricWord[] {
  type L = { line: number; idx: number[]; weak: boolean; doubt: boolean };
  const lines: L[] = [];
  words.forEach((w, i) => {
    const last = lines[lines.length - 1];
    if (last && last.line === w.line) { last.idx.push(i); last.weak ||= !!w.weak; last.doubt ||= !!w.doubt; }
    else lines.push({ line: w.line ?? -1, idx: [i], weak: !!w.weak, doubt: !!w.doubt });
  });
  const out = words.slice();
  const ps = phrases.filter((p) => norm(p.w)).sort((a, b) => a.s - b.s);
  const letters = (l: L) => l.idx.reduce((n, i) => n + Math.max(1, norm(words[i].w).length), 0);
  for (let i = 0; i < lines.length;) {
    if (!lines[i].weak) { i++; continue; }
    let j = i;
    while (j < lines.length && lines[j].weak) j++;
    const run = lines.slice(i, j);
    if (run.some((l) => l.doubt)) {
      const lo = i > 0 ? words[lines[i - 1].idx[lines[i - 1].idx.length - 1]].e : 0;
      const hi = j < lines.length ? words[lines[j].idx[0]].s : duration;
      const cand = ps.filter((p) => p.s >= lo - 0.5 && p.s < hi);
      // Lines matched to phrases, in order (a phrase serves one line).
      const at = new Array<number | null>(run.length).fill(null), until = new Array<number | null>(run.length).fill(null);
      let pi = 0;
      run.forEach((l, k) => {
        const lw = l.idx.map((x) => norm(words[x].w)).filter(Boolean);
        for (let p = pi; p < Math.min(cand.length, pi + 4); p++) {
          if (matchScore(lw, cand[p].w.split(/\s+/).map(norm).filter(Boolean)) >= 0.5) {
            // The alignment is finer than the phrases: its time stays unless the phrase says it is off by more than MOVE.
            // (a line packed on the others always goes to its phrase)
            const mine = words[l.idx[0]].s;
            at[k] = l.doubt || Math.abs(mine - cand[p].s) > MOVE ? Math.max(lo, cand[p].s) : mine;
            until[k] = cand[p].e;
            pi = p + 1;
            break;
          }
        }
      });
      if (at.some((x) => x !== null)) {
        // The others between those starts (or the run's bounds), by their letters.
        const starts = at.slice();
        for (let k = 0; k < run.length;) {
          if (starts[k] !== null) { k++; continue; }
          let m = k;
          while (m < run.length && starts[m] === null) m++;
          const a = k > 0 ? starts[k - 1]! : lo, b = m < run.length ? starts[m]! : hi;
          // Lines the alignment placed in order between those times, none of them packed: they stay.
          const group = run.slice(k, m);
          const mine = group.map((l) => words[l.idx[0]].s);
          if (!group.some((l) => l.doubt) && mine.every((x, q) => x > a && x < b && (q === 0 || x > mine[q - 1]))) {
            for (let q = k; q < m; q++) starts[q] = mine[q - k];
            k = m;
            continue;
          }
          const prevUnits = k > 0 ? letters(run[k - 1]) + GAP : 0;
          const units = prevUnits + run.slice(k, m).reduce((n, l) => n + letters(l) + GAP, 0);
          let u = prevUnits;
          for (let q = k; q < m; q++) { starts[q] = a + ((b - a) * u) / units; u += letters(run[q]) + GAP; }
          k = m;
        }
        run.forEach((l, k) => {
          const s0 = starts[k]!;
          if (Math.abs(s0 - words[l.idx[0]].s) < 1e-6) {
            // Its own time: its words untouched, but it lasts as long as its phrase (the lines after it moved later).
            const next = k + 1 < run.length ? starts[k + 1]! : hi;
            const last = l.idx[l.idx.length - 1];
            if (until[k] !== null) out[last] = { ...words[last], e: Math.max(words[last].e, Math.min(until[k]!, next - 0.04)) };
            return;
          }
          const next = k + 1 < run.length ? starts[k + 1]! : hi;
          // Up to the next line, a held end at most (a phrase the speech model cut short does not cut the line).
          const end = Math.max(s0 + 0.2, Math.min(next - 0.04, Math.max(until[k] ?? 0, s0 + 0.5 + 0.12 * letters(l))));
          const total = letters(l);
          let u = 0;
          for (const x of l.idx) {
            const n = Math.max(1, norm(words[x].w).length);
            const ws = s0 + ((end - s0) * u) / total;
            u += n;
            out[x] = { ...words[x], s: ws, e: s0 + ((end - s0) * u) / total, doubt: at[k] === null ? true : undefined };
          }
        });
      }
    }
    i = j;
  }
  return out;
}
