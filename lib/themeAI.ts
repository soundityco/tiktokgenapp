/**
 * The local theme model (public/themes/worker.js): a small multilingual sentence model run in the browser,
 * downloaded once (≈120 MB, then cached by the browser). No online AI, nothing leaves the device.
 */
import { aiTagsNow, hookKey, textItems } from "./generate";
import { examplesFor, LEX_WEIGHT, pickTags, THEME_EXAMPLES, themeScores, THEMES_VERSION } from "./themes";
import type { TextPool } from "./types";

let worker: Worker | null = null;
let seq = 0;

/** The tags of each text (none when it speaks of nothing of the kind), found by the model with the lexicon's help;
 *  `examples`: the built-in ones, or the list's (with the texts tagged by hand, see examplesFor). */
export function classifyTags(texts: string[], onProgress?: (p: { step: "model" | "think"; pct: number }) => void, examples: Record<string, string[]> = THEME_EXAMPLES): Promise<string[][]> {
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
      else if (m.type === "done") { w.removeEventListener("message", on); resolve((m.scores as Record<string, number>[]).map((sc, i) => pickTags(sc, lex[i]))); }
      else if (m.type === "error") { w.removeEventListener("message", on); reject(new Error(m.message)); }
    };
    w.addEventListener("message", on);
    // Every tag scored for every text; the "none" examples catch the texts about nothing of the kind.
    w.postMessage({ type: "classify", id, texts, examples, lex, weight: LEX_WEIGHT });
  });
}

/** The tags set by hand on each text of a list (its own tags, else its old hand-set theme; none: []). */
export const ownTagsOf = (pool: TextPool): string[][] =>
  textItems(pool).map((x) => { const k = hookKey(x), th = pool.themes?.[k]; return pool.tags?.[k] ?? (th ? [th] : []); });

/**
 * The texts of a list the model has to sort now: none when the list never used it (the lexicon tags it); else the
 * whole list when its tags were found with an older version of the tags, else only the texts added since.
 */
export function modelWork(pool: TextPool): string[] {
  // (a hooks list is always sorted by the model, never sorted by hand first: a new hook lands in its best tag, not
  // "Other"; the other lists only once sorted by the model)
  if (!pool.aiTags && !pool.aiThemes && pool.kind !== "hooks") return [];
  const now = aiTagsNow(pool);
  const items = textItems(pool);
  return now ? items.filter((x) => !(hookKey(x) in now)) : items;
}

/**
 * Sorts these texts of a list with the model, learning from the list's own hand-set tags (yours included); the
 * change to apply to the list (kept with what was found before, unless it was found with an older version).
 */
export async function sortWithModel(pool: TextPool, texts: string[], onProgress?: (p: { step: "model" | "think"; pct: number }) => void): Promise<(x: TextPool) => TextPool> {
  const found = await classifyTags(texts, onProgress, examplesFor(textItems(pool), ownTagsOf(pool)));
  const add = Object.fromEntries(texts.map((tx, i) => [hookKey(tx), found[i]]));
  return (x) => ({ ...x, aiTags: { ...(aiTagsNow(x) ?? {}), ...add }, aiVersion: THEMES_VERSION });
}
