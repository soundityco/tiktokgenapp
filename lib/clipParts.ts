/**
 * Parts of a video clip turned off, as in Premiere (a clip cut, then one piece disabled): the clip stays whole on its
 * track, in sync, but nothing of it is shown (nor heard) in an off piece. Times are seconds in the camera file, so the
 * pieces follow the clip when it slides, and stay right when it is trimmed.
 */
export interface ClipParts {
  /** Where the clip is cut (seconds in the file), sorted. */
  splits?: number[];
  /** The pieces turned off (seconds in the file), sorted, never overlapping. */
  offParts?: [number, number][];
}

const EPS = 0.001;
/** Closest a cut may be to another cut or to the clip's edges. */
export const MIN_PIECE = 0.1;

/** The pieces of the part kept [ci, co], cut at its splits. */
export function piecesOf(p: ClipParts, ci: number, co: number): [number, number][] {
  const cuts = (p.splits ?? []).filter((x) => x > ci + EPS && x < co - EPS);
  const out: [number, number][] = [];
  let a = ci;
  for (const x of cuts) { out.push([a, x]); a = x; }
  out.push([a, co]);
  return out;
}

/** Is file time `t` in a piece turned off? */
export function isOff(p: ClipParts, t: number): boolean {
  return (p.offParts ?? []).some(([a, b]) => t >= a - EPS && t < b - EPS);
}

/** The clip cut at file time `t` (inside the part kept, not on another cut). Unchanged when it cannot be. */
export function splitAt(p: ClipParts, t: number, ci: number, co: number): ClipParts {
  if (t < ci + MIN_PIECE || t > co - MIN_PIECE) return p;
  const s = p.splits ?? [];
  if (s.some((x) => Math.abs(x - t) < MIN_PIECE)) return p;
  return { ...p, splits: [...s, round3(t)].sort((a, b) => a - b) };
}

/** The piece under file time `t`. */
export function pieceAt(p: ClipParts, t: number, ci: number, co: number): [number, number] | null {
  return piecesOf(p, ci, co).find(([a, b]) => t >= a - EPS && t < b + EPS) ?? null;
}

/** The piece under file time `t` turned off, or back on. */
export function togglePiece(p: ClipParts, t: number, ci: number, co: number): ClipParts {
  const pc = pieceAt(p, t, ci, co);
  if (!pc) return p;
  const [a, b] = pc, mid = (a + b) / 2;
  const off = without(p.offParts ?? [], a, b);
  return tidy({ ...p, offParts: isOff(p, mid) ? off : merge([...off, [a, b]]) });
}

/** The cut nearest to file time `t` removed (within `near` seconds): the two pieces become one, off only if both were. */
export function joinAt(p: ClipParts, t: number, near: number, ci: number, co: number): ClipParts {
  const s = p.splits ?? [];
  let k = -1;
  for (let i = 0; i < s.length; i++) if (Math.abs(s[i] - t) <= near && (k < 0 || Math.abs(s[i] - t) < Math.abs(s[k] - t))) k = i;
  if (k < 0) return p;
  const before = pieceAt(p, s[k] - 2 * EPS, ci, co), after = pieceAt(p, s[k] + 2 * EPS, ci, co);
  const bothOff = !!before && !!after && isOff(p, (before[0] + before[1]) / 2) && isOff(p, (after[0] + after[1]) / 2);
  const next = { ...p, splits: s.filter((_, i) => i !== k) };
  if (before && after) {
    const off = without(p.offParts ?? [], before[0], after[1]);
    next.offParts = bothOff ? merge([...off, [before[0], after[1]]]) : off;
  }
  return tidy(next);
}

/** Every cut and every off piece removed: the clip whole again. */
export function wholeAgain(p: ClipParts): ClipParts {
  return { ...p, splits: undefined, offParts: undefined };
}

/** The windows of [a, b] (official time) where the clip is on, its offset `offset` (file time = official − offset). */
export function onWindows(p: ClipParts, a: number, b: number, offset: number): [number, number][] {
  const out: [number, number][] = [];
  let x = a;
  for (const [o0, o1] of p.offParts ?? []) {
    const s = o0 + offset, e = o1 + offset;
    if (e <= x || s >= b) continue;
    if (s > x) out.push([x, s]);
    x = Math.max(x, e);
  }
  if (x < b) out.push([x, b]);
  return out;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

function without(rs: [number, number][], a: number, b: number): [number, number][] {
  const out: [number, number][] = [];
  for (const [x, y] of rs) {
    if (y <= a + EPS || x >= b - EPS) { out.push([x, y]); continue; }
    if (x < a - EPS) out.push([x, a]);
    if (y > b + EPS) out.push([b, y]);
  }
  return out;
}

function merge(rs: [number, number][]): [number, number][] {
  const s = [...rs].sort((p, q) => p[0] - q[0]);
  const out: [number, number][] = [];
  for (const r of s) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + EPS) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

function tidy(p: ClipParts): ClipParts {
  return { ...p, splits: p.splits?.length ? p.splits : undefined, offParts: p.offParts?.length ? p.offParts : undefined };
}
