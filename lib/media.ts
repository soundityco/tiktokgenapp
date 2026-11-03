/** Audio helpers for the video studio. Everything runs in the browser: no file ever leaves the device. */

import { mixToMono } from "./syncAudio";
export { syncAudio, mixToMono, NO_SYNC } from "./syncAudio";
export type { SyncResult, Focus } from "./syncAudio";

const monoCache = new WeakMap<AudioBuffer, Float32Array>();
/** All channels averaged, cached per buffer (the same array lets the sync reuse the track\'s analysis). */
export function monoOf(buf: AudioBuffer): Float32Array {
  let x = monoCache.get(buf);
  if (!x) {
    x = mixToMono(Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i)));
    monoCache.set(buf, x);
  }
  return x;
}

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
