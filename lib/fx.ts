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
interface FxState {
  held?: HTMLCanvasElement; heldKey?: string; curT?: number; prevT?: number; tmp?: HTMLCanvasElement;
  /** The last frames as they came (the picture and its finish, before the shutter): what a slow exposure gathers. */
  frames?: { t: number; c: HTMLCanvasElement }[];
  /** Canvases of frames dropped, used again. */
  spare?: HTMLCanvasElement[];
  /** The shot the frames belong to (a cut of the multicam, a video starting or ending: the exposure starts again). */
  shot?: string;
  acc?: HTMLCanvasElement;
}
const states = new WeakMap<CanvasRenderingContext2D, FxState[]>();

/** A number from 0 to 1 that is always the same for the same seed (the shutter's unevenness: the export is the preview). */
const rand = (seed: number) => { const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };

/**
 * The light of these frames gathered, as a sensor during an exposure: each frame with the same weight (a running mean),
 * `organic` adding the camera's unevenness — weights a little uneven, each frame shifted and turned a hair (a hand-held
 * camera's shake during the exposure: the trails never quite straight).
 */
function expose(to: HTMLCanvasElement, frames: { t: number; c: HTMLCanvasElement }[], organic: number, seed: number) {
  const g = to.getContext("2d")!, W = to.width, H = to.height;
  let sum = 0;
  frames.forEach((f, i) => {
    const r = (k: number) => rand(seed + f.t * 1000 + k * 17.3 + i);
    const w = Math.max(0.2, 1 + organic * 0.9 * (r(1) - 0.5));
    sum += w;
    g.save();
    g.globalCompositeOperation = i === 0 ? "copy" : "source-over";
    g.globalAlpha = i === 0 ? 1 : w / sum;
    if (organic > 0 && frames.length > 1) {
      const shake = organic * 0.006 * Math.min(W, H), turn = organic * 0.004;
      g.translate(W / 2 + (r(2) - 0.5) * shake, H / 2 + (r(3) - 0.5) * shake);
      g.rotate((r(4) - 0.5) * turn);
      g.translate(-W / 2, -H / 2);
    }
    g.drawImage(f.c, 0, 0, W, H);
    g.restore();
  });
}

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
  pic?: PicRect | null,
  /** What is on screen (the multicam's camera, the video there or not): when it changes, a cut — the slow exposure starts
   *  again, never a dissolve from the shot before. */
  shot = "") {
  const run = fxAt(list, t).filter((c) => !!c.over === over);
  // (the layers under the texts and those over them each keep their own frames)
  const all = states.get(ctx) ?? [{}, {}];
  states.set(ctx, all);
  const st = all[over ? 1 : 0];
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
      const sh = c.shutter, organic = Math.min(1, Math.max(0, sh.organic ?? 0.5));
      // The frames as they come (this one kept), within this shot: a cut, a jump, the preview at rest start them again.
      const fresh = !advancing || st.shot !== shot;
      st.shot = shot;
      const frames = (st.frames ??= []), spare = (st.spare ??= []);
      if (fresh) { spare.push(...frames.map((f) => f.c)); frames.length = 0; }
      if (!frames.length || frames[frames.length - 1].t !== t) {
        const cv = canvasOf(spare.pop(), W, H);
        copy(ctx, cv);
        frames.push({ t, c: cv });
      }
      // (a second of them at most)
      while (frames.length > 1 && frames[0].t < t - 1) spare.push(frames.shift()!.c);
      // the exposure: `trail` of a held frame's time (a 360° shutter at 1), or up to 0.2 s with no hold
      const exposure = Math.max(0, Math.min(1, sh.trail)) * (sh.fps > 0 ? 1 / sh.fps : 0.2);
      const lit = frames.filter((f) => f.t >= t - exposure - 1e-4);
      if (sh.fps > 0) {
        // held at a lower frame rate: its first frame's exposure, shown until the next one (a camera at that rate)
        const key = `${c.id}|${heldFrame(c, t, sh.fps)}|${shot}`;
        if (!fresh && st.held && st.heldKey === key) { ctx.save(); ctx.globalCompositeOperation = "copy"; ctx.drawImage(st.held, 0, 0, W, H); ctx.restore(); }
        else {
          st.held = canvasOf(st.held, W, H);
          expose(st.held, lit, organic, heldFrame(c, t, sh.fps) + c.from);
          st.heldKey = key;
          ctx.save(); ctx.globalCompositeOperation = "copy"; ctx.drawImage(st.held, 0, 0, W, H); ctx.restore();
        }
      } else if (lit.length > 1) {
        // no hold: each frame the light of the last `exposure` seconds
        st.acc = canvasOf(st.acc, W, H);
        expose(st.acc, lit, organic, Math.round(t * 1000));
        ctx.save(); ctx.globalCompositeOperation = "copy"; ctx.drawImage(st.acc, 0, 0, W, H); ctx.restore();
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
  return { ...base, shutter: { fps: 8, trail: 0.8, organic: 0.5 } };
}

/** What a clip does, in a few words (its clip's label). */
export const fxKinds = (c: FxClip) => [c.strobe && "strobe", c.zoom && "zoom", c.shutter && "shutter"].filter(Boolean) as ("strobe" | "zoom" | "shutter")[];

/** A clip cut in two at `at` (both keep its effects; the second a new id), or null when `at` is not inside it. */
export function splitFx(c: FxClip, at: number, id: string): [FxClip, FxClip] | null {
  if (at <= c.from + 0.05 || at >= c.to - 0.05) return null;
  const t = Math.round(at * 100) / 100;
  return [{ ...c, to: t }, { ...c, id, from: t }];
}
