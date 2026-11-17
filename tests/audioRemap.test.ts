import { describe, expect, it, vi } from "vitest";
import { coverage, mapSpan, mapTime, remapClip, remapWords, sharedShare, trackMap, uniformShift } from "../lib/audioRemap";
import { alignTracks } from "../lib/syncAudio";
import type { VideoSetup } from "../lib/types";
import { song, SR } from "./songSim";

vi.setConfig({ testTimeout: 120000 });

/* A demo and its master: the same song, edited or remastered. */
const demo = song(70, 7);
const at = (s: number) => Math.round(s * SR);
const cat = (...parts: Float32Array[]) => { const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const silence = (s: number) => new Float32Array(at(s));
/** Mastered: louder, compressed (soft clip), its tone changed, a little noise. */
const master = (x: Float32Array) => {
  const out = new Float32Array(x.length);
  let lp = 0;
  for (let i = 0; i < x.length; i++) { lp = lp * 0.7 + x[i] * 0.3; out[i] = Math.tanh((x[i] * 0.6 + lp * 0.8) * 2.2) * 0.9 + (Math.sin(i * 12.9898) * 43758.5453 % 1) * 0.004; }
  return out;
};
const mapOf = (next: Float32Array) => trackMap(alignTracks(demo, SR, next, SR), demo.length / SR, next.length / SR);

describe("a new version of the audio", () => {
  it("an excerpt of the song (25 s cut out of 70 s) is the same song: its words found in it", () => {
    const m = mapOf(master(demo.subarray(at(30), at(55))));
    expect(coverage(m)).toBeLessThan(0.4); // (as a share of the full song: too little to tell)
    expect(sharedShare(m)).toBeGreaterThan(0.85);
    const words = [{ w: "before", s: 10, e: 10.5 }, { w: "inside", s: 40, e: 40.5 }, { w: "after", s: 62, e: 62.5 }];
    const out = remapWords(m, words) ?? [];
    expect(out.map((x) => x.w)).toEqual(["inside"]);
    expect(out[0].s).toBeCloseTo(10, 0);
  });

  it("the very same timing (a master): nothing moves", () => {
    const m = mapOf(master(demo));
    expect(uniformShift(m)).toBe(0);
    expect(mapSpan(m, 20, 15).status).toBe("same");
  });

  it("a longer intro: everything moves by its length, and stays exact", () => {
    const m = mapOf(cat(silence(1.5), master(demo)));
    expect(uniformShift(m)).toBeCloseTo(1.5, 1);
    const s = mapSpan(m, 30, 12);
    expect(s.status).toBe("moved");
    expect(s.start).toBeCloseTo(31.5, 1);
  });

  it("a part cut: before it nothing moves, after it everything moves back, across it to check", () => {
    // 6 s removed at 34 s.
    const m = mapOf(master(cat(demo.subarray(0, at(34)), demo.subarray(at(40)))));
    expect(uniformShift(m)).toBeNull();
    expect(mapSpan(m, 10, 15).status).toBe("same");
    const after = mapSpan(m, 48, 12);
    expect(after.status).toBe("moved");
    expect(after.start).toBeCloseTo(42, 1);
    expect(mapSpan(m, 28, 14).status).toBe("check");
    // A moment of the part removed is in no stretch (or only where two meet).
    const gone = mapTime(m, 37);
    expect(gone === null || !gone.sure).toBe(true);
  });

  it("a part added: after it everything moves on", () => {
    // 5 s of another passage inserted at 30 s.
    const m = mapOf(cat(demo.subarray(0, at(30)), song(5, 99), demo.subarray(at(30))));
    expect(mapSpan(m, 5, 20).status).toBe("same");
    const after = mapSpan(m, 40, 15);
    expect(after.status).toBe("moved");
    expect(after.start).toBeCloseTo(45, 1);
  });

  it("a chorus repeated note for note: each one goes to its own place", () => {
    const withChorus = song(70, 11, { repeat: { from: 10, to: 22, copyAt: 40 } });
    const m = trackMap(alignTracks(withChorus, SR, cat(silence(2), master(withChorus)), SR), 70, 72);
    expect(mapSpan(m, 42, 8).start).toBeCloseTo(44, 1);
    expect(mapSpan(m, 12, 8).start).toBeCloseTo(14, 1);
  });

  it("a very different master (heavier, noisier): still found, still exact", () => {
    let k = 1;
    const rough = master(demo).map((x) => Math.tanh(x * 4) * 0.7 + ((k = (k * 16807) % 2147483647) / 2147483647 - 0.5) * 0.08);
    const m = mapOf(cat(silence(0.8), rough));
    expect(uniformShift(m)).toBeCloseTo(0.8, 1);
    expect(mapSpan(m, 25, 15).status).toBe("moved");
  });

  it("another song is not a version of this one", () => {
    const m = mapOf(song(70, 1234));
    expect(coverage(m)).toBeLessThan(0.5);
  });
});

describe("a video and the lyrics follow", () => {
  const m = trackMap([...Array(60)].map((_, i) => ({ old: i + 2, new: i + 3.5, score: 0.9 })), 64, 65.5);
  const clip = {
    id: "v1", name: "Take 1", crop: { start: 20, duration: 10 }, offset: 18.2, takes: [{ offset: 18.2, musicStart: 1, musicEnd: 30 }, { offset: 40, musicStart: 31, musicEnd: 60 }],
    captions: true, activeVersion: "A", versions: [{ id: "A", v: {} }, { id: "B", name: "B", v: { crop: { start: 30, duration: 8 }, offset: 25 } }],
  } as unknown as VideoSetup;

  it("its sync and takes, every version's segment move with the music; its own clock does not", () => {
    const { clip: v, report } = remapClip(clip, m);
    expect(v.crop.start).toBeCloseTo(21.5);
    expect(v.offset).toBeCloseTo(19.7);
    expect(v.takes?.map((x) => x.offset)).toEqual([19.7, 41.5]);
    expect(v.takes?.[0].musicStart).toBe(1);
    expect(v.versions?.[1].v.crop?.start).toBeCloseTo(31.5);
    expect(v.versions?.[1].v.offset).toBeCloseTo(26.5);
    expect(report).toEqual({ id: "v1", name: "Take 1", status: "moved", versions: [] });
    expect(uniformShift(m)).toBe(1.5);
  });
  it("the words move, a hand-set end too; the ones of a part gone are dropped", () => {
    const count = { moved: 0, dropped: 0 };
    const cut = trackMap([...Array(20)].map((_, i) => ({ old: i + 2, new: i + 2, score: 0.9 })), 64, 40);
    const words = remapWords(cut, [{ w: "a", s: 10, e: 10.4 }, { w: "b", s: 11, e: 11.5, until: 12, manual: true }, { w: "c", s: 50, e: 50.5 }], count);
    expect(words?.map((w) => [w.w, w.s, w.until, w.manual])).toEqual([["a", 10, undefined, undefined], ["b", 11, 12, true]]);
    expect(count).toEqual({ moved: 2, dropped: 1 });
  });
});
