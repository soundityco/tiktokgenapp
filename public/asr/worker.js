// Speech-to-text worker (Whisper with word timestamps, via transformers.js). Runs in the browser:
// the audio never leaves the device; only the model files are downloaded once, then cached.
const LIB = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6";

let pipe = null;
let loadedModel = "";
/** "webgpu" (the graphics card) when it works here, else "wasm" (the processor). */
let device = "";

/** The model on the graphics card when the browser has one that works (several times faster), else the processor. */
async function load(pipeline, model, onProgress) {
  const gpu = device !== "wasm" && self.navigator && "gpu" in self.navigator && (await self.navigator.gpu.requestAdapter().catch(() => null));
  // The very precise model (large-v3-turbo): 4-bit weights, in half floats when the card computes them (about 560 MB once).
  const large = /large/.test(model);
  const f16 = !!gpu && gpu.features && gpu.features.has("shader-f16");
  if (large && !gpu) throw new Error("The very precise model needs a graphics card (WebGPU).");
  if (gpu) {
    try {
      const dtype = large
        ? { encoder_model: f16 ? "q4f16" : "q4", decoder_model_merged: f16 ? "q4f16" : "q4" }
        : { encoder_model: "fp32", decoder_model_merged: "q4" };
      const p = await pipeline("automatic-speech-recognition", model, { device: "webgpu", dtype, progress_callback: onProgress });
      device = "webgpu";
      return p;
    } catch (err) {
      if (large) throw err;
      console.warn("[asr] graphics card not usable, the processor instead", err);
    }
  }
  device = "wasm";
  return pipeline("automatic-speech-recognition", model, { device: "wasm", dtype: "q8", progress_callback: onProgress });
}

const post = (msg) => self.postMessage(msg);

self.onmessage = async (e) => {
  const { type, audio, model, language } = e.data || {};
  if (type !== "run") return;
  try {
    post({ type: "status", step: "library" });
    const { pipeline, env } = await import(LIB);
    env.allowLocalModels = false;
    if (!pipe || loadedModel !== model) {
      post({ type: "status", step: "model" });
      const files = new Map();
      pipe = await load(pipeline, model, (p) => {
        if (p.status === "progress" && p.file) {
          files.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
          let loaded = 0, total = 0;
          for (const f of files.values()) { loaded += f.loaded; total += f.total; }
          if (total) post({ type: "progress", pct: loaded / total });
        }
      });
      loadedModel = model;
    }
    post({ type: "device", device });
    post({ type: "status", step: "listen" });
    const opts = { return_timestamps: "word", chunk_length_s: 30, stride_length_s: 5, task: "transcribe" };
    if (language && language !== "auto") opts.language = language;
    let out;
    try { out = await pipe(audio, opts); }
    catch (err) {
      // The graphics card failed on this audio: the processor, once (the model loaded again for it).
      if (device !== "webgpu") throw err;
      console.warn("[asr] graphics card failed while listening, the processor instead", err);
      device = "wasm";
      pipe = await load(pipeline, model, () => {});
      post({ type: "device", device });
      out = await pipe(audio, opts);
    }
    const words = (out.chunks || [])
      .map((c) => ({ w: String(c.text || "").trim(), s: c.timestamp?.[0], e: c.timestamp?.[1] }))
      .filter((c) => c.w && typeof c.s === "number");
    post({ type: "done", words });
  } catch (err) {
    post({ type: "error", message: String((err && err.message) || err) });
  }
};
