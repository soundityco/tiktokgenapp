// Video converter worker (ffmpeg compiled to WebAssembly). Converts a segment of a camera file the
// browser cannot decode (4:2:2 10-bit, ProRes…) into a light H.264 4:2:0 MP4. The camera file is read
// from the disk (WORKERFS) and never leaves the device; only the engine is downloaded, once, then cached.
//
// Our own worker rather than the one of @ffmpeg/ffmpeg: that one loads the engine with an import()
// that Next.js's bundler rewrites, so the engine was never found.
const CORE = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";

let core = null;
let job = 0; // id of the job being run, echoed in every message so the page tells the answers apart
const post = (msg, transfer) => self.postMessage({ ...msg, job }, transfer || []);

async function load() {
  if (core) return core;
  post({ type: "status", step: "engine" });
  const res = await fetch(`${CORE}/ffmpeg-core.wasm`); // HTTP cache: downloaded once
  if (!res.ok || !res.body) throw new Error(`engine download failed (${res.status})`);
  const total = Number(res.headers.get("content-length")) || 32_300_000;
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    post({ type: "progress", step: "engine", p: Math.min(1, got / total) });
  }
  const wasmURL = URL.createObjectURL(new Blob(parts, { type: "application/wasm" }));
  const coreURL = `${CORE}/ffmpeg-core.js`;
  const { default: create } = await import(coreURL);
  // The engine finds its .wasm through this URL fragment (same trick as @ffmpeg/ffmpeg).
  core = await create({ mainScriptUrlOrBlob: `${coreURL}#${btoa(JSON.stringify({ wasmURL, workerURL: "" }))}` });
  return core;
}

let queue = Promise.resolve();
self.onmessage = (e) => { queue = queue.then(() => run(e)); };
async function run(e) {
  const { type, file, files, args, duration, output = "out.mp4", id = 0 } = e.data || {};
  if (type !== "convert") return;
  job = id;
  const log = [];
  try {
    const ff = await load();
    post({ type: "status", step: "convert" });
    ff.setLogger(({ message }) => {
      log.push(message);
      if (log.length > 40) log.shift();
      // "time=00:00:12.34": progress of the conversion.
      const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(message);
      if (m) post({ type: "progress", step: "convert", p: Math.min(1, (+m[1] * 3600 + +m[2] * 60 + +m[3]) / duration) });
    });
    try { ff.FS.mkdir("/in"); } catch { /* already there */ }
    ff.FS.mount(ff.FS.filesystems.WORKERFS, { blobs: [{ name: "source", data: file }] }, "/in");
    // Small extra inputs (the colour grade LUT) go in memory.
    for (const f of files || []) ff.FS.writeFile(f.name, f.data);
    try {
      ff.exec(...args);
      const ret = ff.ret;
      ff.reset();
      if (ret !== 0) throw new Error(`ffmpeg stopped (code ${ret})`);
      const out = ff.FS.readFile(output);
      try { ff.FS.unlink(output); } catch { /* nothing */ }
      post({ type: "done", data: out }, [out.buffer]);
    } finally {
      try { ff.FS.unmount("/in"); } catch { /* nothing */ }
      for (const f of files || []) try { ff.FS.unlink(f.name); } catch { /* nothing */ }
    }
  } catch (err) {
    post({ type: "error", message: String((err && err.message) || err), log: log.slice(-12) });
  }
}
