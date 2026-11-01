/** Audio helpers for the video studio. Everything runs in the browser: no file ever leaves the device. */

export interface SyncResult {
  /** Official-audio time of the clip's first frame, in seconds. */
  offset: number;
  /** Confidence, 0 to 1. */
  score: number;
  /** Clip seconds where the music really plays, null when it could not be told. */
  musicStart: number | null;
  musicEnd: number | null;
  /** How many spread-out excerpts of the official track agreed on the offset. */
  anchors: number;
}

/** Official-audio window the post uses, used to place the anchors where they matter. */
export interface Focus {
  from: number;
  to: number;
}

const EMPTY_SYNC: SyncResult = { offset: 0, score: 0, musicStart: null, musicEnd: null, anchors: 0 };

/** Mono RMS envelope, `rate` values per second. */
export function envelopeOf(samples: Float32Array, sampleRate: number, rate = 25): Float32Array {
  const win = Math.max(1, Math.round(sampleRate / rate));
  const n = Math.floor(samples.length / win);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    const base = i * win;
    for (let j = 0; j < win; j++) {
      const v = samples[base + j];
      sum += v * v;
    }
    out[i] = Math.sqrt(sum / win);
  }
  return out;
}

/** Peak per bucket, normalised to 0-1, for drawing a waveform. */
export function peaksOf(samples: Float32Array, buckets = 600): number[] {
  const out: number[] = [];
  const step = Math.max(1, Math.floor(samples.length / buckets));
  for (let i = 0; i < samples.length && out.length < buckets; i += step) {
    let peak = 0;
    for (let j = i; j < Math.min(i + step, samples.length); j++) peak = Math.max(peak, Math.abs(samples[j]));
    out.push(peak);
  }
  const max = Math.max(...out, 1e-9);
  return out.map((v) => v / max);
}

/** Zero-lag Pearson correlation of two equally long windows. */
function corr(x: Float32Array, xa: number, y: Float32Array, ya: number, n: number): number {
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += x[xa + i];
    my += y[ya + i];
  }
  mx /= n;
  my /= n;
  let dot = 0;
  let ex = 0;
  let ey = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[xa + i] - mx;
    const dy = y[ya + i] - my;
    dot += dx * dy;
    ex += dx * dx;
    ey += dy * dy;
  }
  return ex > 1e-9 && ey > 1e-9 ? dot / Math.sqrt(ex * ey) : 0;
}

/** Where a reference window matches best inside the clip (clip stays the long one here). */
function bestLag(clip: Float32Array, anchor: Float32Array): { lag: number; score: number; delta: number } | null {
  const n = anchor.length;
  const last = clip.length - n;
  if (n < 8 || last < 1) return null;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += anchor[i];
  mean /= n;
  const centred = new Float32Array(n);
  let energy = 0;
  for (let i = 0; i < n; i++) {
    const v = anchor[i] - mean;
    centred[i] = v;
    energy += v * v;
  }
  if (energy < 1e-9) return null;

  const scores = new Float32Array(last + 1);
  let best = 0;
  let bestScore = -Infinity;
  for (let lag = 0; lag <= last; lag++) {
    let dot = 0;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const r = clip[lag + i];
      dot += centred[i] * r;
      sum += r;
      sumSq += r * r;
    }
    const variance = sumSq - (sum * sum) / n;
    const score = variance > 1e-9 ? dot / Math.sqrt(energy * variance) : 0;
    scores[lag] = score;
    if (score > bestScore) { bestScore = score; best = lag; }
  }

  let delta = 0;
  if (best > 0 && best < last) {
    const y0 = scores[best - 1], y1 = scores[best], y2 = scores[best + 1];
    const den = y0 - 2 * y1 + y2;
    if (Math.abs(den) > 1e-9) delta = Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den));
  }
  return { lag: best, score: bestScore, delta };
}

/** Frame positions of the excerpts we try to recognise, spread over the segment and the whole track. */
function anchorPositions(refLen: number, alen: number, rate: number, focus?: Focus): number[] {
  const maxPos = refLen - alen;
  if (maxPos <= 0) return [0];
  const out: number[] = [];
  const push = (p: number) => {
    const q = Math.max(0, Math.min(maxPos, Math.round(p)));
    if (!out.some((x) => Math.abs(x - q) < rate * 2)) out.push(q);
  };
  const spread = (from: number, to: number, count: number) => {
    const lo = Math.max(0, Math.min(maxPos, from));
    const hi = Math.max(lo, Math.min(maxPos, to));
    for (let k = 0; k < count; k++) push(lo + ((hi - lo) * k) / Math.max(1, count - 1));
  };
  if (focus) spread((focus.from - 8) * rate, (focus.to + 8) * rate, 7);
  // Recordings start with (or just before) the song, and the real-time fallback only
  // listens to the first ~45 s: keep anchors inside that window.
  spread(0, Math.min(maxPos, rate * 60), 6);
  spread(0, maxPos, focus ? 4 : 9);
  return out;
}

/** Largest stretch of the clip that really is the reference at `lag`, in frames. */
function matchingRegion(clip: Float32Array, ref: Float32Array, lag: number, win: number): { start: number; end: number } | null {
  const n = clip.length;
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const len = Math.min(win, n - i);
    if (lag + i < 0 || lag + i + len > ref.length) continue;
    raw[i] = corr(clip, i, ref, lag + i, len);
  }
  const r = 2;
  const sm = new Float32Array(n);
  let max = 0;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let count = 0;
    for (let k = Math.max(0, i - r); k <= Math.min(n - 1, i + r); k++) { sum += raw[k]; count++; }
    sm[i] = sum / count;
    if (sm[i] > max) max = sm[i];
  }
  if (max < 0.35) return null;
  const thr = Math.max(0.3, max * 0.55);

  let bestStart = -1, bestEnd = -1, start = -1, lastGood = -1;
  const close = () => {
    if (start >= 0 && lastGood - start > bestEnd - bestStart) { bestStart = start; bestEnd = lastGood; }
    start = -1;
  };
  for (let i = 0; i < n; i++) {
    if (sm[i] >= thr) {
      if (start < 0) start = i;
      lastGood = i;
    } else if (start >= 0 && i - lastGood > win / 2) {
      close();
    }
  }
  close();
  if (bestStart < 0) return null;

  // A window that is half speech and half music still correlates: only call it music once a
  // whole window is solid, otherwise the reported start creeps into the talking intro.
  const solid = Math.max(0.45, max * 0.7);
  while (bestStart + win < bestEnd) {
    let full = true;
    for (let i = bestStart; i < bestStart + win; i++) {
      if (sm[i] < solid) { full = false; break; }
    }
    if (full) break;
    bestStart++;
  }
  return { start: bestStart, end: Math.min(n, bestEnd + win + 1) };
}

/** Fine offset search around a coarse lag, on a slice that is known to be music. */
function refineAt(clip: Float32Array, ref: Float32Array, a: number, b: number, lo: number, hi: number) {
  const n = b - a;
  const scores = new Float32Array(hi - lo + 1).fill(-1);
  let best = -1;
  let bestScore = -1;
  for (let lag = lo; lag <= hi; lag++) {
    if (lag < 0 || lag + b > ref.length) continue;
    const s = corr(clip, a, ref, lag + a, n);
    scores[lag - lo] = s;
    if (s > bestScore) { bestScore = s; best = lag; }
  }
  if (best < 0) return null;
  let delta = 0;
  const k = best - lo;
  if (k > 0 && k < scores.length - 1) {
    const y0 = scores[k - 1], y1 = scores[k], y2 = scores[k + 1];
    const den = y0 - 2 * y1 + y2;
    if (Math.abs(den) > 1e-9) delta = Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den));
  }
  return { lag: best, delta, score: bestScore };
}

/**
 * Where a camera recording sits in the official track.
 *
 * Correlating the whole recording never worked well: somebody saying "ok, j'enregistre" over
 * the intro drags the score down and pulls the match off. So instead we take a handful of
 * short excerpts spread over the official track (and around the segment), look for each of
 * them inside the recording, and keep the offset the majority agrees on. Excerpts that fall
 * outside the recorded part simply find nothing. The stretch that matched is then refined at
 * full precision, and its bounds tell us where the music really starts and ends.
 */
export function syncClip(clip: Float32Array, ref: Float32Array, rate: number, focus?: Focus): SyncResult {
  if (clip.length < rate * 2 || ref.length < rate * 4) return EMPTY_SYNC;
  const alen = Math.min(Math.round(rate * 4), Math.floor(clip.length * 0.8), ref.length);
  if (alen < rate) return EMPTY_SYNC;

  const found: { off: number; score: number }[] = [];
  for (const pos of anchorPositions(ref.length, alen, rate, focus)) {
    const m = bestLag(clip, ref.slice(pos, pos + alen));
    if (m && m.score >= 0.3) found.push({ off: pos / rate - m.lag / rate, score: m.score });
  }
  if (!found.length) return EMPTY_SYNC;

  // Keep the biggest group of offsets that agree within 0.4 s.
  found.sort((a, b) => a.off - b.off);
  let bestFrom = 0, bestTo = 0, bestWeight = 0;
  for (let i = 0; i < found.length; i++) {
    let weight = 0;
    let j = i;
    while (j < found.length && found[j].off - found[i].off <= 0.4) { weight += found[j].score ** 2; j++; }
    if (weight > bestWeight) { bestWeight = weight; bestFrom = i; bestTo = j; }
  }
  const cluster = found.slice(bestFrom, bestTo);
  let wsum = 0;
  let osum = 0;
  for (const c of cluster) {
    const w = c.score * c.score;
    wsum += w;
    osum += c.off * w;
  }
  let offset = Math.round((osum / wsum) * rate) / rate;
  let score = Math.max(...cluster.map((c) => c.score));

  const win = Math.round(rate);
  let region = matchingRegion(clip, ref, Math.round(offset * rate), win);
  if (region) {
    const a = Math.min(region.start + Math.round(rate * 0.2), Math.max(0, region.end - rate));
    const b = Math.min(region.end, a + Math.round(rate * 12));
    if (b - a >= rate) {
      const centre = Math.round(offset * rate);
      const span = Math.round(rate * 0.7);
      const fine = refineAt(clip, ref, a, b, centre - span, centre + span);
      if (fine && fine.score > 0.3) {
        offset = (fine.lag + fine.delta) / rate;
        score = Math.max(score, fine.score);
      }
    }
  }

  region = matchingRegion(clip, ref, Math.round(offset * rate), win);
  const musicStart = region && region.end - region.start >= rate ? region.start / rate : null;
  const musicEnd = musicStart === null || !region ? null : region.end / rate;
  const anchors = cluster.length;
  const support = anchors >= 3 ? 1 : anchors === 2 ? 0.95 : 0.85;
  return { offset, score: Math.max(0, Math.min(1, score * support)), musicStart, musicEnd, anchors };
}

/** Frame count of the shortest silence that separates two lyric lines. */
const MIN_GAP = 0.25;

/** Sharp rises of the envelope: the attacks a singer starts a line on. */
function onsetPeaks(env: Float32Array, rate: number, from: number, to: number): { t: number; strength: number }[] {
  const a = Math.max(1, Math.floor(from * rate));
  const b = Math.min(env.length, Math.ceil(to * rate));
  const out: { t: number; strength: number }[] = [];
  if (b - a < 2) return out;

  const diff = new Float32Array(b - a);
  let max = 0;
  for (let i = a; i < b; i++) {
    const d = Math.max(0, env[i] - env[i - 1]);
    diff[i - a] = d;
    if (d > max) max = d;
  }
  if (max < 1e-4) return out;
  const thr = max * 0.15;

  for (let i = 0; i < diff.length; i++) {
    const d = diff[i];
    if (d < thr) continue;
    const prev = i > 0 ? diff[i - 1] : 0;
    const next = i < diff.length - 1 ? diff[i + 1] : 0;
    if (d < prev || d < next) continue;
    const t = (a + i) / rate;
    const last = out[out.length - 1];
    if (last && t - last.t < MIN_GAP) {
      if (d > last.strength) out[out.length - 1] = { t, strength: d };
      continue;
    }
    out.push({ t, strength: d });
  }
  return out;
}

const VOWELS = /[aeiouyàâäéèêëîïôöùûüÿœæ]+/gi;

/** Rough duration of a line: its vowel groups. Far better than the raw character count. */
const syllables = (text: string) => (text.match(VOWELS) ?? []).length;

/**
 * Automatic lyric timing for one segment. Lines are spread over the segment by length, then
 * each one is pulled onto the closest attack of the official audio, so a line starts where
 * something actually starts instead of at an arbitrary fraction of the segment.
 */
export function autoLineTimes(lines: string[], env: Float32Array, rate: number, from: number, to: number): number[] {
  const count = lines.length;
  if (!count) return [];
  const start = Math.max(0, from) + 0.2;
  const end = Math.max(start + 0.5, to - 0.4);
  const weights = lines.map((l) => Math.max(4, syllables(l)));
  const total = weights.reduce((a, b) => a + b, 0) || count;

  const targets: number[] = [];
  let acc = 0;
  for (let i = 0; i < count; i++) {
    targets.push(start + ((end - start) * (acc + weights[i] / 2)) / total);
    acc += weights[i];
  }

  const onsets = onsetPeaks(env, rate, from, to);
  const used = new Set<number>();
  const out: number[] = [];
  let min = 0;
  for (const target of targets) {
    let best = -1;
    let bestScore = 0;
    for (let k = 0; k < onsets.length; k++) {
      if (used.has(k)) continue;
      const o = onsets[k];
      if (o.t <= min || o.t > to - 0.1) continue;
      const d = Math.abs(o.t - target);
      if (d > 1.2) continue;
      const s = o.strength * (1 - d / 1.2);
      if (s > bestScore) { bestScore = s; best = k; }
    }
    let t: number;
    if (best >= 0) {
      used.add(best);
      t = onsets[best].t;
    } else {
      t = Math.max(min + MIN_GAP, Math.min(to - 0.05, target));
    }
    out.push(t);
    min = t;
  }
  return out;
}

export async function decodeAudio(ctx: BaseAudioContext, blob: Blob): Promise<AudioBuffer> {
  return await ctx.decodeAudioData(await blob.arrayBuffer());
}

export const fmtTime = (s: number) => {
  const v = Math.max(0, s);
  const m = Math.floor(v / 60);
  const sec = v - m * 60;
  return `${m}:${sec < 10 ? "0" : ""}${sec.toFixed(1)}`;
};
