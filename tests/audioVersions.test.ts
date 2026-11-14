import { describe, expect, it } from "vitest";
import { audioIdOf, audioLabel, audioVersionsOf, mainAudioId, projectFor, renameAudio, videosOn, writeFor } from "../lib/audioVersions";
import type { Project } from "../lib/types";

const release = {
  id: "r", name: "R", slides: [], lyrics: [], generated: null, selectedSlide: 0,
  audioName: "demo.wav", audioSize: 10, lyricWords: [{ w: "a", s: 1, e: 2 }],
  audios: [{ id: "m", audioName: "Master final.wav", audioSize: 20, lyricWords: [{ w: "a", s: 3, e: 4 }] }],
  videos: [{ id: "v1", name: "1", audioId: "m" }, { id: "v2", name: "2" }, { id: "v3", name: "3", audioId: "gone" }],
} as unknown as Project;

describe("the versions of a release's audio", () => {
  it("the main one first (the project's own fields), then the others; a video on an unknown one plays the main", () => {
    expect(audioVersionsOf(release).map((a) => [a.id, audioLabel(a)])).toEqual([[mainAudioId(release), "demo"], ["m", "Master final"]]);
    expect(release.videos.map((v) => audioIdOf(release, v))).toEqual(["m", mainAudioId(release), mainAudioId(release)]);
    expect([videosOn(release, "m"), videosOn(release, mainAudioId(release))]).toEqual([1, 2]);
  });
  it("a video's view has its version's file and lyrics; a change goes back to that version only", () => {
    const view = projectFor(release, "m");
    expect([view.audioName, view.lyricWords?.[0].s]).toEqual(["Master final.wav", 3]);
    const out = writeFor(release, "m", (p) => ({ ...p, lyricWords: [{ w: "b", s: 5, e: 6 }], selectedSlide: 2 }));
    expect(out.lyricWords?.[0].s).toBe(1); // the main audio's lyrics untouched
    expect(out.audios?.[0].lyricWords?.[0].s).toBe(5);
    expect(out.audios?.[0].audioName).toBe("Master final.wav");
    expect(out.selectedSlide).toBe(2); // the rest of the release as changed
    expect(writeFor(release, mainAudioId(release), (p) => ({ ...p, lyricWords: [] })).lyricWords).toEqual([]);
  });
  it("renamed: the main one's name on the project, another's on it", () => {
    expect(renameAudio(release, mainAudioId(release), "Démo").audioLabel).toBe("Démo");
    expect(renameAudio(release, "m", " Master ").audios?.[0].label).toBe("Master");
  });
});
