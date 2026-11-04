/**
 * Conversion of camera formats the browser cannot decode (H.264 / HEVC 4:2:2 10-bit, ProRes…) with
 * ffmpeg compiled to WebAssembly (public/ffmpeg/worker.js). Only the segment of the post is converted,
 * to a light H.264 4:2:0 file (upright, at most 1920 px), which the export then decodes like any phone video.
 *
 * The ffmpeg engine (~32 MB) is downloaded from jsDelivr the first time, then kept by the browser.
 * The camera file is read from the disk: it is never copied whole into memory, and never leaves the device.
 */

export type ConvertStep = "engine" | "convert";

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
        // Upright (ffmpeg applies the phone's rotation), at most 1920 px on the long side, 8-bit 4:2:0.
        "-vf", "scale=1920:1920:force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "17", "-g", "30", "-bf", "0",
        "-movflags", "+faststart",
        "out.mp4",
      ],
    });
  });
}
