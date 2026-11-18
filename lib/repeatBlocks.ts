import { norm } from "./lyricsAlign";

/**
 * A chorus copied and pasted: the same lines sung the same way several times in a row ("Tout mais pas ça / Non ×4 /
 * Tout mais pas ça" four times). When the alignment hardly hears it (effects), it cannot tell its copies apart and
 * places them unevenly. The audio itself repeats with a fixed period: measured on the sound (its spectrum, not the
 * voice), it places every copy, phased on the bits of them the alignment did hear clearly.
 */

/** A run of the same lines repeated: lines `from` .. `from + unit * times - 1`. */
export interface Repeat { from: number; unit: number; times: number }

/** The longest run of a group of lines repeated word for word at least 3 times in a row. */
export function findRepeat(lines: string[], minTimes = 3): Repeat | null {
  const key = lines.map((l) => norm(l));
  let best: Repeat | null = null;
  for (let unit = 1; unit <= 12; unit++) {
    for (let from = 0; from + unit * minTimes <= key.length; from++) {
      let times = 1;
      while (from + (times + 1) * unit <= key.length && key.slice(from + times * unit, from + (times + 1) * unit).every((x, i) => x && x === key[from + i])) times++;
      if (times >= minTimes && (!best || unit * times > best.unit * best.times)) best = { from, unit, times };
    }
  }
  // A unit made of a smaller one repeated (unit 2 of "Non, Non") is that smaller one: kept as found (longest coverage).
  return best;
}

/** Every block repeated (≥ `minTimes` in a row) in the lyrics, the longest first found, none overlapping, in text
 *  order: a chorus written in the intro and again at the end are two blocks. */
export function findRepeats(lines: string[], minTimes = 3): Repeat[] {
  const left = lines.slice(), out: Repeat[] = [];
  for (;;) {
    const r = findRepeat(left, minTimes);
    if (!r) break;
    out.push(r);
    for (let i = r.from; i < r.from + r.unit * r.times; i++) left[i] = "";
  }
  return out.sort((a, b) => a.from - b.from);
}

// ---------- the sound's repetition period ----------

function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, ai = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k + len / 2] = re[i + k] - ar; im[i + k + len / 2] = im[i + k] - ai;
        re[i + k] += ar; im[i + k] += ai;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

/** Log-mel spectrum (40 bands, 60 Hz – 7 kHz) of 16 kHz mono samples, every 20 ms, each band centred and scaled. */
export function melFrames(x: Float32Array, rate = 16000): Float32Array[] {
  const n = 1024, hop = Math.round(rate * 0.02), bands = 40;
  const mel = (f: number) => 2595 * Math.log10(1 + f / 700), imel = (m: number) => 700 * (10 ** (m / 2595) - 1);
  const pts = Array.from({ length: bands + 2 }, (_, i) => Math.floor(((n + 1) * imel(mel(60) + ((mel(7000) - mel(60)) * i) / (bands + 1))) / rate));
  const win = Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  const out: Float32Array[] = [];
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let at = 0; at + n <= x.length; at += hop) {
    for (let i = 0; i < n; i++) { re[i] = x[at + i] * win[i]; im[i] = 0; }
    fft(re, im);
    const f = new Float32Array(bands);
    for (let b = 0; b < bands; b++) {
      const l = pts[b], c = pts[b + 1], r = pts[b + 2];
      let e = 0;
      for (let k = l; k < r; k++) { const p = re[k] * re[k] + im[k] * im[k]; e += p * (k < c ? (k - l) / Math.max(1, c - l) : (r - k) / Math.max(1, r - c)); }
      f[b] = Math.log(e + 1e-8);
    }
    out.push(f);
  }
  for (let b = 0; b < bands; b++) {
    let m = 0; for (const f of out) m += f[b]; m /= out.length || 1;
    let v = 0; for (const f of out) v += (f[b] - m) ** 2; const sd = Math.sqrt(v / (out.length || 1)) + 1e-6;
    for (const f of out) f[b] = (f[b] - m) / sd;
  }
  return out;
}

/**
 * The period (seconds) the sound repeats with, between `min` and `max`, and how alike it is (mean cosine of the frames
 * one period apart, 0..1). Null when nothing repeats clearly.
 */
export function repeatPeriod(frames: Float32Array[], min: number, max: number, frame = 0.02): { period: number; score: number } | null {
  let best = { period: 0, score: -1 }, second = -1;
  const scores: [number, number][] = [];
  for (let L = Math.round(min / frame); L <= Math.round(max / frame) && L < frames.length - 25; L++) {
    let sum = 0, n = 0;
    for (let i = 0; i + L < frames.length; i++) {
      const a = frames[i], b = frames[i + L];
      let d = 0, na = 0, nb = 0;
      for (let k = 0; k < a.length; k++) { d += a[k] * b[k]; na += a[k] * a[k]; nb += b[k] * b[k]; }
      sum += d / (Math.sqrt(na * nb) + 1e-9); n++;
    }
    scores.push([L * frame, sum / n]);
  }
  for (const [p, s] of scores) if (s > best.score) best = { period: p, score: s };
  // The best that is not next to it (a different period): the peak must stand out.
  for (const [p, s] of scores) if (Math.abs(p - best.period) > 0.15 && s > second) second = s;
  // Measured: WANNA TRY's chorus 0.60 (clear), Fontaines D.C.'s repeated line 0.41 (placing it so cost a line): 0.5.
  return best.score >= 0.5 && best.score - second >= 0.1 ? best : null;
}

/**
 * The period of a block of `times` copies somewhere in `frames` (a passage that also holds other things: the bridge
 * before a chorus, an intro's instrumental): for each period, the stretch of (times − 1) periods where the frames one
 * period apart are the most alike (mean cosine), and the best period. Measured on WANNA TRY [MASTER INSTA]: over its
 * whole intro (0–35 s) or its chorus with the bridge before it, the mean over everything found nothing, this finds
 * 4.06 s (0.60 / 0.61) and where the copies start (16.7 / 64.7 s). A period's double or half is not a rival (the sound
 * repeats there too), only another period is.
 */
export function repeatPeriodIn(frames: Float32Array[], min: number, max: number, times: number, frame = 0.02): { period: number; score: number; at: number } | null {
  const n = frames.length;
  if (times < 2) return null;
  const nrm = frames.map((f) => Math.sqrt(f.reduce((a, v) => a + v * v, 0)) + 1e-9);
  const scores: { period: number; score: number; at: number }[] = [];
  for (let L = Math.max(1, Math.round(min / frame)); L <= Math.round(max / frame); L++) {
    const m = (times - 1) * L;
    if (m + L > n) break;
    const pre = new Float64Array(n - L + 1);
    for (let i = 0; i + L < n; i++) {
      const a = frames[i], b = frames[i + L];
      let d = 0;
      for (let k = 0; k < a.length; k++) d += a[k] * b[k];
      pre[i + 1] = pre[i] + d / (nrm[i] * nrm[i + L]);
    }
    let best = -1, at = 0;
    for (let i = 0; i + m <= n - L; i++) { const s = (pre[i + m] - pre[i]) / m; if (s > best) { best = s; at = i; } }
    scores.push({ period: L * frame, score: best, at: at * frame });
  }
  if (!scores.length) return null;
  let best = scores[0];
  for (const x of scores) if (x.score > best.score) best = x;
  const harmonic = (p: number) => [0.5, 1, 2, 1 / 3, 3].some((k) => Math.abs(p - best.period * k) <= 0.15);
  let second = -1;
  for (const x of scores) if (!harmonic(x.period) && x.score > second) second = x.score;
  return best.score >= 0.5 && best.score - second >= 0.1 ? best : null;
}

/**
 * The copies heard together: the model's frames of every copy averaged, one period apart, from each possible start
 * (20 ms steps over one period); the block's letters aligned on that average (what one copy says faintly, four say
 * clearly); the start whose alignment fits best kept. Gives the copies' start and where each word of a copy is sung.
 * `toks`/`owner`: the block's letters (model ids) and the word (index in the block) each belongs to.
 */
export function foldedFit(
  emis: Float32Array, T: number, V: number, from: number, to: number, period: number, times: number,
  toks: number[], owner: number[], align: (e: Float32Array, T: number, V: number, toks: number[]) => Int32Array | null,
  frame = 0.02,
): { start: number; wordStart: number[] } | null {
  const P = Math.round(period / frame);
  if (!toks.length || P < toks.length + 2) return null;
  let best: { score: number; start: number; starts: Int32Array } | null = null;
  const folded = new Float32Array(P * V);
  for (let f0 = Math.round(from / frame); f0 <= Math.round(to / frame); f0++) {
    // (the last copy may run past the end of the audio after its last word, a song ending on its chorus: that time is
    // silence there, the blank; else its true start was never tried and the copies were placed a second early)
    if (f0 < 0 || f0 + (times - 1) * P >= T) continue;
    for (let t = 0; t < P; t++) {
      for (let v = 0; v < V; v++) {
        let p = 0;
        for (let k = 0; k < times; k++) { const f = f0 + k * P + t; p += f < T ? Math.exp(emis[f * V + v]) : v === 0 ? 1 : 0; }
        folded[t * V + v] = Math.log(p / times + 1e-9);
      }
    }
    const st = align(folded, P, V, toks);
    if (!st) continue;
    let score = 0;
    for (let k = 0; k < toks.length; k++) score += folded[st[k] * V + toks[k]];
    if (!best || score > best.score) best = { score, start: f0 * frame, starts: st };
  }
  if (!best) return null;
  const nWords = owner[owner.length - 1] + 1;
  const wordStart = new Array<number>(nWords).fill(NaN);
  for (let k = 0; k < toks.length; k++) if (isNaN(wordStart[owner[k]])) wordStart[owner[k]] = best.starts[k] * frame;
  return { start: best.start, wordStart };
}
