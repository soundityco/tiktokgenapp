import { isLineList } from "./defaults";
import { slideLyrics } from "./lyricsSections";
import { isReleaseTag, RELEASE_TAG, tagsOf, THEMES_VERSION } from "./themes";
import { GenSlide, PicPool, Project, TextPool, Workspace } from "./types";

export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\u00c0-\u024f]+/g, " ").trim();

/** Items of a text pool. Hooks: one per line, deduplicated. Block: the whole text is one item. */
/**
 * Captions are kept as they are written (line breaks and empty lines included, the hashtags often on their own
 * line), separated by a line made of "---". A text with no such line (a .txt imported) is cut on empty lines.
 */
export const CAPTION_SEP = "\n---\n";
export function splitCaptions(text: string): string[] {
  const t = text.replace(/\r\n/g, "\n");
  const parts = /^[ \t]*-{3,}[ \t]*$/m.test(t) ? t.split(/^[ \t]*-{3,}[ \t]*$/m) : t.split(/\n[ \t]*\n/);
  return parts.map((x) => x.replace(/^\s*\n|\s+$/g, "").trim()).filter(Boolean);
}
export const joinCaptions = (items: string[]) => items.join(CAPTION_SEP);

export function textItems(pool: TextPool): string[] {
  if (pool.kind === "captions") return splitCaptions(pool.text);
  if (pool.kind === "block") return pool.text.trim() ? [pool.text.replace(/\r\n/g, "\n").replace(/\s+$/g, "")] : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of pool.text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const k = norm(line.replace(/\|/g, " "));
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(line);
  }
  return out;
}

const shuffle = <T,>(a: T[]): T[] => {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
};

/** Shuffle bag per pool: nothing is reused until the whole pool has been used. Mutates `bags`. */
export function pick(
  poolId: string,
  items: string[],
  bags: Record<string, string[]>,
  noRepeat: boolean,
  exclude: Set<string> = new Set()
): string | null {
  if (!items.length) return null;
  const candidates = items.filter((i) => !exclude.has(i));
  const pool = candidates.length ? candidates : items;
  if (!noRepeat) return pool[Math.floor(Math.random() * pool.length)];
  let bag = (bags[poolId] ?? []).filter((i) => items.includes(i));
  if (!bag.length) bag = shuffle(items);
  let idx = bag.findIndex((i) => !exclude.has(i));
  if (idx === -1) {
    bag = shuffle(items);
    idx = bag.findIndex((i) => !exclude.has(i));
    if (idx === -1) idx = 0;
  }
  const [chosen] = bag.splice(idx, 1);
  bags[poolId] = bag;
  return chosen;
}

export const hookKey = (t: string) => norm(t.replace(/\|/g, " "));

/** Random hook, more likely the more views it got. Hooks without stored views count as the median. */
export function weightedPick(items: string[], views: Record<string, number>): string {
  const known = Object.values(views).filter((v) => v > 0).sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : 1;
  const w = items.map((t) => Math.max(1, views[hookKey(t)] ?? median));
  let r = Math.random() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < items.length; i++) { r -= w[i]; if (r <= 0) return items[i]; }
  return items[items.length - 1];
}

/**
 * Views-weighted pick that still honours the shuffle bag.
 * Without this, turning on "Favor my best hooks" silently disabled "No repeats".
 */
export function weightedPickBag(
  poolId: string,
  items: string[],
  views: Record<string, number>,
  bags: Record<string, string[]>,
  noRepeat: boolean
): string | null {
  if (!items.length) return null;
  if (!noRepeat) return weightedPick(items, views);
  let bag = (bags[poolId] ?? []).filter((i) => items.includes(i));
  if (!bag.length) bag = shuffle(items);
  const chosen = weightedPick(bag, views);
  bags[poolId] = bag.filter((i) => i !== chosen);
  return chosen;
}

/**
 * One hook from a list, for the video studio: the same shuffle bag as the carousel, so a hook used
 * on one side does not come back on the other before the list has been used up. Mutates `bags`.
 */
export function drawHook(ws: Workspace, poolId: string, bags: Record<string, string[]>, exclude: string[] = [], tags?: string[] | string,
  /** Tags excluded (the − of a tag): their texts are never drawn. */
  not?: string[]): string | null {
  const pool = ws.textPools.find((p) => p.id === poolId);
  if (!pool) return null;
  // Some tags of the list only (their own shuffle bag), as for a slide; none (or none matching): the whole list.
  const want = typeof tags === "string" ? [tags] : tags;
  // (the release drawing: the texts kept for another one are left out)
  const inTags = want?.length ? taggedItems(pool, want, not, ws.currentProjectId) : [];
  const items = inTags.length ? inTags : drawableItems(pool, not, ws.currentProjectId);
  const bag = inTags.length ? bagOf(pool.id, want) : pool.id;
  if (!items.length) return null;
  const skip = new Set(exclude);
  if (ws.favorTop && pool.kind === "hooks" && pool.views && Object.keys(pool.views).length) {
    const rest = items.filter((i) => !skip.has(i));
    const before = bags[bag] ?? [];
    const chosen = weightedPickBag(bag, rest.length ? rest : items, pool.views, bags, ws.noRepeat);
    // The hooks left out (already on the video) stay in the bag: they were not drawn.
    if (ws.noRepeat && bags[bag]) bags[bag] = [...bags[bag], ...before.filter((x) => skip.has(x) && !bags[bag].includes(x))];
    return chosen;
  }
  return pick(bag, items, bags, ws.noRepeat, skip);
}

export type HookLink = { pool: string; line: number; text: string; count: number };

/** The link of a hook taken from a list (see VideoHook.link), or none when the text is not one of its lines. */
export function hookLink(pool: TextPool | undefined, text: string): HookLink | undefined {
  if (!pool) return undefined;
  const items = textItems(pool);
  const line = items.indexOf(text);
  return line < 0 ? undefined : { pool: pool.id, line, text, count: items.length };
}

/**
 * Hooks of a video taken from lists, after the lists changed:
 * - its line still there (maybe moved, lines added or removed above): found again by its text;
 * - the list has as many lines but not this text: the line was edited, the hook takes its new text;
 * - otherwise (line deleted, or edited while others came and went): the hook keeps its text, unlinked.
 * Returns the same array when nothing changed.
 */
export function followLists<T extends { text: string; link?: HookLink }>(hooks: T[], pools: TextPool[]): T[] {
  let changed = false;
  const out = hooks.map((h) => {
    const l = h.link;
    if (!l) return h;
    const pool = pools.find((p) => p.id === l.pool);
    if (!pool) return h;
    const items = textItems(pool);
    if (items[l.line] === l.text && items.length === l.count) return h; // unchanged
    changed = true;
    const moved = items.indexOf(l.text);
    if (moved >= 0) return { ...h, link: { ...l, line: moved, count: items.length } };
    if (items.length === l.count && l.line < items.length) return { ...h, text: items[l.line], link: { ...l, text: items[l.line] } };
    const { link: _gone, ...rest } = h;
    return rest as T;
  });
  return changed ? out : hooks;
}

export function pickText(project: Project, ws: Workspace, slideIdx: number, bags: Record<string, string[]>): string {
  const src = project.slides[slideIdx].textSource;
  if (src.kind === "lyrics") return slideLyrics(project, src);
  if (src.kind === "pool") {
    const pool = ws.textPools.find((p) => p.id === src.poolId);
    if (!pool) return "";
    // Some tags of the list only (their own shuffle bag); none ticked, or none matching: the whole list.
    const all = drawableItems(pool, src.notTags, project.id);
    const want = sourceTags(src.tags, src.theme);
    const inTags = want ? taggedItems(pool, want, src.notTags, project.id) : all;
    const items = inTags.length ? inTags : all;
    const bag = want && inTags.length ? bagOf(pool.id, want) : pool.id;
    if (ws.favorTop && pool.kind === "hooks" && pool.views && Object.keys(pool.views).length && items.length) {
      return weightedPickBag(bag, items, pool.views, bags, ws.noRepeat) ?? "";
    }
    return pick(bag, items, bags, ws.noRepeat) ?? "";
  }
  return "";
}

export function pickPic(
  poolId: string | null,
  ws: Workspace,
  bags: Record<string, string[]>,
  exclude: Set<string>
): { id: string; name: string } | null {
  const pool: PicPool | undefined = ws.picPools.find((p) => p.id === poolId);
  if (!pool || !pool.pics.length) return null;
  const id = pick(pool.id, pool.pics.map((p) => p.id), bags, ws.noRepeat, exclude);
  const ref = pool.pics.find((p) => p.id === id);
  return ref ? { id: ref.id, name: ref.name } : null;
}

/**
 * Generate every slide of the project. Never the same picture twice in one carousel.
 * `preserve` lets locked slides keep their existing generated text and photo.
 */
export function generateAll(
  ws: Workspace,
  project: Project,
  preserve?: (index: number) => GenSlide | undefined
): { slides: GenSlide[]; bags: Record<string, string[]> } {
  const bags = { ...ws.bags };
  const kept = project.slides.map((_, i) => preserve?.(i));
  const used = new Set<string>(
    kept.map((g) => g?.picId).filter((id): id is string => !!id)
  );
  const slides = project.slides.map((_, i): GenSlide => {
    const old = kept[i];
    if (old) return old;
    const pic = pickPic(project.slides[i].picPoolId, ws, bags, used);
    if (pic) used.add(pic.id);
    return { text: pickText(project, ws, i, bags), picId: pic?.id ?? null, picName: pic?.name };
  });
  return { slides, bags };
}

export const poolsVisible = <T extends { scope: string; projectId?: string }>(pools: T[], projectId: string) =>
  pools.filter((p) => p.scope === "shared" || p.projectId === projectId);

/** The model's tags of a list, when they were found with this version of the tags (else none: found again). */
export const aiTagsNow = (pool: TextPool): Record<string, string[]> | undefined => (pool.aiVersion === THEMES_VERSION ? pool.aiTags : undefined);
/** The tags found automatically for every text of a list (by hand as a theme, the local model, the lexicon). */
export const poolAutoTags = (pool: TextPool): string[][] => tagsOf(textItems(pool), hookKey, pool.themes, aiTagsNow(pool), pool.aiThemes);
/**
 * The tags of every text of a list: the ones set by hand, else the ones found automatically (several: what it
 * does, how it grabs…). "" is the tag of the texts that have none ("Other").
 */
export function poolTags(pool: TextPool): string[][] {
  const items = textItems(pool), auto = poolAutoTags(pool);
  return items.map((x, i) => {
    const own = pool.tags?.[hookKey(x)];
    const list = own ?? auto[i];
    return list.length ? list : [""];
  });
}
/** What a list keeps under each text's key: moved with the text when it is rewritten, dropped with it. */
const KEYED = ["tags", "themes", "aiTags", "aiThemes", "only", "views"] as const;
/**
 * A text of a list rewritten in place: its line replaced; its tags, theme, release and views follow it (the model's
 * tags too, until it reads it again). Empty: the text is taken out.
 */
export function rewriteText(pool: TextPool, from: string, to: string): TextPool {
  const next = to.replace(/\s*\n\s*/g, " ").trim();
  if (!next) return removeText(pool, from);
  if (next === from) return pool;
  const lines = pool.text.split("\n"), at = lines.findIndex((l) => l.trim() === from.trim());
  if (at < 0) return pool;
  lines[at] = next;
  const kf = hookKey(from), kt = hookKey(next);
  const out: TextPool = { ...pool, text: pool.kind === "hooks" ? sortLines(lines.join("\n")) : lines.join("\n") };
  if (kf !== kt) for (const f of KEYED) {
    const m = pool[f] as Record<string, unknown> | undefined;
    if (!m || !(kf in m)) continue;
    const c = { ...m };
    if (!(kt in c)) c[kt] = c[kf];
    delete c[kf];
    (out as unknown as Record<string, unknown>)[f] = c;
  }
  return out;
}
/** A text taken out of a list, with what was kept under its key (unless the same text is still there). */
export function removeText(pool: TextPool, text: string): TextPool {
  const lines = pool.text.split("\n"), at = lines.findIndex((l) => l.trim() === text.trim());
  if (at < 0) return pool;
  lines.splice(at, 1);
  const out: TextPool = { ...pool, text: lines.join("\n") };
  const k = hookKey(text);
  if (textItems(out).some((x) => hookKey(x) === k)) return out;
  for (const f of KEYED) {
    const m = pool[f] as Record<string, unknown> | undefined;
    if (!m || !(k in m)) continue;
    const c = { ...m }; delete c[k];
    (out as unknown as Record<string, unknown>)[f] = c;
  }
  return out;
}
/**
 * A text of a list doubled, to change one detail of it: « … (copy) » (« (copy 2) »…, never the same key twice) right
 * under it, with its tags, theme and release (never its TikTok views: they are the original's). `copy`: the word.
 */
export function duplicateText(pool: TextPool, text: string, copy = "copy"): { pool: TextPool; added: string } {
  const have = new Set(textItems(pool).map(hookKey));
  let n = 1, next = `${text} (${copy})`;
  while (have.has(hookKey(next))) next = `${text} (${copy} ${++n})`;
  const lines = pool.text.split("\n"), at = lines.findIndex((l) => l.trim() === text.trim());
  lines.splice(at < 0 ? lines.length : at + 1, 0, next);
  const out: TextPool = { ...pool, text: pool.kind === "hooks" ? sortLines(lines.join("\n")) : lines.join("\n") };
  const kf = hookKey(text), kt = hookKey(next);
  for (const f of KEYED) {
    if (f === "views") continue;
    const m = pool[f] as Record<string, unknown> | undefined;
    if (!m || !(kf in m)) continue;
    (out as unknown as Record<string, unknown>)[f] = { ...m, [kt]: m[kf] };
  }
  return { pool: out, added: next };
}
/** A list's text found by a search: every word typed in it, or in one of its tags' names (accents and case ignored). */
export function textMatches(text: string, tagNames: string[], query: string): boolean {
  const flat = (x: string) => x.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const words = flat(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = flat([text, ...tagNames].join(" "));
  return words.every((w) => hay.includes(w));
}
/** Texts pasted (one per line), the ones not in the list yet added (a hooks list stays in alphabetical order). */
export function addTexts(pool: TextPool, pasted: string): { pool: TextPool; added: string[] } {
  const have = new Set(textItems(pool).map(hookKey)), added: string[] = [];
  for (const l of pasted.split("\n").map((x) => x.trim()).filter(Boolean)) {
    const k = hookKey(l);
    if (have.has(k)) continue;
    have.add(k); added.push(l);
  }
  if (!added.length) return { pool, added };
  const text = [pool.text.replace(/\s+$/, ""), ...added].filter(Boolean).join("\n");
  return { pool: { ...pool, text: pool.kind === "hooks" ? sortLines(text) : text }, added };
}
/** Alphabetical order, the French way: no case, no accents, no punctuation (quotes, "POV :"), 2 before 10. */
const collator = new Intl.Collator("fr", { sensitivity: "base", numeric: true, ignorePunctuation: true });
export const compareTexts = (a: string, b: string) => collator.compare(a.replace(/\|/g, " ").trim(), b.replace(/\|/g, " ").trim());
/** A list's texts (one per line) in alphabetical order, the blank lines dropped. */
export const sortLines = (text: string) => text.split("\n").filter((l) => l.trim()).sort(compareTexts).join("\n");
/** Tags (or tag groups) in alphabetical order of their names as shown, "Other" ("") last. */
// (the releases' own tags in their own group, at the very end, after "Other")
const tagRank = (id: string) => (id === "" ? 1 : isReleaseTag(id) ? 2 : 0);
export const byTagName = <T,>(list: T[], id: (x: T) => string, label: (id: string) => string): T[] =>
  [...list].sort((a, b) => tagRank(id(a)) - tagRank(id(b)) || compareTexts(label(id(a)), label(id(b))));
/** The tags of a list, the biggest first ("" last), with their texts' indexes (a text is under each of its tags). */
export function tagGroups(tags: string[][]): { id: string; items: number[] }[] {
  const m = new Map<string, number[]>();
  tags.forEach((list, i) => list.forEach((id) => m.set(id, [...(m.get(id) ?? []), i])));
  return [...m.entries()].map(([id, items]) => ({ id, items })).sort((a, b) => (a.id === "") === (b.id === "") ? b.items.length - a.items.length : a.id === "" ? 1 : -1);
}
/**
 * A list's tags per text, with its release's tag ("release:<id>") when it is kept for one release (`TextPool.only`):
 * the tags shown and ticked, the draws' filters.
 */
export function itemTags(pool: TextPool): string[][] {
  const base = poolTags(pool);
  if (!pool.only || !Object.keys(pool.only).length) return base;
  return textItems(pool).map((x, i) => {
    const r = pool.only?.[hookKey(x)];
    return r ? [...base[i].filter(Boolean), RELEASE_TAG + r] : base[i];
  });
}
/** A text kept for another release than `release`, its tag not ticked here: never drawn nor offered in this one. */
export const keptElsewhere = (tags: string[], release?: string, ticked?: string[]) =>
  tags.some((x) => isReleaseTag(x) && x !== RELEASE_TAG + release && !ticked?.includes(x));
/** The texts of a list with at least one of `tags`, none of the excluded ones (`not`), none kept for another release. */
export function taggedItems(pool: TextPool, tags: string[], not?: string[], release?: string): string[] {
  const items = textItems(pool), tg = itemTags(pool);
  return items.filter((_, i) => tg[i].some((x) => tags.includes(x)) && !tg[i].some((x) => not?.includes(x)) && !keptElsewhere(tg[i], release, tags));
}
/** The texts of a list that can be drawn: none with an excluded tag (the − of a tag: `notTags`), none kept for another
 *  release (`release`: the one drawing). */
export function drawableItems(pool: TextPool, not?: string[], release?: string): string[] {
  const items = textItems(pool);
  if (!isLineList(pool) || (!not?.length && !pool.only)) return items;
  const tg = itemTags(pool);
  return items.filter((_, i) => !tg[i].some((x) => not?.includes(x)) && !keptElsewhere(tg[i], release));
}
/**
 * A tag's next state, Splice-like: a click ticks it or not (only the texts with a ticked tag), its − excludes it or not
 * (never its texts). A tag is never ticked and excluded at once.
 */
export function tagStep(tags: string[], not: string[], id: string, act: "tick" | "not"): { tags: string[]; not: string[] } {
  if (act === "tick") return { tags: tags.includes(id) ? tags.filter((x) => x !== id) : [...tags, id], not: not.filter((x) => x !== id) };
  return { tags: tags.filter((x) => x !== id), not: not.includes(id) ? not.filter((x) => x !== id) : [...not, id] };
}
/** The tags a source draws from: its own, else its older single theme, else none (the whole list). */
export const sourceTags = (tags?: string[], theme?: string): string[] | undefined => (tags?.length ? tags : theme !== undefined ? [theme] : undefined);
/** The shuffle bag of a list drawn from some of its tags only (its own bag, so the whole list's is left as it is). */
const bagOf = (poolId: string, tags?: string[]) => (tags?.length ? `${poolId}#${[...tags].sort().join("+")}` : poolId);
