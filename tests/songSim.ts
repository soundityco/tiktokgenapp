/* A small, deterministic song simulator for the audio tests: pitched pads and a melody that changes every bar, bass,
   drum loops. */

export const rng = (seed: number) => {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
};
export const SR = 16000;

export function song(seconds: number, seed: number, opts: { repeat?: { from: number; to: number; copyAt: number }; melodyOnly?: boolean } = {}): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(Math.round(seconds * SR));
  const bpm = 90 + Math.floor(r() * 30);
  const beat = 60 / bpm;
  const root = 40 + Math.floor(r() * 10);
  const prog = [0, 5, 3, 4];
  const scale = [0, 2, 4, 5, 7, 9, 11];
  const f = (n: number) => 440 * 2 ** ((n - 69) / 12);
  // The melody alone (a voice recorded with the music in headphones): the rest is drawn silent, same random numbers.
  const mute = opts.melodyOnly ? 0 : 1;
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
    for (const k of [0, 4, 7]) add(f(chord + 12 + k), t0, 4 * beat, 0.05 * mute);
    for (let k = 0; k < 8; k++) add(f(chord - 12), t0 + (k * beat) / 2, beat / 2, 0.14 * mute, 3);
    for (let k = 0; k < 4; k++) {
      if (k % 2 === 0) burst(t0 + k * beat, 0.12, 0.6 * mute, 30);
      else burst(t0 + k * beat, 0.15, 0.4 * mute, 25);
    }
    for (let k = 0; k < 8; k++) burst(t0 + (k * beat) / 2, 0.04, 0.12 * mute, 80);
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
