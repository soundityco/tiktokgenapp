// Photo AI, on the device: sharper (Swin2SR ×4, transformers.js) and fill the frame (LaMa, onnxruntime-web).
// Nothing is sent anywhere: only the model files are downloaded once, then kept by the browser.
const TF = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6";
const ORT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/";
const SR_MODEL = "Xenova/swin2SR-compressed-sr-x4-48";
const LAMA_URL = "https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx";
const N = 512; // LaMa's fixed size

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const gpu = async () => { try { return !!(self.navigator.gpu && (await self.navigator.gpu.requestAdapter())); } catch { return false; } };

// ---- sharper: ×4 ----
let upscaler = null;
async function upscale(id, { width, height, data }) {
  if (!upscaler) {
    post({ id, type: "status", step: "model" });
    const { pipeline, env } = await import(TF);
    env.allowLocalModels = false;
    const files = new Map();
    const device = (await gpu()) ? "webgpu" : "wasm";
    upscaler = await pipeline("image-to-image", SR_MODEL, {
      device, dtype: device === "webgpu" ? "fp32" : "q8",
      progress_callback: (p) => {
        if (p.status === "progress" && p.file) {
          files.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
          let loaded = 0, total = 0;
          for (const f of files.values()) { loaded += f.loaded; total += f.total; }
          if (total) post({ id, type: "progress", step: "model", pct: loaded / total });
        }
      },
    });
    console.info("[photoai] sharper on", device);
  }
  post({ id, type: "status", step: "run" });
  const { RawImage } = await import(TF);
  const image = new RawImage(new Uint8ClampedArray(data), width, height, 4).rgb();
  let out = await upscaler(image);
  if (Array.isArray(out)) out = out[0];
  const rgba = out.rgba();
  post({ id, type: "done", width: rgba.width, height: rgba.height, data: rgba.data.buffer }, [rgba.data.buffer]);
}

// ---- fill the frame: LaMa on 512 × 512 windows along the picture ----
let lama = null;
async function cachedModel(id) {
  const cache = await caches.open("rollout-photoai");
  let res = await cache.match(LAMA_URL);
  if (!res) {
    post({ id, type: "status", step: "model" });
    const r = await fetch(LAMA_URL);
    if (!r.ok || !r.body) throw new Error("model download " + r.status);
    const total = Number(r.headers.get("content-length")) || 208044816;
    const reader = r.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); got += value.length;
      post({ id, type: "progress", step: "model", pct: got / total });
    }
    const blob = new Blob(parts);
    await cache.put(LAMA_URL, new Response(blob)).catch(() => {});
    return new Uint8Array(await blob.arrayBuffer());
  }
  return new Uint8Array(await res.arrayBuffer());
}
async function fill(id, { width: W, height: H, data, mask }) {
  if (!lama) {
    const bytes = await cachedModel(id);
    post({ id, type: "status", step: "start" });
    const ort = await import(ORT + "ort.all.min.mjs");
    ort.env.wasm.wasmPaths = ORT;
    ort.env.wasm.numThreads = Math.min(8, self.navigator.hardwareConcurrency || 4);
    const open = async (provider) => ({ ort, bytes, provider, session: await ort.InferenceSession.create(bytes, { executionProviders: [provider] }) });
    lama = (await gpu()) ? await open("webgpu").catch(() => open("wasm")) : await open("wasm");
    lama.open = open;
    console.info("[photoai] fill on", lama.provider, lama.session.inputNames, lama.session.outputNames);
  }
  const { ort } = lama;
  // The graphics card cannot run every part of LaMa in some browsers: then the processor (slower, always works).
  const run = async (feeds) => {
    try { return await lama.session.run(feeds); }
    catch (err) {
      if (lama.provider !== "webgpu") throw err;
      console.info("[photoai] fill: the graphics card failed, on the processor instead", String(err && err.message || err));
      lama = { ...(await lama.open("wasm")), open: lama.open };
      return await lama.session.run(feeds);
    }
  };
  const rgba = new Uint8ClampedArray(data), hole = new Uint8Array(mask);
  // Windows of 512 along the long side (the short side is 512), each one filling with what is known so far.
  const long = Math.max(W, H), across = W >= H;
  const starts = [];
  for (let p = 0; ; p += 384) { const s = Math.min(p, long - N); starts.push(s); if (s >= long - N) break; }
  const todo = starts.filter((s) => {
    for (let a = 0; a < N; a++) for (let b = 0; b < N; b++) { const x = across ? s + a : b, y = across ? b : s + a; if (hole[y * W + x]) return true; }
    return false;
  });
  let n = 0;
  for (const s of todo) {
    post({ id, type: "progress", step: "run", pct: n / todo.length });
    const img = new Float32Array(3 * N * N), m = new Float32Array(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const gx = across ? s + x : x, gy = across ? y : s + y, gi = gy * W + gx, k = y * N + x;
      const unknown = hole[gi];
      m[k] = unknown ? 1 : 0;
      for (let c = 0; c < 3; c++) img[c * N * N + k] = unknown ? 0 : rgba[gi * 4 + c] / 255;
    }
    const feeds = {};
    const names = lama.session.inputNames;
    const [iName, mName] = names.length === 2 && /mask/i.test(names[0]) ? [names[1], names[0]] : names;
    feeds[iName] = new ort.Tensor("float32", img, [1, 3, N, N]);
    feeds[mName] = new ort.Tensor("float32", m, [1, 1, N, N]);
    const res = await run(feeds);
    const out = res[lama.session.outputNames[0]].data;
    let max = 0;
    for (let i = 0; i < out.length; i += 997) max = Math.max(max, out[i]);
    const k255 = max > 2 ? 1 : 255; // some exports give 0-255, others 0-1
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const gx = across ? s + x : x, gy = across ? y : s + y, gi = gy * W + gx, k = y * N + x;
      if (!hole[gi]) continue;
      for (let c = 0; c < 3; c++) rgba[gi * 4 + c] = Math.max(0, Math.min(255, out[c * N * N + k] * k255));
      rgba[gi * 4 + 3] = 255;
      hole[gi] = 0;
    }
    n++;
  }
  post({ id, type: "done", width: W, height: H, data: rgba.buffer }, [rgba.buffer]);
}

self.onmessage = async (e) => {
  const { type, id } = e.data || {};
  try {
    if (type === "upscale") await upscale(id, e.data);
    else if (type === "fill") await fill(id, e.data);
  } catch (err) {
    post({ id, type: "error", message: String((err && err.message) || err) });
  }
};
