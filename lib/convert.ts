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
import type { PicSettings, VideoSourceInfo } from "./types";

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
let jobs = 0;
/** Stop the converter; the other jobs waiting on it fail at once instead of waiting forever. */
function restart(w: Worker) {
  w.terminate();
  if (worker === w) worker = null;
  w.dispatchEvent(new ErrorEvent("error", { message: "converter restarted" }));
}
/** Messages of the converter for one job only (the export and the frame reader share it). */
const mine = (id: number, fn: (e: MessageEvent) => void) => (e: MessageEvent) => { if (e.data?.job === id) fn(e); };

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
  /** Colour grade as a .cube 3D LUT, applied on the camera's own pixels (10-bit) before the 8-bit file is made. */
  lut?: Uint8Array,
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
    const drop = () => restart(w); // a fresh engine next time
    const id = ++jobs;
    const onMsg = mine(id, (e: MessageEvent) => {
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
    });
    const onErr = (e: ErrorEvent) => { cleanup(); drop(); reject(new Error(e.message || "converter could not start")); };
    const onAbort = () => { cleanup(); drop(); reject(new DOMException("aborted", "AbortError")); };
    w.addEventListener("message", onMsg);
    w.addEventListener("error", onErr);
    signal.addEventListener("abort", onAbort, { once: true });
    const size = crop ? `${crop.out.w}:${crop.out.h}` : "trunc(iw/2)*2:trunc(ih/2)*2";
    const vf = [
      ...(crop ? [`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`] : []),
      ...(lut
        ? [
          // 16-bit RGB with the camera's matrix, the LUT, then back to video-level BT.709 8-bit.
          `scale=${size}:flags=lanczos+accurate_rnd+full_chroma_int:in_color_matrix=bt709:in_range=tv`, "format=gbrp16le",
          "lut3d=file=/grade.cube:interp=tetrahedral",
          "scale=flags=accurate_rnd:out_color_matrix=bt709:out_range=tv", "format=yuv420p",
        ]
        : [`scale=${size}${crop ? ":flags=lanczos" : ""}`, "format=yuv420p"]),
    ].join(",");
    w.postMessage({
      type: "convert",
      id,
      file,
      files: lut ? [{ name: "/grade.cube", data: lut }] : [],
      duration: dur,
      args: [
        "-ss", from.toFixed(3), "-t", dur.toFixed(3),
        "-i", "/in/source",
        "-map", "0:v:0", "-an", "-sn", "-dn",
        // Upright (ffmpeg applies the rotation before the filters), the visible part only, 8-bit 4:2:0.
        "-vf", vf,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "17", "-g", "30", "-bf", "0",
        ...(lut ? ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"] : []),
        "-movflags", "+faststart",
        "out.mp4",
      ],
    });
  });
}

/** Run one ffmpeg job on the converter worker; resolves with the bytes of `output`. */
function runJob(file: Blob, args: string[], output: string, duration: number, signal?: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
    worker ??= new Worker("/ffmpeg/worker.js", { type: "module" });
    const w = worker;
    const cleanup = () => { w.removeEventListener("message", onMsg); w.removeEventListener("error", onErr); signal?.removeEventListener("abort", onAbort); };
    const drop = () => restart(w);
    const id = ++jobs;
    const onMsg = mine(id, (e: MessageEvent) => {
      const m = e.data;
      if (m.type === "done") { cleanup(); resolve(m.data); }
      else if (m.type === "error") { cleanup(); drop(); reject(new Error(m.message)); }
    });
    const onErr = (e: ErrorEvent) => { cleanup(); drop(); reject(new Error(e.message || "converter could not start")); };
    const onAbort = () => { cleanup(); drop(); reject(new DOMException("aborted", "AbortError")); };
    w.addEventListener("message", onMsg);
    w.addEventListener("error", onErr);
    signal?.addEventListener("abort", onAbort, { once: true });
    w.postMessage({ type: "convert", id, file, files: [], duration, args, output });
  });
}

let grabbing: Promise<unknown> = Promise.resolve();

/**
 * One picture of the camera file at `at` seconds, at most `maxW` pixels wide, as the camera recorded it
 * (no colour change: the grade is applied on it like on the video). For browsers that show no picture of a
 * paused video before it played (Safari). Jobs run one after the other.
 */
export function grabFrame(file: Blob, at: number, maxW = 2048): Promise<ImageBitmap> {
  const job = grabbing.catch(() => {}).then(async () => {
    const data = await runJob(file, [
      "-ss", Math.max(0, at).toFixed(3), "-i", "/in/source",
      "-map", "0:v:0", "-an", "-sn", "-dn", "-frames:v", "1",
      "-vf", `scale='min(${maxW},iw)':-2:flags=bicubic:in_color_matrix=bt709:in_range=tv,format=rgb24`,
      "-f", "image2", "-c:v", "bmp", "frame.bmp",
    ], "frame.bmp", 1);
    return createImageBitmap(new Blob([data as BlobPart], { type: "image/bmp" }));
  });
  grabbing = job;
  return job;
}


// ---- The working copy of a camera take, for the other devices ----

/** How a take's working copy is encoded: as rich as the take (10-bit for log / HDR / 10-bit / 4:2:2 footage). */
export interface CopyPlan { tenBit: boolean; chroma: "420" | "422"; crf: number }

/**
 * The copy keeps what the take has: log or HDR stays log or HDR (the grade is applied on both devices alike),
 * 10-bit and 4:2:2 stay so (8-bit would band once the log is graded). Standard 8-bit SDR footage gets 8-bit.
 */
export function copyPlanFor(info?: Pick<VideoSourceInfo, "colour" | "codec">): CopyPlan {
  const codec = info?.codec ?? "";
  const bits = Number(/(\d+)-bit/.exec(codec)?.[1] ?? 8);
  const prores = /ProRes/i.test(codec);
  const rich = /4:2:2|4:4:4/.test(codec) || prores;
  const tenBit = bits > 8 || prores || info?.colour === "log" || info?.colour === "hdr";
  return { tenBit, chroma: tenBit && rich ? "422" : "420", crf: tenBit ? 14 : 16 };
}

/**
 * ffmpeg arguments of the copy. It keeps the take's own clock (t = 0 is the take's start), so the sync and every
 * setting stay right: before `from` the first picture of the passage is held (a still costs next to nothing),
 * with the camera's real sound all along (the sync can be done again on the copy); it ends at `to`.
 * At most 1920 pixels on the short side: what a 1080×1920 post can use, never upscaled.
 */
export function copyArgs(plan: CopyPlan, from: number, to: number): string[] {
  const pix = plan.tenBit ? (plan.chroma === "422" ? "yuv422p10le" : "yuv420p10le") : "yuv420p";
  const short = "scale='if(gt(iw,ih),-2,min(1920,trunc(iw/2)*2))':'if(gt(iw,ih),min(1920,trunc(ih/2)*2),-2)':flags=lanczos";
  const lead = Math.max(0, from);
  return [
    "-ss", lead.toFixed(3), "-t", Math.max(0.1, to - lead).toFixed(3), "-i", "/in/source",
    "-t", to.toFixed(3), "-i", "/in/source",
    "-filter_complex", `[0:v]${short},setpts=PTS-STARTPTS${lead > 0 ? `,tpad=start_duration=${lead.toFixed(3)}:start_mode=clone` : ""},format=${pix}[v]`,
    "-map", "[v]", "-map", "1:a:0?",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", String(plan.crf), "-pix_fmt", pix, "-g", "50",
    "-c:a", "aac", "-b:a", "160k",
    "-movflags", "+faststart",
    "copy.mp4",
  ];
}

/** Make the working copy (in this browser, with the ffmpeg engine): `onProgress` from 0 to 1. */
export function makeWorkCopy(file: Blob, plan: CopyPlan, from: number, to: number, onProgress: (p: number) => void, signal: AbortSignal): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
    worker ??= new Worker("/ffmpeg/worker.js", { type: "module" });
    const w = worker;
    const cleanup = () => { w.removeEventListener("message", onMsg); w.removeEventListener("error", onErr); signal.removeEventListener("abort", onAbort); };
    const id = ++jobs;
    const onMsg = mine(id, (e: MessageEvent) => {
      const m = e.data;
      if (m.type === "progress") onProgress(m.p);
      else if (m.type === "done") { cleanup(); onProgress(1); resolve(new Blob([m.data], { type: "video/mp4" })); }
      else if (m.type === "error") { cleanup(); restart(w); console.warn("[copy] ffmpeg log:\n" + (m.log ?? []).join("\n")); reject(new Error(m.message)); }
    });
    const onErr = (e: ErrorEvent) => { cleanup(); restart(w); reject(new Error(e.message || "converter could not start")); };
    const onAbort = () => { cleanup(); restart(w); reject(new DOMException("aborted", "AbortError")); };
    w.addEventListener("message", onMsg);
    w.addEventListener("error", onErr);
    signal.addEventListener("abort", onAbort, { once: true });
    w.postMessage({ type: "convert", id, file, files: [], duration: Math.max(0.1, to), args: copyArgs(plan, from, to), output: "copy.mp4" });
  });
}
