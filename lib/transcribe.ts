import type { LyricWord } from "./types";
import { wordsFromSegments } from "./lyricsAlign";

export type AsrModel = "tiny" | "base" | "small" | "turbo";
export const ASR_MODELS: Record<AsrModel, string> = {
  tiny: "onnx-community/whisper-tiny_timestamped",
  base: "onnx-community/whisper-base_timestamped",
  small: "onnx-community/whisper-small_timestamped",
  // Whisper large-v3-turbo: much better on singing over a mix; graphics card only, about 560 MB downloaded once.
  turbo: "onnx-community/whisper-large-v3-turbo_timestamped",
};

/** The browser has a graphics card the speech models can run on (WebGPU): the very precise model needs it. */
export const hasGpu = () => typeof navigator !== "undefined" && "gpu" in navigator;

export type AsrStep = "library" | "model" | "listen";

/**
 * Mono 16 kHz copy of a part of the track: the format speech models expect. Turned towards the voice: the middle of
 * the mix (mono = left + right: the voice, almost always centred), the deep bass and the highest highs cut (the voice
 * lives between them): the model hears the singing better over the beat.
 */
export async function prepareAudio(buf: AudioBuffer, from: number, to: number): Promise<Float32Array> {
  const start = Math.max(0, from);
  const dur = Math.max(0.5, Math.min(buf.duration, to) - start);
  const ctx = new OfflineAudioContext(1, Math.ceil(dur * 16000), 16000);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const low = ctx.createBiquadFilter();
  low.type = "highpass"; low.frequency.value = 110; low.Q.value = 0.7;
  const high = ctx.createBiquadFilter();
  high.type = "lowpass"; high.frequency.value = 7000; high.Q.value = 0.7;
  src.connect(low); low.connect(high); high.connect(ctx.destination);
  src.start(0, start, dur);
  const out = await ctx.startRendering();
  return out.getChannelData(0);
}

let worker: Worker | null = null;
/** Where the speech model last ran: "webgpu" (graphics card) or "wasm" (processor). */
export let asrDevice = "";

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
  opts: { model: AsrModel; language: string; base: number; mode?: "word" | "segment"; raw?: boolean; onStep?: (s: AsrStep) => void; onProgress?: (p: number) => void; signal?: AbortSignal }
): Promise<LyricWord[]> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) { reject(new Error("aborted")); return; }
    worker ??= new Worker("/asr/worker.js", { type: "module" });
    const w = worker;
    const cleanup = () => { w.removeEventListener("message", onMsg); w.removeEventListener("error", onErr); opts.signal?.removeEventListener("abort", onAbort); };
    const onMsg = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === "status") opts.onStep?.(m.step);
      else if (m.type === "device") { asrDevice = m.device; console.info(`[asr] listening on the ${m.device === "webgpu" ? "graphics card" : "processor"}`); }
      else if (m.type === "progress") opts.onProgress?.(m.pct);
      else if (m.type === "done") {
        cleanup();
        const got = (m.words as { w: string; s: number; e?: number }[]).map((x) => ({
          w: x.w, s: x.s + opts.base, e: (typeof x.e === "number" ? x.e : x.s + 0.3) + opts.base,
        }));
        resolve(m.seg && !opts.raw ? wordsFromSegments(got) : got); // raw: the phrases themselves (text, start, end)
      } else if (m.type === "error") { cleanup(); stopTranscribe(); reject(new Error(m.message)); } // fresh worker next time: a failed import is not retried
    };
    const onErr = (e: ErrorEvent) => { cleanup(); stopTranscribe(); reject(new Error(e.message || "worker")); };
    const onAbort = () => { cleanup(); stopTranscribe(); reject(new Error("aborted")); };
    w.addEventListener("message", onMsg);
    w.addEventListener("error", onErr);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    w.postMessage({ type: "run", audio: samples, model: ASR_MODELS[opts.model], language: opts.language, mode: opts.mode });
  });
}
