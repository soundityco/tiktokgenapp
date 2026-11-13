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
  /** Font file loaded by the user (see lib/fonts.ts). Overrides `font` and `googleFont` when set. */
  customFont?: string;
  /** Google font family (see lib/googleFonts.ts). Overrides `font` when set. */
  googleFont?: string;
  /** Weight of the Google font (default 400). */
  weight?: number;
  /** Italic (Google font, or a loaded family that has an italic file). */
  italic?: boolean;
  /** Width of a loaded family that has condensed / expanded files (CSS font-stretch keyword). */
  stretch?: string;
  look: "outline" | "box" | "shadow" | "plain";
  /** "sentence": lower case with a capital at the start of each line. */
  case: "asis" | "upper" | "lower" | "sentence";
  /** Outline thickness, % of the text size (default 20). Drawn outside the letters. */
  stroke?: number;
  /** Space added between the letters, % of the text size (default 0; negative: tighter). */
  tracking?: number;
  /** Shadow mode: blur, % of the text size (default 35). */
  shadowBlur?: number;
  /** Shadow mode: offset right (+) / left (−) and down (+) / up (−), % of the text size (default 0 and 5). */
  shadowX?: number;
  shadowY?: number;
  /** Shadow mode: opacity 0-100 (default 100). */
  shadowOpacity?: number;
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
  /** Photo edits (carousel), each -100 to 100 (vignette and grain 0 to 100); none: the photo as it is. */
  adjust?: PhotoAdjust;
}

/** A photo's own edits, kept for when it comes back on a slide (its framing only for the same format). */
export interface PicEdit { adjust?: PhotoAdjust; zoom: number; ox: number; oy: number; format: string }

export interface PhotoAdjust {
  exposure?: number;
  contrast?: number;
  saturation?: number;
  temperature?: number;
  vignette?: number;
  grain?: number;
}

/**
 * A lyrics slide shows the sections of the release ticked for it (`sectionIds`, in the song's order), under an
 * optional header. Older slides: `sectionId` (one section), or none (the release's default / first section).
 */
export type TextSource =
  | { kind: "none" }
  | { kind: "pool"; poolId: string; /** Only the texts of this theme of the list (see lib/themes). */ theme?: string;
      /** Only the texts with one of these tags (replaces `theme`, see lib/generate poolTags). */ tags?: string[] }
  | { kind: "lyrics"; sectionId?: string; sectionIds?: string[]; header?: string };

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
  /** Its role. hooks: the opening line of a post (slide 1, the videos), one per line; texts: the other slides'
   *  texts (transitions…), one per line; captions: post captions with their hashtags; block (old): the whole text
   *  on one slide. The video studio only shows hooks and captions. */
  kind: "hooks" | "texts" | "block" | "captions";
  text: string;
  /** Theme of a text set by hand (hookKey of the text -> theme id, "group:<word>", a name typed, or "" other). The others are found by lib/themes. */
  themes?: Record<string, string>;
  /** Themes found by the local model (public/themes/worker.js), by hookKey; "" = no theme. Hand-set ones win. */
  aiThemes?: Record<string, string>;
  /** Tags of a text set by hand (hookKey -> tags). A text without its own tags has one: its theme (lib/generate poolTags). */
  tags?: Record<string, string[]>;
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
  /** Starts a caption cut by hand (its own `line`): the cut stays when the lyrics are placed again. */
  split?: boolean;
  /** Word-by-word captions only: the timing retouched by hand there (start, end, leaves the screen). The phrases
   *  keep s / e / until: a word retouched alone never moves its phrase. */
  ws?: number;
  we?: number;
  wu?: number;
}

export interface GenSlide {
  text: string;
  /** Text retouched on the slide (line breaks, cuts…): a copy, it no longer follows the release's lyrics. */
  edited?: boolean;
  /** The lyrics retouched on this slide, kept aside while it shows another source (they come back with the lyrics). */
  lyricsDraft?: string;
  picId: string | null;
  picName?: string;
  /** Photo found on the web: who took it and its licence (CC BY: credit them in the post caption). */
  picCredit?: { author: string; license: string; page: string; required: boolean };
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
/** One version of a video (see VideoSettings.versions): the values of its own fields. */
export interface VideoVersion {
  id: string;
  name?: string;
  v: Partial<VideoSettings>;
  /** It holds its own framing, format and grade too (older versions: only the segment and the texts, the rest
   *  the video's). */
  all?: boolean;
}

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
  /** Taken from a hook list: the line it came from, so an edit of that line in the list follows here. */
  link?: { pool: string; line: number; text: string; count: number };
  /** The hook list it is drawn from (none: the video's, by default slide 1's). */
  pool?: string;
  /** Only the texts with one of these tags ([] = all; none: the video's tags). */
  tags?: string[];
}

/** Colour grade of a camera clip (see lib/grade.ts). Sliders are applied in linear light / DaVinci Intermediate. */
export interface VideoGrade {
  /** Standard SDR video: the camera profile and the LUT were turned back on by hand (off by default). */
  sdrOverride?: boolean;
  /** How the camera recorded the colours: converted to DaVinci Wide Gamut / Intermediate first. */
  profile: "slog3-cine" | "slog3" | "rec709" | "applelog" | "hlg" | "pq" | "none";
  /** Look LUT made in DaVinci (input DWG / Intermediate), kept on this device (IndexedDB "lut:<id>"). */
  lut?: { id: string; name: string; /** Copy in the user's Drive: any browser or device gets it from there. */ driveId?: string };
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
  /** Only the hooks of this theme of the hook list (see lib/themes). */
  hookTheme?: string;
  /** Only the hooks with one of these tags (replaces `hookTheme`). */
  hookTags?: string[];
  /** Text of the TikTok post (caption and hashtags), and the captions list it is drawn from. */
  caption?: string;
  captionPoolId?: string;
  audioName?: string;
  videoName?: string;
  /** Size in bytes of the camera file: picking the same file again (another browser) keeps the sync. */
  videoSize?: number;
  /** What the camera file is (read at import). */
  source?: VideoSourceInfo;
  /** The camera file kept in the user's Google Drive, to open the clip on another device. */
  drive?: {
    originalId?: string;
    /** The working copy on the Drive (lib/convert makeWorkCopy): the take's own clock from 0 to `to`, real pictures
     *  from `from`; made from the camera file of `of` bytes. The other devices work on it, the one with the
     *  camera file exports from the camera file. */
    copy?: { id: string; from: number; to: number; of: number; size: number; tenBit: boolean };
  };
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
  /** Filmed through an anamorphic lens: the picture is drawn this many times wider (1.33, 1.5…). The lens goes with
   *  the camera file, so it is the video's, not a version's. None: a normal lens. */
  desqueeze?: number;
  /** Shape of the exported video: vertical 1080×1920 (default) or horizontal 1920×1080. */
  format?: "9:16" | "16:9";
  /** Audio and video locked together: the offset does not move and the segment stays inside the synced video. */
  linked?: boolean;
  /** Versions of this video to compare (A/B): each keeps every choice of the post (segment, hooks, lyrics, post
   *  text, their styles, framing, format, grade); only the camera file and what depends on it (sync, takes, the
   *  camera profile of the grade) are the video's. The one shown lives in the fields above (`activeVersion`). */
  versions?: VideoVersion[];
  activeVersion?: string;
  /** Burn the timed lyrics on the video. */
  captions: boolean;
  /** How the generated lyrics are cut into captions: one word at a time or one phrase at a time. */
  captionMode?: "phrase" | "word";
  /** Word by word: each word at the time the model heard it, or spread over its phrase by syllables (lib/lyricsAlign). */
  wordTiming?: "ai" | "even";
  /** Longest line of a caption, in characters (smart line breaks happen before it is exceeded). */
  lineChars?: number;
  /** Own text style for the captions; falls back to the selected carousel slide's style. */
  captionStyle?: TextStyle;
  /** Progressive zoom over the segment: ×1 on the first frame, this factor on the last (e.g. 1.05). None: off. */
  push?: number;
  /** Colour grade of the camera picture. None: the picture as recorded. */
  grade?: VideoGrade;
  /** Hook list the titles are drawn from; none: the list of the first carousel slide of the release. */
  hookPoolId?: string;
  /** Titles over the video, one after the other or all along. */
  hooks?: VideoHook[];
  /** Show the hooks on the video (default yes). */
  showHooks?: boolean;
  /** Text style of the hooks; falls back to the caption style, placed at the top. */
  hookStyle?: TextStyle;
  frame: VideoFrame;
}

/** One clip made for a release: its own official-audio segment, camera take and sync. */
/** One carousel of a release (a release can have several; see lib/carousels.ts). */
export interface CarouselSetup {
  id: string;
  name: string;
  slides: SlideCfg[];
  generated: GenSlide[] | null;
  selectedSlide: number;
  /** Text of the TikTok post: caption and hashtags. */
  caption?: string;
  /** Captions list it is drawn from at each generation. */
  captionPoolId?: string;
}

export interface VideoSetup extends VideoSettings {
  id: string;
  name: string;
  /** Its files on the device (camera file, its picture) are those kept under this key: a duplicate reads the ones of
   *  the video it was made from (never copied: a camera file weighs gigabytes). None: its own id. */
  media?: string;
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
  /** Caption and hashtags of the open carousel's post, and the captions list it is drawn from. */
  caption?: string;
  captionPoolId?: string;
  /** The video studio's lyrics are the release's sections (songLyrics follows them; see linkLyrics). */
  lyricsLinked?: boolean;
  /** The sung text the video's lyrics were last placed from: when the sections change, they are placed again. */
  lyricsPlacedFrom?: string;
  /** Version of the way the lyrics are placed on the audio they were last placed with (placed again once when it changes). */
  lyricsAlignV?: number;
  /** The lyrics were brought to their one place (lib/lyricsSections migrateLyrics): done once, never again. */
  lyricsV2?: boolean;
  /** Every carousel of the release (the open one is in the fields above). */
  carousels?: CarouselSetup[];
  /** Carousel currently open. */
  carouselId?: string;
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
  /** The text lists got their roles (hooks / texts / captions): done once, see normalizeWorkspace. */
  textRolesV1?: boolean;
  /** The photo lists once filled from the user's own Drive folders were copied into Rollout / Photos (once). */
  drivePhotosV1?: boolean;
  /** Every photo, audio and LUT taken from the user's own Drive was copied into Rollout, so the app can work with
   *  the `drive.file` permission alone (once). */
  driveFilesV1?: boolean;
  /** The edits made on each photo (by its id): a slide that gets the photo again gets them back. */
  picEdits?: Record<string, PicEdit>;
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
