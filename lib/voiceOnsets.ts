import type { LyricWord } from "./types";

/**
 * When the voice starts (its attacks), from the audio itself: the band where a voice lives (250 Hz – 3.5 kHz), its
 * loudness every 10 ms, and the moments it jumps up (a sung syllable starting over the beat). Used to put each lyrics
 * line on the moment it is really sung, never before (the speech model's timing can be early by a few tenths). Only on
 * an airy mix: on a dense one (MENSONGES: an attack every 0.4 s, the beat) none are kept.
 */
export async function voiceOnsets(buf: AudioBuffer): Promise<number[]> {
  const RATE = 8000;
  const ctx = new OfflineAudioContext(1, Math.ceil(buf.duration * RATE), RATE);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const low = ctx.createBiquadFilter();
  low.type = "highpass"; low.frequency.value = 250;
  const high = ctx.createBiquadFilter();
  high.type = "lowpass"; high.frequency.value = 3500;
  src.connect(low); low.connect(high); high.connect(ctx.destination);
  src.start();
  const x = (await ctx.startRendering()).getChannelData(0);
  const on = onsetsOf(x, RATE);
  // A dense mix (an attack every few tenths: drums, synths) does not tell the voice apart: none then, the speech model's
  // own timing is better than snapping a line to the next beat.
  const gaps = on.slice(1).map((t, i) => t - on[i]).sort((a, b) => a - b);
  return gaps.length && gaps[Math.floor(gaps.length / 2)] >= 0.7 ? on : [];
}

/**
 * The attacks of a mono signal at `rate`: loudness (dB) every 10 ms; an attack rises 6 dB or more over 80 ms and holds
 * (a sung syllable lasts: over the next 150 ms it stays within 6 dB of its top, where a hi-hat or a snare falls back at
 * once), 250 ms apart.
 */
export function onsetsOf(x: Float32Array, rate: number): number[] {
  const hop = Math.round(rate / 100), n = Math.floor(x.length / hop);
  const db = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let e = 0;
    for (let k = i * hop; k < (i + 1) * hop; k++) e += x[k] * x[k];
    db[i] = 10 * Math.log10(e / hop + 1e-10);
  }
  // The quiet floor of the track (its 20th percentile): attacks below it are noise.
  const floor = [...db].sort((a, b) => a - b)[Math.floor(n * 0.2)] ?? -100;
  const out: number[] = [];
  let last = -Infinity;
  for (let i = 8; i < n - 16; i++) {
    let before = Infinity;
    for (let k = i - 8; k <= i - 3; k++) before = Math.min(before, db[k]);
    const rise = db[i] - before;
    let held = 0;
    for (let k = i + 1; k <= i + 15; k++) held += db[k];
    held /= 15;
    // The top of a rise (the next frame rises less), loud enough, held, not right after the last attack.
    if (rise >= 6 && db[i] > floor + 6 && db[i + 1] - before < rise && held >= db[i] - 6 && i / 100 - last >= 0.25) {
      out.push(i / 100);
      last = i / 100;
    }
  }
  return out;
}

/**
 * Each lyrics line started on the voice's attack nearest its estimated start: the first attack from 0.1 s before it to
 * 0.6 s after (the model is often early: the line used to show before it was sung). Its first words that would come
 * before that attack move to it; a line retimed by hand keeps its timing.
 */
export function snapLines(words: LyricWord[], onsets: number[]): LyricWord[] {
  if (!onsets.length) return words;
  const out = words.map((w) => ({ ...w }));
  for (let i = 0; i < out.length; i++) {
    const w = out[i];
    if (i > 0 && out[i - 1].line === w.line) continue; // not the first word of its line
    if (w.manual) continue;
    const at = onsets.find((o) => o >= w.s - 0.1 && o <= w.s + 0.6);
    if (at === undefined || Math.abs(at - w.s) < 0.02) continue;
    // The line's words that would start before the attack move to it (their order kept).
    for (let k = i; k < out.length && out[k].line === w.line && out[k].s < at; k++) {
      const d = out[k].e - out[k].s;
      out[k].s = Math.round(at * 1000) / 1000;
      out[k].e = Math.round((at + Math.max(0.05, Math.min(d, 0.4))) * 1000) / 1000;
    }
  }
  return out;
}
