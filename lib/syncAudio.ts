/**
 * Where does a camera recording sit inside the official track?
 *
 * The old approach compared loudness (RMS) envelopes. Loudness says almost nothing about *where*
 * in a song you are: a drum loop repeats every bar, a phone's auto-gain flattens everything, so
 * unrelated passages looked identical, and the wrong answer came back with a high "score".
 *
 * This version compares what the music actually sounds like over time:
 *   1. each signal becomes a spectrogram (32 mel bands, 40 frames per second, log scale);
 *   2. slow changes are removed (phone gain control, room, speaker EQ) and each band is normalised;
 *   3. short chunks of the recording are slid over the WHOLE official track with an FFT cross-correlation
 *      (all bands at once): chords, melody, bass line and timbre make the right spot stand out;
 *   4. every chunk votes for an offset, weighted by how much its best match beats the runner-up,
 *      so someone talking over the intro, or a repeated chorus, cannot decide alone;
 *   5. at the strongest offsets, the stretches where the music really matches become "takes"
 *      (a video can hold the same passage filmed 2-3 times, each with its own offset);
 *   6. the take covering the post's segment is used, its offset refined where the music plays.
 *
 * Pure functions, no browser API: it runs the same in the app and in the tests.
 */

export interface SyncResult {
  /** Official-audio time of the clip's first frame, in seconds (negative if the clip starts before the music). */
  offset: number;
  /** Confidence, 0 to 1. */
  score: number;
  /** Clip seconds where the music really plays, null when it could not be told. */
  musicStart: number | null;
  musicEnd: number | null;
  /** How many chunks of the recording agreed on the offset. */
  anchors: number;
  /**
   * Every take found in the clip (several when the passage was filmed 2-3 times in one video),
   * in clip order. `offset`/`musicStart`/`musicEnd` above are those of the take used.
   */
  takes: Take[];
}

/** One stretch of the clip where it plays a part of the official track. */
export interface Take {
  offset: number;
  musicStart: number;
  musicEnd: number;
  /** Strength relative to the best take, 0 to 1. */
  strength: number;
}

/** Official-audio window the post uses: breaks ties between identical repeats (verse 2 vs verse 1). */
export interface Focus {
  from: number;
  to: number;
}

export const NO_SYNC: SyncResult = { offset: 0, score: 0, musicStart: null, musicEnd: null, anchors: 0, takes: [] };

const FPS = 40; // feature frames per second (25 ms)
const BANDS = 32;
const SMOOTH = 40; // frames either side removed as "slow" background (1 s)
const CHUNK = 6 * FPS; // 6 s excerpts
const CHUNK_HOP = 2 * FPS;
const EXCLUDE = FPS; // ±1 s around the best peak does not count as a rival

// ---------------------------------------------------------------- FFT ----

const twiddles = new Map<number, { cos: Float64Array; sin: Float64Array }>();
function tw(n: number) {
  let t = twiddles.get(n);
  if (!t) {
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    t = { cos, sin };
    twiddles.set(n, t);
  }
  return t;
}

/** In-place iterative radix-2 FFT. `n` must be a power of two. */
export function fft(re: Float64Array, im: Float64Array, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const a = re[i]; re[i] = re[j]; re[j] = a;
      const b = im[i]; im[i] = im[j]; im[j] = b;
    }
  }
  const { cos, sin } = tw(n);
  const sgn = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0, w = 0; k < half; k++, w += step) {
        const wr = cos[w], wi = sgn * sin[w];
        const a = i + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

const pow2 = (n: number) => { let p = 1; while (p < n) p <<= 1; return p; };

// ----------------------------------------------------------- features ----

export interface Features {
  /** bands[b][frame]: normalised log-mel "texture". */
  bands: Float32Array[];
  frames: number;
  /** Per-frame energy over all bands (for normalised correlation). */
  energy: Float64Array;
  /** Cached FFT of every band, for correlating many chunks against the same reference. */
  spectra?: { size: number; re: Float64Array[]; im: Float64Array[] };
}

const mel = (f: number) => 2595 * Math.log10(1 + f / 700);
const imel = (m: number) => 700 * (10 ** (m / 2595) - 1);

/** Mono, ~16 kHz: cheap box-filter decimation is plenty for a 100 Hz - 7 kHz spectral fingerprint. */
function decimate(x: Float32Array, rate: number): { x: Float32Array; rate: number } {
  const d = Math.max(1, Math.round(rate / 16000));
  if (d === 1) return { x, rate };
  const n = Math.floor(x.length / d);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const base = i * d;
    for (let k = 0; k < d; k++) s += x[base + k];
    out[i] = s / d;
  }
  return { x: out, rate: rate / d };
}

export function featuresOf(samples: Float32Array, sampleRate: number): Features {
  const { x, rate } = decimate(samples, sampleRate);
  const N = pow2(Math.round(rate * 0.06)); // ~64 ms analysis window
  const half = N / 2;
  const hop = rate / FPS;
  const frames = Math.max(0, Math.floor((x.length / hop)));

  const hann = new Float64Array(N);
  for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);

  // triangular mel filters over rFFT bins
  const fLo = 100;
  const fHi = Math.min(7000, rate * 0.47);
  const edges: number[] = [];
  for (let b = 0; b <= BANDS + 1; b++) edges.push(imel(mel(fLo) + ((mel(fHi) - mel(fLo)) * b) / (BANDS + 1)));
  const bin = (f: number) => (f * N) / rate;
  const filters: { from: number; w: Float64Array }[] = [];
  for (let b = 0; b < BANDS; b++) {
    const lo = bin(edges[b]), mid = bin(edges[b + 1]), hi = bin(edges[b + 2]);
    const from = Math.max(1, Math.floor(lo));
    const to = Math.min(half - 1, Math.ceil(hi));
    const w = new Float64Array(Math.max(0, to - from + 1));
    for (let k = from; k <= to; k++) {
      w[k - from] = k < mid ? Math.max(0, (k - lo) / Math.max(1e-9, mid - lo)) : Math.max(0, (hi - k) / Math.max(1e-9, hi - mid));
    }
    filters.push({ from, w });
  }

  const raw: Float32Array[] = Array.from({ length: BANDS }, () => new Float32Array(frames));
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let f = 0; f < frames; f++) {
    const start = Math.round(f * hop - half);
    for (let i = 0; i < N; i++) {
      const j = start + i;
      re[i] = j >= 0 && j < x.length ? x[j] * hann[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    for (let b = 0; b < BANDS; b++) {
      const { from, w } = filters[b];
      let e = 0;
      for (let k = 0; k < w.length; k++) {
        const p = re[from + k] * re[from + k] + im[from + k] * im[from + k];
        e += p * w[k];
      }
      raw[b][f] = Math.log(e + 1e-7);
    }
  }

  // Remove slow background (auto-gain, room, speaker EQ), then give every band the same weight.
  const bands: Float32Array[] = [];
  const energy = new Float64Array(frames);
  for (let b = 0; b < BANDS; b++) {
    const v = raw[b];
    const prefix = new Float64Array(frames + 1);
    for (let i = 0; i < frames; i++) prefix[i + 1] = prefix[i] + v[i];
    const out = new Float32Array(frames);
    let sq = 0;
    for (let i = 0; i < frames; i++) {
      const a = Math.max(0, i - SMOOTH), c = Math.min(frames, i + SMOOTH + 1);
      const m = (prefix[c] - prefix[a]) / (c - a);
      out[i] = v[i] - m;
      sq += out[i] * out[i];
    }
    const sd = Math.sqrt(sq / Math.max(1, frames));
    const inv = sd > 1e-4 ? 1 / sd : 0;
    for (let i = 0; i < frames; i++) {
      const z = Math.max(-4, Math.min(4, out[i] * inv));
      out[i] = z;
      energy[i] += z * z;
    }
    bands.push(out);
  }
  return { bands, frames, energy };
}

// -------------------------------------------------------- correlation ----

function referenceSpectra(ref: Features) {
  if (ref.spectra) return ref.spectra;
  const size = pow2(ref.frames + CHUNK + 1);
  const re: Float64Array[] = [];
  const im: Float64Array[] = [];
  for (let b = 0; b < BANDS; b++) {
    const r = new Float64Array(size);
    const i = new Float64Array(size);
    r.set(ref.bands[b]);
    fft(r, i);
    re.push(r);
    im.push(i);
  }
  ref.spectra = { size, re, im };
  return ref.spectra;
}

interface Peak {
  /** Reference frame where the chunk fits (sub-frame precision). */
  lag: number;
  score: number;
}

interface ChunkMatch {
  /** Best positions in the track, best first, at least 1 s apart. Several valid ones = repeated music. */
  peaks: Peak[];
  /** Best score minus the best rival at least 1 s away: how unambiguous the match is. */
  margin: number;
}

/** Slide clip frames [a, a+n) over every position of the reference. */
function matchChunk(clip: Features, a: number, n: number, ref: Features, cumRef: Float64Array): ChunkMatch | null {
  const last = ref.frames - n;
  if (last < 1) return null;
  const { size, re: fr, im: fi } = referenceSpectra(ref);

  let ec = 0;
  for (let i = a; i < a + n; i++) ec += clip.energy[i];
  if (ec < n * BANDS * 0.25) return null; // flat / silent excerpt: nothing to recognise

  const accRe = new Float64Array(size);
  const accIm = new Float64Array(size);
  const cr = new Float64Array(size);
  const ci = new Float64Array(size);
  for (let b = 0; b < BANDS; b++) {
    cr.fill(0); ci.fill(0);
    cr.set(clip.bands[b].subarray(a, a + n));
    fft(cr, ci);
    const rr = fr[b], ri = fi[b];
    for (let k = 0; k < size; k++) {
      // ref * conj(chunk)
      accRe[k] += rr[k] * cr[k] + ri[k] * ci[k];
      accIm[k] += ri[k] * cr[k] - rr[k] * ci[k];
    }
  }
  fft(accRe, accIm, true);

  const meanWin = (cumRef[ref.frames] / ref.frames) * n;
  const scores = new Float32Array(last + 1);
  for (let lag = 0; lag <= last; lag++) {
    const dot = accRe[lag] / size;
    const er = cumRef[lag + n] - cumRef[lag];
    scores[lag] = dot / Math.sqrt(ec * (er + 0.1 * meanWin) + 1e-9);
  }

  const peaks: Peak[] = [];
  for (let k = 0; k < 4; k++) {
    let best = -1, bestScore = -Infinity;
    for (let lag = 0; lag <= last; lag++) {
      if (peaks.some((p) => Math.abs(Math.round(p.lag) - lag) <= EXCLUDE)) continue;
      if (scores[lag] > bestScore) { bestScore = scores[lag]; best = lag; }
    }
    if (best < 0) break;
    let delta = 0;
    if (best > 0 && best < last) {
      const y0 = scores[best - 1], y1 = scores[best], y2 = scores[best + 1];
      const den = y0 - 2 * y1 + y2;
      if (Math.abs(den) > 1e-9) delta = Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den));
    }
    peaks.push({ lag: best + delta, score: bestScore });
  }
  return { peaks, margin: peaks.length > 1 ? peaks[0].score - peaks[1].score : peaks[0].score };
}

const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

// ----------------------------------------------------------- the sync ----

/** Reference features are computed once per official track. */
const refCache = new WeakMap<Float32Array, Features>();
const featuresCached = (samples: Float32Array, rate: number) => {
  let f = refCache.get(samples);
  if (!f) { f = featuresOf(samples, rate); refCache.set(samples, f); }
  return f;
};

export function syncAudio(clipSamples: Float32Array, clipRate: number, refSamples: Float32Array, refRate: number, focus?: Focus): SyncResult {
  if (clipSamples.length < clipRate * 2 || refSamples.length < refRate * 4) return NO_SYNC;
  const clip = featuresOf(clipSamples, clipRate);
  const ref = featuresCached(refSamples, refRate);
  if (clip.frames < 2 * FPS || ref.frames < 4 * FPS) return NO_SYNC;

  const cumRef = new Float64Array(ref.frames + 1);
  for (let i = 0; i < ref.frames; i++) cumRef[i + 1] = cumRef[i] + ref.energy[i];

  // ---- every chunk of the recording looks for itself in the whole track
  const n = Math.min(CHUNK, clip.frames);
  const starts: number[] = [];
  for (let a = 0; a + n <= clip.frames; a += CHUNK_HOP) starts.push(a);
  if (starts[starts.length - 1] !== clip.frames - n) starts.push(clip.frames - n);

  interface Vote { off: number; score: number; margin: number }
  const votes: Vote[] = [];
  let usable = 0;
  starts.forEach((a) => {
    const m = matchChunk(clip, a, n, ref, cumRef);
    if (!m) return;
    usable++;
    const top = m.peaks[0].score;
    m.peaks.forEach((p, k) => {
      // The best peak always votes; a runner-up votes too when it is nearly as good (a repeated chorus).
      if (p.score < 0.12 || (k > 0 && p.score < 0.5 * top)) return;
      votes.push({ off: (p.lag - a) / FPS, score: p.score, margin: k === 0 ? m.margin : 0 });
    });
  });
  if (!votes.length) return NO_SYNC;

  // ---- cluster the votes: offsets that agree within 0.15 s support each other.
  //      Unambiguous chunks (big margin) count much more than ambiguous ones.
  votes.sort((p, q) => p.off - q.off);
  interface Cluster { off: number; weight: number; votes: Vote[] }
  const clusters: Cluster[] = [];
  for (let i = 0; i < votes.length; i++) {
    let j = i;
    let w = 0;
    while (j < votes.length && votes[j].off - votes[i].off <= 0.15) { w += votes[j].score ** 2 + votes[j].score * votes[j].margin * 100; j++; }
    const grp = votes.slice(i, j);
    let ws = 0, os = 0;
    for (const v of grp) { const x = v.score ** 2 + v.score * v.margin * 100 + 1e-6; ws += x; os += v.off * x; }
    clusters.push({ off: os / ws, weight: w, votes: grp });
  }
  clusters.sort((p, q) => q.weight - p.weight);
  const top = clusters[0];

  // ---- candidates: the strongest clusters (not the same offset twice). A video with several takes
  //      has one strong cluster per take; identical repeats (copy-pasted chorus) give equal ones.
  const candidates: Cluster[] = [];
  for (const c of clusters) {
    if (c.weight < top.weight * 0.05 || candidates.length >= 10) break;
    if (candidates.some((k) => Math.abs(k.off - c.off) < 0.4)) continue;
    candidates.push(c);
  }

  // Frame-by-frame agreement of the clip with the reference at a given shift (prefix sums).
  const frameScores = (sh: number) => {
    const d = new Float64Array(clip.frames + 1), c2 = new Float64Array(clip.frames + 1), r2 = new Float64Array(clip.frames + 1);
    for (let i = 0; i < clip.frames; i++) {
      const j = i + sh;
      let dot = 0;
      if (j >= 0 && j < ref.frames) for (let b = 0; b < BANDS; b++) dot += clip.bands[b][i] * ref.bands[b][j];
      d[i + 1] = d[i] + dot;
      c2[i + 1] = c2[i] + clip.energy[i];
      r2[i + 1] = r2[i] + (j >= 0 && j < ref.frames ? ref.energy[j] : 0);
    }
    return { d, c2, r2 };
  };
  /** Agreement over 1 s windows around every clip frame. */
  const localCurve = (sh: number) => {
    const { d, c2, r2 } = frameScores(sh);
    const W = FPS;
    const local = new Float32Array(clip.frames);
    for (let i = 0; i < clip.frames; i++) {
      const a = Math.max(0, i - W / 2), b = Math.min(clip.frames, i + W / 2);
      if (b - a < W / 2) continue;
      local[i] = (d[b] - d[a]) / Math.sqrt((c2[b] - c2[a]) * (r2[b] - r2[a]) + 1e-9);
    }
    return local;
  };
  /** How well the clip matches over the frames that fall on the chosen segment (null: they do not overlap enough). */
  const focusMatch = (off: number): number | null => {
    if (!focus || focus.to <= focus.from) return null;
    const sh = Math.round(off * FPS);
    const a = Math.max(0, Math.ceil((focus.from - off) * FPS));
    const b = Math.min(clip.frames, Math.floor((focus.to - off) * FPS));
    if (b - a < 2 * FPS) return null;
    const { d, c2, r2 } = frameScores(sh);
    return (d[b] - d[a]) / Math.sqrt((c2[b] - c2[a]) * (r2[b] - r2[a]) + 1e-9);
  };
  /** Share of the chosen segment that a stretch of the clip [a, b) covers at this offset. */
  const focusFit = (off: number, a: number, b: number) =>
    !focus || focus.to <= focus.from ? 0 : overlap(off + a / FPS, off + b / FPS, focus.from, focus.to) / (focus.to - focus.from);

  // ---- takes: at each candidate offset, the stretches of the clip where the music really matches.
  //      Talking, silence or another passage between two takes breaks the stretch.
  interface Region { c: Cluster; bs: number; be: number; strength: number; fit: number }
  const GAP = Math.round(1.5 * FPS);
  const minLen = Math.min(4 * FPS, Math.floor(clip.frames * 0.5));
  const found: Region[] = [];
  const curves = new Map<Cluster, Float32Array>();
  for (const c of candidates) {
    const local = localCurve(Math.round(c.off * FPS));
    const sorted = Array.from(local).sort((x, y) => x - y);
    const thr = Math.max(0.1, (sorted[Math.floor(sorted.length * 0.97)] ?? 0) * 0.5);
    const spans: [number, number][] = [];
    const push = (a: number, b: number) => { if (b - a >= minLen) spans.push([a, b]); };
    let s0 = -1, last = -1;
    for (let i = 0; i < clip.frames; i++) {
      if (local[i] >= thr) { if (s0 < 0) s0 = i; last = i; }
      else if (s0 >= 0 && i - last > GAP) { push(s0, last + 1); s0 = -1; }
    }
    if (s0 >= 0) push(s0, last + 1);
    if (!spans.length) continue;
    // Stretches at the same offset are one performance on one clock (the music only got covered for a
    // moment: the artist singing loud, someone talking, a quiet bridge): a single take from the first to the last.
    const a = spans[0][0], b = spans[spans.length - 1][1];
    let st = 0;
    for (const [x, y] of spans) for (let i = x; i < y; i++) st += local[i];
    found.push({ c, bs: a, be: b, strength: st, fit: focusFit(c.off, a, b) });
    curves.set(c, local);
  }
  // Keep the best explanation of each part of the clip. Covering the post's segment is a small bonus,
  // enough to settle identical repeats, not enough for a short repeated chorus to beat a whole take.
  const rank = (r: Region) => r.strength * (1 + 0.2 * r.fit);
  found.sort((p, q) => rank(q) - rank(p));
  const kept: Region[] = [];
  for (const r of found) {
    if (kept.length >= 6 || (kept.length && r.strength < 0.2 * kept[0].strength)) continue;
    const clash = kept.some((k) => overlap(k.bs, k.be, r.bs, r.be) > 0.3 * Math.min(k.be - k.bs, r.be - r.bs));
    // A repeated part of the song (a second chorus, an outro played twice) also matches at another offset; it is
    // no other take when a stronger take's own offset explains those frames about as well.
    const mean = (l: Float32Array) => { let n = 0; for (let i = r.bs; i < r.be; i++) n += l[i]; return n / Math.max(1, r.be - r.bs); };
    const own = mean(curves.get(r.c)!);
    const echo = kept.some((k) => Math.abs(k.c.off - r.c.off) > 0.4 && mean(curves.get(k.c)!) >= 0.6 * own);
    if (!clash && !echo) kept.push(r);
  }

  // Fine offset (±3 frames) measured on the music-only part of a take, capped at 30 s.
  const refine = (off: number, bs: number, be: number): number => {
    const shift = Math.round(off * FPS);
    const a = bs, b = Math.min(be, bs + 30 * FPS);
    const sc: number[] = [];
    for (let delta = -3; delta <= 3; delta++) {
      let dot = 0, e1 = 0, e2 = 0;
      for (let i = a; i < b; i++) {
        const j = i + shift + delta;
        if (j < 0 || j >= ref.frames) continue;
        for (let k = 0; k < BANDS; k++) dot += clip.bands[k][i] * ref.bands[k][j];
        e1 += clip.energy[i]; e2 += ref.energy[j];
      }
      sc.push(dot / Math.sqrt(e1 * e2 + 1e-9));
    }
    let k = 0;
    for (let i = 1; i < sc.length; i++) if (sc[i] > sc[k]) k = i;
    let frac = 0;
    if (k > 0 && k < sc.length - 1) {
      const den = sc[k - 1] - 2 * sc[k] + sc[k + 1];
      if (Math.abs(den) > 1e-9) frac = Math.max(-0.5, Math.min(0.5, (0.5 * (sc[k - 1] - sc[k + 1])) / den));
    }
    // keep the refinement only if it stays close to what the chunks agreed on
    const refined = (shift + (k - 3) + frac) / FPS;
    return Math.abs(refined - off) < 0.1 ? refined : off;
  };

  // ---- the take used: the one that covers the post's segment, else the strongest
  let chosen: Region | null = kept[0] ?? null;
  for (const r of kept) if (r.fit >= 0.3 && (!chosen || r.fit > chosen.fit + 0.05)) chosen = r;
  const cluster = chosen?.c ?? top;
  const group = cluster.votes;
  const offset = chosen ? refine(cluster.off, chosen.bs, chosen.be) : cluster.off;
  const chosenFocus = focusMatch(offset);

  // ---- confidence that the offset is the right one: the excerpts agree on it and it clearly beats every other
  //      place of the track. How much the sound resembles the track counts little once it is past a low bar: a
  //      voice alone (the music in headphones), another performance or a far phone are less alike, as surely placed.
  const best = group.reduce((m, v) => Math.max(m, v.score), 0);
  const bestMargin = group.reduce((m, v) => Math.max(m, v.margin), 0);
  const agree = group.length / Math.max(1, Math.min(usable, 4));
  const musicFrac = kept.length ? kept.reduce((n, r) => n + r.be - r.bs, 0) / clip.frames : 0.5;
  // Identical repeats leave no margin: then the segment itself must match well.
  const clean = Math.max(Math.min(1, bestMargin / 0.15), chosenFocus !== null && chosenFocus > 0.2 ? 1 : 0);
  const score = Math.max(0, Math.min(1, (0.55 * clean + 0.45 * Math.min(1, agree)) * Math.min(1, best / 0.2)));
  // A match on a small part of the clip only could be chance (the camera rolling long before the music is not).
  const covered = Math.min(1, 0.7 + musicFrac);

  const round = (x: number) => Math.round(x * 1000) / 1000;
  const strongest = kept[0]?.strength || 1;
  const takes: Take[] = kept
    .map((r) => ({
      offset: round(r === chosen ? offset : refine(r.c.off, r.bs, r.be)),
      musicStart: r.bs / FPS,
      musicEnd: r.be / FPS,
      strength: Math.round((r.strength / strongest) * 100) / 100,
    }))
    .sort((p, q) => p.musicStart - q.musicStart);

  return {
    offset: round(offset),
    score: score * covered,
    musicStart: chosen ? chosen.bs / FPS : null,
    musicEnd: chosen ? chosen.be / FPS : null,
    anchors: group.length,
    takes,
  };
}

/** Average all channels: a recording can have one dead channel, and the official track is often wide stereo. */
export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i] / channels.length;
  return out;
}
