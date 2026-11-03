// Speech-to-text worker (Whisper with word timestamps, via transformers.js). Runs in the browser:
// the audio never leaves the device; only the model files are downloaded once, then cached.
const LIB = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6";

let pipe = null;
let loadedModel = "";

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
      pipe = await pipeline("automatic-speech-recognition", model, {
        device: "wasm",
        dtype: "q8",
        progress_callback: (p) => {
          if (p.status === "progress" && p.file) {
            files.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
            let loaded = 0, total = 0;
            for (const f of files.values()) { loaded += f.loaded; total += f.total; }
            if (total) post({ type: "progress", pct: loaded / total });
          }
        },
      });
      loadedModel = model;
    }
    post({ type: "status", step: "listen" });
    const opts = { return_timestamps: "word", chunk_length_s: 30, stride_length_s: 5, task: "transcribe" };
    if (language && language !== "auto") opts.language = language;
    const out = await pipe(audio, opts);
    const words = (out.chunks || [])
      .map((c) => ({ w: String(c.text || "").trim(), s: c.timestamp?.[0], e: c.timestamp?.[1] }))
      .filter((c) => c.w && typeof c.s === "number");
    post({ type: "done", words });
  } catch (err) {
    post({ type: "error", message: String((err && err.message) || err) });
  }
};
