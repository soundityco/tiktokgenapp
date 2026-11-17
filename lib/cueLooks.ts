import type { Cue } from "./lyricsAlign";
import type { LyricWord, TextStyle } from "./types";

/**
 * A caption's own look (custom subtitles): one word (word by word) or one phrase (phrase by phrase) given its own
 * style or place, over the lyrics' style (the "master"). Kept in the video's settings (VideoSettings.captionLooks),
 * by a key that survives a new placing of the lyrics: the word's written line and its place in that line.
 */
export type CueLook = Partial<TextStyle>;

/** Each word's key: "<line>.<n>" (its n-th word in its written line), else its time ("t<tenths>": words heard with no
 *  written line). */
export function wordKeys(words: LyricWord[]): Map<LyricWord, string> {
  const keys = new Map<LyricWord, string>();
  const seen = new Map<number, number>();
  for (const w of words) {
    if (w.line == null) { keys.set(w, `t${Math.round(w.s * 10)}`); continue; }
    const n = seen.get(w.line) ?? 0;
    seen.set(w.line, n + 1);
    keys.set(w, `${w.line}.${n}`);
  }
  return keys;
}

/** A caption's key: its mode and its first word's key (a word and the phrase it starts are two different captions). */
export function cueKey(cue: Cue, mode: "phrase" | "word", keys: Map<LyricWord, string>): string | null {
  // (word by word, the caption holds a copy of the word with its own timing: `src` is the word itself)
  const first = (cue.words[0] as (LyricWord & { src?: LyricWord }) | undefined)?.src ?? cue.words[0];
  if (!first) return null;
  return `${mode}:${keys.get(first) ?? (first.line == null ? `t${Math.round(first.s * 10)}` : `${first.line}.?${first.w}`)}`;
}

/** The style a caption is drawn with: the lyrics' style, its own look over it. */
export const cueStyle = (base: TextStyle, look: CueLook | undefined): TextStyle => (look ? { ...base, ...look } : base);

/** What `next` changes from `base` (a caption's own look: only what differs from the lyrics' style). */
export function styleDiff(base: TextStyle, next: TextStyle): CueLook {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(next) as (keyof TextStyle)[]) if (next[k] !== base[k]) out[k] = next[k];
  // A field the base has and the next one dropped (a Google font removed…): kept as undefined, so it is dropped too.
  for (const k of Object.keys(base) as (keyof TextStyle)[]) if (!(k in next)) out[k] = undefined;
  return out as CueLook;
}
