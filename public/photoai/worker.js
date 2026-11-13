// Photo AI, on the device: sharper (Swin2SR real-world ×4) and fill the frame (LaMa), both with onnxruntime-web.
// Nothing is sent anywhere: only the model files are downloaded once, then kept by the browser.
const ORT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/";
const MODELS = {
  sharp: { url: "https://huggingface.co/onnx-community/swin2SR-realworld-sr-x4-64-bsrgan-psnr-ONNX/resolve/main/onnx/model.onnx", size: 53827735 },
  fill: { url: "https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx", size: 208044816 },
};

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

/** A model's file: from the browser's cache, else downloaded once (its progress in whole percents). */
async function modelBytes(id, { url, size }) {
  const cache = await caches.open("rollout-photoai");
  const hit = await cache.match(url);
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  post({ id, type: "progress", step: "model", pct: 0 });
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error("model download " + r.status);
  const total = Number(r.headers.get("content-length")) || size;
  const reader = r.body.getReader();
  const parts = [];
  let got = 0, shown = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
    const pct = Math.floor((got / total) * 100);
    if (pct > shown) { shown = pct; post({ id, type: "progress", step: "model", pct: pct / 100 }); }
  }
  const blob = new Blob(parts);
  await cache.put(url, new Response(blob)).catch(() => {});
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * A model ready to run: on the graphics card when there is one, else (or when the card cannot run one of its parts,
 * as for LaMa in some browsers) on the processor, slower but always there.
 */
const sessions = {};
async function model(id, key) {
  if (!sessions[key]) {
    const bytes = await modelBytes(id, MODELS[key]);
    post({ id, type: "status", step: "start" });
    const ort = await ortLib();
    const open = async (provider) => ({ provider, session: await ort.InferenceSession.create(bytes, { executionProviders: [provider] }) });
    const s = (await gpu()) ? await open("webgpu").catch(() => open("wasm")) : await open("wasm");
    sessions[key] = {
      ...s, ort,
      async run(feeds) {
        try { return await this.session.run(feeds); }
        catch (err) {
          if (this.provider !== "webgpu") throw err;
          console.info(`[photoai] ${key}: the graphics card failed, on the processor instead`, String((err && err.message) || err));
          Object.assign(this, await open("wasm"));
          return await this.session.run(feeds);
        }
      },
    };
    console.info(`[photoai] ${key} on`, s.provider);
  }
  return sessions[key];
}

// ---- sharper: ×4 on tiles, each with a margin of which only its middle is kept (no seams) ----
const TILE = 128, MARGIN = 16, T = TILE + 2 * MARGIN; // T: a multiple of 8 (the model's window)
async function upscale(id, { width: W, height: H, data }) {
  const m = await model(id, "sharp");
  const src = new Uint8ClampedArray(data), OW = W * 4, OH = H * 4;
  const out = new Uint8ClampedArray(OW * OH * 4);
  const tiles = [];
  for (let y = 0; y < H; y += TILE) for (let x = 0; x < W; x += TILE) tiles.push([x, y]);
  const input = new Float32Array(3 * T * T), S = T * 4;
  for (let n = 0; n < tiles.length; n++) {
    post({ id, type: "progress", step: "run", pct: n / tiles.length });
    const [tx, ty] = tiles[n];
    // The tile and its margin, the picture's edge repeated where it goes past it.
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      const gx = Math.min(W - 1, Math.max(0, tx - MARGIN + x)), gy = Math.min(H - 1, Math.max(0, ty - MARGIN + y));
      const gi = (gy * W + gx) * 4, k = y * T + x;
      for (let c = 0; c < 3; c++) input[c * T * T + k] = src[gi + c] / 255;
    }
    const res = await m.run({ [m.session.inputNames[0]]: new m.ort.Tensor("float32", input, [1, 3, T, T]) });
    const o = res[m.session.outputNames[0]].data;
    const cw = Math.min(TILE, W - tx), ch = Math.min(TILE, H - ty);
    for (let y = 0; y < ch * 4; y++) for (let x = 0; x < cw * 4; x++) {
      const k = (y + MARGIN * 4) * S + (x + MARGIN * 4), oi = ((ty * 4 + y) * OW + tx * 4 + x) * 4;
      for (let c = 0; c < 3; c++) out[oi + c] = Math.round(Math.max(0, Math.min(1, o[c * S * S + k])) * 255);
      out[oi + 3] = 255;
    }
  }
  post({ id, type: "done", width: OW, height: OH, data: out.buffer }, [out.buffer]);
}

// ---- fill the frame: LaMa on 512 × 512 windows along the picture (the short side is 512) ----
const N = 512;
async function fill(id, { width: W, height: H, data, mask }) {
  const m = await model(id, "fill");
  const rgba = new Uint8ClampedArray(data), hole = new Uint8Array(mask);
  // Windows along the long side, each one filling with what is known so far.
  const long = Math.max(W, H), across = W >= H;
  const starts = [];
  for (let p = 0; ; p += 384) { const s = Math.min(p, long - N); starts.push(s); if (s >= long - N) break; }
  const at = (s, a, b) => (across ? b * W + s + a : (s + b) * W + a); // window `s`, its pixel (a, b)
  const todo = starts.filter((s) => { for (let b = 0; b < N; b++) for (let a = 0; a < N; a++) if (hole[at(s, a, b)]) return true; return false; });
  const names = m.session.inputNames;
  const [iName, mName] = names.length === 2 && /mask/i.test(names[0]) ? [names[1], names[0]] : names;
  for (let n = 0; n < todo.length; n++) {
    post({ id, type: "progress", step: "run", pct: n / todo.length });
    const s = todo[n];
    const img = new Float32Array(3 * N * N), mk = new Float32Array(N * N);
    for (let b = 0; b < N; b++) for (let a = 0; a < N; a++) {
      const gi = at(s, a, b), k = b * N + a, unknown = hole[gi];
      mk[k] = unknown ? 1 : 0;
      for (let c = 0; c < 3; c++) img[c * N * N + k] = unknown ? 0 : rgba[gi * 4 + c] / 255;
    }
    const res = await m.run({ [iName]: new m.ort.Tensor("float32", img, [1, 3, N, N]), [mName]: new m.ort.Tensor("float32", mk, [1, 1, N, N]) });
    const out = res[m.session.outputNames[0]].data;
    let max = 0;
    for (let i = 0; i < out.length; i += 997) max = Math.max(max, out[i]);
    const k255 = max > 2 ? 1 : 255; // some exports give 0-255, others 0-1
    for (let b = 0; b < N; b++) for (let a = 0; a < N; a++) {
      const gi = at(s, a, b), k = b * N + a;
      if (!hole[gi]) continue;
      for (let c = 0; c < 3; c++) rgba[gi * 4 + c] = Math.max(0, Math.min(255, out[c * N * N + k] * k255));
      rgba[gi * 4 + 3] = 255;
      hole[gi] = 0;
    }
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
