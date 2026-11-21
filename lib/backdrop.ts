import type { Backdrop } from "./types";

/**
 * The ground of a post (VideoSettings.backdrop): what shows behind the picture where it leaves room and in its bars.
 * Black by default; a colour; or a gradient through its stops, set by two points as in Photoshop — linear from A to B,
 * radial centred on A out to B — moved on the preview (VideoStudio) or in the Ground panel (components/BackdropPanel).
 */

export const GROUND_BLACK = "#000000";
export const isGradient = (b?: Backdrop): boolean => b?.kind === "linear" || b?.kind === "radial";

/** A gradient's points, filled in: A, B and its stops (two at least, in order). */
export function gradientOf(b: Backdrop) {
  const radial = b.kind === "radial";
  const stops = [...(b.stops?.length ? b.stops : [{ at: 0, color: "#f7d9bd" }, { at: 1, color: "#c7cdf8" }])].sort((x, y) => x.at - y.at);
  if (stops.length === 1) stops.push({ at: 1, color: stops[0].color });
  return { stops, ax: b.ax ?? 0.5, ay: b.ay ?? (radial ? 0.5 : 0), bx: b.bx ?? 0.5, by: b.by ?? 1 };
}

/** What a W×H canvas is painted with for this ground. */
export function groundFill(ctx: CanvasRenderingContext2D, W: number, H: number, b?: Backdrop): string | CanvasGradient {
  if (!b || b.kind === "color") return b?.color ?? GROUND_BLACK;
  const g = gradientOf(b);
  const ax = g.ax * W, ay = g.ay * H, bx = g.bx * W, by = g.by * H;
  const grad = b.kind === "radial"
    ? ctx.createRadialGradient(ax, ay, 0, ax, ay, Math.max(1, Math.hypot(bx - ax, by - ay)))
    : ctx.createLinearGradient(ax, ay, bx === ax && by === ay ? bx + 1 : bx, by);
  for (const s of g.stops) grad.addColorStop(Math.min(1, Math.max(0, s.at)), s.color);
  return grad;
}

/** The whole canvas painted with the ground. */
export function paintGround(ctx: CanvasRenderingContext2D, W: number, H: number, b?: Backdrop) {
  ctx.fillStyle = groundFill(ctx, W, H, b);
  ctx.fillRect(0, 0, W, H);
}

const hex = (c: string) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim()) ?? /^#?([0-9a-f]{3})$/i.exec(c.trim());
  if (!m) return [0, 0, 0];
  const h = m[1].length === 3 ? [...m[1]].map((x) => x + x).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const toHex = (v: number[]) => "#" + v.map((x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, "0")).join("");

/** The gradient's colour at `at` (0..1), between its stops: a stop added there takes it (it does not change the look). */
export function colorAt(stops: { at: number; color: string }[], at: number): string {
  const s = [...stops].sort((x, y) => x.at - y.at);
  if (!s.length) return GROUND_BLACK;
  if (at <= s[0].at) return s[0].color;
  for (let i = 1; i < s.length; i++) {
    if (at <= s[i].at) {
      const k = (at - s[i - 1].at) / Math.max(1e-6, s[i].at - s[i - 1].at), a = hex(s[i - 1].color), b = hex(s[i].color);
      return toHex(a.map((x, j) => x + (b[j] - x) * k));
    }
  }
  return s[s.length - 1].color;
}

/** A new gradient of this kind, from the colour the ground had (kept as its first stop). */
export function startGradient(kind: "linear" | "radial", from?: Backdrop): Backdrop {
  const was = from && isGradient(from) ? gradientOf(from) : null;
  const first = from?.kind === "color" && from.color ? from.color : "#f7d9bd";
  return kind === "radial"
    ? { kind, stops: was?.stops ?? [{ at: 0, color: first }, { at: 1, color: "#1a1630" }], ax: 0.5, ay: 0.42, bx: 0.5, by: 1 }
    : { kind, stops: was?.stops ?? [{ at: 0, color: first }, { at: 1, color: "#c7cdf8" }], ax: 0.5, ay: 0, bx: 0.5, by: 1 };
}
