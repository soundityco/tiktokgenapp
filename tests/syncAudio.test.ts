import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60000 });
import { fft, NO_SYNC, syncAudio } from "../lib/syncAudio";

/* A small, deterministic "song + phone recording" simulator: pitched pads and a melody that changes
   every bar, bass, drum loops, then a speaker / room / noise / auto-gain chain and someone talking. */

const rng = (seed: number) => {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
};
const SR = 16000;

function song(seconds: number, seed: number, opts: { repeat?: { from: number; to: number; copyAt: number } } = {}): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(Math.round(seconds * SR));
  const bpm = 90 + Math.floor(r() * 30);
  const beat = 60 / bpm;
  const root = 40 + Math.floor(r() * 10);
  const prog = [0, 5, 3, 4];
  const scale = [0, 2, 4, 5, 7, 9, 11];
  const f = (n: number) => 440 * 2 ** ((n - 69) / 12);
  const add = (freq: number, at: number, dur: number, amp: number, harmonics = 6) => {
    const i0 = Math.round(at * SR), n = Math.round(dur * SR);
    for (let i = 0; i < n && i0 + i < out.length; i++) {
      const t = i / SR, env = Math.min(1, i / (0.01 * SR)) * Math.exp(-t * 2.5);
      let v = 0;
      for (let h = 1; h <= harmonics; h++) v += Math.sin(2 * Math.PI * freq * h * t) / h;
      out[i0 + i] += v * amp * env;
    }
  };
  const burst = (at: number, dur: number, amp: number, decay: number) => {
    const i0 = Math.round(at * SR), n = Math.round(dur * SR);
    for (let i = 0; i < n && i0 + i < out.length; i++) out[i0 + i] += (r() * 2 - 1) * amp * Math.exp((-i / SR) * decay);
  };
  const bars = Math.floor(seconds / (4 * beat));
  for (let b = 0; b < bars; b++) {
    const t0 = b * 4 * beat;
    const chord = root + scale[prog[b % 4]];
    for (const k of [0, 4, 7]) add(f(chord + 12 + k), t0, 4 * beat, 0.05);
    for (let k = 0; k < 8; k++) add(f(chord - 12), t0 + (k * beat) / 2, beat / 2, 0.14, 3);
    for (let k = 0; k < 4; k++) {
      if (k % 2 === 0) burst(t0 + k * beat, 0.12, 0.6, 30);
      else burst(t0 + k * beat, 0.15, 0.4, 25);
    }
    for (let k = 0; k < 8; k++) burst(t0 + (k * beat) / 2, 0.04, 0.12, 80);
    for (let k = 0; k < 4; k++) add(f(root + 24 + scale[Math.floor(r() * 7)]), t0 + k * beat, beat * 0.9, 0.1, 4); // new melody every bar
  }
  if (opts.repeat) {
    const { from, to, copyAt } = opts.repeat;
    out.set(out.subarray(Math.round(from * SR), Math.round(to * SR)), Math.round(copyAt * SR));
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < out.length; i++) out[i] = (out[i] / peak) * 0.8;
  return out;
}

function fftConvolve(x: Float32Array, h: Float32Array): Float32Array {
  let n = 1;
  while (n < x.length + h.length) n <<= 1;
  const xr = new Float64Array(n), xi = new Float64Array(n), hr = new Float64Array(n), hi = new Float64Array(n);
  xr.set(x); hr.set(h);
  fft(xr, xi); fft(hr, hi);
  for (let i = 0; i < n; i++) { const a = xr[i] * hr[i] - xi[i] * hi[i]; xi[i] = xr[i] * hi[i] + xi[i] * hr[i]; xr[i] = a; }
  fft(xr, xi, true);
  const out = new Float32Array(x.length);
  for (let i = 0; i < out.length; i++) out[i] = xr[i] / n;
  return out;
}

const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / Math.max(1, x.length));

/** What a phone camera hears: someone talking, then the song from a small speaker in a room, with noise and auto-gain. */
function phone(music: Float32Array, leadSeconds: number, seed: number, snrDb = 12): Float32Array {
  const r = rng(seed);
  const lead = Math.round(leadSeconds * SR);
  let x: Float32Array = new Float32Array(lead + music.length);
  x.set(music, lead);
  // small speaker: no bass, no treble, distortion
  let lp = 0, hpState = 0, prev = 0;
  for (let i = 0; i < x.length; i++) {
    lp += 0.45 * (x[i] - lp);
    hpState = 0.97 * (hpState + lp - prev); prev = lp;
    x[i] = Math.tanh(hpState * 2.2);
  }
  // room: decaying noise reverb
  const ir = new Float32Array(Math.round(0.4 * SR));
  for (let i = 0; i < ir.length; i++) ir[i] = (r() * 2 - 1) * Math.exp((-6.9 * i) / ir.length) * 0.15;
  ir[0] = 1;
  x = fftConvolve(x, ir);
  // person talking before the music (and a little over it)
  const talk = rms(x.subarray(lead, lead + 4 * SR));
  for (let i = 0; i < Math.min(x.length, lead + SR); i++) {
    const t = i / SR, syl = Math.max(0, Math.sin(2 * Math.PI * 3.7 * t)) ** 1.5;
    x[i] += talk * syl * (Math.sin(2 * Math.PI * 120 * t) + 0.5 * (r() * 2 - 1));
  }
  // noise + slow automatic gain
  const level = rms(x);
  for (let i = 0; i < x.length; i++) x[i] += (r() * 2 - 1) * level * 10 ** (-snrDb / 20);
  let gain = 1;
  for (let i = 0; i < x.length; i += 256) {
    const seg = x.subarray(i, i + 256);
    gain += 0.05 * (0.15 / (rms(seg) + 1e-4) - gain);
    for (let k = 0; k < seg.length; k++) seg[k] = Math.tanh(seg[k] * gain);
  }
  return x;
}

/** Linear-interpolation resampler: the recording and the official track rarely share a sample rate. */
function resample(x: Float32Array, from: number, to: number): Float32Array {
  const out = new Float32Array(Math.floor((x.length * to) / from));
  for (let i = 0; i < out.length; i++) {
    const p = (i * from) / to, a = Math.floor(p), fr = p - a;
    out[i] = x[a] * (1 - fr) + (x[Math.min(a + 1, x.length - 1)] ?? 0) * fr;
  }
  return out;
}

const REF = song(70, 11);

describe("syncAudio (camera recording on the official audio)", () => {
  it("finds a noisy phone recording to within a few hundredths of a second", () => {
    const p0 = 23.4, lead = 2.2;
    const rec = phone(REF.slice(Math.round(p0 * SR), Math.round((p0 + 18) * SR)), lead, 5);
    const r = syncAudio(rec, SR, REF, SR, { from: p0 + 1, to: p0 + 11 });
    expect(r.offset).toBeCloseTo(p0 - lead, 1);
    expect(Math.abs(r.offset - (p0 - lead))).toBeLessThan(0.05);
    expect(r.score).toBeGreaterThan(0.7);
    expect(r.anchors).toBeGreaterThanOrEqual(3);
  });

  it("is not thrown off by someone talking over a long intro, and reports where the music starts", () => {
    const p0 = 40, lead = 5.5;
    const rec = phone(REF.slice(Math.round(p0 * SR), Math.round((p0 + 16) * SR)), lead, 9);
    const r = syncAudio(rec, SR, REF, SR, { from: p0, to: p0 + 12 });
    expect(Math.abs(r.offset - (p0 - lead))).toBeLessThan(0.05);
    expect(r.musicStart).not.toBeNull();
    expect(r.musicStart!).toBeGreaterThan(lead - 1.5);
    expect(r.musicStart!).toBeLessThan(lead + 1.5);
  });

  it("returns a negative offset when the recording starts before the song does", () => {
    const rec = phone(REF.slice(0, 15 * SR), 3, 3);
    const r = syncAudio(rec, SR, REF, SR);
    expect(Math.abs(r.offset - -3)).toBeLessThan(0.05);
  });

  it("works when the recording and the track have different sample rates", () => {
    const p0 = 31, lead = 1.5;
    const rec = resample(phone(REF.slice(Math.round(p0 * SR), Math.round((p0 + 14) * SR)), lead, 21), SR, 22050);
    const r = syncAudio(rec, 22050, REF, SR, { from: p0, to: p0 + 10 });
    expect(Math.abs(r.offset - (p0 - lead))).toBeLessThan(0.05);
  });

  it("survives a very noisy, echoey room", () => {
    const p0 = 12.7, lead = 2;
    const rec = phone(REF.slice(Math.round(p0 * SR), Math.round((p0 + 20) * SR)), lead, 77, 3);
    const r = syncAudio(rec, SR, REF, SR, { from: p0, to: p0 + 12 });
    expect(Math.abs(r.offset - (p0 - lead))).toBeLessThan(0.08);
  });

  it("does not invent a match for a different song: low confidence", () => {
    const other = song(40, 999);
    const rec = phone(other.slice(5 * SR, 25 * SR), 2, 4);
    const r = syncAudio(rec, SR, REF, SR);
    expect(r.score).toBeLessThan(0.6);
  });

  it("gives up on silence and on clips that are too short", () => {
    expect(syncAudio(new Float32Array(SR * 20), SR, REF, SR).anchors).toBe(0);
    expect(syncAudio(REF.slice(0, SR), SR, REF, SR)).toEqual(NO_SYNC);
  });

  it("settles identical repeats with the segment the post uses (copy-pasted chorus)", () => {
    const ref = song(100, 31, { repeat: { from: 20, to: 44, copyAt: 60 } }); // 60-84 s is an exact copy of 20-44 s
    const p0 = 26, lead = 2;
    const rec = phone(ref.slice(Math.round(p0 * SR), Math.round((p0 + 11) * SR)), lead, 8);
    const onRecorded = syncAudio(rec, SR, ref, SR, { from: p0 + 1, to: p0 + 7 });
    expect(Math.abs(onRecorded.offset - (p0 - lead))).toBeLessThan(0.05);
    const onCopy = syncAudio(rec, SR, ref, SR, { from: p0 + 40 + 1, to: p0 + 40 + 7 });
    expect(Math.abs(onCopy.offset - (p0 - lead + 40))).toBeLessThan(0.05);
  });

  /** Several takes in one video: excerpts of the track with a pause (silence) between them. */
  const takes = (parts: [number, number][], pause: number) => {
    const total = parts.reduce((n, [a, b]) => n + Math.round(b * SR) - Math.round(a * SR), 0) + (parts.length - 1) * pause * SR;
    const out = new Float32Array(total);
    let at = 0;
    parts.forEach(([a, b], k) => {
      if (k) at += pause * SR;
      const piece = REF.subarray(Math.round(a * SR), Math.round(b * SR));
      out.set(piece, at);
      at += piece.length;
    });
    return out;
  };

  it("finds every take when the same passage was filmed three times", () => {
    const lead = 2, pause = 4, len = 12;
    const rec = phone(takes([[20, 32], [20, 32], [20, 32]], pause), lead, 41);
    const r = syncAudio(rec, SR, REF, SR, { from: 22, to: 30 });
    const want = [0, 1, 2].map((k) => 20 - (lead + k * (len + pause)));
    expect(r.takes.length).toBe(3);
    r.takes.forEach((tk, k) => expect(Math.abs(tk.offset - want[k])).toBeLessThan(0.05));
    expect(want.some((w) => Math.abs(r.offset - w) < 0.05)).toBe(true);
    expect(r.score).toBeGreaterThan(0.6);
  });

  it("uses the take that holds the post's segment when the takes are different passages", () => {
    const lead = 1.5, pause = 3;
    const rec = phone(takes([[10, 22], [40, 52]], pause), lead, 42);
    const second = 40 - (lead + 12 + pause);
    const r = syncAudio(rec, SR, REF, SR, { from: 42, to: 50 });
    expect(r.takes.length).toBe(2);
    expect(Math.abs(r.offset - second)).toBeLessThan(0.05);
    expect(r.musicStart!).toBeGreaterThan(lead + 12 + pause - 1.5);
    const first = syncAudio(rec, SR, REF, SR, { from: 12, to: 20 });
    expect(Math.abs(first.offset - (10 - lead))).toBeLessThan(0.05);
  });
});
