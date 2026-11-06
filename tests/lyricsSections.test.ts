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
    expect(slideLyrics(proj(), { kind: "lyrics", sectionIds: ["c", "v"], header: "Paroles" })).toBe("Paroles\n\na\nb\n\nla la\nla");
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
  it("a slide retouched by hand keeps its text when the lyrics change", () => {
    const p = proj({ slides: [slide({ kind: "lyrics", sectionIds: ["v"] })], generated: [{ text: "a\n\nb (my layout)", picId: null, edited: true }] });
    expect(refreshLyricSlides({ ...p, lyrics: [{ id: "v", name: "Verse", text: "changed" }] }).generated?.[0].text).toBe("a\n\nb (my layout)");
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
  it("runs once: sections deleted later do not come back from the video studio's song", () => {
    const ws = { v: 1, currentProjectId: "p", textPools: [], picPools: [], projects: [proj({ lyrics: [], songLyrics: "[Refrain]\nla" })] } as unknown as Workspace;
    const once = migrateLyrics(ws, label);
    expect(once.projects[0].lyrics).toHaveLength(1);
    const cleared = { ...once, projects: [{ ...once.projects[0], lyrics: [] }] };
    expect(migrateLyrics(cleared, label).projects[0].lyrics).toHaveLength(0);
  });
});

describe("part names written alone on their line", () => {
  const song = `Couplet
J’ai arrêté d’être triste
J’ai chassé mes angoisses

Pré-refrain
Des années à subir

Refrain
J’ai compris ce que je ne voulais plus dans ma vie
Jusqu’ici

Couplet 2
Tu me disais d'être plus

Pré-refrain 2
Des années à souffrir


Refrain 2
J’ai compris
(yeah)

Pont
Oh non vraiment là c’est fini

Refrain 3
Maintenant que tu sais

Outro
Regarde nous en vie`;
  it("are found, in French and English, with their numbers", () => {
    const parts = splitSong(song, label);
    expect(parts.map((p) => p.name)).toEqual(["Couplet", "Pré-refrain", "Refrain", "Couplet 2", "Pré-refrain 2", "Refrain 2", "Pont", "Refrain 3", "Outro"]);
    expect(parts[0].text).toBe("J’ai arrêté d’être triste\nJ’ai chassé mes angoisses");
    expect(parts[5].text).toBe("J’ai compris\n(yeah)");
  });
  it("other ways people write them", () => {
    expect(splitSong("[Verse 1: Artist]\na\nPre-Chorus:\nb\nCHORUS x2\nc\n(Bridge)\nd", label).map((p) => p.name)).toEqual(["Verse 1: Artist", "Pre-Chorus", "CHORUS x2", "Bridge"]);
  });
  it("no names: the block sung again is the chorus", () => {
    expect(splitSong("one\ntwo\n\nla la\nla\n\nthree\n\nla la\nla", label, "Refrain").map((p) => p.name)).toEqual(["Part 1", "Refrain", "Part 2", "Refrain"]);
  });
});
