export type FormatId = "9:16" | "3:4" | "4:5" | "1:1" | "orig";

export const FORMATS: Record<Exclude<FormatId, "orig">, [number, number]> = {
  "9:16": [1080, 1920],
  "3:4": [1080, 1440],
  "4:5": [1080, 1350],
  "1:1": [1080, 1080],
};

export type FontId =
  | "classic" | "bold" | "clean" | "heavy" | "condensed" | "impact" | "serif" | "serifItalic" | "typewriter";

export interface TextStyle {
  font: FontId;
  /** Font file loaded by the user (see lib/fonts.ts). Overrides `font` when set. */
  customFont?: string;
  look: "outline" | "box" | "shadow" | "plain";
  /** "sentence": lower case with a capital at the start of each line. */
  case: "asis" | "upper" | "lower" | "sentence";
  /** Outline thickness, % of the text size (default 20). Drawn outside the letters. */
  stroke?: number;
  /** Box mode: padding left and right of the text, % of the text size (default 30). */
  padX?: number;
  /** Box mode: extra padding above and below the text, % of the text size (default 0). */
  padY?: number;
  size: number; // px at 1080 wide
  width: number; // % of canvas width
  lineHeight: number; // multiplier
  align: "left" | "center" | "right";
  color: string;
  accent: string; // outline / box colour
  x: number; // % centre
  y: number; // % centre
}

export interface PicSettings {
  framing: "fill" | "fit";
  bars: "blur" | "black";
  zoom: number;
  darken: number; // 0-80 %
  ox: number; // offset, fraction of canvas width
  oy: number; // offset, fraction of canvas height
}

/** A lyrics slide uses the project's section by default, or its own section when `sectionId` is set. */
export type TextSource =
  | { kind: "none" }
  | { kind: "pool"; poolId: string }
  | { kind: "lyrics"; sectionId?: string };

export interface SlideCfg {
  id: string;
  /** Locked slides keep their generated text and photo when the carousel is regenerated. */
  locked?: boolean;
  format: FormatId;
  textSource: TextSource;
  picPoolId: string | null;
  pic: PicSettings;
  style: TextStyle;
}

export interface TextPool {
  id: string;
  name: string;
  scope: "shared" | "project";
  projectId?: string;
  kind: "hooks" | "block";
  text: string;
  /** hook (normalised) -> views. Reserved for the TikTok import (phase 2). */
  views?: Record<string, number>;
}

export interface PicRef {
  id: string; // Google Drive file id
  name: string;
  /** Linked Drive folder this photo came from (kept in sync with it). */
  folder?: string;
}

export interface PicPool {
  id: string;
  name: string;
  scope: "shared" | "project";
  projectId?: string;
  pics: PicRef[];
  /** Drive folders imported whole: new photos put in them are added to the list, deleted ones removed. */
  folders?: { id: string; name: string }[];
  /** Photos of a linked folder removed by hand, so the sync does not bring them back. */
  excluded?: string[];
}

export interface LyricSection {
  id: string;
  name: string;
  text: string;
  /** Reserved for phase 3 (video subtitles): start time in seconds. */
  start?: number;
  /**
   * Start of every line of `text` in the official audio (seconds), indexed like `text.split("\n")`.
   * `null` = not placed yet. Kept per section so it is reused by every video of the release.
   */
  times?: (number | null)[];
}

/** One sung word placed on the official audio (absolute seconds in the track). */
export interface LyricWord {
  w: string;
  s: number;
  e: number;
  /** Line of the lyrics text this word belongs to, when the words were aligned on written lyrics. */
  line?: number;
  /** Set by hand on the last word of a caption: when that caption leaves the screen (seconds in the audio). */
  until?: number;
  /** Retimed by hand: this timing wins over the automatic one, also when the lyrics are placed again. */
  manual?: boolean;
}

export interface GenSlide {
  text: string;
  picId: string | null;
  picName?: string;
}

/** Reusable text style, saved in the workspace and available in every project. */
export interface StylePreset {
  id: string;
  name: string;
  style: TextStyle;
}

export interface VideoFrame {
  zoom: number;
  ox: number; // fraction of the canvas
  oy: number;
  /** Same choices as the carousel photos: fill (crop) or fit with blurred / black bars. Default fill. */
  framing?: PicSettings["framing"];
  bars?: PicSettings["bars"];
}

/** One take found in the camera video: where its music plays and its own offset. */
export interface VideoTake {
  offset: number;
  musicStart: number;
  musicEnd: number;
}

/** A title shown over the video (the hook). Times in seconds from the start of the segment. */
export interface VideoHook {
  id: string;
  text: string;
  from: number;
  /** Leaves the screen at this time; none = until the end of the segment. */
  to?: number;
}

/** Colour grade of a camera clip (see lib/grade.ts). Sliders are applied in linear light / DaVinci Intermediate. */
export interface VideoGrade {
  /** How the camera recorded the colours: converted to DaVinci Wide Gamut / Intermediate first. */
  profile: "slog3-cine" | "slog3" | "rec709" | "applelog" | "hlg" | "pq" | "none";
  /** Look LUT made in DaVinci (input DWG / Intermediate), kept on this device (IndexedDB "lut:<id>"). */
  lut?: { id: string; name: string };
  /** Stops. */
  exposure: number;
  /** 1 = unchanged, around `pivot` (DaVinci Intermediate, default middle grey). */
  contrast: number;
  pivot?: number;
  /** -100 (cooler) to 100 (warmer). */
  temp: number;
  /** -100 (greener) to 100 (more magenta). */
  tint: number;
  /** 1 = unchanged. */
  sat: number;
  /** 0-100. */
  vignette: number;
  vignetteSize: number;
  /** 0-100. */
  grain: number;
  /** Grain size, 1-4. */
  grainSize: number;
}

/** What the imported camera / phone file is, read from its metadata (see lib/probe.ts). */
export interface VideoSourceInfo {
  kind: "camera" | "phone" | "unknown";
  /** "Sony ILME-FX30", "iPhone 15 Pro"… */
  device?: string;
  colour: "log" | "hdr" | "sdr" | "unknown";
  /** Camera profile to convert it with, when it is log or HDR. */
  profile?: VideoGrade["profile"];
  /** Human name of the recorded curve ("S-Log3 / S-Gamut3.Cine", "HDR HLG"…). */
  curve?: string;
  /** "H.264 4:2:2 10-bit"… */
  codec?: string;
  /** The browser cannot read it frame by frame: the export converts it with ffmpeg. */
  convert: boolean;
  /** Seconds, from the file's index. */
  duration?: number;
}

export interface VideoSettings {
  audioName?: string;
  videoName?: string;
  /** What the camera file is (read at import). */
  source?: VideoSourceInfo;
  /** The camera file kept in the user's Google Drive, to open the clip on another device. */
  drive?: { originalId?: string };
  /** Part of the official audio used by the post (seconds). The imported file itself is never trimmed. */
  crop: { start: number; duration: number };
  /** Official-audio time of the first video frame (video t=0). */
  offset: number;
  /** Confidence of the automatic sync, 0 to 1. */
  score?: number;
  /** Clip seconds where the music really plays, found by the automatic sync. */
  musicStart?: number;
  musicEnd?: number;
  /** How many spread-out excerpts of the official track agreed on the offset. */
  anchors?: number;
  /** When the video holds the passage several times: every take found by the sync (the user picks one). */
  takes?: VideoTake[];
  /** Shape of the exported video: vertical 1080×1920 (default) or horizontal 1920×1080. */
  format?: "9:16" | "16:9";
  /** Audio and video locked together: the offset does not move and the segment stays inside the synced video. */
  linked?: boolean;
  /** Burn the timed lyrics on the video. */
  captions: boolean;
  /** How the generated lyrics are cut into captions: one word at a time or one phrase at a time. */
  captionMode?: "phrase" | "word";
  /** Longest line of a caption, in characters (smart line breaks happen before it is exceeded). */
  lineChars?: number;
  /** Own text style for the captions; falls back to the selected carousel slide's style. */
  captionStyle?: TextStyle;
  /** Progressive zoom over the segment: ×1 on the first frame, this factor on the last (e.g. 1.05). None: off. */
  push?: number;
  /** Colour grade of the camera picture. None: the picture as recorded. */
  grade?: VideoGrade;
  /** Titles over the video, one after the other or all along. */
  hooks?: VideoHook[];
  /** Show the hooks on the video (default yes). */
  showHooks?: boolean;
  /** Text style of the hooks; falls back to the caption style, placed at the top. */
  hookStyle?: TextStyle;
  frame: VideoFrame;
}

/** One clip made for a release: its own official-audio segment, camera take and sync. */
export interface VideoSetup extends VideoSettings {
  id: string;
  name: string;
}

export interface Project {
  id: string;
  name: string;
  slides: SlideCfg[];
  lyrics: LyricSection[];
  lyricsSectionId: string | null;
  /** Words heard in the official audio, timed (from the lyrics generator of the video studio). */
  lyricWords?: LyricWord[];
  /** Raw words of the last analysis of the whole track: the written lyrics are re-placed on them without a new analysis. */
  heardWords?: LyricWord[];
  /** Full lyrics of the song pasted in the video studio, synced on the official audio. */
  songLyrics?: string;
  /** Name of the official audio of the release: one file per project, shared by all its videos (IndexedDB "audio:project:<id>"). */
  audioName?: string;
  /** Size in bytes of that file: importing the same file again keeps the lyrics timing. */
  audioSize?: number;
  /** Google Drive file of that audio, when picked from Drive: fetched again when this device lost its copy. */
  audioDriveId?: string;
  generated: GenSlide[] | null;
  selectedSlide: number;
  /** @deprecated Single video setup of older workspaces; migrated to `videos` on load. */
  video?: VideoSettings;
  /** One entry per clip made for this release (a release can have several camera takes). */
  videos: VideoSetup[];
  /** Clip currently open in the video studio. */
  videoId?: string;
}

export interface Workspace {
  v: 1;
  /** Revision stamped by the server on each save (see saveWorkspaceCas). */
  rev?: number;
  projects: Project[];
  currentProjectId: string;
  textPools: TextPool[];
  picPools: PicPool[];
  noRepeat: boolean;
  bags: Record<string, string[]>; // poolId -> items still available in the current shuffle bag
  exportFormat: "jpg" | "png";
  zones: boolean;
  /** Draw hooks in proportion to their TikTok views (hooks that have views stored). */
  favorTop?: boolean;
  /** Named text styles, reusable across projects. */
  presets?: StylePreset[];
}
