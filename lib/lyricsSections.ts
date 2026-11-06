import type { LyricSection, Project, SlideCfg, TextPool, TextSource, Workspace } from "./types";
import { uid } from "./defaults";
import { mapAllSlides } from "./carousels";

/**
 * The lyrics of a release live in one place: its sections (verse, chorus…). A slide whose text comes from
 * the lyrics shows the sections ticked for it, in the song's order, under an optional header.
 */

/** A line naming a section: "[Chorus]", "[Refrain x2]", "(Couplet 1)", "Refrain :". */
const TAG = /^\s*(?:\[([^\]\n]{1,40})\]|\(([^)\n]{1,40})\)|((?:refrain|chorus|couplet|verse|pont|bridge|intro|outro|hook|pre-?chorus|pré-?refrain|interlude)[^:\n]{0,20}):)\s*$/i;

/** Cuts a whole song into sections: on its tags when it has some, else on its empty lines. */
export function splitSong(text: string, label: (n: number) => string): { name: string; text: string }[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: { name: string; text: string[] }[] = [];
  const tagged = lines.some((l) => TAG.test(l));
  let cur: { name: string; text: string[] } | null = null;
  for (const line of lines) {
    const m = TAG.exec(line);
    if (tagged && m) { cur = { name: (m[1] ?? m[2] ?? m[3]).trim(), text: [] }; out.push(cur); continue; }
    if (!tagged && !line.trim()) { cur = null; continue; }
    if (!cur) { if (!line.trim()) continue; cur = { name: "", text: [] }; out.push(cur); }
    cur.text.push(line);
  }
  return out
    .map((s) => ({ name: s.name, text: s.text.join("\n").replace(/^\s*\n|\s+$/g, "") }))
    .filter((s) => s.text.trim())
    .map((s, i) => ({ name: s.name || label(i + 1), text: s.text }));
}

/** The sections a lyrics slide shows (older slides: their one section, or the release's default one). */
export function sectionsOf(project: Project, src: Extract<TextSource, { kind: "lyrics" }>): LyricSection[] {
  if (src.sectionIds) return project.lyrics.filter((l) => src.sectionIds!.includes(l.id));
  const one = (src.sectionId && project.lyrics.find((l) => l.id === src.sectionId))
    || project.lyrics.find((l) => l.id === project.lyricsSectionId) || project.lyrics[0];
  return one ? [one] : [];
}

/** The text of a lyrics slide: its header, then its sections one after the other (an empty line between). */
export function slideLyrics(project: Project, src: Extract<TextSource, { kind: "lyrics" }>): string {
  const body = sectionsOf(project, src).map((s) => s.text.replace(/\r\n/g, "\n").replace(/\s+$/g, "")).filter(Boolean).join("\n\n");
  const head = src.header?.trim();
  return head && body ? `${head}\n${body}` : head || body;
}

/** The lyrics slides of every carousel follow their sections (a section edited, ticked, renamed…). Locked slides stay. */
export function refreshLyricSlides(p: Project): Project {
  const fix = (slides: SlideCfg[], generated: Project["generated"]) => {
    if (!generated) return generated;
    let changed = false;
    const g = generated.map((x, i) => {
      const s = slides[i];
      if (!s || s.locked || s.textSource.kind !== "lyrics") return x;
      const text = slideLyrics(p, s.textSource);
      if (x.text === text) return x;
      changed = true;
      return { ...x, text };
    });
    return changed ? g : generated;
  };
  return {
    ...p,
    generated: fix(p.slides, p.generated),
    carousels: p.carousels?.map((c) => ({ ...c, generated: fix(c.slides, c.generated) })),
  };
}

/**
 * Older workspaces, brought to one place for the lyrics:
 * - a release with no sections but the whole song pasted in the video studio gets it cut into sections;
 * - a slide on the lyrics shows the section it showed (its own, or the release's default one);
 * - a slide on a "lyrics block" list gets that text as a section of its release, and shows it.
 * The block lists themselves are kept (nothing is lost); they are just not offered any more.
 */
export function migrateLyrics(ws: Workspace, label: (n: number) => string = (n) => `Part ${n}`): Workspace {
  const blocks = new Map<string, TextPool>(ws.textPools.filter((x) => x.kind === "block").map((x) => [x.id, x]));
  let touched = false;
  const projects = ws.projects.map((p0) => {
    let p = p0;
    if (!p.lyrics.length && p.songLyrics?.trim()) {
      const parts = splitSong(p.songLyrics, label);
      if (parts.length) { p = { ...p, lyrics: parts.map((s) => ({ id: uid(), name: s.name, text: s.text })) }; touched = true; }
    }
    const lyrics = [...p.lyrics];
    const sectionFor = (pool: TextPool) => {
      const text = pool.text.replace(/\r\n/g, "\n").replace(/\s+$/g, "");
      let s = lyrics.find((l) => l.text.replace(/\s+$/g, "") === text);
      if (!s) { s = { id: uid(), name: pool.name, text }; lyrics.push(s); }
      return s.id;
    };
    const fixSlide = (s: SlideCfg): SlideCfg => {
      const src = s.textSource;
      if (src.kind === "lyrics" && !src.sectionIds) {
        const one = (src.sectionId && lyrics.find((l) => l.id === src.sectionId)) || lyrics.find((l) => l.id === p.lyricsSectionId) || lyrics[0];
        if (!one) return s; // no sections yet: it will show the first one written
        touched = true;
        return { ...s, textSource: { kind: "lyrics", sectionIds: [one.id] } };
      }
      if (src.kind === "pool" && blocks.has(src.poolId)) {
        touched = true;
        return { ...s, textSource: { kind: "lyrics", sectionIds: [sectionFor(blocks.get(src.poolId)!)] } };
      }
      return s;
    };
    p = mapAllSlides(p, fixSlide);
    return lyrics.length !== p.lyrics.length ? { ...p, lyrics } : p;
  });
  return touched ? { ...ws, projects } : ws;
}

/**
 * After a section was cut in two (`keep`: the slides showing it show both parts) or merged into another
 * (the slides showing the merged one show the one it went into).
 */
export function relinkSections(p: Project, from: string, to: string, keep: boolean): Project {
  return mapAllSlides(p, (s) => {
    const src = s.textSource;
    if (src.kind !== "lyrics") return s;
    const ids = src.sectionIds ?? sectionsOf(p, src).map((x) => x.id);
    if (!ids.includes(from)) return s;
    const next = keep ? [...ids, to] : ids.map((x) => (x === from ? to : x));
    return { ...s, textSource: { ...src, sectionId: undefined, sectionIds: [...new Set(next)] } };
  });
}
