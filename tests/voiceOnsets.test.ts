import { describe, expect, it } from "vitest";
import { onsetsOf, snapLines } from "@/lib/voiceOnsets";

describe("voice onsets", () => {
  it("finds where a sound starts after silence", () => {
    const rate = 8000, x = new Float32Array(rate * 3);
    // Noise floor, then a tone from 1.00 s and another from 2.00 s.
    for (let i = 0; i < x.length; i++) x[i] = (Math.random() - 0.5) * 0.001;
    for (const start of [1, 2]) for (let i = start * rate; i < (start + 0.5) * rate; i++) x[i] += 0.5 * Math.sin((2 * Math.PI * 440 * i) / rate);
    const on = onsetsOf(x, rate);
    expect(on.some((t) => Math.abs(t - 1) <= 0.05)).toBe(true);
    expect(on.some((t) => Math.abs(t - 2) <= 0.05)).toBe(true);
  });
});

describe("snapLines", () => {
  const words = [
    { w: "un", s: 1.0, e: 1.3, line: 0 }, { w: "deux", s: 1.3, e: 1.6, line: 0 },
    { w: "trois", s: 3.0, e: 3.3, line: 1 }, { w: "quatre", s: 3.4, e: 3.7, line: 1 },
  ];
  it("puts a line that showed too early on the voice's attack", () => {
    const out = snapLines(words, [1.35, 3.0]);
    expect(out[0].s).toBe(1.35); // the line starts when it is sung
    expect(out[1].s).toBe(1.35); // its next word, before the attack, moves with it
    expect(out[2].s).toBe(3.0); // already on an attack: unchanged
  });
  it("never moves a line far, nor one retimed by hand", () => {
    expect(snapLines(words, [2.0])[0].s).toBe(1.0); // too far
    expect(snapLines([{ ...words[0], manual: true }, words[1]], [1.2])[0].s).toBe(1.0);
  });
});
