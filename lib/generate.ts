import { GenSlide, LyricSection, PicPool, Project, TextPool, Workspace } from "./types";

export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\u00c0-\u024f]+/g, " ").trim();

/** Items of a text pool. Hooks: one per line, deduplicated. Block: the whole text is one item. */
export function textItems(pool: TextPool): string[] {
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

/** The section a lyrics slide reads: its own, else the project's, else the first one. */
export function lyricsSection(project: Project, sectionId?: string | null): LyricSection | undefined {
  return (
    (sectionId ? project.lyrics.find((l) => l.id === sectionId) : undefined) ??
    project.lyrics.find((l) => l.id === project.lyricsSectionId) ??
    project.lyrics[0]
  );
}

export function lyricsText(project: Project, sectionId?: string | null): string {
  const s = lyricsSection(project, sectionId);
  return s?.text.replace(/\r\n/g, "\n").replace(/\s+$/g, "") ?? "";
}

export function pickText(project: Project, ws: Workspace, slideIdx: number, bags: Record<string, string[]>): string {
  const src = project.slides[slideIdx].textSource;
  if (src.kind === "lyrics") return lyricsText(project, src.sectionId);
  if (src.kind === "pool") {
    const pool = ws.textPools.find((p) => p.id === src.poolId);
    if (!pool) return "";
    const items = textItems(pool);
    if (ws.favorTop && pool.kind === "hooks" && pool.views && Object.keys(pool.views).length && items.length) {
      return weightedPickBag(pool.id, items, pool.views, bags, ws.noRepeat) ?? "";
    }
    return pick(pool.id, items, bags, ws.noRepeat) ?? "";
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
