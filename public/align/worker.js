// Lyrics alignment, on the device: the MMS forced-alignment model (wav2vec2, CTC) read by onnxruntime-web.
// It gives, for every 20 ms of the song, how likely each letter is; the app then places the written lyrics on those
// frames (lib/forcedAlign.ts). Nothing is sent anywhere: only the model file is downloaded once, then kept by the browser.
// Model: Meta MMS-300M forced aligner, ONNX fp16 by tatsu020 (CC-BY-NC-4.0, non-commercial use).
const ORT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/";
// Two copies of the same model. On the graphics card the fp16 one gives wrong values on some songs (measured: the
// lines come out far from where they are sung), so it runs there in fp32 (1.26 GB, fast). On the processor the fp16
// one is right (and half the size), only slower. Both from Hugging Face, the fp32 one by the transformers.js community.
const MODELS = {
  gpu: { url: "https://huggingface.co/onnx-community/mms-300m-1130-forced-aligner-ONNX/resolve/main/onnx/model.onnx", size: 1262500000, cache: "rollout-align-fp32" },
  cpu: { url: "https://huggingface.co/tatsu020/mms-300m-fa-onnx/resolve/main/mms_300m_fa_fp16.onnx", size: 631499926, cache: "rollout-align" },
};
const RATE = 16000, STRIDE = 320, CHUNK = 30 * RATE, CTX = 2 * RATE;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const gpu = async () => { try { return !!(self.navigator.gpu && (await self.navigator.gpu.requestAdapter())); } catch { return false; } };

let ortMod = null;
async function ortLib() {
  if (!ortMod) {
    ortMod = await import(ORT + "ort.all.min.mjs");
    ortMod.env.wasm.wasmPaths = ORT;
    ortMod.env.wasm.numThreads = Math.min(8, self.navigator.hardwareConcurrency || 4);
  }
  return ortMod;
}

/** A model file: from the browser's cache, else downloaded once (progress in 0..1), written to the cache as it comes. */
async function modelBytes(m) {
  const cache = await caches.open(m.cache);
  const hit = await cache.match(m.url);
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  post({ type: "status", step: "model" });
  const r = await fetch(m.url);
  if (!r.ok || !r.body) throw new Error("model download " + r.status);
  const total = Number(r.headers.get("content-length")) || m.size;
  const [toCache, toUse] = r.body.tee();
  const kept = cache.put(m.url, new Response(toCache, { headers: { "content-length": String(total) } })).catch(() => {});
  let out = new Uint8Array(total);
  const reader = toUse.getReader();
  let got = 0, shown = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // (a length the server did not give, or wrong: the buffer grows rather than the download failing)
    if (got + value.length > out.length) { const bigger = new Uint8Array(Math.max(out.length * 1.25, got + value.length) | 0); bigger.set(out.subarray(0, got)); out = bigger; }
    out.set(value, got); got += value.length;
    const pct = Math.floor((got / total) * 100);
    if (pct > shown) { shown = pct; post({ type: "progress", pct: pct / 100 }); }
  }
  await kept;
  return got === total ? out : out.subarray(0, got);
}

let session = null;
let provider = "";
async function open(bytes, ort, which) {
  provider = which;
  session = await ort.InferenceSession.create(bytes, { executionProviders: [which] });
}
/** The model ready: fp32 on the graphics card when there is one, else (or when it cannot start) fp16 on the processor. */
async function start(ort) {
  if (await gpu()) {
    try { await open(await modelBytes(MODELS.gpu), ort, "webgpu"); return; }
    catch (err) { console.warn("[align] graphics card model not usable, the processor instead", err); session = null; }
  }
  post({ type: "status", step: "model" });
  await open(await modelBytes(MODELS.cpu), ort, "wasm");
}

/** Log-probabilities of one excerpt: frames × V. */
async function chunk(ort, x) {
  let m = 0;
  for (let i = 0; i < x.length; i++) m += x[i];
  m /= x.length;
  let v = 0;
  for (let i = 0; i < x.length; i++) v += (x[i] - m) * (x[i] - m);
  const sd = Math.sqrt(v / x.length) + 1e-7;
  const inp = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) inp[i] = (x[i] - m) / sd;
  const out = await session.run({ input_values: new ort.Tensor("float32", inp, [1, inp.length]) });
  const lg = out.logits;
  return { data: lg.data, T: lg.dims[1], V: lg.dims[2] };
}

/** The whole track listened to: log-probabilities, T frames × V letters. */
async function listen(ort, audio) {
    const frames = Math.ceil(audio.length / STRIDE);
    let V = 0, all = null;
    for (let s = 0; s < audio.length; s += CHUNK) {
      const a = Math.max(0, s - CTX), z = Math.min(audio.length, s + CHUNK + CTX);
      const r = await chunk(ort, audio.subarray(a, z));
      if (!all) {
        V = r.V;
        all = new Float32Array((frames + 2) * V).fill(-12);
        for (let t = 0; t < frames + 2; t++) all[t * V] = -0.01; // frames not filled: the blank
      }
      const from = Math.round((s - a) / STRIDE);
      const n = Math.min(r.T - from, Math.round(Math.min(CHUNK, audio.length - s) / STRIDE));
      const base = Math.round(s / STRIDE);
      for (let t = 0; t < n; t++) {
        if (base + t >= frames + 2) break;
        let mx = -Infinity;
        for (let k = 0; k < V; k++) { const q = r.data[(from + t) * V + k]; if (q > mx) mx = q; }
        let sum = 0;
        for (let k = 0; k < V; k++) sum += Math.exp(r.data[(from + t) * V + k] - mx);
        const ls = mx + Math.log(sum);
        for (let k = 0; k < V; k++) all[(base + t) * V + k] = r.data[(from + t) * V + k] - ls;
      }
      post({ type: "progress", pct: Math.min(1, (s + CHUNK) / audio.length) });
    }
    const T = Math.min(frames, Math.floor(all.length / V));
  return { frames: all.subarray(0, T * V).slice(), T, V };
}

/** The model loaded once, even asked twice at a time (the studio's warm-up and a click). */
let ready = null;
const ensure = (ort) => (session ? Promise.resolve() : (ready ??= start(ort).finally(() => { ready = null; })));

self.onmessage = async (e) => {
  const { type, audio } = e.data || {};
  if (type === "warm") {
    // Loaded ahead (the video studio opened with lyrics), so a click places the lyrics at once: only on the graphics
    // card, and only a model already downloaded (never a download nobody asked for).
    try {
      if (!session && (await gpu()) && (await (await caches.open(MODELS.gpu.cache)).match(MODELS.gpu.url))) {
        const ort = await ortLib();
        await ensure(ort);
        await listen(ort, new Float32Array(RATE)); // (a second of silence: the graphics card readies its work once, here)
      }
      post({ type: "warm-done", loaded: !!session });
    } catch (err) {
      post({ type: "warm-done", loaded: false, message: String((err && err.message) || err) });
    }
    return;
  }
  if (type !== "run") return;
  try {
    post({ type: "status", step: "library" });
    const ort = await ortLib();
    if (!session) { await ensure(ort); post({ type: "status", step: "start" }); }
    post({ type: "device", device: provider });
    post({ type: "status", step: "listen" });
    let r;
    try { r = await listen(ort, audio); }
    catch (err) {
      // The graphics card could not run it: the processor model, once.
      if (provider !== "webgpu") throw err;
      console.warn("[align] graphics card failed, the processor instead", err);
      session = null;
      post({ type: "status", step: "model" });
      await open(await modelBytes(MODELS.cpu), ort, "wasm");
      post({ type: "device", device: provider });
      post({ type: "status", step: "listen" });
      r = await listen(ort, audio);
    }
    post({ type: "done", frames: r.frames, T: r.T, V: r.V });
  } catch (err) {
    post({ type: "error", message: String((err && err.message) || err) });
  }
};
