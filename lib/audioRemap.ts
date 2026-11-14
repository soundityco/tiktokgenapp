/**
 * A new version of a release's audio (the master after a demo): everything placed on the earlier one is moved to
 * where the same music is in the new one. The anchors come from lib/syncAudio alignTracks; here they become a map of
 * the time (stretches where the music is the same, each with its shift), then the release follows it: every video's
 * sync and takes, every version's segment, the lyrics placed word by word, the lines of the sections. What the map
 * cannot vouch for (a segment whose passage was edited, a passage gone) is moved as well as can be and reported.
 *
 * Pure functions: they run the same in the app and in the tests.
 */
import type { TrackAnchor } from "./syncAudio";
import type { LyricWord, Project, VideoSettings, VideoSetup } from "./types";

/** An anchor stands for the 4 s excerpt around it. */
const HALF = 2;
/** Two neighbouring anchors this close in shift: the same stretch of music (a tempo nudged included). */
const SAME = 0.08;
/** A segment whose length changes more than this in the new version: its passage was edited. */
const EXACT = 0.04;

export interface TrackMap {
  /** Stretches of the earlier version found as they are in the new one, their anchors in order. */
  pieces: TrackAnchor[][];
  oldDur: number;
  newDur: number;
}

/** The map of a new version from the anchors (in order of the earlier version). */
export function trackMap(anchors: TrackAnchor[], oldDur: number, newDur: number): TrackMap {
  const pieces: TrackAnchor[][] = [];
  for (const x of anchors) {
    const cur = pieces[pieces.length - 1], prev = cur?.[cur.length - 1];
    if (prev && Math.abs((x.new - x.old) - (prev.new - prev.old)) <= SAME && x.new > prev.new) cur.push(x);
    else pieces.push([x]);
  }
  return { pieces, oldDur, newDur };
}

/** The stretch of the earlier version a piece vouches for: its excerpts (the first and last pieces to the ends). */
function regionOf(m: TrackMap, i: number): [number, number] {
  const p = m.pieces[i];
  let lo = p[0].old - HALF, hi = p[p.length - 1].old + HALF;
  if (i === 0 && lo < 1.5) lo = 0;
  if (i === m.pieces.length - 1 && hi > m.oldDur - 1.5) hi = m.oldDur;
  return [lo, hi];
}

/** Share of the earlier version found in the new one (0 to 1): low, it is not the same song. */
export function coverage(m: TrackMap): number {
  if (!m.oldDur) return 0;
  let covered = 0;
  m.pieces.forEach((_, i) => { const [lo, hi] = regionOf(m, i); covered += Math.max(0, hi - lo); });
  return Math.min(1, covered / m.oldDur);
}

/** The same timing all along, moved by this many seconds (0: the very same timing); null when parts changed. */
export function uniformShift(m: TrackMap): number | null {
  if (m.pieces.length !== 1 || coverage(m) < 0.9) return null;
  const shifts = m.pieces[0].map((x) => x.new - x.old).sort((a, b) => a - b);
  if (shifts[shifts.length - 1] - shifts[0] > 0.03) return null;
  return Math.round(shifts[Math.floor(shifts.length / 2)] * 1000) / 1000;
}

export interface Mapped {
  t: number;
  /** In one stretch only (not where two meet, at an edit). */
  sure: boolean;
  piece: number;
}

/** Where a moment of the earlier version is in the new one; null when it is in no stretch found (a part removed). */
export function mapTime(m: TrackMap, t: number): Mapped | null {
  const hits = m.pieces.map((_, i) => i).filter((i) => { const [lo, hi] = regionOf(m, i); return t >= lo && t <= hi; });
  if (!hits.length) return null;
  // Where two stretches meet (an edit), the one whose excerpts are nearest.
  const dist = (i: number) => Math.min(...m.pieces[i].map((x) => Math.abs(x.old - t)));
  const i = hits.reduce((a, b) => (dist(b) < dist(a) ? b : a));
  const p = m.pieces[i];
  let at: number;
  if (t <= p[0].old) at = t + (p[0].new - p[0].old);
  else if (t >= p[p.length - 1].old) at = t + (p[p.length - 1].new - p[p.length - 1].old);
  else {
    let k = 0;
    while (p[k + 1].old < t) k++;
    const a = p[k], b = p[k + 1], f = (t - a.old) / (b.old - a.old);
    at = a.new + f * (b.new - a.new);
  }
  return { t: Math.min(m.newDur, Math.max(0, at)), sure: hits.length === 1, piece: i };
}

/** How a segment (or a synced passage) fares: the same place, moved, moved but to check (edited), or gone. */
export type SpanStatus = "same" | "moved" | "check" | "gone";

/** A segment of the earlier version in the new one: same length, moved with the music of its middle. */
export function mapSpan(m: TrackMap, start: number, duration: number): { start: number; shift: number; status: SpanStatus } {
  const a = mapTime(m, start), b = mapTime(m, start + duration), mid = mapTime(m, start + duration / 2);
  const ref = mid ? { at: start + duration / 2, to: mid.t } : a ? { at: start, to: a.t } : b ? { at: start + duration, to: b.t } : null;
  if (!ref) return { start, shift: 0, status: "gone" };
  const shift = ref.to - ref.at;
  const moved = Math.min(Math.max(0, start + shift), Math.max(0, m.newDur - duration));
  const exact = !!a && !!b && a.sure && b.sure && a.piece === b.piece && Math.abs((b.t - a.t) - duration) <= EXACT;
  return { start: moved, shift: moved - start, status: !exact ? "check" : Math.abs(moved - start) < 0.005 ? "same" : "moved" };
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r2 = (x: number) => Math.round(x * 100) / 100;

export interface RemapReport {
  /** The whole timing moved by this (0: the same), or null: parts changed. */
  shift: number | null;
  coverage: number;
  /** Each video of the release, and its versions not followed for sure. */
  videos: { id: string; name: string; status: SpanStatus; versions: { name: string; status: SpanStatus }[] }[];
  /** Words of the lyrics moved, and those whose passage is no longer in the audio. */
  words: { moved: number; dropped: number };
}

const worst = (list: SpanStatus[]): SpanStatus =>
  list.includes("gone") ? "gone" : list.includes("check") ? "check" : list.includes("moved") ? "moved" : "same";

/** A version's (or a video's) segment and sync moved with the music: the video follows its segment's shift. */
function moveSettings<T extends Partial<VideoSettings>>(m: TrackMap, v: T): { v: T; status: SpanStatus | null; shift: number } {
  if (!v.crop) return { v, status: null, shift: 0 };
  const r = mapSpan(m, v.crop.start, v.crop.duration);
  if (r.status === "gone") return { v, status: "gone", shift: 0 };
  return {
    v: { ...v, crop: { start: r2(r.start), duration: v.crop.duration }, ...(typeof v.offset === "number" ? { offset: r3(v.offset + r.shift) } : null) },
    status: r.status,
    shift: r.shift,
  };
}

/** Words placed on the earlier version, on the new one; the ones whose passage is gone are dropped. */
function moveWords(m: TrackMap, words: LyricWord[] | undefined, count: { moved: number; dropped: number }): LyricWord[] | undefined {
  if (!words) return words;
  const out: LyricWord[] = [];
  for (const w of words) {
    const s = mapTime(m, w.s), e = mapTime(m, w.e);
    if (!s) { count.dropped++; continue; }
    const until = w.until !== undefined ? mapTime(m, w.until)?.t : undefined;
    out.push({ ...w, s: r3(s.t), e: r3(Math.max(s.t, e ? e.t : s.t + (w.e - w.s))), ...(w.until !== undefined ? { until: until !== undefined ? r3(until) : undefined } : null) });
    count.moved++;
  }
  return out;
}

/**
 * The release on the new version of its audio: every video (its sync, its takes) and every version (its segment and
 * its own sync) moved with the music of its segment, the lyrics' words and the sections' lines moved; with the report.
 */
export function remapProject(p: Project, m: TrackMap): { project: Project; report: RemapReport } {
  const words = { moved: 0, dropped: 0 };
  const videos: RemapReport["videos"] = [];
  const list: VideoSetup[] = (p.videos ?? []).map((clip) => {
    const top = moveSettings(m, clip);
    const vers: { name: string; status: SpanStatus }[] = [];
    const versions = clip.versions?.map((ver, k) => {
      if (ver.id === clip.activeVersion) return ver; // the one shown lives in the video's own fields (moved above)
      const r = moveSettings(m, ver.v);
      if (r.status) vers.push({ name: ver.name || String.fromCharCode(65 + k), status: r.status });
      return { ...ver, v: r.v };
    });
    // The takes (the passage filmed several times): each one moved like the video's segment.
    const takes = top.status && top.status !== "gone" ? clip.takes?.map((tk) => ({ ...tk, offset: r3(tk.offset + top.shift) })) : clip.takes;
    const status = worst([...(top.status ? [top.status] : []), ...vers.map((x) => x.status)]);
    videos.push({ id: clip.id, name: clip.name, status, versions: vers.filter((x) => x.status === "check" || x.status === "gone") });
    return { ...(top.v as VideoSetup), versions, takes };
  });
  const lyrics = p.lyrics.map((l) => (l.times ? { ...l, times: l.times.map((x) => (x === null ? null : mapTime(m, x)?.t ?? null)).map((x) => (x === null ? null : r3(x))) } : l));
  const project: Project = {
    ...p,
    videos: list,
    lyrics,
    lyricWords: moveWords(m, p.lyricWords, words),
    heardWords: moveWords(m, p.heardWords, { moved: 0, dropped: 0 }),
  };
  return { project, report: { shift: uniformShift(m), coverage: coverage(m), videos, words } };
}
