/**
 * The local theme model (public/themes/worker.js): a small multilingual sentence model run in the browser,
 * downloaded once (≈120 MB, then cached by the browser). No online AI, nothing leaves the device.
 */
import { LEX_WEIGHT, THEME_EXAMPLES, themeScores } from "./themes";

let worker: Worker | null = null;
let seq = 0;

/** The theme of each text ("" when it speaks of none of them), found by the model with the lexicon's help. */
export function classifyThemes(texts: string[], onProgress?: (p: { step: "model" | "think"; pct: number }) => void): Promise<string[]> {
  worker ??= new Worker("/themes/worker.js", { type: "module" });
  const w = worker;
  const id = ++seq;
  const lex = texts.map((t) => Object.fromEntries(themeScores(t).map((x) => [x.id, x.score])));
  return new Promise((resolve, reject) => {
    let step: "model" | "think" = "model";
    const on = (e: MessageEvent) => {
      const m = e.data;
      if (m?.id !== id) return;
      if (m.type === "status") { step = m.step; onProgress?.({ step, pct: 0 }); }
      else if (m.type === "progress") onProgress?.({ step: m.step ?? step, pct: m.pct });
      else if (m.type === "done") { w.removeEventListener("message", on); resolve((m.themes as (string | null)[]).map((x) => (x && x !== "none" ? x : ""))); }
      else if (m.type === "error") { w.removeEventListener("message", on); reject(new Error(m.message)); }
    };
    w.addEventListener("message", on);
    // Every text gets the model's best theme; the "none" examples catch the texts about nothing of the kind.
    w.postMessage({ type: "classify", id, texts, examples: THEME_EXAMPLES, lex, weight: LEX_WEIGHT, minScore: -Infinity });
  });
}
