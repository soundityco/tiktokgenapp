import { describe, expect, it } from "vitest";
import { autoLineTimes, envelopeOf, fmtTime, peaksOf, syncClip } from "../lib/media";

const RATE = 25;

/** Deterministic pseudo-random generator, so the sync tests never flake. */
const noise = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
};

/** Fake music envelope: a slow pulse plus noise, like a real song. */
const track = (len: number, seed: number) => {
  const rnd = noise(seed);
  const a = new Float32Array(len);
  for (let i = 0; i < len; i++) a[i] = 0.15 + 0.85 * rnd() * (0.55 + 0.45 * Math.sin(i / 9));
  return a;
};

/** Fake room recording before the music: word-like bursts, uncorrelated with the track. */
const speech = (len: number, seed: number) => {
  const rnd = noise(seed);
  const a = new Float32Array(len);
  for (let i = 0; i < len; i++) a[i] = (0.04 + 0.2 * rnd()) * (i % 19 < 10 ? 1 : 0.12);
  return a;
};

const concat = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

describe("syncClip (camera recording on the official audio)", () => {
  const ref = track(RATE * 120, 7);
  const at = RATE * 37;
  const clean = ref.slice(at, at + RATE * 20);

  it("finds a clean excerpt and reports the music region", () => {
    const r = syncClip(clean, ref, RATE, { from: 37, to: 57 });
    expect(Math.abs(r.offset - 37)).toBeLessThan(0.15);
    expect(r.score).toBeGreaterThan(0.9);
    expect(r.anchors).toBeGreaterThanOrEqual(2);
    expect(r.musicStart).toBeLessThan(0.3);
    expect(r.musicEnd).toBeGreaterThan(19);
  });

  it("ignores someone talking over the intro", () => {
    const clip = concat(speech(RATE * 5, 3), clean);
    const r = syncClip(clip, ref, RATE, { from: 37, to: 57 });
    expect(Math.abs(r.offset - 32)).toBeLessThan(0.2);
    expect(r.score).toBeGreaterThan(0.8);
    expect(r.musicStart).not.toBeNull();
    expect(Math.abs((r.musicStart ?? 0) - 5)).toBeLessThan(0.3);
  });

  it("keeps working with room noise on the music", () => {
    const rnd = noise(11);
    const clip = concat(speech(RATE * 3, 5), clean.map((v) => Math.max(0, v + (rnd() - 0.5) * 0.07)));
    const r = syncClip(clip, ref, RATE, { from: 37, to: 57 });
    expect(Math.abs(r.offset - 34)).toBeLessThan(0.4);
    expect(r.score).toBeGreaterThan(0.7);
  });

  it("gives up on silence", () => {
    const r = syncClip(new Float32Array(RATE * 20), ref, RATE);
    expect(r).toEqual({ offset: 0, score: 0, musicStart: null, musicEnd: null, anchors: 0 });
  });

  it("needs at least a couple of seconds of clip", () => {
    expect(syncClip(new Float32Array(RATE), ref, RATE).anchors).toBe(0);
  });

  it("does not invent a match out of unrelated audio", () => {
    const rnd = noise(23);
    const junk = new Float32Array(RATE * 30).map(() => rnd());
    expect(syncClip(junk, ref, RATE).score).toBeLessThan(0.6);
  });
});

describe("autoLineTimes (lyrics on the segment)", () => {
  const bursts = (times: number[], seconds: number) => {
    const env = new Float32Array(seconds * RATE);
    for (const t of times) {
      const from = Math.round(t * RATE);
      for (let i = from; i < Math.min(env.length, from + RATE); i++) env[i] = 1;
    }
    return env;
  };
  const LINES = ["la", "la la", "la la la", "la la la la"];

  it("pulls each line onto an attack instead of splitting blindly", () => {
    const times = autoLineTimes(LINES, bursts([3, 8, 13, 17], 20), RATE, 0, 20);
    expect(times).toHaveLength(4);
    [3, 8, 13, 17].forEach((expected, k) => expect(Math.abs(times[k] - expected)).toBeLessThan(0.2));
  });

  it("stays ordered inside the segment when there is no attack", () => {
    const times = autoLineTimes(LINES, new Float32Array(20 * RATE), RATE, 0, 20);
    expect(times[0]).toBeGreaterThan(0);
    expect(times[3]).toBeLessThan(20);
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1]);
  });

  it("never places a line outside the segment", () => {
    const times = autoLineTimes(LINES, bursts([40, 45, 50, 55], 60), RATE, 39, 58);
    times.forEach((t) => {
      expect(t).toBeGreaterThanOrEqual(39);
      expect(t).toBeLessThanOrEqual(58);
    });
  });
});

describe("waveform helpers", () => {
  it("envelopeOf returns one RMS value per window", () => {
    const env = envelopeOf(new Float32Array(48000).fill(0.5), 48000, 25);
    expect(env.length).toBe(25);
    expect(env[0]).toBeCloseTo(0.5, 5);
  });

  it("peaksOf normalises the tallest peak to 1", () => {
    const peaks = peaksOf(new Float32Array([0, 1, -0.5, 0.25]), 2);
    expect(peaks).toHaveLength(2);
    expect(Math.max(...peaks)).toBeCloseTo(1, 5);
  });

  it("fmtTime prints m:ss.d", () => {
    expect(fmtTime(0)).toBe("0:00.0");
    expect(fmtTime(75.4)).toBe("1:15.4");
  });
});
