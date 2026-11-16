// Lyrics alignment, on the device: the MMS forced-alignment model (wav2vec2, CTC) read by onnxruntime-web.
// It gives, for every 20 ms of the song, how likely each letter is; the app then places the written lyrics on those
// frames (lib/forcedAlign.ts). Nothing is sent anywhere: only the model file is downloaded once, then kept by the browser.
// Model: Meta MMS-300M forced aligner, ONNX fp16 by tatsu020 (CC-BY-NC-4.0, non-commercial use).
const ORT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/";
const MODEL = { url: "https://huggingface.co/tatsu020/mms-300m-fa-onnx/resolve/main/mms_300m_fa_fp16.onnx", size: 631499926 };
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

/** The model file: from the browser's cache, else downloaded once (progress in 0..1). */
async function modelBytes() {
  const cache = await caches.open("rollout-align");
  const hit = await cache.match(MODEL.url);
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  post({ type: "status", step: "model" });
  const r = await fetch(MODEL.url);
  if (!r.ok || !r.body) throw new Error("model download " + r.status);
  const total = Number(r.headers.get("content-length")) || MODEL.size;
  const reader = r.body.getReader();
  const parts = [];
  let got = 0, shown = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
    const pct = Math.floor((got / total) * 100);
    if (pct > shown) { shown = pct; post({ type: "progress", pct: pct / 100 }); }
  }
  const blob = new Blob(parts);
  await cache.put(MODEL.url, new Response(blob)).catch(() => {});
  return new Uint8Array(await blob.arrayBuffer());
}

let session = null;
let provider = "";
async function open(bytes, ort, which) {
  provider = which;
  session = await ort.InferenceSession.create(bytes, { executionProviders: [which] });
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

self.onmessage = async (e) => {
  const { type, audio } = e.data || {};
  if (type !== "run") return;
  try {
    post({ type: "status", step: "library" });
    const ort = await ortLib();
    if (!session) {
      const bytes = await modelBytes();
      post({ type: "status", step: "start" });
      if (await gpu()) await open(bytes, ort, "webgpu").catch(() => open(bytes, ort, "wasm"));
      else await open(bytes, ort, "wasm");
      self.__bytes = provider === "webgpu" ? bytes : null; // kept only for a fallback to the processor
    }
    post({ type: "device", device: provider });
    post({ type: "status", step: "listen" });
    const frames = Math.ceil(audio.length / STRIDE);
    let V = 0, all = null;
    for (let s = 0; s < audio.length; s += CHUNK) {
      const a = Math.max(0, s - CTX), z = Math.min(audio.length, s + CHUNK + CTX);
      let r;
      try { r = await chunk(ort, audio.subarray(a, z)); }
      catch (err) {
        // The graphics card could not run it: the processor, once.
        if (provider !== "webgpu") throw err;
        console.warn("[align] graphics card failed, the processor instead", err);
        await open(self.__bytes, ort, "wasm");
        post({ type: "device", device: provider });
        r = await chunk(ort, audio.subarray(a, z));
      }
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
    // The last frames may be unfilled (rounding): the blank there.
    const T = Math.min(frames, Math.floor(all.length / V));
    post({ type: "done", frames: all.subarray(0, T * V).slice(), T, V }, []);
  } catch (err) {
    post({ type: "error", message: String((err && err.message) || err) });
  }
};
