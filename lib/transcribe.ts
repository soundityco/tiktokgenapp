import type { LyricWord } from "./types";

export type AsrModel = "tiny" | "base" | "small";
export const ASR_MODELS: Record<AsrModel, string> = {
  tiny: "onnx-community/whisper-tiny_timestamped",
  base: "onnx-community/whisper-base_timestamped",
  small: "onnx-community/whisper-small_timestamped",
};

export type AsrStep = "library" | "model" | "listen";

/** Mono 16 kHz copy of a part of the track: the format speech models expect. */
export async function prepareAudio(buf: AudioBuffer, from: number, to: number): Promise<Float32Array> {
  const start = Math.max(0, from);
  const dur = Math.max(0.5, Math.min(buf.duration, to) - start);
  const ctx = new OfflineAudioContext(1, Math.ceil(dur * 16000), 16000);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start(0, start, dur);
  const out = await ctx.startRendering();
  return out.getChannelData(0);
}

let worker: Worker | null = null;

/** Stop the speech worker (drops the loaded model). */
export function stopTranscribe() {
  worker?.terminate();
  worker = null;
}

/**
 * Hear the words of an excerpt. Times come back relative to the excerpt, `base` shifts them to the
 * track's own timeline. Rejects with Error("aborted") when the signal fires.
 */
export function transcribe(
  samples: Float32Array,
  opts: { model: AsrModel; language: string; base: number; onStep?: (s: AsrStep) => void; onProgress?: (p: number) => void; signal?: AbortSignal }
): Promise<LyricWord[]> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) { reject(new Error("aborted")); return; }
    worker ??= new Worker("/asr/worker.js", { type: "module" });
    const w = worker;
    const cleanup = () => { w.removeEventListener("message", onMsg); w.removeEventListener("error", onErr); opts.signal?.removeEventListener("abort", onAbort); };
    const onMsg = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === "status") opts.onStep?.(m.step);
      else if (m.type === "progress") opts.onProgress?.(m.pct);
      else if (m.type === "done") {
        cleanup();
        resolve((m.words as { w: string; s: number; e?: number }[]).map((x) => ({
          w: x.w, s: x.s + opts.base, e: (typeof x.e === "number" ? x.e : x.s + 0.3) + opts.base,
        })));
      } else if (m.type === "error") { cleanup(); stopTranscribe(); reject(new Error(m.message)); } // fresh worker next time: a failed import is not retried
    };
    const onErr = (e: ErrorEvent) => { cleanup(); stopTranscribe(); reject(new Error(e.message || "worker")); };
    const onAbort = () => { cleanup(); stopTranscribe(); reject(new Error("aborted")); };
    w.addEventListener("message", onMsg);
    w.addEventListener("error", onErr);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    w.postMessage({ type: "run", audio: samples, model: ASR_MODELS[opts.model], language: opts.language });
  });
}
