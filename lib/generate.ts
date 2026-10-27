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

export function lyricsText(project: Project): string {
  const s: LyricSection | undefined =
    project.lyrics.find((l) => l.id === project.lyricsSectionId) ?? project.lyrics[0];
  return s?.text.replace(/\r\n/g, "\n").replace(/\s+$/g, "") ?? "";
}

export function pickText(project: Project, ws: Workspace, slideIdx: number, bags: Record<string, string[]>): string {
  const src = project.slides[slideIdx].textSource;
  if (src.kind === "lyrics") return lyricsText(project);
  if (src.kind === "pool") {
    const pool = ws.textPools.find((p) => p.id === src.poolId);
    return pool ? pick(pool.id, textItems(pool), bags, ws.noRepeat) ?? "" : "";
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

/** Generate every slide of the project. Never the same picture twice in one carousel. */
export function generateAll(ws: Workspace, project: Project): { slides: GenSlide[]; bags: Record<string, string[]> } {
  const bags = { ...ws.bags };
  const used = new Set<string>();
  const slides = project.slides.map((_, i): GenSlide => {
    const pic = pickPic(project.slides[i].picPoolId, ws, bags, used);
    if (pic) used.add(pic.id);
    return { text: pickText(project, ws, i, bags), picId: pic?.id ?? null, picName: pic?.name };
  });
  return { slides, bags };
}

export const poolsVisible = <T extends { scope: string; projectId?: string }>(pools: T[], projectId: string) =>
  pools.filter((p) => p.scope === "shared" || p.projectId === projectId);
