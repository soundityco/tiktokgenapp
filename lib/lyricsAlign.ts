import type { LyricWord } from "./types";

/**
 * Pure helpers behind the lyrics generator: align written lyrics on the words a speech model
 * heard in the official audio, then cut the timed words into captions (one word or one phrase
 * at a time, never splitting a word, with balanced line breaks).
 */

/** Lower case, no accents, no punctuation: the form words are compared in. */
const r3 = (n: number) => Math.round(n * 1000) / 1000;

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
 * `minCoverage`: share of the heard words that must match. A whole track has intros, ad-libs and
 * misheard stretches, so it is aligned with a lower bar than a short segment.
 */
export function alignLyrics(text: string, heard: LyricWord[], minCoverage = 0.35): AlignResult | null {
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
  if (exact < 2 || coverage < minCoverage) return null;

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

// ---------- pasted lyrics ----------

// Longest names first, so "refrain final" is not read as "refrain" followed by a sung word.
const PART = "refrain final|final chorus|pre ?refrain|pre ?chorus|post ?chorus|intro|outro|couplet|refrain|pont|bridge|verse|chorus|hook|interlude|break|drop|instrumental|ad ?libs?";
const PART_RE = new RegExp(`^(${PART})\\b(.*)$`);
const plain = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/-/g, " ").trim();

/** "[Refrain x2]", "Couplet 2 :", "(Chorus)", "Pre-chorus - Artist"… → the part's name and how many times it is sung. Null for a sung line. */
export function partHeader(line: string): { key: string; label: string; times: number } | null {
  const raw = line.trim();
  if (!raw || raw.length > 60) return null;
  const bracketed = /^[[(].*[\])]$/.test(raw);
  const inner = plain(raw.replace(/^[[(]\s*|\s*[\])]$/g, ""));
  const m = PART_RE.exec(inner);
  // Any other title in square brackets ("[Partie 2]", "[Hook block]") is a title too: never sung.
  if (!m) return /^\[.*\]$/.test(raw) && inner ? { key: inner.replace(/\s+/g, ""), label: raw.slice(1, -1).trim(), times: 1 } : null;
  const rest = m[2];
  // Without brackets only a bare title counts ("Refrain", "Couplet 1 :", "Hook x2"), not a sung line starting with "hook".
  if (!bracketed && !/^[\s\d:.#()x×–—-]*$/.test(rest) && !/:\s*$/.test(rest) && !/^\s*\d*\s*[:–—-]/.test(rest)) return null;
  const num = /^\s*(\d+)/.exec(rest)?.[1] ?? "";
  const times = Number(/[x×]\s*(\d+)/.exec(rest)?.[1] ?? 1) || 1;
  const label = raw.replace(/^[[(]\s*|\s*[\])]$/g, "").replace(/\s*[:：]\s*$/, "");
  return { key: m[1].replace(/\s+/g, "") + num, label, times: Math.min(8, times) };
}

export interface ParsedLyrics {
  /** Only the sung lines, in the order they are sung (repeats written out). */
  text: string;
  /** Titles found, in order (for display). */
  parts: string[];
}

/**
 * Lyrics pasted as found online: part titles are removed, a part announced again without its text
 * ("[Refrain]" alone, "Refrain x2") is written out again, a line ending in "(x2)" is repeated.
 */
export function parseLyrics(input: string): ParsedLyrics {
  const lines = input.replace(/\r/g, "").split("\n");
  const bodies = new Map<string, string[]>();
  const out: string[] = [];
  const parts: string[] = [];
  let cur: { key: string; times: number; body: string[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const body = cur.body.length ? cur.body : bodies.get(cur.key) ?? [];
    if (cur.body.length) bodies.set(cur.key, cur.body);
    for (let k = 0; k < cur.times; k++) out.push(...body);
    cur = null;
  };
  for (const line of lines) {
    const h = partHeader(line);
    if (h) {
      flush();
      parts.push(h.times > 1 ? `${h.label}` : h.label);
      cur = { key: h.key, times: h.times, body: [] };
      continue;
    }
    const t = line.trim();
    if (!t) continue;
    const rep = /\s*\(?\s*[x×]\s*(\d+)\s*\)?\s*$/i.exec(t);
    const sung = rep && rep.index > 0 ? t.slice(0, rep.index).trim() : t;
    const n = rep && rep.index > 0 ? Math.min(8, Number(rep[1]) || 1) : 1;
    for (let k = 0; k < n; k++) (cur ? cur.body : out).push(sung);
  }
  flush();
  return { text: out.join("\n"), parts };
}

/**
 * Place a whole song on the words heard in the whole track. Unlike `alignLyrics` (which looks for the
 * best matching stretch), every written word is kept, in order: misheard or missed stretches get a time
 * between their neighbours instead of being dropped, and what the model heard outside the song
 * (ad-libs, hallucinations in instrumental parts) is skipped. Null when the lyrics do not match at all.
 */
export function alignSong(text: string, heard: LyricWord[]): AlignResult | null {
  const lyr = splitWords(text);
  const hrd = heard.filter((h) => norm(h.w));
  if (!lyr.length || !hrd.length) return null;
  const ln = lyr.map((x) => norm(x.w));
  const hn = hrd.map((x) => norm(x.w));
  const n = ln.length, m = hn.length;
  const SKIP_LYR = -1, SKIP_HRD = -0.6;
  // Semi-global: free start and end in the heard words, every written word consumed.
  const H: Float64Array[] = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const sub: Float32Array[] = Array.from({ length: n }, () => new Float32Array(m));
  for (let i = 1; i <= n; i++) {
    H[i][0] = H[i - 1][0] + SKIP_LYR;
    for (let j = 1; j <= m; j++) {
      const sim = similarity(ln[i - 1], hn[j - 1]);
      const sc = sim >= 0.6 ? 3 * sim : -1;
      sub[i - 1][j - 1] = sc;
      H[i][j] = Math.max(H[i - 1][j - 1] + sc, H[i - 1][j] + SKIP_LYR, H[i][j - 1] + SKIP_HRD);
    }
  }
  let bj = 0;
  for (let j = 1; j <= m; j++) if (H[n][j] > H[n][bj]) bj = j;
  const pair = new Map<number, number>();
  let i = n, j = bj;
  while (i > 0 && j > 0) {
    const sc = sub[i - 1][j - 1];
    if (sc > 0 && H[i][j] === H[i - 1][j - 1] + sc) { pair.set(i - 1, j - 1); i--; j--; }
    else if (H[i][j] === H[i - 1][j] + SKIP_LYR) i--;
    else if (H[i][j] === H[i][j - 1] + SKIP_HRD) j--;
    else { i--; j--; } // a mismatch taken as a pair: both words skipped
  }
  const idx = [...pair.keys()].sort((a, b) => a - b);
  if (idx.length < 2 || idx.length / n < 0.2) return null;

  const out: LyricWord[] = [];
  const first = idx[0], last = idx[idx.length - 1];
  const AVG = 0.35;
  // Before the first heard word / after the last one: words keep an average length, back to back.
  for (let k = 0; k < first; k++) {
    const s0 = Math.max(0, hrd[pair.get(first)!].s - (first - k) * AVG);
    out.push({ w: lyr[k].w, s: s0, e: s0 + AVG * 0.9, line: lyr[k].line });
  }
  let k = first;
  while (k <= last) {
    const h = pair.get(k);
    if (h !== undefined) {
      out.push({ w: lyr[k].w, s: hrd[h].s, e: Math.max(hrd[h].e, hrd[h].s + 0.05), line: lyr[k].line });
      k++;
      continue;
    }
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
  const end = out[out.length - 1].e;
  for (let q = last + 1; q < n; q++) {
    const s0 = end + (q - last - 1) * AVG;
    out.push({ w: lyr[q].w, s: s0, e: s0 + AVG * 0.9, line: lyr[q].line });
  }
  return { words: out, coverage: idx.length / n };
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

export interface Cue {
  text: string;
  start: number;
  end: number;
  /** The words shown (the same objects as in the list given to buildCues), to retime the caption. */
  words: LyricWord[];
}
export interface CueOptions {
  /** Longest line, in characters. A caption holds up to two lines. */
  lineChars?: number;
  /** Only the words overlapping this window of the track. */
  from?: number;
  to?: number;
  /** Word by word: each word at the time heard by the model ("ai", the default), or spread over its phrase by its
   *  syllables ("even": the phrases are well placed, the model's word times less so). Retouches win either way. */
  wordTiming?: "ai" | "even";
}

/** Syllables of a word, roughly (groups of vowels): its share of the phrase when the words are spread. */
export function syllables(w: string): number {
  return Math.max(1, (norm(w).match(/[aeiouyàâäéèêëîïôöùûüœæ]+/g) ?? []).length);
}

/** The phrases (as phrase by phrase shows them) of time-sorted words. */
function phrasesOf(ws: LyricWord[], lineChars: number): LyricWord[][] {
  const hard: LyricWord[][] = [[ws[0]]];
  for (let i = 1; i < ws.length; i++) {
    const prev = ws[i - 1], cur = ws[i];
    const lineChange = prev.line !== undefined && cur.line !== undefined && prev.line !== cur.line;
    if (cur.s - prev.e >= 0.6 || lineChange || /[.!?…]$/.test(prev.w)) hard.push([cur]);
    else hard[hard.length - 1].push(cur);
  }
  return hard.flatMap((g) => splitLong(g, lineChars * 2, 5));
}

/**
 * The words as word-by-word captions show them: their own retouch there if any (ws / we / wu), else the model's
 * time or (wordTiming "even") a share of their phrase by syllables. New objects carrying `src`, the word they show.
 */
function wordView(ws: LyricWord[], lineChars: number, timing: "ai" | "even"): (LyricWord & { src: LyricWord })[] {
  const out = new Map<LyricWord, LyricWord & { src: LyricWord }>();
  const view = (x: LyricWord, s: number, e: number) => ({ ...x, s: r3(x.ws ?? s), e: r3(x.we ?? e), until: x.wu, src: x });
  if (timing === "even") {
    for (const g of phrasesOf(ws, lineChars)) {
      const S = g[0].s, E = Math.max(g[g.length - 1].e, S + 0.05);
      const total = g.reduce((n, x) => n + syllables(x.w), 0);
      let at = 0;
      for (const x of g) {
        const share = syllables(x.w) / total;
        out.set(x, view(x, S + (E - S) * at, S + (E - S) * (at + share)));
        at += share;
      }
    }
  }
  return ws.map((x) => out.get(x) ?? view(x, x.s, x.e)).sort((a, b) => a.s - b.s);
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
    // Their own timing (retouches made here, the spread): the phrases never see it.
    groups = wordView(ws, lineChars, opts.wordTiming ?? "ai").map((x) => [x]);
  } else {
    groups = phrasesOf(ws, lineChars);
  }

  const hold = mode === "word" ? 0.25 : 0.5;
  return groups.map((g, i) => {
    const start = g[0].s;
    const spoken = g[g.length - 1].e;
    const nextStart = groups[i + 1]?.[0].s;
    // Keep the caption on screen until the next one when the pause is short: no flicker between them.
    const set = g[g.length - 1].until;
    const end = set ?? (nextStart !== undefined && nextStart - spoken <= hold ? nextStart : spoken + hold * 0.6);
    return { text: mode === "word" ? g[0].w : breakLines(g, lineChars), start, end, words: g };
  });
}


/** Move a caption earlier or later: its words (and the end set by hand, if any) move by `delta` seconds. */
export function shiftCue(all: LyricWord[], cue: Cue, delta: number): LyricWord[] {
  const mine = new Set(cue.words);
  return all.map((x) => (mine.has(x)
    ? { ...x, s: r3(x.s + delta), e: r3(x.e + delta), ...(x.until === undefined ? {} : { until: r3(x.until + delta) }), manual: true,
      // A word retouched word by word goes with its phrase.
      ...(x.ws === undefined ? {} : { ws: r3(x.ws + delta) }), ...(x.we === undefined ? {} : { we: r3(x.we + delta) }), ...(x.wu === undefined ? {} : { wu: r3(x.wu + delta) }) }
    : x));
}

/** When a caption leaves the screen, set by hand on its last word. */
export function setCueEnd(all: LyricWord[], cue: Cue, end: number): LyricWord[] {
  const mine = new Set(cue.words);
  const last = cue.words[cue.words.length - 1];
  return all.map((x) => (x === last ? { ...x, until: r3(end), manual: true } : mine.has(x) ? { ...x, manual: true } : x));
}

/**
 * Words placed out of the order of the written lines (an old retouch pushed a line past the next one):
 * put back in the order of the text, a hundredth of a second apart, and an end set before its own start dropped.
 * Returns the same array when nothing is wrong.
 */
export function repairOrder(words: LyricWord[]): LyricWord[] {
  const lined = words.filter((x) => x.line !== undefined);
  if (lined.length < 2) return words;
  const byText = [...lined].sort((a, b) => a.line! - b.line! || a.s - b.s);
  const fix = new Map<LyricWord, LyricWord>();
  let last = -Infinity;
  for (const x of byText) {
    let y = x;
    if (x.s <= last) { const s0 = r3(last + 0.01); y = { ...x, s: s0, e: r3(Math.max(x.e, s0 + 0.05)) }; }
    if (y.until !== undefined && y.until <= y.s) { const { until: _drop, ...rest } = y; y = rest; }
    if (y !== x) fix.set(x, y);
    last = y.s;
  }
  return fix.size ? words.map((x) => fix.get(x) ?? x) : words;
}

/**
 * The ± buttons of a caption: `start` moves the whole line by `delta`, `end` changes when it leaves the screen.
 * A line glued to its neighbour pushes the limit: a later end makes the next line appear later (its end stays),
 * an earlier start makes the previous line leave sooner. Each line keeps at least 0.2 s. Null: nothing can move.
 */
export function retimeCue(all: LyricWord[], cues: Cue[], i: number, what: "start" | "end", delta: number): LyricWord[] | null {
  const c = cues[i], prev = cues[i - 1], next = cues[i + 1];
  if (!c) return null;
  const MIN = 0.2;
  if (what === "end") {
    const hi = next ? next.end - MIN : c.end + 60;
    const to = r3(Math.max(c.start + MIN, Math.min(hi, c.end + delta)));
    if (Math.abs(to - c.end) < 0.005) return null;
    let out = all;
    if (next && to > next.start) {
      // The next line comes later, but it still leaves when it did: only its words sung before the new start
      // wait for it (in order), the others stay. Nothing goes past the line after it.
      const lastNext = next.words[next.words.length - 1];
      const late = new Map<LyricWord, LyricWord>();
      next.words.forEach((x, k) => {
        if (x.s >= to + k * 0.01) { if (x === lastNext) late.set(x, { ...x, until: r3(next.end), manual: true }); return; }
        const ns = r3(to + k * 0.01);
        late.set(x, { ...x, s: ns, e: r3(Math.max(x.e, ns + 0.05)), manual: true, ...(x === lastNext ? { until: r3(next.end) } : {}) });
      });
      out = all.map((x) => late.get(x) ?? x);
    }
    return setCueEnd(out, c, to);
  }
  const lo = prev ? prev.start + MIN - c.start : -c.start;
  const hi = next ? next.start - c.words[c.words.length - 1].e - 0.02 : 60;
  const d = Math.max(lo, Math.min(hi, delta));
  if (Math.abs(d) < 0.005) return null;
  let out = shiftCue(all, c, d);
  // The previous line leaves when this one now comes.
  if (prev && c.start + d < prev.end) out = setCueEnd(out, prev, c.start + d);
  return out;
}

/**
 * The ± buttons of a word-by-word caption, kept in that mode's own timing (ws / we / wu): the phrases (s / e / until)
 * stay where they are. `start` changes when the word appears (earlier: the word before leaves then), `end` when it
 * leaves (later: the next word comes then). Every word keeps at least 0.05 s on screen. Null: nothing can move.
 */
export function retimeWordCue(all: LyricWord[], cues: Cue[], i: number, what: "start" | "end", delta: number): LyricWord[] | null {
  const MIN = 0.05;
  const c = cues[i], prev = cues[i - 1], next = cues[i + 1];
  const src = (cue: Cue | undefined) => (cue?.words[0] as LyricWord & { src?: LyricWord } | undefined)?.src;
  const me = src(c);
  if (!c || !me) return null;
  const set = new Map<LyricWord, LyricWord>();
  const put = (w: LyricWord, patch: Partial<LyricWord>) => set.set(w, { ...(set.get(w) ?? w), ...patch });
  if (what === "start") {
    const lo = prev ? prev.start + MIN : 0;
    const ns = r3(Math.max(lo, Math.min(c.end - MIN, c.start + delta)));
    if (Math.abs(ns - c.start) < 0.005) return null;
    put(me, { ws: ns, we: r3(Math.max(c.words[0].e, ns + MIN)) });
    const p = src(prev);
    if (p && prev && ns < prev.end) put(p, { wu: ns });
  } else {
    const hi = next ? next.end - MIN : c.end + 60;
    const ne = r3(Math.max(c.start + MIN, Math.min(hi, c.end + delta)));
    if (Math.abs(ne - c.end) < 0.005) return null;
    put(me, { wu: ne });
    const n = src(next);
    if (n && next && ne > next.start) put(n, { ws: ne, we: r3(Math.max(next.words[0].e, ne + MIN)) });
  }
  return all.map((x) => set.get(x) ?? x);
}

/** The word-by-word retouches dropped: those captions go back to the automatic timing. */
export const clearWordTiming = (all: LyricWord[]): LyricWord[] =>
  all.map((x) => (x.ws === undefined && x.we === undefined && x.wu === undefined ? x : (({ ws: _s, we: _e, wu: _u, ...rest }) => rest)(x)));

/** Some words were retouched word by word. */
export const hasWordTiming = (words: LyricWord[] | undefined): boolean => !!words?.some((x) => x.ws !== undefined || x.we !== undefined || x.wu !== undefined);

/**
 * The lyrics were placed again (text edited, synced again): the words retimed by hand keep their timing.
 * Old and new words are matched in order (longest common sequence of the words), so an edit elsewhere
 * in the text, or a line added or removed, leaves the other retouches where they were.
 */
export function keepManual(prev: LyricWord[], next: LyricWord[]): LyricWord[] {
  if (!prev.some((x) => x.manual || x.ws !== undefined || x.wu !== undefined) || !next.length) return next;
  const a = [...prev].sort((x, y) => x.s - y.s), b = [...next].sort((x, y) => x.s - y.s);
  const ka = a.map((x) => norm(x.w)), kb = b.map((x) => norm(x.w));
  const n = a.length, m = b.length;
  // Lengths of the common sequences of a[i..] and b[j..], one row per word of `a`.
  const L = new Int32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i * (m + 1) + j] = ka[i] === kb[j] ? L[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(L[(i + 1) * (m + 1) + j], L[i * (m + 1) + j + 1]);
    }
  }
  const out = [...b];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (ka[i] === kb[j]) {
      const o = a[i];
      if (o.manual) out[j] = { ...b[j], s: o.s, e: o.e, ...(o.until === undefined ? {} : { until: o.until }), manual: true };
      // The word-by-word retouches stay too.
      if (o.ws !== undefined || o.we !== undefined || o.wu !== undefined) out[j] = { ...out[j], ws: o.ws, we: o.we, wu: o.wu };
      i++; j++;
    } else if (L[(i + 1) * (m + 1) + j] >= L[i * (m + 1) + j + 1]) i++;
    else j++;
  }
  return out.sort((x, y) => x.s - y.s);
}

/** Some words were retimed by hand. */
export const hasManual = (words: LyricWord[] | undefined): boolean => !!words?.some((x) => x.manual);

export function activeCue(cues: Cue[], time: number): Cue | null {
  let found: Cue | null = null;
  for (const c of cues) {
    if (c.start - 0.02 <= time) found = c;
    else break;
  }
  return found && time < found.end ? found : null;
}
