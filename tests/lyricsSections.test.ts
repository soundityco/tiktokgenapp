import { describe, expect, it } from "vitest";
import { migrateLyrics, refreshLyricSlides, relinkSections, slideLyrics, splitSong } from "@/lib/lyricsSections";
import type { Project, Workspace } from "@/lib/types";

const label = (n: number) => `Part ${n}`;
const slide = (textSource: any) => ({ id: Math.random().toString(), textSource, picPoolId: null, format: "9:16", pic: {}, style: {} }) as any;
const proj = (over: Partial<Project> = {}): Project => ({
  id: "p", name: "R", slides: [], lyrics: [{ id: "v", name: "Verse", text: "a\nb" }, { id: "c", name: "Chorus", text: "la la\nla" }],
  lyricsSectionId: "c", generated: null, selectedSlide: 0, videos: [], ...over,
});

describe("cutting a song into sections", () => {
  it("on its tags", () => {
    expect(splitSong("[Couplet 1]\nun\ndeux\n\n[Refrain]\nla la\n", label)).toEqual([{ name: "Couplet 1", text: "un\ndeux" }, { name: "Refrain", text: "la la" }]);
  });
  it("on its empty lines when it has no tags", () => {
    expect(splitSong("un\ndeux\n\n\ntrois\n", label)).toEqual([{ name: "Part 1", text: "un\ndeux" }, { name: "Part 2", text: "trois" }]);
  });
});

describe("a lyrics slide", () => {
  it("shows its ticked sections in the song's order, under its header", () => {
    expect(slideLyrics(proj(), { kind: "lyrics", sectionIds: ["c", "v"], header: "Paroles" })).toBe("Paroles\na\nb\n\nla la\nla");
  });
  it("older slides: their section, or the release's default one", () => {
    expect(slideLyrics(proj(), { kind: "lyrics", sectionId: "v" })).toBe("a\nb");
    expect(slideLyrics(proj(), { kind: "lyrics" })).toBe("la la\nla");
  });
  it("follows the sections when they change (locked slides stay)", () => {
    const p = proj({ slides: [slide({ kind: "lyrics", sectionIds: ["v"] }), { ...slide({ kind: "lyrics", sectionIds: ["v"] }), locked: true }], generated: [{ text: "old", picId: null }, { text: "kept", picId: null }] });
    const q = refreshLyricSlides({ ...p, lyrics: [{ id: "v", name: "Verse", text: "new" }] });
    expect(q.generated?.map((g) => g.text)).toEqual(["new", "kept"]);
  });
  it("a section cut in two: the slide shows both parts; merged: the one it went into", () => {
    const p = proj({ slides: [slide({ kind: "lyrics", sectionIds: ["v"] })] });
    expect((relinkSections(p, "v", "v2", true).slides[0].textSource as any).sectionIds).toEqual(["v", "v2"]);
    expect((relinkSections(p, "v", "c", false).slides[0].textSource as any).sectionIds).toEqual(["c"]);
  });
});

describe("older workspaces", () => {
  it("the song pasted in the video studio becomes sections; slides keep what they showed; block lists become sections", () => {
    const ws = {
      v: 1, currentProjectId: "p", noRepeat: true, bags: {}, exportFormat: "jpg", zones: false, picPools: [],
      textPools: [{ id: "b", name: "Hook block", scope: "shared", kind: "block", text: "line 1\nline 2" }],
      projects: [proj({ lyrics: [], lyricsSectionId: null, songLyrics: "[Refrain]\nla\n\n[Couplet]\nun", slides: [slide({ kind: "lyrics" }), slide({ kind: "pool", poolId: "b" })] })],
    } as unknown as Workspace;
    const p = migrateLyrics(ws, label).projects[0];
    expect(p.lyrics.map((l) => l.name)).toEqual(["Refrain", "Couplet", "Hook block"]);
    expect((p.slides[0].textSource as any).sectionIds).toEqual([p.lyrics[0].id]);
    expect(p.slides[1].textSource).toEqual({ kind: "lyrics", sectionIds: [p.lyrics[2].id] });
    expect(migrateLyrics(migrateLyrics(ws, label), label).projects[0].lyrics).toHaveLength(3);
  });
});
