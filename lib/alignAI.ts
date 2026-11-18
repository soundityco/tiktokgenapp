import type { AsrStep } from "./transcribe";

/**
 * The song's letters, frame by frame (20 ms): the MMS forced-alignment model, in a worker (public/align/worker.js).
 * What it returns goes to `alignWordsForced` (lib/forcedAlign.ts). About 630 MB downloaded once, kept by the browser.
 */
export interface Emissions { frames: Float32Array; T: number; V: number }

let worker: Worker | null = null;
/** Where the model last ran: "webgpu" (graphics card) or "wasm" (processor). */
export let alignDevice = "";
export function stopAlign() { worker?.terminate(); worker = null; }

/** Mono 16 kHz copy of the whole track, as the model expects. */
async function mono16k(buf: AudioBuffer): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, Math.max(1, Math.ceil(buf.duration * 16000)), 16000);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  return (await ctx.startRendering()).getChannelData(0).slice(); // its own copy: it is handed over to the worker
}

// The last song listened to stays here: "Listen again" or a new text does not run the model again.
let last: { key: string; em: Emissions } | null = null;
const keyOf = (buf: AudioBuffer) => {
  const d = buf.getChannelData(0);
  let h = 0;
  for (let i = 0; i < d.length; i += Math.max(1, Math.floor(d.length / 4000))) h = (h * 31 + Math.round(d[i] * 32768)) | 0;
  return `${buf.length}|${buf.sampleRate}|${h}`;
};

/** The letters of this track if the model already listened to it in this session (no run: null otherwise). */
export function cachedEmissions(buf: AudioBuffer): Emissions | null {
  return last?.key === keyOf(buf) ? last.em : null;
}

/** The letters of the track; rejects with Error("aborted") when the signal fires. */
export async function alignEmissions(
  buf: AudioBuffer,
  opts: { onStep?: (s: AsrStep) => void; onProgress?: (p: number) => void; signal?: AbortSignal } = {},
): Promise<Emissions> {
  const key = keyOf(buf);
  if (last?.key === key) return last.em;
  if (opts.signal?.aborted) throw new Error("aborted");
  const samples = await mono16k(buf);
  const em = await new Promise<Emissions>((resolve, reject) => {
    worker ??= new Worker("/align/worker.js", { type: "module" });
    const w = worker;
    const cleanup = () => { w.removeEventListener("message", onMsg); w.removeEventListener("error", onErr); opts.signal?.removeEventListener("abort", onAbort); };
    const onMsg = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === "status") opts.onStep?.(m.step === "start" ? "library" : m.step);
      else if (m.type === "device") { alignDevice = m.device; console.info(`[align] on the ${m.device === "webgpu" ? "graphics card" : "processor"}`); }
      else if (m.type === "progress") opts.onProgress?.(m.pct);
      else if (m.type === "done") { cleanup(); resolve({ frames: m.frames, T: m.T, V: m.V }); }
      else if (m.type === "error") { cleanup(); stopAlign(); reject(new Error(m.message)); }
    };
    const onErr = (e: ErrorEvent) => { cleanup(); stopAlign(); reject(new Error(e.message || "worker")); };
    const onAbort = () => { cleanup(); stopAlign(); reject(new Error("aborted")); };
    w.addEventListener("message", onMsg);
    w.addEventListener("error", onErr);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    w.postMessage({ type: "run", audio: samples }, [samples.buffer]);
  });
  last = { key, em };
  return em;
}
