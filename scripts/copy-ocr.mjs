// Copies the OCR engine (tesseract worker + wasm core + English data) into public/ocr so it is served by
// the app itself (no third-party CDN). Runs automatically after `npm install`.
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

const nm = path.resolve("node_modules");
const out = path.resolve("public/ocr");
try {
  mkdirSync(path.join(out, "core"), { recursive: true });
  mkdirSync(path.join(out, "lang"), { recursive: true });
  cpSync(path.join(nm, "tesseract.js/dist/worker.min.js"), path.join(out, "worker.min.js"));
  const core = path.join(nm, "tesseract.js-core");
  for (const f of readdirSync(core)) if (/-lstm\.wasm\.js$/.test(f)) cpSync(path.join(core, f), path.join(out, "core", f));
  const lang = path.join(nm, "@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz");
  if (existsSync(lang)) cpSync(lang, path.join(out, "lang/eng.traineddata.gz"));
  console.log("OCR engine copied to public/ocr");
} catch (e) {
  console.warn("Could not copy the OCR engine:", e.message);
}
