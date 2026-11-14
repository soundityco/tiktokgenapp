/**
 * The audio versions of a release (a demo, the master, a sped up, an acoustic one…), kept side by side in the library;
 * each video plays on one of them (`VideoSettings.audioId`; none: the release's main audio).
 *
 * The main audio is where it always was: the project's own `audioName` / `audioSize` / `audioDriveId` and its lyrics
 * timing (`lyricWords`…), on the device under "audio:project:<id>". The others are `Project.audios`, each with the same
 * fields of its own, on the device under "audio:<its id>". `projectFor` shows a release as one of its versions (the
 * video studio works on the open video's), `writeFor` puts a change made on that view back where it belongs.
 */
import type { AudioVersion, Project, VideoSettings } from "./types";

/** What belongs to each version: its file and the lyrics placed on it. */
const KEYS = ["audioName", "audioSize", "audioDriveId", "lyricWords", "heardWords", "lyricsPlacedFrom", "lyricsAlignV"] as const;
type Own = Pick<Project, (typeof KEYS)[number]>;
const own = (x: Partial<Own>): Own => Object.fromEntries(KEYS.map((k) => [k, x[k]])) as Own;

/** The main version's id (its file is on the device under "audio:project:<id>", as before versions). */
export const mainAudioId = (p: Pick<Project, "id">) => `project:${p.id}`;
/** Where a version's file is kept on the device. */
export const audioKey = (id: string) => `audio:${id}`;

/** Every version of a release, the main one first (when it has a file); the main one's own fields are the project's. */
export function audioVersionsOf(p: Project): AudioVersion[] {
  const main: AudioVersion[] = p.audioName ? [{ id: mainAudioId(p), label: p.audioLabel, ...own(p) }] : [];
  return [...main, ...(p.audios ?? [])];
}

/** The version a video plays on (an unknown or removed one: the main audio). */
export function audioIdOf(p: Project, v: Pick<VideoSettings, "audioId"> | undefined): string {
  const id = v?.audioId;
  return id && p.audios?.some((a) => a.id === id) ? id : mainAudioId(p);
}

/** A version's name in the library: its own, else its file's (without the extension). */
export const audioLabel = (a: Pick<AudioVersion, "label" | "audioName">) => a.label || (a.audioName ?? "").replace(/\.[a-z0-9]{2,4}$/i, "");

/** The release as one of its versions: that version's file and lyrics timing in the project's own fields. */
export function projectFor(p: Project, audioId: string): Project {
  if (audioId === mainAudioId(p)) return p;
  const a = p.audios?.find((x) => x.id === audioId);
  return a ? { ...p, ...own(a) } : p;
}

/** A change made on `projectFor(p, audioId)`, put back: that version's fields to it, the main's left as they were. */
export function writeFor(p: Project, audioId: string, fn: (view: Project) => Project): Project {
  if (audioId === mainAudioId(p) || !p.audios?.some((x) => x.id === audioId)) return fn(p);
  const view = projectFor(p, audioId);
  const out = fn(view);
  if (out === view) return p;
  return { ...out, ...own(p), audios: (out.audios ?? []).map((a) => (a.id === audioId ? { ...a, ...own(out) } : a)) };
}

/** The videos of a release on each version (by version id). */
export function videosOn(p: Project, audioId: string): number {
  return (p.videos ?? []).filter((v) => audioIdOf(p, v) === audioId).length;
}

/** A version renamed (the main one's name is the project's `audioLabel`). */
export function renameAudio(p: Project, id: string, label: string): Project {
  const v = label.trim() || undefined;
  return id === mainAudioId(p) ? { ...p, audioLabel: v } : { ...p, audios: p.audios?.map((a) => (a.id === id ? { ...a, label: v } : a)) };
}
