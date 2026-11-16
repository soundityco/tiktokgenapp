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
/** Whisper's language tokens for the languages the app offers. */
const LANG_CODES = { french: "fr", english: "en", spanish: "es", german: "de", italian: "it", portuguese: "pt", dutch: "nl", arabic: "ar", japanese: "ja", korean: "ko", chinese: "zh", russian: "ru", turkish: "tr", polish: "pl" };

self.onmessage = async (e) => {
  const { type, audio, model, language, mode, prompt } = e.data || {};
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
    // "segment": the times of the decoder itself, one per phrase. The per-word times (alignment heads) sometimes collapse
    // on repeated sung phrases (all words on one instant); the phrase times stay right.
    const seg = mode === "segment";
    const opts = { return_timestamps: seg ? true : "word", chunk_length_s: 30, stride_length_s: 5, task: "transcribe" };
    if (language && language !== "auto") opts.language = language;
    // `prompt`: what was sung just before this excerpt, given to the decoder first (Whisper's own way of keeping the
    // context: <|startofprev|> text <|startoftranscript|> <|lang|> <|transcribe|>). Over music the model often decides
    // there is no speech in a whole window ("...", "Sous-titrage"); with the lines before it, it hears the singing.
    const code = LANG_CODES[language];
    let echo = "";
    if (prompt && code) {
      const tk = pipe.tokenizer;
      const id = (t) => tk.model.tokens_to_ids.get(t);
      const ids = tk.encode(" " + String(prompt).replace(/\s+/g, " ").trim(), { add_special_tokens: false }).slice(-150);
      const head = [id("<|startofprev|>"), ...ids, id("<|startoftranscript|>"), id(`<|${code}|>`), id("<|transcribe|>")];
      if (head.every((x) => typeof x === "number")) { opts.decoder_input_ids = head; echo = tk.decode(ids, { skip_special_tokens: true }).trim(); }
    }
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
    let chunks = out.chunks || [];
    // The prompt comes back at the start: taken away (the start of the first phrase, or the first words).
    if (echo && chunks.length) {
      if (seg) {
        const t0 = String(chunks[0].text || "");
        const tail = echo.slice(-24);
        const at = t0.lastIndexOf(tail);
        if (at >= 0) chunks[0] = { ...chunks[0], text: t0.slice(at + tail.length) };
      } else {
        const letters = (x) => String(x || "").toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");
        const target = letters(echo);
        let acc = "", cut = 0;
        for (let i = 0; i < chunks.length; i++) {
          acc += letters(chunks[i].text);
          if (!target.startsWith(acc)) break;
          if (acc.length >= target.length) { cut = i + 1; break; }
        }
        chunks = chunks.slice(cut);
      }
    }
    const words = chunks
      .map((c) => ({ w: String(c.text || "").trim(), s: c.timestamp?.[0], e: c.timestamp?.[1] }))
      .filter((c) => c.w && typeof c.s === "number");
    post({ type: "done", words, seg });
  } catch (err) {
    post({ type: "error", message: String((err && err.message) || err) });
  }
};
