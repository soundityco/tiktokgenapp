/**
 * A text drawn from a list (a hook, a slide's text) and then retouched by hand is a new variant: once the post is
 * exported, the app offers to keep it in its list, beside the line it came from (with the same tags).
 */
import { isLineList } from "./defaults";
import { hookKey, textItems } from "./generate";
import type { Project, TextPool, VideoHook } from "./types";

export interface Variant {
  /** The list it goes to. */
  pool: string;
  /** The retouched text, as a line of the list (its line breaks as "|"). */
  text: string;
  /** The line it was drawn from, when known: its tags set by hand go with it. */
  from?: string;
}

/** A text as one line of a list: its line breaks become "|" (the lists' forced breaks). */
export const asLine = (s: string) => s.split(/\s*\n\s*/).map((x) => x.trim()).filter(Boolean).join(" | ");

/** Not a line of the list yet (whatever its case, punctuation or breaks). */
const isNew = (pool: TextPool, text: string) => {
  const key = hookKey(text);
  return !!key && !textItems(pool).some((x) => hookKey(x) === key);
};

/** The slides of a carousel whose text, drawn from a list of lines, was retouched into a text the list does not have. */
export function carouselVariants(p: Project, pools: TextPool[]): Variant[] {
  const out: Variant[] = [];
  p.slides.forEach((s, i) => {
    const g = p.generated?.[i];
    if (s.textSource.kind !== "pool" || !g?.edited) return;
    const poolId = s.textSource.poolId;
    const pool = pools.find((x) => x.id === poolId);
    const text = asLine(g.text);
    if (pool && isLineList(pool) && isNew(pool, text)) out.push({ pool: pool.id, text, from: g.from });
  });
  return dedupe(out);
}

/** The hooks of a video taken from a list and retouched into a text the list does not have. */
export function videoVariants(hooks: VideoHook[] | undefined, pools: TextPool[]): Variant[] {
  const out: Variant[] = [];
  for (const h of hooks ?? []) {
    if (!h.link || h.text === h.link.text) continue;
    const pool = pools.find((x) => x.id === h.link!.pool);
    const text = asLine(h.text);
    if (pool && isLineList(pool) && isNew(pool, text)) out.push({ pool: pool.id, text, from: h.link.text });
  }
  return dedupe(out);
}

const dedupe = (list: Variant[]) => list.filter((v, i) => list.findIndex((w) => w.pool === v.pool && hookKey(w.text) === hookKey(v.text)) === i);

/** The lists with the variants added at their end; a variant takes the tags set by hand on the line it came from. */
export function addVariants(pools: TextPool[], list: Variant[]): TextPool[] {
  return pools.map((p) => {
    const mine = list.filter((v) => v.pool === p.id && isNew(p, v.text));
    if (!mine.length) return p;
    const tags = { ...(p.tags ?? {}) };
    for (const v of mine) {
      const own = v.from !== undefined ? p.tags?.[hookKey(v.from)] : undefined;
      if (own?.length) tags[hookKey(v.text)] = own;
    }
    const text = p.text.replace(/\s+$/, "") + (p.text.trim() ? "\n" : "") + mine.map((v) => v.text).join("\n");
    return { ...p, text, ...(p.tags || Object.keys(tags).length ? { tags } : {}) };
  });
}
