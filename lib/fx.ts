import type { FxClip } from "./types";

/**
 * The Effects track (an adjustment layer): effect clips on the song's time, drawn over what is under them — the videos
 * and the post's finish, or the texts too (`over`). The same drawing for the preview and the export (VideoStudio's
 * drawScene, frame after frame: the export draws every frame in order, so the held frames and the trails come out right).
 *
 * Flash (strobe): a colour over the whole post `count` times over the clip, each for `on` of its turn.
 * Zoom blur: the picture spread from a point (x, y), as a zoom during the exposure.
 * Slow shutter: the picture held at a lower frame rate (a stutter) and/or each frame trailing the ones before (a motion
 * blur, "drunk" look).
 */

/** What one canvas keeps from frame to frame (its held picture, its trail): the preview's and the export's apart. */
interface FxState { held?: HTMLCanvasElement; heldKey?: string; trail?: HTMLCanvasElement; trailKey?: string; curT?: number; prevT?: number; tmp?: HTMLCanvasElement }
const states = new WeakMap<CanvasRenderingContext2D, FxState>();

const canvasOf = (c: HTMLCanvasElement | undefined, W: number, H: number) => {
  const x = c ?? document.createElement("canvas");
  if (x.width !== W || x.height !== H) { x.width = W; x.height = H; }
  return x;
};
const copy = (ctx: CanvasRenderingContext2D, to: HTMLCanvasElement) => {
  const g = to.getContext("2d")!;
  g.globalAlpha = 1; g.globalCompositeOperation = "copy";
  g.drawImage(ctx.canvas, 0, 0, to.width, to.height);
  g.globalCompositeOperation = "source-over";
};

/** The effect clips running at `t`, in their order on the track. */
export const fxAt = (list: FxClip[] | undefined, t: number) =>
  (list ?? []).filter((c) => !c.off && t >= c.from && t < c.to).sort((a, b) => (a.track ?? 0) - (b.track ?? 0)); // (the lower tracks first, the higher over them)

/** Is the strobe's colour shown at `t` (count flashes over the clip, each `on` of its turn). */
export function strobeOn(c: FxClip, t: number): boolean {
  if (!c.strobe || c.strobe.count <= 0) return false;
  const k = ((t - c.from) / Math.max(1e-3, c.to - c.from)) * c.strobe.count;
  return k - Math.floor(k) < Math.min(1, Math.max(0, c.strobe.on));
}

/** The held frame's number at `t` (frames counted from the clip's start at `fps`). */
export const heldFrame = (c: FxClip, t: number, fps: number) => Math.floor((t - c.from) * fps + 1e-6);

/** The effects of the clips running at `t` drawn on the canvas: those under the texts (`over` false) or over them. */
/** Where the picture of the video under is drawn on the post (its frame, inside the bars): a layer stays inside it. */
export interface PicRect { x: number; y: number; w: number; h: number }

export function drawFx(ctx: CanvasRenderingContext2D, W: number, H: number, t: number, list: FxClip[] | undefined, over: boolean,
  /** The video's picture on the post (null: none there — a layer kept inside the picture draws nothing). */
  pic?: PicRect | null) {
  const run = fxAt(list, t).filter((c) => !!c.over === over);
  const st = states.get(ctx) ?? {};
  states.set(ctx, st);
  // Held frames and trails carry over only while time moves on, frame after frame (playing, exporting): the same moment
  // drawn again (the preview at rest) or a jump (a click on the timeline) starts them again from this frame — a frame
  // held while the video was still loading stayed black.
  if (st.curT !== t) { st.prevT = st.curT; st.curT = t; }
  const advancing = st.prevT !== undefined && t > st.prevT + 1e-4 && t - st.prevT <= 0.25;
  for (const c of run) {
    // (inside the video's picture only, unless set over the whole post: its effects clipped to its frame — the zoom blur
    // spreads the picture from its centre, it never takes in the ground around it)
    const inside = !c.whole;
    if (inside && !pic) continue;
    ctx.save();
    if (inside && pic) { ctx.beginPath(); ctx.rect(pic.x, pic.y, pic.w, pic.h); ctx.clip(); }
    if (c.shutter && (c.shutter.fps > 0 || c.shutter.trail > 0)) {
      // held at a lower frame rate: the frame of its quantum, drawn again until the next one
      if (c.shutter.fps > 0) {
        const key = `${c.id}|${heldFrame(c, t, c.shutter.fps)}`;
        if (advancing && st.held && st.heldKey === key) { ctx.save(); ctx.globalCompositeOperation = "copy"; ctx.drawImage(st.held, 0, 0, W, H); ctx.restore(); }
        else { st.held = canvasOf(st.held, W, H); copy(ctx, st.held); st.heldKey = key; }
      }
      // trailing: the frames before stay, fading
      if (c.shutter.trail > 0) {
        const tk = c.id;
        if (advancing && st.trail && st.trailKey === tk) {
          ctx.save(); ctx.globalAlpha = Math.min(0.95, c.shutter.trail); ctx.drawImage(st.trail, 0, 0, W, H); ctx.restore();
        }
        st.trail = canvasOf(st.trail, W, H); copy(ctx, st.trail); st.trailKey = tk;
      }
    }
    if (c.zoom && c.zoom.amount > 0) {
      // the picture spread from (x, y): copies a little bigger each, averaged
      st.tmp = canvasOf(st.tmp, W, H); copy(ctx, st.tmp);
      const cx = c.zoom.x * W, cy = c.zoom.y * H, n = 12, spread = 0.35 * Math.min(1, c.zoom.amount);
      ctx.save();
      for (let i = 1; i <= n; i++) {
        const s = 1 + (spread * i) / n;
        ctx.globalAlpha = 1 / (i + 1);
        ctx.drawImage(st.tmp, cx - cx * s, cy - cy * s, W * s, H * s);
      }
      ctx.restore();
    }
    if (c.strobe && strobeOn(c, t)) {
      ctx.save(); ctx.globalAlpha = 1; ctx.fillStyle = c.strobe.color || "#000"; ctx.fillRect(0, 0, W, H); ctx.restore();
    }
    ctx.restore();
  }
}

/** A new effect clip at `at` (a second long) on track `track`: empty (an adjustment layer, its effects then chosen), or of
 *  this kind with its defaults. */
export function newFx(kind: "empty" | "strobe" | "zoom" | "shutter", at: number, id: string, track = 0): FxClip {
  const base = { id, from: Math.round(at * 100) / 100, to: Math.round((at + (kind === "strobe" ? 0.5 : 1)) * 100) / 100, ...(track ? { track } : {}) };
  if (kind === "empty") return base;
  if (kind === "strobe") return { ...base, over: true, strobe: { color: "#000000", count: 6, on: 0.5 } };
  if (kind === "zoom") return { ...base, zoom: { amount: 0.5, x: 0.5, y: 0.5 } };
  return { ...base, shutter: { fps: 8, trail: 0.6 } };
}

/** What a clip does, in a few words (its clip's label). */
export const fxKinds = (c: FxClip) => [c.strobe && "strobe", c.zoom && "zoom", c.shutter && "shutter"].filter(Boolean) as ("strobe" | "zoom" | "shutter")[];

/** A clip cut in two at `at` (both keep its effects; the second a new id), or null when `at` is not inside it. */
export function splitFx(c: FxClip, at: number, id: string): [FxClip, FxClip] | null {
  if (at <= c.from + 0.05 || at >= c.to - 0.05) return null;
  const t = Math.round(at * 100) / 100;
  return [{ ...c, to: t }, { ...c, id, from: t }];
}
