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

export type TextSource = { kind: "none" } | { kind: "pool"; poolId: string } | { kind: "lyrics" };

export interface SlideCfg {
  id: string;
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
}

export interface GenSlide {
  text: string;
  picId: string | null;
  picName?: string;
}

export interface Project {
  id: string;
  name: string;
  slides: SlideCfg[];
  lyrics: LyricSection[];
  lyricsSectionId: string | null;
  generated: GenSlide[] | null;
  selectedSlide: number;
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
}
