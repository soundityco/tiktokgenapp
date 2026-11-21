import type { AsrStep } from "./transcribe";

/**
 * The song's letters, frame by frame (20 ms): the MMS forced-alignment model, in a worker (public/align/worker.js).
 * What it returns goes to `alignWordsForced` (lib/forcedAlign.ts). About 630 MB downloaded once, kept by the browser.
 */
export interface Emissions { frames: Float32Array; T: number; V: number }

let worker: Worker | null = null;
// One job at a time on the worker: its messages carry no job id, two at once would take each other's answer.
let queue: Promise<unknown> = Promise.resolve();
/** Where the model last ran: "webgpu" (graphics card) or "wasm" (processor). */
export let alignDevice = "";
export function stopAlign() { worker?.terminate(); worker = null; queue = Promise.resolve(); } // (a job cut off never answers: the queue starts again)

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
  const em = await runModel(await mono16k(buf), opts);
  last = { key, em };
  return em;
}

type RunOpts = { onStep?: (s: AsrStep) => void; onProgress?: (p: number) => void; signal?: AbortSignal };

const inTurn = <T>(job: () => Promise<T>): Promise<T> => { const r = queue.then(job, job); queue = r.catch(() => {}); return r; };

/**
 * The model loaded ahead, in the background (the video studio opened with lyrics): the first "Re-place" then takes a
 * second, not the model's loading. Graphics card only, and only when it was downloaded before; nothing otherwise.
 */
export function warmAlign(): Promise<boolean> {
  return inTurn(() => new Promise<boolean>((resolve) => {
    worker ??= new Worker("/align/worker.js", { type: "module" });
    const w = worker;
    const onMsg = (e: MessageEvent) => { if (e.data?.type === "warm-done") { w.removeEventListener("message", onMsg); resolve(!!e.data.loaded); } };
    w.addEventListener("message", onMsg);
    w.postMessage({ type: "warm" });
  }));
}

/** The model run on mono 16 kHz samples (handed over to the worker). */
function runModel(samples: Float32Array, opts: RunOpts): Promise<Emissions> {
  return inTurn(() => runNow(samples, opts));
}
function runNow(samples: Float32Array, opts: RunOpts): Promise<Emissions> {
  if (opts.signal?.aborted) return Promise.reject(new Error("aborted")); // (cancelled while waiting its turn)
  return new Promise<Emissions>((resolve, reject) => {
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
}

/**
 * The letters of some passages of the track only (lines placed again between locked ones: a few seconds, not the whole
 * song): the model run on each passage, a second more on each side, the rest of the track left to the blank. Frames on
 * the whole track's clock, as `alignEmissions`. The song's own letters when the model already listened to it.
 */
export async function alignEmissionsIn(buf: AudioBuffer, spans: [number, number][], opts: RunOpts = {}): Promise<Emissions> {
  const cached = cachedEmissions(buf);
  if (cached) return cached;
  const FRAME = 0.02, T = Math.ceil((buf.duration * 16000) / 320);
  // the passages with a margin, on the frames' grid, joined when they touch
  const wins = spans.map(([a, b]) => [Math.max(0, Math.floor((a - 1) / FRAME)), Math.min(T, Math.ceil((b + 1) / FRAME))] as [number, number])
    .filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
    .reduce<[number, number][]>((acc, w) => { const l = acc[acc.length - 1]; if (l && w[0] <= l[1]) l[1] = Math.max(l[1], w[1]); else acc.push([...w]); return acc; }, []);
  const total = wins.reduce((n, [a, b]) => n + b - a, 0);
  let frames: Float32Array | null = null, V = 0, done = 0;
  for (const [a, b] of wins) {
    if (opts.signal?.aborted) throw new Error("aborted");
    const from = a * FRAME, len = (b - a) * FRAME;
    const ctx = new OfflineAudioContext(1, Math.max(1, Math.ceil(len * 16000)), 16000);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0, from, len);
    const samples = (await ctx.startRendering()).getChannelData(0).slice();
    const em = await runModel(samples, { ...opts, onProgress: (p) => opts.onProgress?.((done + p * (b - a)) / Math.max(1, total)) });
    if (!frames) {
      V = em.V;
      frames = new Float32Array(T * V).fill(-12);
      for (let t = 0; t < T; t++) frames[t * V] = -0.01; // (not listened to: the blank)
    }
    const n = Math.min(em.T, T - a);
    frames.set(em.frames.subarray(0, n * V), a * V);
    done += b - a;
  }
  if (!frames) throw new Error("nothing to listen to");
  return { frames, T, V };
}
