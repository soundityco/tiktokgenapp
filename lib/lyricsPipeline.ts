import type { LyricWord } from "./types";
import { type Emissions, alignDevice, alignEmissions } from "./alignAI";
import { FA_VOCAB, alignWordsForced, ctcStarts, faNorm, frenchSound, looksFrench, wordsInSpan } from "./forcedAlign";
import { findRepeats, foldedFit, melFrames, repeatPeriodIn } from "./repeatBlocks";
import { syllableSpans } from "./syllables";
import { alignSong, cleanHeard, norm, similarity, splitWords, syllables, withoutLost, wordsFromSegments } from "./lyricsAlign";
import { mergeHeard, noSpeech, relayWeakLines } from "./lyricsRelay";
import { type AsrModel, type AsrStep, prepareAudio, transcribe } from "./transcribe";
import { clamp } from "./render";

/** The lyrics are heard in windows of this length (s), overlapping a little so no word is cut. */
export const LYRICS_WIN = 28;
export const LYRICS_LAP = 2;

export interface PlaceHooks {
  model: AsrModel;
  language: string;
  onStep?: (s: AsrStep) => void;
  /** Download of a model (0..1). */
  onPct?: (p: number) => void;
  /** The listening itself (0..1). */
  onDone?: (p: number) => void;
  /** The relay starts (passages hard to hear are listened to again). */
  onRelay?: () => void;
  /** One progress for the whole placing, 0..1 (the models' loading, the alignment, the relay), never going back. */
  onOverall?: (p: number) => void;
  signal?: AbortSignal;
  /** Only these written lines (first, last) are sung in this audio (an excerpt of the song): the others are not placed. */
  lines?: [number, number];
}

/**
 * The written lyrics placed on the audio: forced alignment (lib/forcedAlign), then the relay on the passages it hardly
 * heard (lib/lyricsRelay, the speech model prompted with the lines before). The words placed (the app's "heard" words),
 * or null when the alignment cannot run here or the lyrics do not fit (the speech model's own way then).
 * Rejects with Error("aborted") when the signal fires. Shared by the video studio and the dev bench (app/dev/lyrics).
 */
export async function placeByAlignment(buf: AudioBuffer, written: string, h: PlaceHooks): Promise<LyricWord[] | null> {
  const aborted = (e: unknown) => h.signal?.aborted || (e instanceof Error && e.message === "aborted");
  // One bar: the alignment model's loading 0–30 %, the alignment 30–55 %, the relay (when there is one) 55–100 %.
  let shown = 0;
  const overall = (p: number) => { if (p > shown) { shown = p; h.onOverall?.(Math.min(1, p)); } };
  let forced: LyricWord[] | null = null;
  let em: Emissions;
  try {
    let step: AsrStep = "library";
    em = await alignEmissions(buf, {
      onStep: (x) => { step = x; h.onStep?.(x); if (x === "listen") overall(0.3); },
      onProgress: (p) => { if (step === "listen") { h.onDone?.(p); overall(0.3 + 0.25 * p); } else { h.onPct?.(p); overall(0.3 * p); } },
      signal: h.signal,
    });
    const ws = splitWords(written);
    forced = alignWordsForced(em.frames, em.T, em.V, h.lines ? ws.filter((w) => w.line >= h.lines![0] && w.line <= h.lines![1]) : ws);
    if (!forced) { console.warn("[align] the lyrics do not fit this audio: the speech model instead"); return null; }
    // What was placed, line by line (to compare with the song by ear): start, end, text.
    const lines = new Map<number, LyricWord[]>();
    for (const w of forced) { const k = w.line ?? -1; (lines.get(k) ?? lines.set(k, []).get(k)!).push(w); }
    console.debug(`[align] ${alignDevice === "webgpu" ? "graphics card" : "processor"}, ${em.T} frames, ${forced.length} words placed:\n` +
      [...lines.values()].map((ws) => `${ws[0].s.toFixed(2)} → ${ws[ws.length - 1].e.toFixed(2)}  ${ws.map((w) => w.w).join(" ")}${ws.some((w) => w.doubt) ? "  (to check)" : ""}`).join("\n"));
  } catch (e) {
    if (aborted(e)) throw new Error("aborted");
    console.warn("[align] precise alignment not available, the speech model instead", e);
    return null;
  }
  h.onStep?.("library"); h.onPct?.(0); h.onDone?.(0);
  const french = looksFrench(splitWords(written).map((x) => faNorm(x.w)));
  /** The rules that need no speech model: after a cut in the production, lines piled up, a chorus copied and pasted. */
  const finish = async (w: LyricWord[]) => {
    const placed = spreadPacked(afterBreaks(w, silencesOf(buf)));
    return inLines(markUnsure(placed, await applyRepeat(buf, em, placed, french)), em, french);
  };
  // The relay: passages the alignment hardly heard (a hook or a chorus drowned in effects), with lines piled up
  // there, are heard again by the speech model, and its times are used for those lines (lib/lyricsRelay).
  // (a weak run of 4 lines or more is heard again even when nothing piles up in it: a singer the model follows badly all
  // along places its lines at a plausible pace, but in the wrong place — Embers, its first verse 28 s early)
  const longWeak = (ws: LyricWord[]) => new Set(ws.map((w) => w.line)).size >= 4;
  const weakRuns: LyricWord[][] = [];
  for (let i = 0, cur: LyricWord[] = []; i <= forced.length; i++) { const x = forced[i]; if (x?.weak) { cur.push(x); continue; } if (cur.length) weakRuns.push(cur); cur = []; }
  if (!forced.some((x) => x.weak && x.doubt) && !weakRuns.some(longWeak)) { console.info("[align] no passage hard to hear: no relay"); overall(1); return finish(forced); }
  overall(0.55);
  // The passages to hear again: the runs of weak lines that hold a line piled up (doubt), not every weak line of the
  // song (a weak line nothing piles on keeps its place: hearing all between them was minutes for nothing).
  const runs: LyricWord[][] = [];
  for (let i = 0, cur: LyricWord[] = []; i <= forced.length; i++) {
    const x = forced[i];
    if (x?.weak) { cur.push(x); continue; }
    if (cur.some((w) => w.doubt) || longWeak(cur)) runs.push(cur);
    cur = [];
  }
  const weak = runs.flat();
  if (!weak.length) { overall(1); return finish(forced); }
  const lo = Math.min(...weak.map((x) => x.s)) - 2, hi = Math.max(...weak.map((x) => x.e)) + 2;
  try {
    h.onRelay?.();
    const heard: LyricWord[] = [];
    // The words of the lines to place there: what a useful listening must contain.
    const wanted = new Set(weak.map((x) => norm(x.w)).filter((x) => x.length > 1));
    const wantedCount = weak.length;
    // Windows laid on the passage itself. The speech model sometimes hears nothing in a whole window of music
    // ("...", "Thank you", "Sous-titrage") and everything in the same one a few seconds later (WANNA TRY: nothing
    // on 52–80 s, the hook and each chorus on 55–81 s): a window that gives nothing is heard again, moved.
    const starts: number[] = [];
    for (let a = Math.max(0, lo); a < hi; a += LYRICS_WIN - LYRICS_LAP) starts.push(a);
    let prevTo = -Infinity;
    for (let n = 0; n < starts.length; n++) {
      const a = starts[n], b = Math.min(buf.duration, a + LYRICS_WIN);
      // Several listenings (the window moved, with the lines sung just before as the model's context so it hears the
      // singing, or without it: the context can also make the model loop on it), the most complete one kept: the
      // speech model does not answer the same twice over music, the first useful one can miss half the chorus.
      let got: LyricWord[] = [], best = 0, heardTo = b;
      const tries = [[0, true], [-3, true]] as const;
      for (let ti = 0; ti < tries.length; ti++) {
        const [shift, withContext] = tries[ti];
        const s = clamp(a + shift, 0, Math.max(0, buf.duration - 4)), e = Math.min(buf.duration, s + LYRICS_WIN);
        const pcm = await prepareAudio(buf, s, e);
        const before = withContext ? contextBefore(forced, s) : "";
        const hear = (mode: "word" | "segment") => transcribe(pcm, { model: h.model, language: h.language, base: s, mode, raw: true, prompt: before || undefined, onStep: h.onStep, onProgress: h.onPct, signal: h.signal });
        // Its words with their own times (the finest, when they hold; its loops cut, "mort, mort, mort…" for a chorus
        // of "non"), and its phrases' times where no word was given (the word listening can stop early in a chorus).
        const rawWord = await hear("word");
        const byWord = cleanHeard(rawWord.filter((p) => !noSpeech(p.w)), written);
        // (the phrases too: a phrase looping on one line, "Don't you wanna try" a hundred times in a second)
        const rawSeg = await hear("segment");
        const bySeg = withoutLost(cleanHeard(wordsFromSegments(rawSeg.filter((p) => !noSpeech(p.w))), written), s, e);
        console.debug(`[align] relay ${s.toFixed(1)} s: words ${rawWord.length} → ${byWord.length}, phrases ${rawSeg.length} → ${bySeg.length} words`, rawSeg.map((p) => `${p.s.toFixed(1)}–${p.e.toFixed(1)} ${p.w}`).join(" | "));
        const heardHere = mergeHeard(withoutLost(byWord, s, e), bySeg);
        const score = usefulFor(heardHere, wanted) ? hitsOf(heardHere, wanted) : 0;
        console.info(`[align] relay: ${s.toFixed(1)}–${e.toFixed(1)} s ${withContext ? "with" : "without"} context: ${score} words of the lines heard`, heardHere.slice(0, 16).map((p) => p.w).join(" "));
        if (score > best) { best = score; got = heardHere; heardTo = e; }
        overall(0.55 + 0.45 * ((n + (ti + 1) / tries.length) / starts.length));
        if (best >= wantedCount * 0.6) break; // most of it heard: enough
      }
      // The overlap between two windows belongs to the one that hears it whole (its middle); a window heard moved
      // earlier ends earlier, and the next one takes over from there (nothing between them left unheard).
      const from = n === 0 ? -Infinity : prevTo, to = n === starts.length - 1 ? Infinity : Math.min(b - LYRICS_LAP / 2, heardTo - LYRICS_LAP / 2);
      prevTo = to;
      heard.push(...got.filter((p) => { const m = (p.s + p.e) / 2; return m >= from && m < to; }));
      h.onDone?.((n + 1) / starts.length);
    }
    const before = forced;
    const relayed = relayWeakLines(forced, heard, buf.duration);
    // Kept only when it does not pile up more lines than the alignment alone (a poor listening placed lines on almost
    // nothing): the relay must never make it worse.
    if (packedLines(relayed) > packedLines(before)) {
      console.info(`[align] relay heard too little to place the passage (${packedLines(relayed)} lines piled up against ${packedLines(before)}): the alignment kept`,
        heard.map((p) => `${p.s.toFixed(2)} ${p.w}`).join(" "));
      return finish(forced);
    }
    forced = relayed;
    const moved = forced.filter((x, i) => Math.abs(x.s - before[i].s) > 0.01).length;
    console.info(`[align] relay on ${lo.toFixed(1)}–${hi.toFixed(1)} s: ${heard.length} words heard, ${moved} words moved`, heard.map((p) => `${p.s.toFixed(2)} ${p.w}`).join(" "));
  } catch (e) {
    if (aborted(e)) throw new Error("aborted");
    console.warn("[align] relay not available (the speech model could not run), the alignment kept as it is", e);
  }
  h.onStep?.("library"); h.onPct?.(0); h.onDone?.(0);
  overall(1);
  return finish(forced);
}

/** Stretches of (almost) digital silence in the track, a cut in the production: [start, end] in seconds. */
export function silencesOf(buf: AudioBuffer, minLen = 0.06): [number, number][] {
  const ch = buf.getChannelData(0), rate = buf.sampleRate, step = Math.round(rate * 0.01);
  const rms: number[] = [];
  for (let i = 0; i + step <= ch.length; i += step) { let q = 0; for (let j = i; j < i + step; j++) q += ch[j] * ch[j]; rms.push(Math.sqrt(q / step)); }
  const loud = [...rms].sort((a, b) => a - b)[Math.floor(rms.length * 0.95)] || 1;
  const quiet = loud * 0.003; // −50 dB under the loud parts
  const out: [number, number][] = [];
  let from = -1;
  for (let i = 0; i <= rms.length; i++) {
    const q = i < rms.length && rms[i] < quiet;
    if (q && from < 0) from = i;
    if (!q && from >= 0) { if ((i - from) * 0.01 >= minLen) out.push([from * 0.01, i * 0.01]); from = -1; }
  }
  return out;
}

/**
 * Nobody sings through a cut in the production: a line the alignment hardly heard (`weak`) that starts just before a
 * silence (within BREAK_REACH) is sung after it (the chorus after a break in the beat). It starts after the silence, its
 * words keeping their spacing, never into the next line.
 */
const BREAK_REACH = 2;
export function afterBreaks(words: LyricWord[], silences: [number, number][]): LyricWord[] {
  if (!silences.length) return words;
  const out = words.slice();
  const lines: number[][] = [];
  words.forEach((w, i) => { const l = lines[lines.length - 1]; if (l && words[l[0]].line === w.line) l.push(i); else lines.push([i]); });
  lines.forEach((idx, k) => {
    if (!idx.some((i) => words[i].weak)) return;
    const s0 = out[idx[0]].s;
    const cut = silences.find(([a]) => a > s0 && a - s0 <= BREAK_REACH);
    if (!cut) return;
    const next = k + 1 < lines.length ? out[lines[k + 1][0]].s : Infinity;
    const to = cut[1] + 0.1;
    if (to >= next - 0.2) return;
    const span = Math.min(out[idx[idx.length - 1]].e, next - 0.04) - s0;
    const room = Math.min(span, next - 0.04 - to);
    const k2 = span > 0 ? room / span : 1;
    idx.forEach((i) => { const w = out[i]; out[i] = { ...w, s: to + (w.s - s0) * k2, e: to + (w.e - s0) * k2 }; });
    console.info(`[align] "${idx.map((i) => words[i].w).join(" ")}" moved after the break at ${cut[0].toFixed(2)} s`);
  });
  return out;
}

/**
 * A listening is useful when the words of the lines to place are in it, for a fair share of it: not "...", not the
 * model looping on its context ("Je crois que j'" over and over), not another passage.
 */
export function usefulFor(heard: LyricWord[], wanted: Set<string>): boolean {
  if (heard.length < 3) return false;
  const hits = hitsOf(heard, wanted);
  return hits >= 3 && hits / heard.length >= 0.3;
}

/**
 * The model's context for an excerpt starting at `at`: the last whole lines sung before it, as sentences ("Dans tes draps.
 * Je crois que j'aimerais revenir, non."). Never a line cut in the middle: the model would carry on with it, and loop.
 */
export function contextBefore(words: LyricWord[], at: number, lines = 2): string {
  const byLine = new Map<number, LyricWord[]>();
  for (const w of words) (byLine.get(w.line ?? -1) ?? byLine.set(w.line ?? -1, []).get(w.line ?? -1)!).push(w);
  const whole = [...byLine.values()].filter((ws) => ws[ws.length - 1].e <= at + 0.2);
  return whole.slice(-lines).map((ws) => {
    const t = ws.map((w) => w.w).join(" ").trim();
    return /[.!?…]$/.test(t) ? t : t.replace(/[,;:]$/, "") + ".";
  }).join(" ");
}

/** How many of the heard words are words of the lines to place. */
function hitsOf(heard: LyricWord[], wanted: Set<string>): number {
  const want = [...wanted];
  return heard.filter((x) => { const n = norm(x.w); return n.length > 1 && (wanted.has(n) || want.some((w) => similarity(w, n) >= 0.7)); }).length;
}

/** Lines piled up: shown less than 0.15 s before the next one starts. */
export function packedLines(words: LyricWord[]): number {
  const starts: number[] = [];
  let last = -1;
  for (const w of words) if (w.line !== last) { starts.push(w.s); last = w.line ?? -1; }
  let n = 0;
  for (let i = 0; i + 1 < starts.length; i++) if (starts[i + 1] - starts[i] < 0.15) n++;
  return n;
}

/** The written lyrics on words placed by the alignment, as the video studio shows them (lines, words, times). */
export function placeExact(written: string, heard: LyricWord[]): LyricWord[] {
  return alignSong(written, heard)?.words ?? [];
}

/**
 * Lines the alignment hardly heard, piled up one right after the other (starts less than PILE apart), with free time
 * after them (FREE or more before the next line): they were not sung there, they share that time. The line just before
 * them, when it is part of the pile (starting less than a second before), shares it too (its start kept: it was heard).
 * By their letters. WANNA TRY: "Don't you wanna try / Wanna try / Wanna try" at 59.8, 60.5, 60.9 then nothing until the
 * chorus at 65: 59.8, 62.4, 63.6 (the acapella: 59.75, 62.25, 63.4).
 */
const PILE = 0.6, FREE = 1.5;
export function spreadPacked(words: LyricWord[]): LyricWord[] {
  const out = words.slice();
  const lines: number[][] = [];
  words.forEach((w, i) => { const l = lines[lines.length - 1]; if (l && words[l[0]].line === w.line) l.push(i); else lines.push([i]); });
  const start = (k: number) => out[lines[k][0]].s;
  const weak = (k: number) => lines[k].some((i) => words[i].weak);
  for (let k = 0; k < lines.length; k++) {
    if (!weak(k)) continue;
    let j = k;
    while (j + 1 < lines.length && weak(j + 1) && start(j + 1) - start(j) < PILE) j++;
    const next = j + 1 < lines.length ? start(j + 1) : Infinity;
    const pile = j > k || (k > 0 && start(k) - start(k - 1) < PILE);
    if (!pile || next === Infinity || next - start(j) < FREE) { k = j; continue; }
    const from = k > 0 && start(k) - start(k - 1) < 1 ? k - 1 : k;
    const group = lines.slice(from, j + 1);
    const letters = group.map((l) => l.reduce((n, i) => n + Math.max(1, norm(words[i].w).length), 0));
    const total = letters.reduce((a, b) => a + b, 0);
    const a = start(from), b = next - 0.1;
    let at = a;
    group.forEach((l, q) => {
      const span = ((b - a) * letters[q]) / total;
      const n = l.reduce((m, i) => m + Math.max(1, norm(words[i].w).length), 0);
      let u = 0;
      l.forEach((i) => {
        const len = Math.max(1, norm(words[i].w).length);
        // its words in the first part of its share (sung, then held), the last one held to the end of it
        const ws = at + span * 0.7 * (u / n), we = at + span * 0.7 * ((u + len) / n);
        out[i] = { ...out[i], s: ws, e: i === l[l.length - 1] ? at + span - 0.04 : we };
        u += len;
      });
      at += span;
    });
    console.info(`[align] ${group.length} lines piled up spread over ${a.toFixed(2)}–${next.toFixed(2)} s`);
    k = j;
  }
  return out;
}

/**
 * A chorus copied and pasted that the alignment hardly heard (lib/repeatBlocks): the same lines repeated three times or
 * more, the sound repeating with a clear period; its copies heard together (the model's frames averaged one period
 * apart), its words placed on that average, every copy then placed the same way one period after the other.
 */
export async function applyRepeat(buf: AudioBuffer, em: Emissions, words: LyricWord[], french: boolean): Promise<LyricWord[]> {
  const lineOf: number[][] = [];
  words.forEach((w, i) => { const l = lineOf[lineOf.length - 1]; if (l && words[l[0]].line === w.line) l.push(i); else lineOf.push([i]); });
  // Every repeated block (a chorus in the intro and again at the end: two), each placed on its own.
  const reps = findRepeats(lineOf.map((l) => l.map((i) => words[i].w).join(" ")));
  if (!reps.length) return words;
  const textOf = (rep: { from: number; unit: number }) => lineOf.slice(rep.from, rep.from + rep.unit).map((l) => l.map((i) => norm(words[i].w)).join(" ")).join("|");
  // First the period of each one's sound (the time between two copies), where it can be heard.
  const plans: { rep: (typeof reps)[number]; P: number | null; score: number }[] = [];
  for (const rep of reps) {
    const first = rep.from, last = rep.from + rep.unit * rep.times - 1;
    const lines = lineOf.slice(first, last + 1);
    // Every copy with the same words, one for one ("Non non" and "Non-non" read alike but differ in words): else left.
    const perCopy = lineOf.slice(first, first + rep.unit).reduce((n, l) => n + l.length, 0);
    let same = true;
    for (let k = 1; k < rep.times; k++) if (lineOf.slice(first + k * rep.unit, first + (k + 1) * rep.unit).reduce((n, l) => n + l.length, 0) !== perCopy) same = false;
    if (!same) continue;
    // Heard well: the alignment places it better than this.
    const conf = lines.reduce((a, l) => a + (words[l[0]].conf ?? 0), 0) / lines.length;
    if (conf >= 0.15) continue;
    // Heard where the block can be: from the line before (its end) to the line after, not only where the alignment put
    // it (a passage it hardly heard is placed seconds off: the sound measured there held other things, no repeat).
    const end = last + 1 < lineOf.length ? words[lineOf[last + 1][0]].s : buf.duration;
    const from = first > 0 ? words[lineOf[first - 1][lineOf[first - 1].length - 1]].e : 0;
    const room = (end - from) / (rep.times - 0.5);
    let per: { period: number; score: number } | null = null;
    if (room >= 1.5) per = repeatPeriodIn(melFrames(await prepareAudio(buf, Math.max(0, from - 0.5), end)), 1.5, Math.min(9, room), rep.times);
    plans.push({ rep, P: per?.period ?? null, score: per?.score ?? 0 });
  }
  // The same words repeated elsewhere in the song are sung at the same pace: a block whose sound tells no period (a
  // blurred intro, its copies placed too early by the alignment) takes the clearest one of the same text.
  const clearest = new Map<string, { P: number; score: number }>();
  for (const x of plans) if (x.P) { const k = textOf(x.rep), c = clearest.get(k); if (!c || x.score > c.score) clearest.set(k, { P: x.P, score: x.score }); }
  let out = words;
  const placed: { first: number; last: number }[] = [];
  for (const x of plans) {
    const best = clearest.get(textOf(x.rep));
    if (!best) { console.info("[align] repeated lines, but no clear repeat in the sound: left as they are"); continue; }
    const next = await placeCopies(out, lineOf, x.rep, best.P, best.score, buf, em, french);
    if (next !== out) placed.push({ first: x.rep.from, last: x.rep.from + x.rep.unit * x.rep.times - 1 });
    out = next;
  }
  return placed.length ? realignBetween(out, lineOf, placed, em) : out;
}

const FRAME = 0.02; // one frame of the alignment model, s

/**
 * The lines between the repeated blocks placed (the verses between a chorus in the intro and the one at the end), aligned
 * again on their own, in the time left between those blocks. The whole song's alignment had placed them around the
 * blocks' wrong places: WANNA TRY [MASTER] with its intro chorus written, the first verse line came 1.9 s early, the
 * bridge 1.6 s.
 */
function realignBetween(words: LyricWord[], lineOf: number[][], placed: { first: number; last: number }[], em: Emissions): LyricWord[] {
  const blocks = [...placed].sort((a, b) => a.first - b.first);
  const out = words.slice();
  // Each run of lines between two blocks (or a block and the song's edge), with the last line of the block before it as a
  // guide: it takes the singing that runs over its estimated end (a held last word), never the run's first line. (The
  // next block's first line as a guide too pulled the bridge before it 1.2 s early: the run ends at its start.)
  const runs: { from: number; to: number; before: number[]; lines: number[]; after: number[] }[] = [];
  for (let b = 0; b <= blocks.length; b++) {
    const prev = blocks[b - 1], next = blocks[b];
    const a = prev ? prev.last + 1 : 0, z = next ? next.first - 1 : lineOf.length - 1;
    if (z < a) continue;
    const before = prev ? lineOf[prev.last] : [], after: number[] = [];
    const from = before.length ? out[before[0]].s : 0;
    const to = next ? out[lineOf[next.first][0]].s : em.T * FRAME;
    runs.push({ from, to, before, lines: lineOf.slice(a, z + 1).flat(), after });
  }
  for (const r of runs) {
    const f0 = Math.max(0, Math.floor(r.from / FRAME)), f1 = Math.min(em.T, Math.ceil(r.to / FRAME));
    const all = [...r.before, ...r.lines, ...r.after];
    if (f1 - f0 < 10 || !r.lines.length) continue;
    const written = all.map((i) => ({ w: out[i].w, line: out[i].line ?? 0 }));
    const again = alignWordsForced(em.frames.subarray(f0 * em.V, f1 * em.V), f1 - f0, em.V, written);
    if (!again || again.length !== all.length) continue;
    r.lines.forEach((i, k) => { const x = again[r.before.length + k]; out[i] = { ...out[i], s: x.s + f0 * FRAME, e: x.e + f0 * FRAME, conf: x.conf, doubt: x.doubt }; });
  }
  return out;
}

/**
 * Lines to check (the yellow dot, `doubt`): those the alignment hardly heard (mean confidence of their letters under
 * UNSURE), even when nothing piled up to tell it. Measured on six songs timed by hand (LRCLIB): 22 of the 25 lines placed
 * more than 1.5 s off were under 0.1, against 15 % of those placed right. Only marked, never moved; a line placed by its
 * chorus's repetition (`applyRepeat`, the copies heard together) is left unmarked: its place comes from the sound.
 */
const UNSURE = 0.1;
function markUnsure(before: LyricWord[], after: LyricWord[]): LyricWord[] {
  return after.map((w, i) => ((w.conf ?? 1) < UNSURE && !w.doubt && before[i] && Math.abs(before[i].s - w.s) < 0.01 ? { ...w, doubt: true } : w));
}

/** The copies of a repeated block placed one period apart, where the folded copies fit their letters best. */
async function placeCopies(words: LyricWord[], lineOf: number[][], rep: { from: number; unit: number; times: number }, P: number, score: number,
  buf: AudioBuffer, em: Emissions, french: boolean): Promise<LyricWord[]> {
  const first = rep.from, last = rep.from + rep.unit * rep.times - 1;
  const lines = lineOf.slice(first, last + 1);
  const s0 = words[lineOf[first][0]].s;
  const end = last + 1 < lineOf.length ? words[lineOf[last + 1][0]].s : buf.duration;
  const unit = lineOf.slice(first, first + rep.unit).flat();
  const toks: number[] = [], owner: number[] = [];
  unit.forEach((i, wi) => { const n = faNorm(words[i].w); for (const c of french ? frenchSound(n) : n) { const id = FA_VOCAB[c]; if (id !== undefined) { toks.push(id); owner.push(wi); } } });
  // Its first copy may start anywhere between the line before (its end) and the last place all the copies still fit
  // before the line after: not only around where the alignment put it (a passage it hardly heard, a blurred intro, was
  // placed seconds too early, and its true start was never tried).
  const prevEnd = first > 0 ? words[lineOf[first - 1][lineOf[first - 1].length - 1]].e : 0;
  let lo = prevEnd, hi = end - (rep.times - 0.5) * P;
  if (hi < lo) { lo = s0 - 1.5; hi = s0 + P; }
  // A copy starts and ends in a breath, never in the middle of a word: its first letter at least 0.16 s in, its last one
  // 0.1 s before its end. (WANNA TRY's chorus ends a copy and starts the next on the same line, "Tout mais pas ça", sung
  // close together: without it, a copy began in the middle of the line before and every first line came 1.3 s early.)
  const edged = (f: Float32Array, n: number, v: number, tk: number[]) => {
    const lo = new Int32Array(tk.length).fill(8), hi = new Int32Array(tk.length).fill(n - 6);
    return ctcStarts(f, n, v, tk, { lo, hi }) ?? ctcStarts(f, n, v, tk);
  };
  const fit = foldedFit(em.frames, em.T, em.V, lo, hi, P, rep.times, toks, owner, edged);
  if (!fit) return words;
  // One period earlier or later fits the folded letters almost as well (a copy laid over the intro's music: the other
  // three still say it all), and a hair of difference in the model's numbers chose one or the other (WANNA TRY's intro
  // chorus at 12.70 s, sung from 16.5). Of the two, the one whose copies all sound alike is kept: the copy least like the
  // others (log-mel, `copiesAlike`) clearly more alike than the other's (WANNA TRY: 0.53 against 0.33, the intro's music).
  let start = fit.start, worst = -Infinity;
  for (const alt of [fit.start - P, fit.start + P]) {
    if (alt < lo - 1e-6 || alt > hi + 1e-6 || alt + rep.times * P > end + 0.5) continue;
    if (worst === -Infinity) worst = Math.min(...(await copiesAlike(buf, fit.start, P, rep.times)));
    const theirs = Math.min(...(await copiesAlike(buf, alt, P, rep.times)));
    if (theirs > worst + 0.1) { console.info(`[align] the copies moved one period (${(alt - fit.start).toFixed(2)} s): they sound alike (${(theirs * 100).toFixed(0)} % against ${(worst * 100).toFixed(0)} %)`); start = alt; worst = theirs; }
  }
  const out = words.slice();
  const times: number[] = [];
  for (let k = 0; k < rep.times; k++) {
    unit.forEach((_, wi) => {
      const rel = isNaN(fit.wordStart[wi]) ? (wi > 0 ? times[times.length - 1] - (start + k * P) + 0.15 : 0) : fit.wordStart[wi];
      times.push(start + k * P + rel);
    });
  }
  const before = first > 0 ? words[lineOf[first - 1][0]].s : -Infinity;
  if (times[0] <= before + 0.2 || times[times.length - 1] >= end + 0.5) { console.info("[align] repeated lines: the copies do not fit in order, left as they are"); return words; }
  const idx = lines.flat();
  idx.forEach((i, q) => {
    const sNow = times[q], next = q + 1 < times.length ? times[q + 1] : Math.min(end, sNow + 1.2);
    const lineEnd = q + 1 >= idx.length || words[idx[q + 1]].line !== words[i].line;
    out[i] = { ...words[i], s: sNow, e: lineEnd ? Math.max(sNow + 0.1, Math.min(next - 0.04, sNow + 1.2)) : Math.max(sNow + 0.05, next - 0.02), doubt: undefined };
  });
  console.info(`[align] ${rep.times} copies of ${rep.unit} lines placed one period apart (${P.toFixed(2)} s, the sound alike at ${(score * 100).toFixed(0)} %), from ${times[0].toFixed(2)} s`);
  return out;
}

/** How much each copy sounds like the others (cosine of the log-mel frames, the copy against the mean of the others). */
async function copiesAlike(buf: AudioBuffer, start: number, P: number, times: number): Promise<number[]> {
  const fr = melFrames(await prepareAudio(buf, start, start + times * P));
  const per = Math.floor(P / 0.02), out: number[] = [];
  for (let k = 0; k < times; k++) {
    let sim = 0, n = 0;
    for (let f = 0; f < per; f++) {
      const a = fr[k * per + f];
      if (!a) continue;
      const mean = new Float32Array(a.length);
      let c = 0;
      for (let q = 0; q < times; q++) { const b = fr[q * per + f]; if (q === k || !b) continue; for (let d = 0; d < a.length; d++) mean[d] += b[d]; c++; }
      if (!c) continue;
      let ab = 0, aa = 0, bb = 0;
      for (let d = 0; d < a.length; d++) { const x = a[d], y = mean[d] / c; ab += x * y; aa += x * x; bb += y * y; }
      sim += ab / Math.sqrt(aa * bb + 1e-9); n++;
    }
    out.push(n ? sim / n : 0);
  }
  return out;
}

/**
 * Last: each line's words placed again inside the line's own span (up to the next line), on the model's letters there
 * (`wordsInSpan`). The lines stay where the chain put them; their words follow the voice inside them (piled up or spread
 * evenly by the relay and the rules before, they lit late or all at once in the "lit" captions).
 */
export function inLines(words: LyricWord[], em: Emissions, french: boolean, only?: Set<number>): LyricWord[] {
  const out = words.slice(), end = em.T * FRAME;
  const starts: number[] = [];
  for (let i = 0; i < words.length; i++) if (i === 0 || words[i].line !== words[i - 1].line) starts.push(i);
  const textOf = (l: LyricWord[]) => l.map((x) => norm(x.w)).join(" ");
  // each line heard again in its span; the hardly heard ones are settled after, with what the heard ones give
  const done: { a: number; b: number; heard: boolean; words: LyricWord[] | null; to: number; locked?: boolean }[] = [];
  starts.forEach((a, k) => {
    const b = k + 1 < starts.length ? starts[k + 1] : words.length;
    const line = words.slice(a, b);
    const to = b < words.length ? words[b].s : Math.min(end, words[b - 1].e + 0.3);
    if (line.some((x) => x.lock)) {
      // Locked: its words stay where the artist set them; only their syllables' times are added, heard inside each word
      // (the syllables the model hears in the line, kept where they fall in the word as it is placed).
      if (!only || only.has(line[0].line ?? -1)) {
        const own = french && looksFrench(line.map((x) => faNorm(x.w)));
        const again = wordsInSpan(em.frames, em.T, em.V, line, line[0].s, to, own);
        if (again && again.heard >= HEARD) line.forEach((x, j) => {
          const g = again.words[j];
          if (!g.sy) return;
          const sy = g.sy.map((f) => (g.s + f * (g.e - g.s) - x.s) / Math.max(0.05, x.e - x.s));
          if (sy.slice(1).every((f, q) => f > sy[q] && f > 0.02 && f < 0.97)) out[a + j] = { ...x, sy: [0, ...sy.slice(1).map((f) => Math.round(f * 1000) / 1000)] };
        });
      }
      done.push({ a, b, heard: true, words: null, to: 0, locked: true }); return;
    }
    if (only && !only.has(words[a].line ?? -1)) { done.push({ a, b, heard: !looksOff(line), words: null, to }); return; }
    // (each line in its own language: an English hook in a French song, read the French way, was hardly heard)
    const own = french && looksFrench(line.map((x) => faNorm(x.w)));
    const again = wordsInSpan(em.frames, em.T, em.V, line, words[a].s, to, own);
    done.push({ a, b, to, heard: !!again && again.heard >= HEARD, words: again && again.heard >= HEARD ? again.words : null });
  });
  for (const d of done) if (d.words) d.words.forEach((x, j) => { out[d.a + j] = x; });
  // Hardly heard (a voice the model follows badly, high-pitched…): its words stay when they look sung; else (a word
  // dragging over the line, words piled up: they lit late, all at once) they take the rhythm of the same line heard
  // elsewhere (a chorus, a repeated "Non"), or share the line by syllables at a sung pace. Measured on WANNA TRY: its
  // lines heard 0.18-0.40, its hook 0.07, a chorus's last line ~0.1 (spread over 2 s, its last word past the line).
  for (const d of done) {
    if (d.heard || d.words || (only && !only.has(words[d.a].line ?? -1))) continue;
    const line = words.slice(d.a, d.b);
    if (line.some((x) => x.lock)) continue;
    const from = line[0].s;
    // its twin: the same line locked by the artist (checked by ear), else heard well in this pass
    const same = (o: (typeof done)[number]) => o !== d && o.b - o.a === line.length && textOf(out.slice(o.a, o.b)) === textOf(line);
    const twin = done.find((o) => o.locked && same(o)) ?? done.find((o) => o.heard && o.words !== null && same(o));
    let fixed: LyricWord[];
    if (twin) {
      // its words in the twin's rhythm, brought to its own length: its start and its end stay where they are (set by hand
      // often), its inside follows the twin ("Non, non, non, non" of the intro, two words eaten together, as the final
      // chorus's, locked)
      const ref = out.slice(twin.a, twin.b), s0 = ref[0].s, rl = Math.max(0.05, (ref[ref.length - 1].until ?? ref[ref.length - 1].e) - s0);
      // (its own length when its end was set — `until`, by hand —; else the twin's, within its room)
      const set = line[line.length - 1].until;
      const own = Math.max(0.1 * line.length, set !== undefined ? Math.min(d.to, set) - from : Math.min(rl, d.to - from));
      const k = own / rl;
      fixed = line.map((x, j) => ({ ...x, s: Math.round((from + (ref[j].s - s0) * k) * 1000) / 1000, e: Math.round((from + (ref[j].e - s0) * k) * 1000) / 1000, ...(ref[j].sy ? { sy: ref[j].sy } : {}) }));
    } else {
      // only when its words do not look sung (a word dragging, words piled up); retouched by hand or not: what the artist
      // wants kept is locked, what is left unlocked is to fix
      if (!looksOff(line)) continue;
      fixed = bySyllables(line, from, from + (Math.min(d.to, line[line.length - 1].until ?? d.to) - from));
    }
    fixed.forEach((x, j) => { out[d.a + j] = x; });
  }
  // A word said again and again in a line ("non, non, non, non", "oh oh oh") is sung in an even rhythm: the model cannot
  // tell such words apart (it hears "non", not which one), so the words it found best set the step for all of them.
  for (const d of done) {
    if (d.locked || (only && !only.has(words[d.a].line ?? -1))) continue;
    const even = evenRepeats(out.slice(d.a, d.b), d.a > 0 ? out[d.a - 1].e : 0);
    if (even) even.forEach((x, j) => { out[d.a + j] = x; });
  }
  return unpileLines(out, only);
}

/**
 * A run of 3 or more same words in a line, sung in an even rhythm. Opening the line: its first and last words stay
 * (the line's start is often set by hand) and the others are spread evenly between them. Inside the line: the step
 * between its last two words (the model often finds the end of such a run and loses its start: two eaten together), or
 * the median of its steps that look sung, is taken for all of them, the run's last word staying. Never before `after` (the end of what comes before). Null: no run
 * to settle.
 */
export function evenRepeats(line: LyricWord[], after: number): LyricWord[] | null {
  let out: LyricWord[] | null = null;
  for (let i = 0; i < line.length;) {
    let j = i;
    while (j + 1 < line.length && norm(line[j + 1].w) === norm(line[i].w) && norm(line[i].w)) j++;
    const n = j - i + 1;
    if (n >= 3) {
      const run = line.slice(i, j + 1), gaps = run.slice(1).map((x, k) => x.s - run[k].s);
      const sung = gaps.filter((g) => g >= 0.12).sort((x, y) => x - y);
      const lastGap = gaps[gaps.length - 1];
      const step = lastGap >= 0.12 ? lastGap : sung.length ? sung[Math.floor(sung.length / 2)] : 0;
      const last = run[n - 1].s;
      // (opening the line: its start stays where it is — set by hand often — and the run is even up to its last word)
      const first = i === 0 ? run[0].s : Math.max(after + 0.01, last - (n - 1) * step);
      const st = n > 1 ? (last - first) / (n - 1) : 0;
      if (step > 0 && gaps.some((g) => Math.abs(g - st) > 0.03)) {
        out ??= line.slice();
        run.forEach((x, k) => {
          const s = Math.round((first + k * st) * 1000) / 1000;
          const e = k + 1 < n ? Math.round((first + (k + 1) * st - 0.02) * 1000) / 1000 : x.e;
          out![i + k] = { ...x, s, e: Math.max(s + 0.05, e) };
        });
      }
    }
    i = j + 1;
  }
  return out;
}

/**
 * The same line said again and piled on one instant (starting less than PILED apart: a repeated "Non / Non / Non /
 * Non" whose first two came together, the next two in time) share the room up to the next line, each moving whole. Locked lines
 * stay; with `only`, only runs touching those lines move.
 */
const PILED = 0.1;
export function unpileLines(words: LyricWord[], only?: Set<number>): LyricWord[] {
  const starts: number[] = [];
  for (let i = 0; i < words.length; i++) if (i === 0 || words[i].line !== words[i - 1].line) starts.push(i);
  const lineOf = (k: number) => words.slice(starts[k], k + 1 < starts.length ? starts[k + 1] : words.length);
  const out = words.slice();
  for (let k = 0; k < starts.length;) {
    let j = k;
    while (j + 1 < starts.length && words[starts[j + 1]].s - words[starts[j]].s < PILED) j++;
    if (j === k) { k++; continue; }
    const run = Array.from({ length: j - k + 1 }, (_, q) => lineOf(k + q));
    const touches = !only || run.some((l) => only.has(l[0].line ?? -1));
    const locked = run.some((l) => l.some((x) => x.lock));
    // (only a line said again, word for word: "Non / Non"; two different lines piled are a placing to check, and moving
    // the second one later was wrong as often as right — measured: Sombr, Temper)
    const same = run.every((l) => l.map((x) => norm(x.w)).join(" ") === run[0].map((x) => norm(x.w)).join(" "));
    const a = words[starts[k]].s;
    const nextStart = j + 1 < starts.length ? words[starts[j + 1]].s : Math.max(...run.map((l) => l[l.length - 1].e));
    k = j + 1;
    if (!touches || locked || !same || nextStart - a < 0.15 * run.length) continue;
    // each line its share of the room, by syllables, moved whole (its words keep their rhythm, squeezed into its share)
    const syl = run.map((l) => l.reduce((n, x) => n + syllables(x.w), 0)), total = syl.reduce((x, y) => x + y, 0);
    let at = a, idx = starts[k - run.length];
    run.forEach((l, q) => {
      const len = ((nextStart - a) * syl[q]) / total, s0 = l[0].s, span = Math.max(0.05, l[l.length - 1].e - s0);
      const k2 = Math.min(1, (len - 0.02) / span);
      l.forEach((x, w) => {
        const s = at + (x.s - s0) * k2, e = Math.min(at + len - 0.02, at + (x.e - s0) * k2);
        out[idx + w] = { ...x, s: Math.round(s * 1000) / 1000, e: Math.round(Math.max(s + 0.05, e) * 1000) / 1000, ...(x.until !== undefined ? { until: Math.round((at + len - 0.02) * 1000) / 1000 } : {}) };
      });
      idx += l.length;
      at += len;
    });
  }
  return out;
}

/** Under this, a line's letters are not heard well enough to place its words (mean probability on the path). */
const HEARD = 0.15;

/** A line's words that do not look sung: one dragging over half the line with under a third of its syllables, or two
 *  starting less than 0.08 s apart (nobody sings two words in 80 ms; "you" and "wanna" 47 ms apart in WANNA TRY's hook). */
function looksOff(line: LyricWord[]): boolean {
  if (line.length < 2) return false;
  const S = line[0].s, E = Math.max(line[line.length - 1].e, S + 0.05), total = line.reduce((n, x) => n + syllables(x.w), 0);
  let piled = 0;
  for (let i = 0; i < line.length; i++) {
    const end = i + 1 < line.length ? line[i + 1].s : line[i].e;
    if (i + 1 < line.length && end - line[i].s < 0.08) piled++;
    if ((end - line[i].s) / (E - S) > 0.5 && syllables(line[i].w) / total < 0.35) return true;
  }
  return piled >= 1;
}

/** A line's words sharing it by syllables, from its start, at a sung pace (0.3 s a syllable at most), within `end`. */
function bySyllables(line: LyricWord[], from: number, end: number): LyricWord[] {
  const syl = line.map((x) => syllables(x.w)), total = syl.reduce((a, b) => a + b, 0);
  const E = Math.max(from + 0.1 * total, Math.min(end, from + 0.3 * total + 0.2)); // (0.3 s a syllable at most)
  let at = 0;
  return line.map((x, i) => {
    const s = from + ((E - from) * at) / total;
    at += syl[i];
    const e = from + ((E - from) * at) / total;
    // (its written syllables evenly inside it: lit one after the other, an estimate as the words' times)
    const { sy: _sy, ...rest } = x, n = syllableSpans(x.w).length;
    return { ...rest, s: Math.round(s * 1000) / 1000, e: Math.round(Math.max(s + 0.05, e) * 1000) / 1000, ...(n > 1 ? { sy: Array.from({ length: n }, (_, k) => Math.round((k / n) * 1000) / 1000) } : {}) };
  });
}
