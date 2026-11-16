import type { LyricWord } from "./types";
import { type Emissions, alignDevice, alignEmissions } from "./alignAI";
import { FA_VOCAB, alignWordsForced, ctcStarts, faNorm, frenchSound, looksFrench } from "./forcedAlign";
import { findRepeat, foldedFit, melFrames, repeatPeriod } from "./repeatBlocks";
import { alignSong, cleanHeard, norm, similarity, splitWords, withoutLost, wordsFromSegments } from "./lyricsAlign";
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
    forced = alignWordsForced(em.frames, em.T, em.V, splitWords(written));
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
  const finish = async (w: LyricWord[]) => applyRepeat(buf, em, spreadPacked(afterBreaks(w, silencesOf(buf))), french);
  // The relay: passages the alignment hardly heard (a hook or a chorus drowned in effects), with lines piled up
  // there, are heard again by the speech model, and its times are used for those lines (lib/lyricsRelay).
  if (!forced.some((x) => x.weak && x.doubt)) { console.info("[align] no passage hard to hear: no relay"); overall(1); return finish(forced); }
  overall(0.55);
  // The passages to hear again: the runs of weak lines that hold a line piled up (doubt), not every weak line of the
  // song (a weak line nothing piles on keeps its place: hearing all between them was minutes for nothing).
  const runs: LyricWord[][] = [];
  for (let i = 0, cur: LyricWord[] = []; i <= forced.length; i++) {
    const x = forced[i];
    if (x?.weak) { cur.push(x); continue; }
    if (cur.some((w) => w.doubt)) runs.push(cur);
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
  const rep = findRepeat(lineOf.map((l) => l.map((i) => words[i].w).join(" ")));
  if (!rep) return words;
  const first = rep.from, last = rep.from + rep.unit * rep.times - 1;
  const lines = lineOf.slice(first, last + 1);
  // Every copy with the same words, one for one ("Non non" and "Non-non" read alike but differ in words): else left.
  const perCopy = lineOf.slice(first, first + rep.unit).reduce((n, l) => n + l.length, 0);
  for (let k = 1; k < rep.times; k++) if (lineOf.slice(first + k * rep.unit, first + (k + 1) * rep.unit).reduce((n, l) => n + l.length, 0) !== perCopy) return words;
  // Heard well: the alignment places it better than this.
  const conf = lines.reduce((a, l) => a + (words[l[0]].conf ?? 0), 0) / lines.length;
  if (conf >= 0.15) return words;
  const s0 = words[lineOf[first][0]].s;
  const end = last + 1 < lineOf.length ? words[lineOf[last + 1][0]].s : buf.duration;
  const E = (end - s0) / rep.times;
  if (E < 1) return words;
  const frames = melFrames(await prepareAudio(buf, Math.max(0, s0 - 1), end));
  const per = repeatPeriod(frames, E * 0.6, E * 1.5);
  if (!per) { console.info("[align] repeated lines, but no clear repeat in the sound: left as they are"); return words; }
  const P = per.period;
  const unit = lineOf.slice(first, first + rep.unit).flat();
  const toks: number[] = [], owner: number[] = [];
  unit.forEach((i, wi) => { const n = faNorm(words[i].w); for (const c of french ? frenchSound(n) : n) { const id = FA_VOCAB[c]; if (id !== undefined) { toks.push(id); owner.push(wi); } } });
  const fit = foldedFit(em.frames, em.T, em.V, s0 - 1.5, s0 + P, P, rep.times, toks, owner, (f, n, v, tk) => ctcStarts(f, n, v, tk));
  if (!fit) return words;
  const out = words.slice();
  const times: number[] = [];
  for (let k = 0; k < rep.times; k++) {
    unit.forEach((_, wi) => {
      const rel = isNaN(fit.wordStart[wi]) ? (wi > 0 ? times[times.length - 1] - (fit.start + k * P) + 0.15 : 0) : fit.wordStart[wi];
      times.push(fit.start + k * P + rel);
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
  console.info(`[align] ${rep.times} copies of ${rep.unit} lines placed one period apart (${P.toFixed(2)} s, the sound alike at ${(per.score * 100).toFixed(0)} %), from ${times[0].toFixed(2)} s`);
  return out;
}
