// Themes of hooks and texts, found on the device (transformers.js, a small multilingual sentence model).
// Nothing is sent anywhere: only the model files are downloaded once, then kept by the browser.
const LIB = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6";
const MODEL = "Xenova/multilingual-e5-small";

let embed = null;
let protoKey = "";
let proto = null; // { id: Float32Array[] }

const post = (msg) => self.postMessage(msg);
const vec = async (texts) => {
  const out = await embed(texts.map((t) => "query: " + t), { pooling: "mean", normalize: true });
  const [n, d] = out.dims;
  return Array.from({ length: n }, (_, i) => out.data.subarray(i * d, (i + 1) * d));
};
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

self.onmessage = async (e) => {
  const { type, id, texts, examples, lex, weight, minScore } = e.data || {};
  if (type !== "classify") return;
  try {
    if (!embed) {
      post({ id, type: "status", step: "model" });
      const { pipeline, env } = await import(LIB);
      env.allowLocalModels = false;
      const files = new Map();
      embed = await pipeline("feature-extraction", MODEL, {
        device: "wasm", dtype: "q8",
        progress_callback: (p) => {
          if (p.status === "progress" && p.file) {
            files.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
            let loaded = 0, total = 0;
            for (const f of files.values()) { loaded += f.loaded; total += f.total; }
            if (total) post({ id, type: "progress", pct: loaded / total });
          }
        },
      });
    }
    post({ id, type: "status", step: "think" });
    const key = JSON.stringify(examples);
    if (key !== protoKey) {
      proto = {};
      for (const [k, list] of Object.entries(examples)) proto[k] = await vec(list);
      protoKey = key;
    }
    const keys = Object.keys(proto);
    const out = [];
    for (let i = 0; i < texts.length; i += 16) {
      const vs = await vec(texts.slice(i, i + 16));
      vs.forEach((v, k) => {
        // The two closest examples of each theme; the scores relative to this text's own average (z-score),
        // plus the lexicon's points for the theme.
        const raw = keys.map((t) => { const s = proto[t].map((p) => dot(p, v)).sort((a, b) => b - a); return (s[0] + (s[1] ?? s[0])) / 2; });
        const m = raw.reduce((a, x) => a + x, 0) / raw.length;
        const sd = Math.sqrt(raw.reduce((a, x) => a + (x - m) ** 2, 0) / raw.length) || 1;
        const l = lex[i + k] || {};
        let best = null, bestScore = -Infinity;
        keys.forEach((t, j) => { const s = (raw[j] - m) / sd + weight * (l[t] || 0); if (s > bestScore) { bestScore = s; best = t; } });
        out.push(bestScore >= minScore ? best : null);
      });
      post({ id, type: "progress", pct: Math.min(1, (i + 16) / texts.length), step: "think" });
    }
    post({ id, type: "done", themes: out });
  } catch (err) {
    post({ id, type: "error", message: String(err && err.message || err) });
  }
};
