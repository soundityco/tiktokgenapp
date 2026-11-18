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
    // A sign standing alone (French spacing: "revoir ?", "« oui »", " !") has no letter to place: it goes with the word
    // before it (or the next one, at the start of a line), joined by a no-break space, so it shows and never wraps
    // alone. (Dropped, an added "?" never reached the video.)
    let lead = "";
    for (const w of raw.split(/\s+/)) {
      if (!w) continue;
      if (norm(w)) { out.push({ w: lead + w, line }); lead = ""; continue; }
      const last = out[out.length - 1];
      if (last && last.line === line && !lead) last.w += "\u00a0" + w;
      else lead += w + "\u00a0";
    }
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
/** Shortest time a word the model did not hear stays on screen (word by word it would flash unseen otherwise). */
const MIN_MISSED = 0.15;
/**
 * Words the model did not hear, placed between the last placed word and the next heard one, shared by length.
 * When there is no room (the model ran the neighbours together), the previous word gives some of its time,
 * keeping 0.1 s itself: every written word is seen.
 */
function placeMissed(out: LyricWord[], words: { w: string; line: number }[], nextS: number, nextLine?: number) {
  const prev = out[out.length - 1];
  // A new line starting among them, over a long gap (an instrumental, a breath): only the words of the next heard word's
  // own line come just before it, sung at a normal pace (that line shows when the voice attacks it, not at the start of
  // the silence); the others (the end of the line before, whole lines not heard) follow the line before, sung.
  const SUNG = 0.3;
  const cut = nextLine === undefined ? words.findIndex((x) => x.line !== prev.line) : words.findIndex((x) => x.line === nextLine);
  if (cut >= 0 && words.some((x) => x.line !== prev.line) && nextS - prev.e > SUNG * words.length + 0.6) {
    const tail = words.slice(0, cut), head = words.slice(cut);
    let at = prev.e;
    for (const x of tail) { out.push({ w: x.w, s: at, e: at + SUNG * 0.9, line: x.line }); at += SUNG; }
    let s0 = Math.max(at, nextS - SUNG * head.length);
    for (const x of head) { out.push({ w: x.w, s: s0, e: s0 + SUNG * 0.9, line: x.line }); s0 += SUNG; }
    return;
  }
  const need = MIN_MISSED * words.length;
  let a = prev.e;
  if (nextS - a < need) {
    // No room: the model heard the previous word and these as one ("vide de" heard "vide"). Its time is shared
    // by syllables ("vi-de" two shares, "de" one), each word keeping at least 0.1 s.
    const span = Math.max(prev.e, nextS) - prev.s;
    const sp = syllables(prev.w), sw = words.reduce((n, x) => n + syllables(x.w), 0);
    const share = Math.max(prev.s + 0.1, Math.min(nextS - need, prev.s + (span * sp) / (sp + sw)));
    const a2 = Math.max(prev.s + 0.1, Math.min(share, nextS - 0.1 * words.length));
    if (a2 < a) { prev.e = a2; a = a2; }
  }
  const b = Math.max(nextS, a + 0.05 * words.length);
  const weights = words.map((x) => norm(x.w).length + 1);
  const total = weights.reduce((x, y) => x + y, 0);
  let at = a;
  words.forEach((x, q) => {
    const d = ((b - a) * weights[q]) / total;
    out.push({ w: x.w, s: at, e: at + d, line: x.line });
    at += d;
  });
}

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
    placeMissed(out, lyr.slice(k, run), hrd[pair.get(run)!].s, lyr[run].line);
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
  // A sung voice over a busy mix: a tenth of the words recognised (4 at least) is enough to hold the song; the others
  // fall in order between them.
  if (idx.length < 4 || idx.length / n < 0.1) return null;

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
    placeMissed(out, lyr.slice(k, run), hrd[pair.get(run)!].s, lyr[run].line);
    k = run;
  }
  const end = out[out.length - 1].e;
  // After the last recognised word: back to back at an average pace, unless the voice was heard going on after it
  // (words heard that match nothing, a chorus misheard): they then share that time, by length.
  const heardEnd = hrd[m - 1].e;
  const rest = lyr.slice(last + 1);
  const room = heardEnd - end;
  if (rest.length && room > AVG * rest.length) {
    const weights = rest.map((x) => norm(x.w).length + 1);
    const total = weights.reduce((a, b) => a + b, 0);
    let at = end;
    rest.forEach((x, q) => { const d = (room * weights[q]) / total; out.push({ w: x.w, s: at, e: at + d * 0.9, line: x.line }); at += d; });
  } else {
    for (let q = last + 1; q < n; q++) {
      const s0 = end + (q - last - 1) * AVG;
      out.push({ w: lyr[q].w, s: s0, e: s0 + AVG * 0.9, line: lyr[q].line });
    }
  }
  return { words: out, coverage: idx.length / n };
}

/** Words as the model heard them, tidied (no empty ones, ordered, no overlaps). */
/**
 * The speech model's loops cut: on music it can repeat the same phrase over and over ("je suis comme un thème de…" ×40),
 * words that are not sung and spoil the placing. A phrase of 1 to 10 words said more than twice in a row keeps its first
 * two times.
 */
export function dropLoops(words: LyricWord[], written?: string): LyricWord[] {
  const out: LyricWord[] = [];
  const key = (x: LyricWord) => norm(x.w);
  // A phrase the written lyrics repeat (a chorus: "non" x4, "tout mais pas ça" x4) is sung that many times for real.
  const known = written ? splitWords(written).map((x) => norm(x.w)) : null;
  const sung = (ph: LyricWord[]) => {
    if (!known) return 0;
    const k = ph.map(key);
    let n = 0;
    for (let a = 0; a + k.length <= known.length;) { if (k.every((x, j) => known[a + j] === x)) { n++; a += k.length; } else a++; }
    return n;
  };
  for (let i = 0; i < words.length;) {
    let cut = 0;
    for (let p = 1; p <= 10 && !cut; p++) {
      let reps = 1;
      while (i + (reps + 1) * p <= words.length && words.slice(i + reps * p, i + (reps + 1) * p).every((x, k) => key(x) === key(words[i + k]))) reps++;
      const keep = Math.max(2, sung(words.slice(i, i + p)));
      if (reps > keep) cut = p * reps;
      if (cut) { out.push(...words.slice(i, i + keep * p)); i += cut; }
    }
    if (!cut) { out.push(words[i]); i++; }
  }
  return out;
}

/** Phrases timed by the model (start, end, text) as words: each phrase's words share its time, by syllables. */
export function wordsFromSegments(segs: LyricWord[]): LyricWord[] {
  const out: LyricWord[] = [];
  for (const g of segs) {
    const parts = g.w.split(/\s+/).filter((x) => norm(x));
    if (!parts.length) continue;
    const weight = parts.map((x) => syllables(x) + 0.5);
    const total = weight.reduce((a, b) => a + b, 0);
    const span = Math.max(0.1, g.e - g.s);
    let at = g.s;
    parts.forEach((x, k) => { const d = (span * weight[k]) / total; out.push({ w: x, s: at, e: at + d }); at += d; });
  }
  return out;
}

/** The words whose time the model's alignment kept (the ones piled on one instant, or out of the excerpt, taken away). */
export function withoutLost(words: LyricWord[], from: number, to: number): LyricWord[] {
  const ws = [...words].sort((a, b) => a.s - b.s);
  const bad = ws.map((x) => x.s > to + 0.5 || x.s < from - 0.5);
  for (let i = 0; i < ws.length;) {
    let j = i + 1;
    while (j < ws.length && ws[j].s - ws[j - 1].s < 0.08) j++;
    if (j - i >= 3) for (let k = i; k < j; k++) bad[k] = true;
    i = j;
  }
  return ws.filter((_, i) => !bad[i]);
}

/** How many words have a time the model's alignment lost (see respreadLost). */
export function lostCount(words: LyricWord[], from: number, to: number): number {
  const ws = [...words].sort((a, b) => a.s - b.s);
  const bad = ws.map((x) => x.s > to + 0.5 || x.s < from - 0.5);
  for (let i = 0; i < ws.length;) {
    let j = i + 1;
    while (j < ws.length && ws[j].s - ws[j - 1].s < 0.08) j++;
    if (j - i >= 3) for (let k = i; k < j; k++) bad[k] = true;
    i = j;
  }
  return bad.filter(Boolean).length;
}

/**
 * The speech model's word alignment sometimes gives up on a passage over music: a run of words all on one instant
 * (the end of its 30 s excerpt), or after the end of what it heard. The words are right, the times are not: they are
 * spread over the free time between the well-timed words around them (by syllables), not thrown away.
 */
export function respreadLost(words: LyricWord[], from: number, to: number): LyricWord[] {
  const ws = [...words].sort((a, b) => a.s - b.s);
  const bad = ws.map((x) => x.s > to + 0.5 || x.s < from - 0.5);
  // Three words or more less than 80 ms apart one after the other: nobody sings that.
  for (let i = 0; i < ws.length;) {
    let j = i + 1;
    while (j < ws.length && ws[j].s - ws[j - 1].s < 0.08) j++;
    if (j - i >= 3) for (let k = i; k < j; k++) bad[k] = true;
    i = j;
  }
  const out: LyricWord[] = [];
  for (let i = 0; i < ws.length;) {
    if (!bad[i]) { out.push(ws[i]); i++; continue; }
    let j = i;
    while (j < ws.length && bad[j]) j++;
    const run = ws.slice(i, j);
    const lo = Math.max(from, out.length ? out[out.length - 1].e : from);
    const hi = Math.min(to, j < ws.length ? ws[j].s : to);
    if (run.length < 3 || hi - lo < 0.25 * run.length) { i = j; continue; } // no room: left out
    const weight = run.map((x) => syllables(x.w) + 0.5);
    const total = weight.reduce((a, b) => a + b, 0);
    let at = lo;
    run.forEach((x, k) => {
      const d = ((hi - lo) * weight[k]) / total;
      out.push({ ...x, s: at, e: at + d * 0.9 });
      at += d;
    });
    i = j;
  }
  return out;
}

/**
 * Words the model cut at an apostrophe or a hyphen put back together ("c" + "'est" → "c'est", "Est" + "-ce" → "Est-ce"):
 * the written lyrics have them whole (the very precise model cuts them, the verses full of j'crois, t'as… missed).
 */
export function joinPieces(words: LyricWord[]): LyricWord[] {
  const out: LyricWord[] = [];
  for (const x of words) {
    const prev = out[out.length - 1];
    const w = x.w.trim();
    if (prev && (/^['’-]/.test(w) || /['’]$/.test(prev.w)) && x.s - prev.e < 0.6) {
      out[out.length - 1] = { ...prev, w: prev.w + w, e: Math.max(prev.e, x.e) };
      continue;
    }
    out.push({ ...x, w });
  }
  return out;
}

/** Sentences the speech model makes up on music (learnt from subtitles), never sung: taken out. */
const MADE_UP = [
  "sous titrage", "sous titres", "société radio canada", "radio canada", "merci d avoir regardé", "merci de votre attention",
  "amara org", "thank you for watching", "thanks for watching", "subtitles by",
];
export function dropMadeUp(words: LyricWord[]): LyricWord[] {
  // Compared without spaces, however the model cut them into words ("Sous-titrage" or "Sous" "titrage").
  const keys = words.map((x) => norm(x.w).replace(/\s+/g, ""));
  const drop = new Set<number>();
  for (const m of MADE_UP) {
    const want = norm(m).replace(/\s+/g, "");
    for (let i = 0; i < keys.length; i++) {
      let got = "", k = i;
      while (k < keys.length && got.length < want.length) got += keys[k++];
      if (got === want) for (let q = i; q < k; q++) drop.add(q);
    }
  }
  return drop.size ? words.filter((_, i) => !drop.has(i)) : words;
}

export function cleanHeard(words: LyricWord[], written?: string): LyricWord[] {
  const sorted = dropLoops(dropMadeUp(joinPieces([...words].sort((a, b) => a.s - b.s)))
    .map((x) => ({ ...x, w: x.w.trim() }))
    .filter((x) => norm(x.w) && Number.isFinite(x.s))
    .sort((a, b) => a.s - b.s), written);
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
  // Written lyrics: a caption is a line as the artist wrote it (that is how they want it seen and sung). It is cut only
  // by a real break inside it (WRITTEN_BREAK s), or when really too long for the screen (then at a comma first, else at
  // its longest pause). Words heard with no written line: at their pauses, stops and length, as before.
  const written = ws.every((x) => x.line !== undefined);
  const hard: LyricWord[][] = [[ws[0]]];
  for (let i = 1; i < ws.length; i++) {
    const prev = ws[i - 1], cur = ws[i];
    const lineChange = prev.line !== undefined && cur.line !== undefined && prev.line !== cur.line;
    // A word joined by hand to the caption before it is never cut from it by a pause or a stop (a line change still cuts).
    const cut = written ? cur.s - prev.e >= WRITTEN_BREAK : cur.s - prev.e >= 0.6 || /[.!?…]$/.test(prev.w);
    if (lineChange || (!cur.glue && cut)) hard.push([cur]);
    else hard[hard.length - 1].push(cur);
  }
  // Joined by hand: kept whole (the artist then cuts it where they want, "Cut here").
  return hard.flatMap((g) => (g.some((x) => x.glue) ? [g] : written ? splitLong(g, lineChars * 3, 8) : splitLong(g, lineChars * 2, 5)));
}
/** A silence inside a written line long enough to show it in two parts (seconds). */
const WRITTEN_BREAK = 2;

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

/**
 * A caption dragged whole on the timeline (as a clip in an editor): it keeps its length and moves by `delta`, in the
 * room between the line before and the line after (never over them, never pushing them). Its end and the end of the
 * line before are pinned (`until`): an end glued to the next start would stretch to follow it. Null: it cannot move.
 */
export function moveCueBy(all: LyricWord[], cues: Cue[], i: number, delta: number): LyricWord[] | null {
  const c = cues[i], prev = cues[i - 1], next = cues[i + 1];
  if (!c?.words.length) return null;
  const d = Math.max((prev ? prev.end : 0) - c.start, Math.min(next ? next.start - c.end : Infinity, delta));
  if (Math.abs(d) < 0.005) return null;
  let out = shiftCue(all, c, d);
  const last = c.words[c.words.length - 1];
  out = out.map((x, k) => (all[k] === last ? { ...x, until: r3(c.end + d) } : x));
  if (prev?.words.length && !prev.words.some((x) => x.lock)) {
    const pl = prev.words[prev.words.length - 1];
    if (pl.until === undefined) out = out.map((x) => (x === pl ? { ...x, until: r3(prev.end), manual: true } : x));
  }
  return out;
}

/** When a caption leaves the screen, set by hand on its last word. */
export function setCueEnd(all: LyricWord[], cue: Cue, end: number): LyricWord[] {
  const mine = new Set(cue.words);
  const last = cue.words[cue.words.length - 1];
  // Shortened to before its last word starts: its words drawn together into what is left, in the same rhythm (an end
  // before the last word was dropped as out of order, and the line went back to its old end, glued to the next one).
  if (end <= last.s + 0.05 && cue.words.length) {
    const s0 = cue.start, span = Math.max(0.05, Math.max(cue.end, last.e) - s0), room = Math.max(0.1, end - 0.05 - s0);
    const at = (t: number) => r3(s0 + ((t - s0) / span) * room);
    const moved = new Map<LyricWord, LyricWord>(cue.words.map((x) => [x, { ...x, s: at(x.s), e: Math.max(at(x.s) + 0.03, at(x.e)), manual: true, ...(x === last ? { until: r3(end) } : {}) }]));
    return all.map((x) => moved.get(x) ?? x);
  }
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
  // Glued to the next line, the whole line cannot come later: then only its start does (it shows later, leaves when it
  // did, the line before stays until it), so a line shown too early can always wait for its singing.
  if (delta > 0 && d < delta - 0.005) return moveCueStart(all, cues, i, c.start + delta);
  if (Math.abs(d) < 0.005) return null;
  let out = shiftCue(all, c, d);
  // The previous line leaves when this one now comes.
  if (prev && c.start + d < prev.end) out = setCueEnd(out, prev, c.start + d);
  return out;
}

/**
 * A caption's start dragged on the timeline to `at` (its end stays): later, its words sung before `at` wait for it (in
 * order) and the line before stays on screen until it (no gap); earlier, its first word comes then and the line before
 * leaves then. `free` (Alt held): the line before is left as it is (a gap where the singing pauses). Each line keeps
 * 0.2 s at least. Null: nothing moved.
 */
export function moveCueStart(all: LyricWord[], cues: Cue[], i: number, at: number, free = false): LyricWord[] | null {
  const c = cues[i], prev = cues[i - 1];
  if (!c) return null;
  const MIN = 0.2;
  const to = r3(Math.max(prev ? prev.start + MIN : 0, Math.min(c.end - MIN, at)));
  if (Math.abs(to - c.start) < 0.005) return null;
  const moved = new Map<LyricWord, LyricWord>();
  c.words.forEach((x, k) => {
    const ns = k === 0 ? to : r3(Math.max(x.s, to + k * 0.01));
    if (ns !== x.s) moved.set(x, { ...x, s: ns, e: r3(Math.max(x.e, ns + 0.05)), manual: true });
  });
  let out = all.map((x) => moved.get(x) ?? x);
  // Its end stays where it was.
  out = setCueEnd(out, { ...c, words: c.words.map((x) => moved.get(x) ?? x) }, c.end);
  // The line before keeps its own end (pinned: an end glued to this start would stretch to follow it), cut short only
  // when this one now starts over it; never stretched to this one (a gap stays a gap, as in an editor).
  if (prev && !free) out = setCueEnd(out, prev, Math.min(prev.end, to));
  return out;
}

/**
 * A line put between `start` and `end` (the tap mode: its start tapped while listening, its end the next line's tap): its
 * words keep their rhythm inside it (each moved in proportion), marked retouched (kept at the next sync), no longer "to
 * check". Phrase lines only (their words are the lyrics' own).
 */
export function placeLine(all: LyricWord[], cue: Cue, start: number, end: number): LyricWord[] {
  const s0 = cue.start, d0 = Math.max(0.05, cue.end - s0), d1 = Math.max(0.1, end - start);
  const at = (t: number) => r3(start + ((t - s0) / d0) * d1);
  const moved = new Map<LyricWord, LyricWord>(cue.words.map((x) => [x, { ...x, s: at(x.s), e: Math.max(at(x.s) + 0.03, at(x.e)), manual: true, doubt: undefined }]));
  return all.map((x) => moved.get(x) ?? x);
}

/** A caption's end dragged on the timeline to `at`: as its + / − (`retimeCue` "end"): a later end reaching the next
 *  line makes it come later. Null: nothing moved. */
export function moveCueEnd(all: LyricWord[], cues: Cue[], i: number, at: number): LyricWord[] | null {
  const c = cues[i];
  return c ? retimeCue(all, cues, i, "end", at - c.end) : null;
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
  if (!prev.some((x) => x.manual || x.lock || x.ws !== undefined || x.wu !== undefined) || !next.length) return next;
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
      // A cut by hand keeps its place inside its line even when the lines were renumbered (a line added above): the
      // word's new line plus the cut's fraction. A word joined to the line before stays joined (glue): it takes the line
      // of the word before it, as joinCue gave it.
      const cutLine = o.split && o.line !== undefined && b[j].line !== undefined ? b[j].line! + (o.line - Math.floor(o.line)) : o.line;
      if (o.manual || o.lock) out[j] = { ...b[j], s: o.s, e: o.e, ...(o.until === undefined ? {} : { until: o.until }), manual: true, ...(o.lock ? { lock: true } : {}),
        ...(o.split ? { line: cutLine, split: true } : {}),
        ...(o.glue ? { glue: true, line: j > 0 ? out[j - 1].line : b[j].line } : {}) };
      // The word-by-word retouches stay too.
      if (o.ws !== undefined || o.we !== undefined || o.wu !== undefined) out[j] = { ...out[j], ws: o.ws, we: o.we, wu: o.wu };
      i++; j++;
    } else if (L[(i + 1) * (m + 1) + j] >= L[i * (m + 1) + j + 1]) i++;
    else j++;
  }
  // A word new to a line retimed by hand (one the model had missed, a word added to the text) sits between its
  // neighbours of the text, whatever time the model gave it: never outside its line, never unseen.
  for (let j = 0; j < m; j++) {
    if (out[j].manual) continue;
    let r = j;
    while (r < m && !out[r].manual) r++;
    const before = out[j - 1], after = out[r];
    if (before?.manual && after?.manual && before.line === out[j].line && after.line === out[r - 1].line) {
      const run = out.slice(j, r);
      const placed: LyricWord[] = [{ ...before }];
      placeMissed(placed, run.map((x) => ({ w: x.w, line: x.line ?? 0 })), after.s);
      out[j - 1] = { ...before, e: placed[0].e };
      run.forEach((x, q) => { out[j + q] = { ...x, s: placed[q + 1].s, e: placed[q + 1].e }; });
    }
    j = r;
  }
  return out.sort((x, y) => x.s - y.s);
}

/** Some words were retimed by hand. */
export const hasManual = (words: LyricWord[] | undefined): boolean => !!words?.some((x) => x.manual);
/** The lines locked by the artist (their padlock), as line numbers. */
export const lockedLines = (words: LyricWord[] | undefined): Set<number> => new Set((words ?? []).filter((x) => x.lock).map((x) => x.line ?? -1));
/**
 * Lyrics placed again from scratch, the locked lines kept as they were (their times, their retouches): only those count
 * as retouched for keepManual, the other lines take the new placing.
 */
export function keepLocked(prev: LyricWord[], next: LyricWord[]): LyricWord[] {
  if (!prev.some((x) => x.lock)) return next;
  return fitBetweenLocked(keepManual(prev.map((x) => (x.lock ? { ...x, manual: true as const } : { ...x, manual: undefined, ws: undefined, we: undefined, wu: undefined })), next));
}

/**
 * The lines placed again never go over a locked line, nor past it against the text's order: each run of free lines
 * between two locked ones (in the text) stays in the room between them — moved there whole when it fits, else drawn
 * into it, its rhythm kept. The locked lines do not move.
 */
export function fitBetweenLocked(words: LyricWord[]): LyricWord[] {
  const byLine = new Map<number, number[]>();
  words.forEach((x, i) => { const l = x.line ?? -1; (byLine.get(l) ?? byLine.set(l, []).get(l)!).push(i); });
  const order = [...byLine.keys()].sort((a, b) => a - b);
  const locked = (l: number) => byLine.get(l)!.every((i) => words[i].lock);
  const endOf = (l: number) => Math.max(...byLine.get(l)!.map((i) => words[i].until ?? words[i].e));
  const startOf = (l: number) => Math.min(...byLine.get(l)!.map((i) => words[i].s));
  const out = words.slice();
  for (let k = 0; k < order.length;) {
    if (locked(order[k])) { k++; continue; }
    let j = k;
    while (j < order.length && !locked(order[j])) j++;
    const run = order.slice(k, j).flatMap((l) => byLine.get(l)!);
    const lo = k > 0 ? endOf(order[k - 1]) + 0.02 : 0, hi = j < order.length ? startOf(order[j]) - 0.02 : Infinity;
    const a = Math.min(...run.map((i) => words[i].s)), b = Math.max(...run.map((i) => words[i].until ?? words[i].e));
    k = j;
    if (a >= lo && b <= hi) continue;
    // where it goes: moved whole into the room if it fits, else drawn into it
    const len = b - a, room = hi - lo;
    const map = len <= room
      ? ((t: number) => t + (a < lo ? lo - a : hi - b))
      : ((t: number) => lo + ((t - a) / Math.max(0.01, len)) * room);
    for (const i of run) {
      const x = words[i];
      out[i] = { ...x, s: r3(map(x.s)), e: r3(Math.max(map(x.s) + 0.03, map(x.e))), ...(x.until === undefined ? {} : { until: r3(map(x.until)) }) };
    }
  }
  return out.sort((x, y) => x.s - y.s);
}

export function activeCue(cues: Cue[], time: number): Cue | null {
  let found: Cue | null = null;
  for (const c of cues) {
    if (c.start - 0.02 <= time) found = c;
    else break;
  }
  return found && time < found.end ? found : null;
}

/**
 * A caption's text written again by hand (a word the model missed, a typo): its words are replaced, keeping their
 * times when there are as many, else spread over the caption by syllables. Marked as retouched.
 */
export function rewriteCue(all: LyricWord[], cue: Cue, text: string): LyricWord[] {
  const ws = splitWords(text.replace(/\n/g, " ")).map((x) => x.w); // (a sign alone goes with its word)
  if (!ws.length) return all;
  const old = new Set(cue.words);
  const line = cue.words[0]?.line;
  const S = cue.words[0].s, E = Math.max(cue.words[cue.words.length - 1].e, S + 0.05 * ws.length);
  let fresh: LyricWord[];
  if (ws.length === cue.words.length) fresh = cue.words.map((x, i) => ({ ...x, w: ws[i], manual: true }));
  else {
    const total = ws.reduce((n, w) => n + syllables(w), 0);
    let at = S;
    fresh = ws.map((w) => {
      const d = ((E - S) * syllables(w)) / total;
      const x: LyricWord = { w, s: r3(at), e: r3(at + d), manual: true, ...(line === undefined ? {} : { line }) };
      at += d;
      return x;
    });
    const until = cue.words[cue.words.length - 1].until;
    if (until !== undefined) fresh[fresh.length - 1].until = until;
  }
  return [...all.filter((x) => !old.has(x)), ...fresh].sort((a, b) => a.s - b.s);
}

/** A caption cut in two before its word `k`: the second part becomes a caption of its own (a line of its own). */
/**
 * A caption joined with the next one: its words take this one's line and are glued (no automatic cut between them),
 * its timing kept; the end set by hand on this one dropped (they now follow on). To move a cut: join, then "Cut here".
 */
export function joinCue(all: LyricWord[], cue: Cue, next: Cue): LyricWord[] {
  const line = cue.words[0].line;
  const nextWords = new Set(next.words), last = cue.words[cue.words.length - 1];
  return all.map((x) => (nextWords.has(x) ? { ...x, line, glue: true, split: undefined, manual: true }
    : x === last ? { ...x, until: undefined, manual: true } : x));
}

export function splitCue(all: LyricWord[], cue: Cue, k: number): LyricWord[] {
  if (k <= 0 || k >= cue.words.length) return all;
  const second = new Set(cue.words.slice(k));
  const first = new Set(cue.words.slice(0, k));
  // Halfway between this part's line and the next line value there is (a written line, or a part cut before): cut
  // again and again, each part keeps a line of its own, never the next written line's.
  const own = cue.words[0].line ?? 0;
  const above = all.map((x) => x.line ?? 0).filter((l) => l > own);
  const next = above.length ? Math.min(...above, Math.floor(own) + 1) : Math.floor(own) + 1;
  const line = (own + next) / 2;
  return all.map((x) => (second.has(x) ? { ...x, line, split: true, manual: true } : first.has(x) ? { ...x, manual: true } : x));
}

/**
 * Last resort, when the heard words do not match the written ones well enough (a sung, busy mix): the written words
 * spread over the singing heard, in order (the k-th written word at the time of the matching share of the heard ones).
 * Rough: the lines land on the sung passages, to retouch. Null without heard words or written words.
 */
export function spreadOnHeard(written: string, heard: LyricWord[]): LyricWord[] | null {
  const ws = splitWords(written), hs = [...heard].sort((a, b) => a.s - b.s);
  if (!ws.length || !hs.length) return null;
  const at = (k: number) => hs[Math.min(hs.length - 1, Math.floor((k * hs.length) / ws.length))].s;
  return ws.map((x, k) => {
    const s = at(k), next = k + 1 < ws.length ? at(k + 1) : hs[hs.length - 1].e;
    return { w: x.w, s, e: Math.max(s + 0.08, Math.min(next, s + 1.2)), line: x.line };
  });
}

/**
 * The first word of a lyrics line glued by the speech model to the pause before it ("Je" heard at 15.2 s, "ne veux ni
 * tes mensonges" from 17.4 s: the line showed 2 s early): when a line's first word is more than 1.2 s before the next
 * word of the same line, it comes just before that word (a line is sung in one go). Lines retimed by hand stay.
 */
export function tightenLineStarts(words: LyricWord[]): LyricWord[] {
  const out = words.map((w) => ({ ...w }));
  for (let i = 0; i + 1 < out.length; i++) {
    const w = out[i], next = out[i + 1];
    if ((i > 0 && out[i - 1].line === w.line) || next.line !== w.line || w.manual) continue;
    if (next.s - w.s > 1.2) {
      w.s = Math.round((next.s - 0.3) * 1000) / 1000;
      w.e = Math.round((next.s - 0.02) * 1000) / 1000;
    }
  }
  return out;
}
