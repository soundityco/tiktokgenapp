import { describe, expect, it } from "vitest";
import { autoLineTimes, envelopeOf, fmtTime, peaksOf } from "../lib/media";

const RATE = 25;

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
