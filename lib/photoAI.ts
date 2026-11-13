/**
 * Photo AI on the device (public/photoai/worker.js), a test: a picture made sharper (×4), or the slide's frame filled
 * around it (the empty bands of a photo that does not cover the slide, invented by LaMa). The models are downloaded
 * once (54 MB, 208 MB), then kept by the browser; nothing is sent anywhere.
 */
import { framedAt } from "./render";
import type { PicSettings } from "./types";

export type AIStep = "model" | "start" | "run";
export type AIProgress = (step: AIStep, pct?: number) => void;

let worker: Worker | null = null;
let seq = 0;
function call(msg: Record<string, unknown>, transfer: Transferable[], onStep: AIProgress): Promise<ImageData> {
  worker ??= new Worker("/photoai/worker.js", { type: "module" });
  const w = worker, id = ++seq;
  return new Promise((resolve, reject) => {
    const on = (e: MessageEvent) => {
      const m = e.data;
      if (m?.id !== id) return;
      if (m.type === "status") onStep(m.step);
      else if (m.type === "progress") onStep(m.step, m.pct);
      else if (m.type === "done") { w.removeEventListener("message", on); resolve(new ImageData(new Uint8ClampedArray(m.data), m.width, m.height)); }
      else if (m.type === "error") { w.removeEventListener("message", on); reject(new Error(m.message)); }
    };
    w.addEventListener("message", on);
    w.postMessage({ ...msg, id }, transfer);
  });
}

const pixels = (src: CanvasImageSource, w: number, h: number) => {
  const c = new OffscreenCanvas(w, h), g = c.getContext("2d")!;
  g.drawImage(src, 0, 0, w, h);
  return g.getImageData(0, 0, w, h);
};
const toBlob = (img: ImageData | OffscreenCanvas) => {
  const c = img instanceof OffscreenCanvas ? img : (() => { const o = new OffscreenCanvas(img.width, img.height); o.getContext("2d")!.putImageData(img, 0, 0); return o; })();
  return c.convertToBlob({ type: "image/jpeg", quality: 0.92 });
};

/** Pictures this big or more are sharp enough for a slide (1080 wide): nothing to gain. */
export const sharpEnough = (w: number, h: number) => Math.min(w, h) >= 1080;

/** The picture four times bigger, its details rebuilt (Swin2SR, trained on real-world blurry pictures). */
export async function sharper(img: CanvasImageSource & { width: number; height: number }, onStep: AIProgress): Promise<Blob> {
  // At most 540 px on the short side in (2160 out, twice a slide's width): beyond, only slower, nothing gained.
  const k = Math.min(1, 540 / Math.min(img.width, img.height));
  const w = Math.round(img.width * k), h = Math.round(img.height * k);
  const px = pixels(img, w, h);
  return toBlob(await call({ type: "upscale", width: w, height: h, data: px.data.buffer }, [px.data.buffer], onStep));
}

/**
 * The slide (W×H) filled: the photo where the framing puts it, and around it, where the slide was empty, a picture
 * invented to continue it. Made at 512 on the short side (LaMa's size), the photo itself put back on top at its own
 * resolution. Null when the photo already covers the whole slide.
 */
export async function fillFrame(img: CanvasImageSource & { width: number; height: number }, pic: PicSettings, W: number, H: number, onStep: AIProgress): Promise<Blob | null> {
  const { x, y, s } = framedAt(pic, img.width, img.height, W, H);
  const pw = img.width * s, ph = img.height * s;
  if (x <= 0.5 && y <= 0.5 && x + pw >= W - 0.5 && y + ph >= H - 0.5) return null;
  // The work picture: 512 on its short side.
  const k = 512 / Math.min(W, H);
  const ws = Math.round(W * k), hs = Math.round(H * k);
  const c = new OffscreenCanvas(ws, hs), g = c.getContext("2d")!;
  g.drawImage(img, x * k, y * k, pw * k, ph * k);
  const px = g.getImageData(0, 0, ws, hs);
  // Unknown: outside the photo (a pixel inside its edge too, where it blends with the empty part).
  const mask = new Uint8Array(ws * hs);
  const x0 = x * k + 1, y0 = y * k + 1, x1 = (x + pw) * k - 1, y1 = (y + ph) * k - 1;
  for (let j = 0; j < hs; j++) for (let i = 0; i < ws; i++) if (i < x0 || i >= x1 || j < y0 || j >= y1) mask[j * ws + i] = 1;
  const filled = await call({ type: "fill", width: ws, height: hs, data: px.data.buffer, mask: mask.buffer }, [px.data.buffer, mask.buffer], onStep);
  // The full slide: the invented picture under, the photo on top, its edge blended over a few pixels.
  const out = new OffscreenCanvas(W, H), o = out.getContext("2d")!;
  const small = new OffscreenCanvas(ws, hs);
  small.getContext("2d")!.putImageData(filled, 0, 0);
  o.imageSmoothingQuality = "high";
  o.drawImage(small, 0, 0, W, H);
  const F = Math.max(4, Math.round(Math.min(W, H) / 120));
  const ph2 = new OffscreenCanvas(Math.max(1, Math.round(pw)), Math.max(1, Math.round(ph))), q = ph2.getContext("2d")!;
  q.drawImage(img, 0, 0, ph2.width, ph2.height);
  // Feather: fade the photo's own edges where they meet an invented part (not where they meet the slide's border).
  q.globalCompositeOperation = "destination-in";
  const edge = (on: boolean, x0: number, y0: number, x1: number, y1: number) => {
    const gr = q.createLinearGradient(x0, y0, x1, y1);
    gr.addColorStop(0, on ? "rgba(0,0,0,0)" : "#000"); gr.addColorStop(1, "#000");
    return gr;
  };
  const sides: [boolean, number, number, number, number, number, number, number, number][] = [
    [y > 0.5, 0, 0, 0, F, 0, 0, ph2.width, F], // top
    [y + ph < H - 0.5, 0, ph2.height, 0, ph2.height - F, 0, ph2.height - F, ph2.width, F], // bottom
    [x > 0.5, 0, 0, F, 0, 0, 0, F, ph2.height], // left
    [x + pw < W - 0.5, ph2.width, 0, ph2.width - F, 0, ph2.width - F, 0, F, ph2.height], // right
  ];
  for (const [on, ax, ay, bx, by, rx, ry, rw, rh] of sides) {
    if (!on) continue;
    q.fillStyle = edge(true, ax, ay, bx, by);
    q.save(); q.beginPath(); q.rect(rx, ry, rw, rh); q.clip();
    q.fillRect(0, 0, ph2.width, ph2.height);
    q.restore();
  }
  o.drawImage(ph2, x, y, pw, ph);
  return toBlob(out);
}
