/**
 * Conversion of camera formats the browser cannot decode (H.264 / HEVC 4:2:2 10-bit, ProRes…) with
 * ffmpeg compiled to WebAssembly (public/ffmpeg/worker.js). Only the segment of the post is converted,
 * to an H.264 4:2:0 file the export then decodes like any phone video. No detail is lost: only the part
 * of the picture seen in the post is kept, at the camera's own resolution (or just what the export needs).
 *
 * The ffmpeg engine (~32 MB) is downloaded from jsDelivr the first time, then kept by the browser.
 * The camera file is read from the disk: it is never copied whole into memory, and never leaves the device.
 */

import { visibleRegion } from "./render";
import type { PicSettings } from "./types";

export type ConvertStep = "engine" | "convert";

/** Keep only this rectangle of the (upright) camera picture, scaled to `out`. Even numbers. */
export interface ConvertCrop { x: number; y: number; w: number; h: number; out: { w: number; h: number } }

/**
 * What to keep of an iw×ih camera picture for a W×H export: the region seen in the post, with no more
 * pixels than the export can show (`push`: the progressive zoom reaches this factor, so it needs that much more).
 */
export function cropFor(pic: PicSettings, iw: number, ih: number, W: number, H: number, push = 1): ConvertCrop {
  const r = visibleRegion(pic, iw, ih, W, H);
  const down = (n: number) => Math.floor(n / 2) * 2;
  const x = down(r.x), y = down(r.y);
  const w = Math.min(down(iw) - x, Math.ceil((r.x + r.w - x) / 2) * 2);
  const h = Math.min(down(ih) - y, Math.ceil((r.y + r.h - y) / 2) * 2);
  // Export pixels per camera pixel at the strongest zoom; never upscaled.
  const s = (pic.framing === "fill" ? Math.max(W / iw, H / ih) : Math.min(W / iw, H / ih)) * pic.zoom * push;
  const k = Math.min(1, s * 1.05);
  return { x, y, w, h, out: { w: Math.max(2, down(w * k)), h: Math.max(2, down(h * k)) } };
}

let worker: Worker | null = null;

/**
 * Convert [from, to] (seconds of the camera video) to a light MP4. Its time 0 is `from`.
 * Rejects with an AbortError when the signal fires, with the end of ffmpeg's log otherwise.
 */
export function convertSegment(
  file: Blob,
  from: number,
  to: number,
  onProgress: (p: number, step: ConvertStep) => void,
  signal: AbortSignal,
  crop?: ConvertCrop,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
    worker ??= new Worker("/ffmpeg/worker.js", { type: "module" });
    const w = worker;
    const dur = Math.max(0.1, to - from);
    const cleanup = () => {
      w.removeEventListener("message", onMsg);
      w.removeEventListener("error", onErr);
      signal.removeEventListener("abort", onAbort);
    };
    const drop = () => { w.terminate(); if (worker === w) worker = null; }; // a fresh engine next time
    const onMsg = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === "status") onProgress(0, m.step);
      else if (m.type === "progress") onProgress(m.p, m.step);
      else if (m.type === "done") { cleanup(); onProgress(1, "convert"); resolve(new Blob([m.data], { type: "video/mp4" })); }
      else if (m.type === "error") {
        cleanup();
        drop();
        console.warn("[export] ffmpeg log:\n" + (m.log ?? []).join("\n"));
        reject(new Error(m.message));
      }
    };
    const onErr = (e: ErrorEvent) => { cleanup(); drop(); reject(new Error(e.message || "converter could not start")); };
    const onAbort = () => { cleanup(); drop(); reject(new DOMException("aborted", "AbortError")); };
    w.addEventListener("message", onMsg);
    w.addEventListener("error", onErr);
    signal.addEventListener("abort", onAbort, { once: true });
    w.postMessage({
      type: "convert",
      file,
      duration: dur,
      args: [
        "-ss", from.toFixed(3), "-t", dur.toFixed(3),
        "-i", "/in/source",
        "-map", "0:v:0", "-an", "-sn", "-dn",
        // Upright (ffmpeg applies the rotation before the filters), the visible part only, 8-bit 4:2:0.
        "-vf", crop
          ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},scale=${crop.out.w}:${crop.out.h}:flags=lanczos,format=yuv420p`
          : "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "17", "-g", "30", "-bf", "0",
        "-movflags", "+faststart",
        "out.mp4",
      ],
    });
  });
}
