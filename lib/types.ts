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
  look: "outline" | "box" | "shadow" | "plain";
  case: "asis" | "upper" | "lower";
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
}

export interface PicPool {
  id: string;
  name: string;
  scope: "shared" | "project";
  projectId?: string;
  pics: PicRef[];
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
}

export interface VideoSettings {
  audioName?: string;
  videoName?: string;
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
  /** Burn the timed lyrics on the video. */
  captions: boolean;
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
