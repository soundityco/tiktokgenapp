/**
 * Multicam edit of a video: up to 4 cameras (the video itself = camera 0, other videos of the release synced on the
 * same official audio = cameras 1 to 3) and the cuts between them. A cut = from this official time on, this camera
 * plays (until the next cut); before the first one, camera 0. Two cuts in a row may show the same camera (the shot
 * was cut, its camera not chosen yet).
 */

export interface Cut { at: number; cam: number }

export const MAX_CAMS = 4;
/** Two cuts closer than this are the same one. */
const SAME = 0.04;

const r3 = (t: number) => Math.round(t * 1000) / 1000;
const sorted = (cuts: Cut[]) => [...cuts].sort((a, b) => a.at - b.at);

/** The camera playing at official time `t`. */
export function camAt(cuts: Cut[] | undefined, t: number): number {
  let cam = 0;
  for (const c of sorted(cuts ?? [])) { if (c.at <= t + 1e-6) cam = c.cam; else break; }
  return cam;
}

/** A cut at `at` to camera `cam` (the one already there moved to that camera). Live switching while playing. */
export function cutTo(cuts: Cut[] | undefined, at: number, cam: number): Cut[] {
  const rest = (cuts ?? []).filter((c) => Math.abs(c.at - at) > SAME);
  return sorted([...rest, { at: r3(at), cam }]);
}

/** The shot under `t` cut in two (both keep its camera). */
export function splitAt(cuts: Cut[] | undefined, t: number): Cut[] {
  if ((cuts ?? []).some((c) => Math.abs(c.at - t) <= SAME)) return cuts ?? [];
  return cutTo(cuts, t, camAt(cuts, t));
}

/** The shot under `t` (between two cuts) shown by camera `cam`. `from` = where the segment starts (the first shot). */
export function setShotCam(cuts: Cut[] | undefined, t: number, cam: number, from: number): Cut[] {
  const list = sorted(cuts ?? []);
  const i = list.findLastIndex((c) => c.at <= t + 1e-6);
  if (i >= 0) return list.map((c, k) => (k === i ? { ...c, cam } : c));
  // Before the first cut: a cut at the segment's start carries the camera.
  return cutTo(list, from, cam);
}

/** The cut that starts the shot under `t` removed (the shot joins the one before). */
export function removeCutAt(cuts: Cut[] | undefined, t: number): Cut[] {
  const list = sorted(cuts ?? []);
  const i = list.findLastIndex((c) => c.at <= t + 1e-6);
  return i < 0 ? list : list.filter((_, k) => k !== i);
}

/**
 * Cut number `i` moved to `at`, as an edit in a timeline: from the gesture's start (`cuts` as they were when it began),
 * the shot whose edge is pulled covers the shots it goes over. Left: its shot starts earlier, over the shots before (onto
 * a cut, that cut is gone: two shots of camera 4 made one). Right: the shot before it runs on over the shots after; where
 * it stops, the camera of the shot that was there goes on. Before, a cut stopped 0.1 s from the next one (a gap left, both
 * shots kept).
 */
export function moveCut(cuts: Cut[], i: number, at: number): Cut[] {
  const list = sorted(cuts), me = list[i];
  if (!me) return list;
  const to = r3(Math.max(0, at)), lo = Math.min(me.at, to), hi = Math.max(me.at, to);
  const over = (c: Cut, k: number) => k !== i && c.at >= lo - SAME && c.at <= hi + SAME;
  const rest = list.filter((c, k) => k !== i && !over(c, k));
  // (going right past other cuts: the camera of the shot where it lands goes on from there)
  const passed = to > me.at ? list.filter((c, k) => over(c, k)) : [];
  const cam = passed.length ? passed[passed.length - 1].cam : me.cam;
  return sorted([...rest, { ...me, at: to, cam }]);
}

/** The shots between `from` and `to`: where each starts and ends, and its camera. */
export function shotsOf(cuts: Cut[] | undefined, from: number, to: number): { from: number; to: number; cam: number; cut: number }[] {
  const list = sorted(cuts ?? []);
  const out: { from: number; to: number; cam: number; cut: number }[] = [];
  let at = from, cam = camAt(list, from), cut = list.findLastIndex((c) => c.at <= from + 1e-6);
  for (let k = 0; k < list.length; k++) {
    const c = list[k];
    if (c.at <= from + 1e-6) continue;
    if (c.at >= to) break;
    out.push({ from: at, to: c.at, cam, cut });
    at = c.at; cam = c.cam; cut = k;
  }
  out.push({ from: at, to, cam, cut });
  return out;
}
