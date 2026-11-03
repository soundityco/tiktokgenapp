import type { LyricWord } from "./types";

/**
 * Pure helpers behind the lyrics generator: align written lyrics on the words a speech model
 * heard in the official audio, then cut the timed words into captions (one word or one phrase
 * at a time, never splitting a word, with balanced line breaks).
 */

/** Lower case, no accents, no punctuation: the form words are compared in. */
export function norm(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Words of a text with the (0-based) line they sit on. Punctuation stays attached to its word. */
export function splitWords(text: string): { w: string; line: number }[] {
  const out: { w: string; line: number }[] = [];
  text.split(/\r?\n/).forEach((raw, line) => {
    for (const w of raw.split(/\s+/)) if (norm(w)) out.push({ w, line });
  });
  return out;
}

function distance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

/** 1 = same word, 0 = nothing alike. Short words must be identical to count. */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (Math.min(a.length, b.length) <= 2) return 0;
  return 1 - distance(a, b) / Math.max(a.length, b.length);
}

export interface AlignResult {
  words: LyricWord[];
  /** Share of the heard words that found their place in the written lyrics, 0 to 1. */
  coverage: number;
}

/**
 * Place the written lyrics on the heard words (local alignment, so a segment of the song finds
 * its own verse or chorus inside the whole text). The written spelling always wins; words the
 * model missed inside the sung span get a time between their neighbours; words outside it are dropped.
 * Returns null when the lyrics do not resemble what was heard.
 */
export function alignLyrics(text: string, heard: LyricWord[]): AlignResult | null {
  const lyr = splitWords(text);
  const hrd = heard.filter((h) => norm(h.w));
  if (!lyr.length || !hrd.length) return null;
  const ln = lyr.map((x) => norm(x.w));
  const hn = hrd.map((x) => norm(x.w));
  const n = ln.length, m = hn.length;
  const H: Float64Array[] = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  let best = 0, bi = 0, bj = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sim = similarity(ln[i - 1], hn[j - 1]);
      const sub = sim >= 0.6 ? 3 * sim : -1;
      const v = Math.max(0, H[i - 1][j - 1] + sub, H[i - 1][j] - 1, H[i][j - 1] - 1);
      H[i][j] = v;
      if (v > best) { best = v; bi = i; bj = j; }
    }
  }
  if (best <= 0) return null;

  // Walk back from the best cell to rebuild the pairs (lyric index -> heard index).
  const pair = new Map<number, number>();
  let i = bi, j = bj;
  while (i > 0 && j > 0 && H[i][j] > 0) {
    const sim = similarity(ln[i - 1], hn[j - 1]);
    const sub = sim >= 0.6 ? 3 * sim : -1;
    if (H[i][j] === H[i - 1][j - 1] + sub) { pair.set(i - 1, j - 1); i--; j--; }
    else if (H[i][j] === H[i - 1][j] - 1) i--;
    else j--;
  }
  const exact = [...pair].filter(([a, b]) => similarity(ln[a], hn[b]) >= 0.6).length;
  const coverage = exact / m;
  if (exact < 2 || coverage < 0.35) return null;

  const idx = [...pair.keys()].sort((a, b) => a - b);
  const first = idx[0], last = idx[idx.length - 1];
  const out: LyricWord[] = [];
  let k = first;
  while (k <= last) {
    const h = pair.get(k);
    if (h !== undefined) {
      out.push({ w: lyr[k].w, s: hrd[h].s, e: Math.max(hrd[h].e, hrd[h].s + 0.05), line: lyr[k].line });
      k++;
      continue;
    }
    // A run of words the model did not hear: share the gap between the neighbours by word length.
    let run = k;
    while (run <= last && !pair.has(run)) run++;
    const prev = out[out.length - 1];
    const next = hrd[pair.get(run)!];
    const a = prev.e, b = Math.max(next.s, a + 0.05 * (run - k));
    const weights = lyr.slice(k, run).map((x) => norm(x.w).length + 1);
    const total = weights.reduce((x, y) => x + y, 0);
    let at = a;
    for (let q = k; q < run; q++) {
      const d = ((b - a) * weights[q - k]) / total;
      out.push({ w: lyr[q].w, s: at, e: at + d, line: lyr[q].line });
      at += d;
    }
    k = run;
  }
  return { words: out, coverage };
}

/** Words as the model heard them, tidied (no empty ones, ordered, no overlaps). */
export function cleanHeard(words: LyricWord[]): LyricWord[] {
  const sorted = words
    .map((x) => ({ ...x, w: x.w.trim() }))
    .filter((x) => norm(x.w) && Number.isFinite(x.s))
    .sort((a, b) => a.s - b.s);
  return sorted.map((x, i) => {
    const nextStart = sorted[i + 1]?.s ?? Infinity;
    const e = Number.isFinite(x.e) && x.e > x.s ? x.e : x.s + 0.3;
    return { ...x, e: Math.min(e, Math.max(x.s + 0.05, nextStart)) };
  });
}

// ---------- captions ----------

export interface Cue { text: string; start: number; end: number }
export interface CueOptions {
  /** Longest line, in characters. A caption holds up to two lines. */
  lineChars?: number;
  /** Only the words overlapping this window of the track. */
  from?: number;
  to?: number;
}

const WEAK = new Set(
  ("le la les l un une des de du d et ou a à au aux en dans sur sous pour par avec sans que qui ne pas je tu il elle on " +
    "nous vous ils me te se ce mon ton son ma ta sa mes tes ses the an of to in on at for and or but my your his her our " +
    "i you he she we they it is").split(/\s+/).map(norm)
);

const chars = (ws: LyricWord[]) => ws.reduce((n, x) => n + x.w.length, 0) + Math.max(0, ws.length - 1);

/** Index where a run of words is best cut in two: balanced halves, after punctuation or a pause, never after "de", "the"… */
function bestSplit(ws: LyricWord[]): number {
  const total = chars(ws);
  let best = 1, bestCost = Infinity;
  for (let k = 1; k < ws.length; k++) {
    const left = chars(ws.slice(0, k));
    const right = total - left - 1;
    let cost = Math.abs(left - right) / total;
    const last = ws[k - 1];
    if (WEAK.has(norm(last.w))) cost += 0.5;
    if (/[,;:]$/.test(last.w)) cost -= 0.3;
    cost -= Math.min(0.6, Math.max(0, ws[k].s - last.e)) * 0.5;
    if (cost < bestCost) { bestCost = cost; best = k; }
  }
  return best;
}

/** Break a caption into balanced lines (at most `lineChars` each when possible). */
export function breakLines(ws: LyricWord[], lineChars: number): string {
  if (ws.length < 2 || chars(ws) <= lineChars) return ws.map((x) => x.w).join(" ");
  const k = bestSplit(ws);
  return [ws.slice(0, k), ws.slice(k)].map((p) => breakLines(p, lineChars)).join("\n");
}

function splitLong(ws: LyricWord[], maxChars: number, maxDur: number): LyricWord[][] {
  if (ws.length < 2 || (chars(ws) <= maxChars && ws[ws.length - 1].e - ws[0].s <= maxDur)) return [ws];
  const k = bestSplit(ws);
  return [...splitLong(ws.slice(0, k), maxChars, maxDur), ...splitLong(ws.slice(k), maxChars, maxDur)];
}

/** Cut timed words into captions. Words are never split; a phrase ends at a pause, a lyrics line, a full stop or when too long. */
export function buildCues(words: LyricWord[], mode: "phrase" | "word", opts: CueOptions = {}): Cue[] {
  const lineChars = Math.max(8, opts.lineChars ?? 22);
  const from = opts.from ?? -Infinity, to = opts.to ?? Infinity;
  const ws = words.filter((x) => x.e > from && x.s < to).sort((a, b) => a.s - b.s);
  if (!ws.length) return [];

  let groups: LyricWord[][];
  if (mode === "word") {
    groups = ws.map((x) => [x]);
  } else {
    const hard: LyricWord[][] = [[ws[0]]];
    for (let i = 1; i < ws.length; i++) {
      const prev = ws[i - 1], cur = ws[i];
      const lineChange = prev.line !== undefined && cur.line !== undefined && prev.line !== cur.line;
      if (cur.s - prev.e >= 0.6 || lineChange || /[.!?…]$/.test(prev.w)) hard.push([cur]);
      else hard[hard.length - 1].push(cur);
    }
    groups = hard.flatMap((g) => splitLong(g, lineChars * 2, 5));
  }

  const hold = mode === "word" ? 0.25 : 0.5;
  return groups.map((g, i) => {
    const start = g[0].s;
    const spoken = g[g.length - 1].e;
    const nextStart = groups[i + 1]?.[0].s;
    // Keep the caption on screen until the next one when the pause is short: no flicker between them.
    const end = nextStart !== undefined && nextStart - spoken <= hold ? nextStart : spoken + hold * 0.6;
    return { text: mode === "word" ? g[0].w : breakLines(g, lineChars), start, end };
  });
}

export function activeCue(cues: Cue[], time: number): Cue | null {
  let found: Cue | null = null;
  for (const c of cues) {
    if (c.start - 0.02 <= time) found = c;
    else break;
  }
  return found && time < found.end ? found : null;
}
