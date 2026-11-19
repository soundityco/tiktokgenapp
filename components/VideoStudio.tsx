"use client";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { defaultCaptionStyle, defaultVideo, uid } from "@/lib/defaults";
import { useT } from "@/lib/i18n";
import { isOff, joinAt, onWindows, pieceAt, splitAt as splitClip, togglePiece, wholeAgain, type ClipParts } from "@/lib/clipParts";
import { safeName, saveBlob, stamp } from "@/lib/files";
import { askPersistentStorage, delMedia, getMedia, putMedia } from "@/lib/idb";
import { DRIVE_PATHS, canWriteDrive, deleteDriveFile, downloadDriveFile, downloadDriveFileProgress, findInAppFolder, listAppFiles, trashDriveFile, uploadToDrive } from "@/lib/drive";
import { cueKey, cueStyle, styleDiff, wordKeys } from "@/lib/cueLooks";
import type { Cue } from "@/lib/lyricsAlign";
import { activeCue, alignLyrics, alignSong, buildCues, placeLine, setCueEnd, cleanHeard, clearWordTiming, hasManual, hasWordTiming, keepLocked, keepManual, lockedLines, lostCount, parseLyrics, repairOrder, respreadLost, joinCue, moveCueBy, moveCueEnd, moveCueStart, retimeCue, retimeWordCue, rewriteCue, splitCue, spreadOnHeard, tightenLineStarts } from "@/lib/lyricsAlign";
import { alignTracks, autoLineTimes, decodeAudio, envelopeOf, fmtLength, fmtTime, monoOf, peaksOf, syncAudio } from "@/lib/media";
import { coverage, remapClip, remapWords, sharedShare, trackMap, uniformShift, type RemapReport, type TrackMap } from "@/lib/audioRemap";
import { audioIdOf, audioKey, audioLabel, audioVersionsOf, mainAudioId, projectFor, renameAudio, videosOn, writeFor } from "@/lib/audioVersions";
import type { AudioVersion, GradePreset, LutRef, VideoExportPrefs, VideoGrade, VideoSourceInfo } from "@/lib/types";
import { askNotifyPermission, notify, notifyBlocked } from "@/lib/notify";
import { clamp, clampPic, drawFramed, drawHelpers, drawMatte, drawPictureAt, framedAt, snapPic, drawStyledText, litWords, TextBox, visibleRegion, zoomPic } from "@/lib/render";
import { buildGradeLut, convertsFootage, type CubeLut, drawLook, gradeKey, gradesColour, NEUTRAL_GRADE, parseCube, toCube } from "@/lib/grade";
import { PROBE_VERSION, probeVideo } from "@/lib/probe";
import { compareTexts, followLists, hookLink, poolTags, sourceTags, tagGroups, textItems } from "@/lib/generate";
import { copyRegion, Grader } from "@/lib/gradeGL";
import ColorGrade, { knownLuts, lastLut, rememberLut, sameLut } from "./ColorGrade";
import { AUDIO_KBPS, exportMp4, exportSettings, ExportStep, exportSampleRate, mp4Support, recommendedRate, seekVideo } from "@/lib/exportVideo";
import { DESQUEEZE, desqueeze, type Picture, VideoSource } from "@/lib/videoSource";
import { type Variant, videoVariants } from "@/lib/variants";
import { fastWorkCopy } from "@/lib/fastCopy";
import { gpuGradedSource, gpuGradeReason } from "@/lib/grade10";
import { camAt, cutTo, MAX_CAMS, moveCut, removeCutAt, setShotCam, shotsOf, splitAt } from "@/lib/multicam";
import { convertSegment, copyPlanFor, cropFor, ffmpegAlone, grabFrame, makeWorkCopy, type ConvertCrop, type ConvertStep } from "@/lib/convert";
import { ASR_MODELS, AsrModel, AsrStep, hasGpu, prepareAudio, stopTranscribe, transcribe } from "@/lib/transcribe";
import { alignEmissions, cachedEmissions, stopAlign } from "@/lib/alignAI";
import { faNorm, looksFrench } from "@/lib/forcedAlign";
import { LYRICS_LAP, LYRICS_WIN, inLines, placeByAlignment } from "@/lib/lyricsPipeline";
import { snapLines, voiceOnsets } from "@/lib/voiceOnsets";
import type { VideoOverlay } from "@/lib/types";
import type { LyricWord, PicSettings, Project, StylePreset, TextPool, TextStyle, VideoFrame, VideoHook, VideoSettings, VideoSetup, VideoTake, VideoVersion } from "@/lib/types";
import CaptionStyle from "./CaptionStyle";
import { presetNamed, presetOf, StylePresets, TextQuickMenu, withPreset } from "./TextControls";
import Icon from "./Icon";
import PostCaption from "./PostCaption";
import ShareDialog, { useHandheld } from "./ShareDialog";
import { linkLyrics, mergeSong, refreshLyricSlides, songOf, sungOf } from "@/lib/lyricsSections";
import { SourceButton, sourceSub, tagSummary, TagChips, TextPickList } from "./SourcePick";
import { ConfirmDialog, ContextMenu, Hint, MatteSelect, Menu, Modal, PromptDialog, Range, Section, Select, Switch } from "./ui";
import { createPortal } from "react-dom";
import { FullView } from "./FullView";
import { PHONE_QUERY, StyleTabs, usePhone, useStyleParts, type SheetPart } from "./StyleSheet";

const RATE = 25;
const PRESETS = [10, 15, 20, 30];
/** Longest stretch of a video listened to in real time when the browser cannot decode its audio (10 min). */
const MAX_CAPTURE = 600;
/** Above this, the camera file's sound is not decoded by the browser from the whole file in memory (ffmpeg reads it). */
const SYNC_DECODE_MAX = 400 * 1024 * 1024;

const DEFAULT_VIDEO: VideoSettings = defaultVideo();
/** Look LUTs already read on this page (id → LUT). */
const LOOKS = new Map<string, CubeLut>();
/** A multicam camera's look: its framing and grade (its LUT for the preview, 33 points). */
type AngleLook = { frame?: VideoSettings["frame"]; desqueeze?: VideoSettings["desqueeze"]; grade?: VideoGrade; lut: Float32Array | null;
  /** Its own black bars and progressive zoom (none: the project's, camera 1's; 0 / false: none for this camera). */
  matte?: number; push?: number; pushIn?: boolean;
  /** Its own sound's volume (the take's clipVolume), heard on its shots. */
  volume?: number };
/** A camera's own value, else the project's (camera 1's): an explicit 0 / false is "none" for that camera. */
const ownOr = <T,>(own: T | undefined, project: T | undefined) => (own !== undefined ? own : project);
/** A multicam camera: another video of the release, its file played by a hidden player. */
type Angle = AngleLook & { id: string; media: string; blob: Blob; el: HTMLVideoElement; url: string; offset: number; look: CubeLut | null;
  /** Its file here is its Drive working copy (the camera file is on another device). */
  fromCopy: boolean };

/** Clips of a release; old workspaces still carry a single `project.video`. */
/** A working copy on its way (shown in the top bar wherever the user is: see Studio). */
export interface CopyJob { step: "make" | "send"; p: number; clip: string; project: string; label: string }

function clipsOf(p: Project): VideoSetup[] {
  return p.videos?.length
    ? p.videos
    : [{ ...DEFAULT_VIDEO, id: p.id, name: "Video 1", ...(p.video ?? {}) }];
}

/** Export size for each shape of video. */
const OUT_SIZE = (f?: VideoSettings["format"]): [number, number] => (f === "16:9" ? [1920, 1080] : [1080, 1920]);
/** The grade's grain changes this many times a second (whatever the export's frame rate). */
const GRAIN_FPS = 30;
/** The video frame settings in the carousel's photo terms, so both are drawn by the same code. */
const picOf = (f: VideoFrame, matte?: number): PicSettings => ({ framing: f.framing ?? "fill", bars: f.bars ?? "blur", zoom: f.zoom, ox: f.ox, oy: f.oy, darken: 0 , matte });
const round2 = (n: number) => Math.round(n * 100) / 100;
/** The hook on screen at official time `time` (the first one when several overlap). */
/** The film icon (components/Icon.tsx), drawn on the waveform's video band. */
const FILM_PATH = typeof Path2D === "undefined" ? (undefined as unknown as Path2D) : new Path2D("M4 5h16v14H4zM8 5v14M16 5v14M4 9h4M4 15h4M16 9h4M16 15h4");
const hookAt = (cfg: VideoSettings, time: number): VideoHook | undefined => {
  const rel = time - cfg.crop.start;
  return cfg.hooks?.find((h) => h.text.trim() && rel >= h.from - 0.001 && rel < (h.to ?? cfg.crop.duration));
};


/** Fade of the sound when playback starts or stops (seconds): just enough to avoid a click, short enough not to eat
 *  the first or last syllable of a line (a video that starts right on the voice). The export has none. */
const FADE = 0.02;

/** Where the playhead was left on this video (this browser), if anywhere. */
const savedHead = (id: string): number | null => {
  try { const v = Number(localStorage.getItem(`tktgen-tl-head:${id}`)); return Number.isFinite(v) && v > 0 ? v : null; } catch { return null; }
};

/** The way the lyrics are placed on the audio: raised when it changes, so lyrics placed before are placed again once. */
// (4: a sign alone in the written lyrics, French spacing « revoir ? », goes with its word: the lyrics placed before
// it lost it; placed again once, retouches kept)
const LYRICS_ALIGN_V = 4;

/** What each version of a video keeps for itself: every choice of the post. The rest is the video's: the camera file
 *  and what depends on it (sync, takes, and the grade's camera profile, see `valuesOf`). */
/** The menu's progressive zooms (0: off); any other factor is a custom one. */
const PUSH_PRESETS = [0, 1.05, 1.1];
const VERSION_KEYS = ["crop", "offset", "clipIn", "clipOut", "splits", "offParts", "clipVolume", "videoHidden", "overlay", "overlays", "musicStart", "musicEnd", "linked", "push", "pushIn", "hooks", "hookTheme", "hookTags", "hookPoolId", "showHooks", "hookStyle",
  "captions", "captionMode", "litDim", "litSweep", "lineChars", "captionStyle", "captionLooks", "caption", "captionPoolId", "format", "frame", "grade", "matte", "angles", "cuts"] as const satisfies readonly (keyof VideoSettings)[];
/** Kept by a version only since versions hold everything (`VideoVersion.all`): an older one takes the video's. */
const LOOK_KEYS: readonly (keyof VideoSettings)[] = ["format", "frame", "grade", "matte"];
/** The part of the camera file shown (seconds in the file, `len` its length): trimmed on the video track, else all. */
const clipSpan = (s: Pick<VideoSettings, "clipIn" | "clipOut">, len: number): [number, number] => {
  const a = clamp(s.clipIn ?? 0, 0, Math.max(0, len));
  return [a, clamp(s.clipOut ?? len, a, Math.max(a, len))];
};
const versionOf = (s: VideoSettings): Partial<VideoSettings> => Object.fromEntries(VERSION_KEYS.map((k) => [k, s[k]]));


/**
 * Last resort when `decodeAudioData` refuses the container (typical of phone MOV/MP4):
 * play the video through the Web Audio graph, unmuted but wired only to a silent gain,
 * and keep the raw mono sound that comes out (the sync needs the real audio, not just its
 * loudness). Real time, so we stop after `maxSeconds`.
 */
async function capturePcm(
  url: string,
  maxSeconds: number,
  onProgress?: (p: number) => void,
  signal?: AbortSignal
): Promise<{ samples: Float32Array; rate: number }> {
  const ctx = new AudioContext();
  const v = document.createElement("video");
  v.src = url;
  v.preload = "auto";
  v.playsInline = true;
  v.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0";
  document.body.appendChild(v);

  const blocks: Float32Array[] = [];
  let total = maxSeconds;
  let samples = 0;
  let base = -1;
  let baseTime = 0;
  let lastPct = -1;
  let active = true;
  let guard = 0;
  let stall = 0;

  const src = ctx.createMediaElementSource(v);
  const proc = ctx.createScriptProcessor(1024, 1, 1);
  const silent = ctx.createGain();
  silent.gain.value = 0;
  src.connect(proc);
  proc.connect(silent);
  silent.connect(ctx.destination);

  let settle!: () => void;
  const finished = new Promise<void>((resolve) => { settle = resolve; });
  const done = () => {
    if (!active) return;
    active = false;
    window.clearTimeout(guard);
    window.clearTimeout(stall);
    settle();
  };

  proc.onaudioprocess = (e) => {
    if (!active) return;
    const buffer = e.inputBuffer;
    if (!buffer.numberOfChannels) return;
    const data = buffer.getChannelData(0);
    samples += data.length;
    // The graph runs before the video really starts: ignore that priming silence.
    if (base < 0) {
      if (v.currentTime <= 0) return;
      base = samples;
      baseTime = v.currentTime;
      window.clearTimeout(stall);
    }
    const t = baseTime + (samples - base) / ctx.sampleRate;
    blocks.push(new Float32Array(data)); // the buffer is reused by the browser: copy it
    const pct = Math.round(Math.min(1, t / total) * 100);
    if (pct !== lastPct) { lastPct = pct; onProgress?.(pct / 100); }
    if (t >= total) done();
  };
  v.onended = () => done();

  // Everything here runs before the first await, inside the click: unmuted playback is
  // gated by the autoplay policy, and muting the element would zero the samples before
  // they reach the graph. Starting both now is what makes the sync repeatable after a reload.
  v.addEventListener("loadedmetadata", () => {
    if (Number.isFinite(v.duration) && v.duration > 0) total = Math.min(v.duration, maxSeconds);
  }, { once: true });
  void ctx.resume().catch(() => {});
  // Never await play(): some browsers keep that promise pending while the element is
  // already playing and the samples are flowing, which froze the analysis at 100 %.
  void v.play().catch(() => {});
  guard = window.setTimeout(done, (maxSeconds + 10) * 1000);
  // If playback never starts (autoplay blocked, broken file), do not wait forever.
  stall = window.setTimeout(() => {
    if (base < 0) done();
  }, 12000);
  signal?.addEventListener("abort", done, { once: true });

  try {
    await finished;
    v.pause();
    const rate = ctx.sampleRate;
    const lead = Math.round(baseTime * rate); // playback rarely starts at exactly 0 s: keep the timeline true
    const len = Math.min(lead + blocks.reduce((n, b) => n + b.length, 0), Math.ceil(total * rate));
    const pcm = new Float32Array(len);
    let at = lead;
    let peak = 0;
    for (const b of blocks) {
      if (at >= len) break;
      const take = Math.min(b.length, len - at);
      pcm.set(take === b.length ? b : b.subarray(0, take), at);
      for (let i = 0; i < take; i++) peak = Math.max(peak, Math.abs(b[i]));
      at += take;
    }
    if (peak < 1e-4) throw new Error("silent");
    onProgress?.(1);
    return { samples: pcm, rate };
  } finally {
    active = false;
    v.pause();
    v.removeAttribute("src");
    v.load();
    v.remove();
    ctx.close().catch(() => {});
  }
}

/**
 * Frames of a hidden player, played in real time from `start` (video seconds). For formats the
 * browser plays but cannot decode frame by frame (4:2:2 10-bit from pro cameras): seeking every frame
 * made its decoder give up, a normal playback does not. The export then takes the clip's own length.
 */
function playerFrames(el: HTMLVideoElement, start: number) {
  let latest = -1;
  let wake: (() => void) | null = null;
  let running = true;
  // Rendered (tiny, invisible) so the browser really presents the frames.
  el.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:.01;pointer-events:none;z-index:-1";
  document.body.appendChild(el);
  const watch = () => {
    if (!running) return;
    if ("requestVideoFrameCallback" in el) {
      el.requestVideoFrameCallback((_now, meta) => { latest = meta.mediaTime; wake?.(); watch(); });
    } else {
      requestAnimationFrame(() => { latest = (el as HTMLVideoElement).currentTime; wake?.(); watch(); });
    }
  };
  const begin = seekVideo(el, start).then(() => { watch(); return el.play().catch(() => {}); });
  return {
    /**
     * Wait until the player shows the frame at `target` (or a later one). When it cannot keep up
     * (heavy formats decoded in software), it plays slower: taking a late frame instead gave a slow-motion look.
     */
    async frameAt(target: number) {
      await begin;
      const start = performance.now();
      let slowed = false;
      while (running && latest < target - 1 / 120 && !el.ended) {
        await new Promise<void>((r) => { wake = () => { wake = null; r(); }; setTimeout(r, 250); });
        const waited = performance.now() - start;
        if (!slowed && waited > 500 && el.playbackRate > 0.125) { el.playbackRate /= 2; slowed = true; }
        if (el.paused && !document.hidden) void el.play().catch(() => {});
        if (waited > 20000) break; // the player is stuck: the frozen-picture check stops the export
      }
    },
    stop() {
      running = false;
      el.pause();
      el.remove();
    },
  };
}

/** The export stopped because the hidden player kept showing the same picture. */
class FrozenVideo extends Error {
  constructor(readonly at: number) { super("frozen"); }
}

let printCanvas: HTMLCanvasElement | null = null;
/** Tiny 16×16 copy of a picture: two different frames of a camera video never give the same one (sensor noise). */
function fingerprint(src: CanvasImageSource): string {
  const c = (printCanvas ??= Object.assign(document.createElement("canvas"), { width: 16, height: 16 }));
  const g = c.getContext("2d", { willReadFrequently: true });
  if (!g) return "";
  g.drawImage(src, 0, 0, 16, 16);
  const d = g.getImageData(0, 0, 16, 16).data;
  let h = 0;
  for (let i = 0; i < d.length; i++) h = (h * 31 + d[i]) | 0;
  return String(h);
}

/** Resolves once the video knows its metadata, so a seek is not silently dropped. */
function whenReady(el: HTMLVideoElement, wait = 3000): Promise<void> {
  if (el.readyState >= 1) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { el.removeEventListener("loadedmetadata", done); resolve(); };
    el.addEventListener("loadedmetadata", done);
    window.setTimeout(done, wait);
  });
}

/**
 * Video studio: import the official audio of the release, import the playback video,
 * find where the camera recording sits in the official track, trim the segment, place the
 * lyrics once, then export a vertical clip with the official audio and the lyrics burned in.
 */
/** The dock's film strips already made (file, passage): coming back to a page shows them at once. */
const STRIPS = new Map<string, string[]>();

/** Minutes and seconds, no tenths (the dock's player). */
const mmss = (x: number) => { const v = Math.max(0, Math.floor(x)); return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`; };

/** The parts of the video's style, as a phone opens them. */
type VPart = "framing" | "lyrics" | "hook" | "color" | "export";

export default function VideoStudio({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  project: release,
  hookPools,
  onDrawHook,
  onProject: onRelease,
  audioUsedElsewhere,
  onSaveNow,
  releaseTitle,
  library,
  libraryPhone,
  lyricsRow,
  onCopyJob,
  onToast,
  onVariants,
  playReturn = true,
  active = true,
  stylePage = false,
  libraryPage = false,
  captionPools,
  onDrawCaption,
  onNewCaptionList,
  onEditLyrics,
  fonts,
  onFonts,
  presets,
  onSavePreset,
  onDeletePreset,
  exportPrefs,
  onExportPrefs,
  gradePresets,
  onGradePresets,
  lutLibrary,
  onLutLibrary,
  onRemoveLut,
}: {
  /** History of the workspace, shared with the carousel. */
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  project: Project;
  /** Hook lists of the release (the same as the carousel's). */
  hookPools: TextPool[];
  /** Draw a hook from a list (shared shuffle bag with the carousel); `exclude`: hooks already on this video. */
  onDrawHook: (poolId: string, exclude: string[], tags?: string[], notTags?: string[]) => string | null;
  onProject: (fn: (p: Project) => Project) => void;
  /** Another release uses this Drive file as its official audio (it is then kept when this one is replaced). */
  audioUsedElsewhere?: (driveId: string) => boolean;
  onSaveNow: () => void;
  /** The release's name, and the menu to change it: the title of both studios. */
  releaseTitle: ReactNode;
  /** A working copy on its way, or done (null): the shell shows it wherever the user is. */
  onCopyJob?: (job: CopyJob | null) => void;
  /** A short message, wherever the user is (the copy is done, or failed). */
  onToast?: (msg: string) => void;
  /** After an export: the hooks retouched into texts their list does not have (see lib/variants), to offer keeping. */
  onVariants?: (list: Variant[]) => void;
  /** A pause puts the playhead back where play started (the app's setting, on unless turned off). */
  playReturn?: boolean;
  /** The library's shared part (the text lists, the same as the carousel's), under the release's files. */
  library?: ReactNode;
  /** The same on a phone, where the library holds everything of the release (the carousel's lists too). */
  libraryPhone?: ReactNode;
  /** The release's lyrics, as a row of the library (next to the official audio). */
  lyricsRow?: ReactNode;
  /** Shown (the video studio is kept mounted, hidden, while the carousel is open). */
  active?: boolean;
  /** The phone's Style page is open: the preview, then the style part by part. */
  stylePage?: boolean;
  /** The phone's Library page is open: no player on the dock there (nothing to watch). */
  libraryPage?: boolean;
  /** The captions lists of the release, and drawing one of their captions for this video's post. */
  captionPools: TextPool[];
  onDrawCaption: (poolId: string | undefined, current: string | undefined, apply: (text: string) => void) => void;
  onNewCaptionList: () => void;
  /** Opens the release's lyrics (the same editor as the carousel's). */
  onEditLyrics: () => void;
  /** Fonts loaded by the user, shared with the carousel. */
  fonts: string[];
  onFonts: (names: string[]) => void;
  presets: StylePreset[];
  onSavePreset: (name: string, style: TextStyle) => void;
  onDeletePreset: (id: string) => void;
  /** The account's export settings (the recommended ones unless turned on), and changing them. */
  exportPrefs?: VideoExportPrefs;
  onExportPrefs?: (p: VideoExportPrefs) => void;
  /** The account's colour presets, and changing them. */
  gradePresets?: GradePreset[];
  onGradePresets?: (list: GradePreset[]) => void;
  /** The account's LUTs, and changing them (`silent`: no undo step, for what the app does by itself). */
  lutLibrary?: LutRef[];
  onLutLibrary?: (fn: (list: LutRef[]) => LutRef[], silent?: boolean) => void;
  /** A LUT deleted from the account (asked first, by the shell: every release may use it). */
  onRemoveLut?: (lut: LutRef) => void;
}) {
  const { t, lang } = useT();
  // The release as the open video's audio version (lib/audioVersions): its file and its lyrics timing in the project's
  // own fields, so everything below works on that version; a change goes back where it belongs.
  const releaseRef = useRef(release);
  releaseRef.current = release;
  const exportPrefsRef = useRef(exportPrefs);
  exportPrefsRef.current = exportPrefs;
  const lutLibraryRef = useRef(lutLibrary);
  lutLibraryRef.current = lutLibrary;
  const versionClip = useMemo(() => { const l = clipsOf(release); return l.find((c) => c.id === release.videoId && !c.takeOnly) ?? l.find((c) => !c.takeOnly) ?? l[0]; }, [release]);
  const audioId = audioIdOf(release, versionClip);
  const project = useMemo(() => projectFor(release, audioId), [release, audioId]);
  const onProject = useCallback((fn: (p: Project) => Project) => onRelease((p) => {
    const l = clipsOf(p), c = l.find((x) => x.id === p.videoId && !x.takeOnly) ?? l.find((x) => !x.takeOnly) ?? l[0];
    return writeFor(p, audioIdOf(p, c), fn);
  }), [onRelease]);
  const clips = useMemo(() => clipsOf(project), [project.videos, project.video, project.id]);
  const clip = clips.find((c) => c.id === project.videoId && !c.takeOnly) ?? clips.find((c) => !c.takeOnly) ?? clips[0];
  /** The release's projects (posts): its videos, the takes only imported for the library apart. */
  const projects = useMemo(() => clips.filter((c) => !c.takeOnly), [clips]);
  // Repair: a project without any camera file of its own cannot hold other videos (an older "+" copied the open video,
  // its cameras and videos over it included: listed in its takes, nothing on its timeline). They stay takes of the release.
  useEffect(() => {
    const bad = projects.filter((c) => !c.videoName && !c.media && ((c.angles ?? []).some(Boolean) || !!c.overlays?.length || !!c.overlay));
    if (!bad.length) return;
    const ids = new Set(bad.map((c) => c.id));
    onProject((p) => ({ ...p, videos: clipsOf(p).map((c) => (ids.has(c.id) ? { ...c, angles: undefined, cuts: undefined, overlays: undefined, overlay: undefined } : c)) }));
  }, [projects]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Multicam: a take put on the paused preview from the library ("main" = camera 1); playing gives it back to the cuts. */
  const [pinCam, setPinCam] = useState<string | null>(null);
  const pinRef = useRef(pinCam);
  pinRef.current = pinCam;
  useEffect(() => { drawAtRef.current?.(headRef.current); }, [pinCam]); // eslint-disable-line react-hooks/exhaustive-deps
  const drawAtRef = useRef<((t: number) => void) | null>(null);
  const settings = useMemo<VideoSettings>(() => ({ ...DEFAULT_VIDEO, ...clip }), [clip]);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const clipIdRef = useRef(clip.id);
  clipIdRef.current = clip.id;

  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [videoBlob, setVideoBlob] = useState<Blob | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const videoUrlRef = useRef(videoUrl);
  videoUrlRef.current = videoUrl;
  /** The clip the camera file in the player belongs to: right after a switch the old file is still loaded. */
  const fileClip = useRef<string | null>(null);
  /** The video open right now (an async job checks it is still the one before showing its file). */
  const openClip = useRef<string | null>(null);
  openClip.current = clip.id;
  /** The browser opened the camera file (it can play it): until then the timeline shows it is loading. */
  const [playerReady, setPlayerReady] = useState(false);
  /** The user let the app create files in their Drive (null: not known yet). */
  const [driveWrite, setDriveWrite] = useState<boolean | null>(null);
  /** Transfer with Drive in progress. */
  const [driveJob, setDriveJob] = useState<null | { kind: "fetch"; p: number }>(null);
  /** The video open here is the Drive working copy (the camera file is on another device). */
  const [onCopy, setOnCopy] = useState(false);
  /** The working copy being made, then sent to the Drive. */
  const [copyJob, setCopyJob] = useState<null | CopyJob>(null);
  const copyAc = useRef<AbortController | null>(null);
  /** The video whose copy is on its way (only that video's changes stop it). */
  const copyClip = useRef<string | null>(null);
  const stopCopyOf = (id: string) => { if (copyClip.current === id) copyAc.current?.abort(); };
  const copyFailed = useRef<string | null>(null);
  /** The copy of the open video will be made again in a few seconds (its passage changed). */
  /** When the copy of the open video will be made again (its passage went past it): a countdown, "now" skips it. */
  const [copyDueAt, setCopyDueAt] = useState<number | null>(null);
  const dueTimer = useRef<number | null>(null);
  /** The passage was just changed and the copy already holds it: said for a moment. */
  const [copyFits, setCopyFits] = useState(false);
  /** The last copy of the open video failed (a click tries again). */
  const [copyErr, setCopyErr] = useState<string | null>(null);
  /** How long the last copy took on this device (shown under its status until the page is reloaded). */
  const [copyTook, setCopyTook] = useState<{ clip: string; text: string } | null>(null);
  const [, tick] = useState(0);
  /** Drive id of the copy open here: another one in the data (made again elsewhere, longer) is fetched instead. */
  const copyShown = useRef<string | null>(null);
  const [driveErr, setDriveErr] = useState<string | null>(null);
  const driveAc = useRef<AbortController | null>(null);
  const [audioBuf, setAudioBuf] = useState<AudioBuffer | null>(null);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [videoDur, setVideoDur] = useState(0);
  const videoDurRef = useRef(videoDur);
  videoDurRef.current = videoDur;
  const [head, setHead] = useState(settings.crop.start);
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false);
  playingRef.current = playing;
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncPct, setSyncPct] = useState(0);
  const [exporting, setExporting] = useState(false);
  /** The clip whose files were read from the device (its camera file found or not): a batch export waits for it. */
  const [loadedClip, setLoadedClip] = useState<string | null>(null);
  /** Exporting every video of the release, one after the other (see the batch runner below). */
  const [batch, setBatch] = useState<null | { ids: string[]; i: number; res: Record<string, "done" | "failed" | "skipped">; back: string }>(null);
  const batchBusy = useRef(false);
  /** The videos just exported (with their caption): "Send to my phone" sends them without exporting again. */
  const lastFiles = useRef<{ name: string; blob: Blob; caption?: string }[]>([]);
  const [shareOpen, setShareOpen] = useState(false);
  const handheld = useHandheld();
  /** Why the colour grade could not run on the graphics card (the export then converts with ffmpeg, slower). */
  const [gpuWhy, setGpuWhy] = useState("");
  /** Export window: progress 0-1 and current step ("record" = realtime fallback). */
  const [exp, setExpRaw] = useState<null | { p: number; step: ExportStep | ConvertStep | "record"; done?: boolean; file?: string }>(null);
  /** Progress updates only when the whole percentage or the step changes: no re-render per frame. */
  const setExp = useCallback((next: null | { p: number; step: ExportStep | ConvertStep | "record"; done?: boolean; file?: string }) => {
    setExpRaw((cur) => (cur && next && !next.done && cur.step === next.step && Math.floor(cur.p * 100) === Math.floor(next.p * 100) ? cur : next));
  }, []);
  const exportRef = useRef<AbortController | null>(null);
  /** Last converted segment (pro camera formats), reused when the same segment is exported again. */
  const proxyRef = useRef<{ key: string; blob: Blob } | null>(null);
  /** How the export gets the camera frames: decoded from the file, or read from a hidden player (needs the tab visible). */
  const [expMode, setExpMode] = useState<null | { direct: boolean; detail: string }>(null);
  const [expPaused, setExpPaused] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [sectionId, setSectionId] = useState(project.lyricsSectionId ?? project.lyrics[0]?.id ?? "");
  const [genBusy, setGenBusy] = useState(false);
  const [genStep, setGenStep] = useState<AsrStep | null>(null);
  const [genPct, setGenPct] = useState(0);
  const [genDone, setGenDone] = useState(0);
  const [genInfo, setGenInfo] = useState<string | null>(null);
  const [model, setModel] = useState<AsrModel>("base");
  // With a graphics card, the very precise model by default (it hears singing over a mix; downloaded once).
  useEffect(() => { if (hasGpu()) setModel((m) => (m === "base" ? "turbo" : m)); }, []);
  /** When the voice starts in the official audio (its attacks): each lyrics line is put on the one it is sung on. */
  const onsetsRef = useRef<number[]>([]);
  const [language, setLanguage] = useState(lang === "fr" ? "french" : "auto");
  /**
   * Written lyrics the heard words are placed on: "song" (the lyrics pasted in the video studio),
   * "all" (every section of the carousel lyrics), a section id, or "none".
   */
  const [writtenSrc, setWrittenSrc] = useState(project.lyricsLinked || project.songLyrics?.trim() || !project.lyrics.length ? "song" : "all");
  const pasteRef = useRef<HTMLTextAreaElement>(null);
  const [paste, setPaste] = useState(project.songLyrics ?? "");
  /** The pasted text, unfolded (it folds into one line once the lyrics are placed). */
  const [pasteOpen, setPasteOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  /** The audio version being renamed (its id). */
  const [renamingAudio, setRenamingAudio] = useState<string | null>(null);
  /** One official audio per release, shared by all its videos. */
  const projectAudioKey = audioKey(audioId);
  // Another release (the studio stays mounted behind the carousel): its own lyrics, its own source of lyrics,
  // and an export of all the videos of the previous one stops.
  useEffect(() => {
    setPaste(project.songLyrics ?? "");
    setConfirmRemove(false);
    setPinCam(null);
    setWrittenSrc(project.lyricsLinked || project.songLyrics?.trim() || !project.lyrics.length ? "song" : "all");
  }, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const pasted = useMemo(() => {
    const r = parseLyrics(paste);
    return { parts: r.parts, lines: r.text ? r.text.split("\n").length : 0 };
  }, [paste]);
  const genRef = useRef<AbortController | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const waveRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const fadeRef = useRef<GainNode | null>(null);
  /** The song muted in the studio (the eye-like button by the waveform): heard nowhere here, still in the export. */
  const [musicMuted, setMusicMuted] = useState(() => { try { return localStorage.getItem("tktgen-music-muted") === "1"; } catch { return false; } });
  const mutedRef = useRef(musicMuted);
  mutedRef.current = musicMuted;
  const muteNode = useRef<GainNode | null>(null);
  const rafRef = useRef(0);
  const originRef = useRef(0);
  const ioRef = useRef(0);
  const syncRef = useRef<AbortController | null>(null);

  const getCtx = useCallback(() => {
    if (!ctxRef.current) ctxRef.current = new AudioContext();
    return ctxRef.current;
  }, []);
  /**
   * The sound under the playhead while it is dragged, paused (as DaVinci): a short grain of the song there, at most every
   * 50 ms, faded in and out (no clicks); a grain is cut by the next one. Silent while playing (the song plays) and
   * when the playhead does not move.
   */
  const scrubGrain = useRef<{ src: AudioBufferSourceNode; gain: GainNode } | null>(null);
  const scrubAt = useRef({ t: -1, ms: 0 });
  const scrubSound = (t: number) => {
    if (!audioBuf || sourceRef.current || mutedRef.current) return;
    const now = performance.now(), last = scrubAt.current;
    if (now - last.ms < 50 || Math.abs(t - last.t) < 0.005) return;
    scrubAt.current = { t, ms: now };
    try {
      const ctx = getCtx();
      if (ctx.state === "suspended") void ctx.resume();
      const g = scrubGrain.current;
      if (g) { try { g.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.008); g.src.stop(ctx.currentTime + 0.04); } catch { /* ended */ } }
      const GRAIN = 0.09, from = clamp(t, 0, Math.max(0, audioBuf.duration - GRAIN));
      const src = ctx.createBufferSource(), gain = ctx.createGain();
      src.buffer = audioBuf;
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.8, ctx.currentTime + 0.01);
      gain.gain.setValueAtTime(0.8, ctx.currentTime + GRAIN - 0.02);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + GRAIN);
      src.connect(gain); gain.connect(ctx.destination);
      src.start(0, from, GRAIN);
      scrubGrain.current = { src, gain };
      src.onended = () => { if (scrubGrain.current?.src === src) scrubGrain.current = null; };
    } catch { /* no audio output */ }
  };

  const setV = useCallback((patch: Partial<Omit<VideoSetup, "id" | "name">>) => {
    onProject((p) => {
      const list = clipsOf(p);
      const target = list.find((c) => c.id === clip.id) ?? list[0];
      return { ...p, videos: list.map((c) => (c.id === target.id ? { ...c, ...patch } : c)), videoId: target.id };
    });
  }, [onProject, clip.id]);

  const section = project.lyrics.find((s) => s.id === sectionId) ?? project.lyrics[0];

  // Default look of the lyrics; only the font follows the selected carousel slide. The text studio overrides it per clip.
  const slideStyle: TextStyle = useMemo(
    () => defaultCaptionStyle(project.slides[project.selectedSlide]?.style ?? project.slides[0]?.style),
    [project.slides, project.selectedSlide]
  );
  const captionStyle: TextStyle = settings.captionStyle ?? slideStyle;
  // ("lit": the phrases, each shown whole, its words lighting as sung: cut as phrases, drawn by drawStyledText's `lit`)
  const mode: "phrase" | "word" = settings.captionMode === "word" ? "word" : "phrase";
  const lineChars = settings.lineChars ?? 22;
  const cues = useMemo(
    () => buildCues(project.lyricWords ?? [], mode, { lineChars, from: settings.crop.start, to: settings.crop.start + settings.crop.duration, wordTiming: settings.wordTiming }),
    [project.lyricWords, mode, lineChars, settings.crop.start, settings.crop.duration, settings.wordTiming]
  );
  // The whole song's lines, for the track (the lyrics are placed on the whole track): the ones outside the segment are
  // shown there too, dimmed, so it is clear they were found (only the segment's are edited and go in the video).
  // ---- tap mode (as Musixmatch): the song plays, a key pressed when each line starts puts it there ----
  /** The whole song's lines as phrases (the tap mode works line by line, whatever the captions' mode). */
  const tapCues = useMemo(
    () => buildCues(project.lyricWords ?? [], "phrase", { lineChars, wordTiming: settings.wordTiming }),
    [project.lyricWords, lineChars, settings.wordTiming]
  );
  /**
   * The loop (as in Ableton), apart from the padlock (the sync): on, playing stays in the segment and starts it again at
   * its end, the playhead in it; off, it plays on past the segment to the song's end, the playhead anywhere. Kept in
   * this browser (a way of working, not a choice of the post).
   */
  const [loopSeg, setLoopSegRaw] = useState(() => { try { return localStorage.getItem("tktgen-video-loop") !== "0"; } catch { return true; } });
  const loopRef = useRef(loopSeg);
  loopRef.current = loopSeg;
  const setLoopSeg = (on: boolean) => { setLoopSegRaw(on); loopRef.current = on; try { localStorage.setItem("tktgen-video-loop", on ? "1" : "0"); } catch { /* private mode */ } };
  /** While playing, as Musixmatch: the line the last arrow placed (null: none yet since playing started). */
  const tapCursor = useRef<number | null>(null);
  const lyricWordsRef = useRef(project.lyricWords);
  lyricWordsRef.current = project.lyricWords;
  const songCues = useMemo(
    () => buildCues(project.lyricWords ?? [], mode, { lineChars, wordTiming: settings.wordTiming }),
    [project.lyricWords, mode, lineChars, settings.wordTiming]
  );

  /** Font under the pointer in a font list (lyrics or hook style): shown on the video until the pointer leaves. */
  const [fontPreview, setFontPreview] = useState<null | { which: "caption" | "hook" | "cue"; key?: string; patch: Partial<TextStyle> }>(null);
  const styleRef = useRef(captionStyle);
  styleRef.current = fontPreview?.which === "caption" ? { ...captionStyle, ...fontPreview.patch } : captionStyle;
  // The hooks look like the lyrics until they get their own style, but at the top of the picture.
  /** Default look of the hooks: white, black outline (20 %), as typed, centred near the top. Font of the slide. */
  const hookDefault: TextStyle = useMemo(() => ({
    ...slideStyle, look: "outline", size: 56, color: "#ffffff", accent: "#000000", stroke: 20, case: "asis", align: "center",
    width: 70, lineHeight: 1.15, x: 50, y: 20,
  }), [slideStyle]);
  const hookStyle: TextStyle = useMemo(() => settings.hookStyle ?? hookDefault, [settings.hookStyle, hookDefault]);
  const hookStyleRef = useRef(hookStyle);
  hookStyleRef.current = fontPreview?.which === "hook" ? { ...hookStyle, ...fontPreview.patch } : hookStyle;
  const activeRef = useRef<(time: number) => Cue | null>(() => null);
  // (outside the segment, the playhead free while unlocked: the song's line there, on the preview only, never exported)
  activeRef.current = (time: number) => {
    const c = settingsRef.current.crop;
    // (a line of the segment past its edge: as the segment shows it, its own end; the song's other lines for their time)
    const seg = cues.find((x) => time >= x.start && time < x.end);
    if (seg) return seg;
    if (time < c.start || time > c.start + c.duration) return songCues.find((x) => (x.end <= c.start || x.start >= c.start + c.duration) && time >= x.start && time < x.end) ?? null;
    return cues.length ? activeCue(cues, time) : null;
  };

  // ---- custom subtitles: a word (word by word) or a phrase with its own look over the lyrics' style (lib/cueLooks) ----
  const wordKeyMap = useMemo(() => wordKeys(project.lyricWords ?? []), [project.lyricWords]);
  const keyOf = (c: Cue | null | undefined) => (c ? cueKey(c, mode, wordKeyMap) : null);
  const looks = settings.captionLooks ?? {};
  /** What the lyrics panel sets: every caption ("all"), or only the one under the playhead ("one"). */
  const [lookScope, setLookScope] = useState<"all" | "one">("all");
  /** A caption's style as drawn: the lyrics' style, its own look over it (and a font tried in a list, on it alone). */
  const cueStyleRef = useRef<(c: Cue) => TextStyle>(() => captionStyle);
  cueStyleRef.current = (c: Cue) => {
    const k = keyOf(c);
    const st = cueStyle(styleRef.current, k ? looks[k] : undefined);
    return fontPreview?.which === "cue" && fontPreview.key === k ? { ...st, ...fontPreview.patch } : st;
  };
  /** The lyrics' style as it is now (also inside a drag, between two renders). */
  const masterStyle = () => settingsRef.current.captionStyle ?? slideStyle;
  /** A caption's own look: what `next` changes from the lyrics' style. */
  const setCueLook = (key: string, next: TextStyle) =>
    setV({ captionLooks: { ...(settingsRef.current.captionLooks ?? {}), [key]: styleDiff(masterStyle(), next) } });
  /** The caption takes the lyrics' style again (font, effects, size, place: everything). */
  const relinkCue = (key: string) => {
    const rest = { ...(settingsRef.current.captionLooks ?? {}) };
    delete rest[key];
    setV({ captionLooks: Object.keys(rest).length ? rest : undefined });
  };
  /** The caption under the playhead, and whether what is done on the preview goes to it alone: it has its own look,
   *  or "this word / phrase" is chosen in the lyrics panel. */
  const cueHere = () => {
    const c = activeRef.current(headRef.current), key = keyOf(c);
    if (!c || !key) return null;
    return { cue: c, key, one: lookScope === "one" || !!settingsRef.current.captionLooks?.[key] };
  };

  const end = audioBuf ? Math.min(audioBuf.duration, settings.crop.start + settings.crop.duration) : settings.crop.start + settings.crop.duration;

  // ---- colour grade: one LUT (camera log → look), applied live on the GPU ----
  /** A grade with its LUT's own settings as the account has them now (its input, output, highlights): a video keeps a
   *  copy of its LUT, the library says how it is used. */
  const withLutSettings = (g: VideoGrade | undefined): VideoGrade | undefined => {
    // The video's own settings for its LUT (each file its own: one needs Cineon, another the camera's log); a video
    // that never set them takes the library's (what a new video starts with).
    if (!g?.lut || g.lut.input) return g;
    const l = lutLibraryRef.current?.find((x) => x.id === g.lut!.id);
    return l ? { ...g, lut: { ...g.lut, input: l.input, output: l.output, tonemap: l.tonemap, kind: l.kind } } : g;
  };
  const grade = useMemo(() => withLutSettings(settings.grade), [settings.grade, lutLibrary]); // eslint-disable-line react-hooks/exhaustive-deps
  const [look, setLook] = useState<CubeLut | null>(null);
  const [lookErr, setLookErr] = useState<string | null>(null);
  /** Show the camera picture as recorded (log), to compare. Preview only. */
  const [rawView, setRawView] = useState(false);
  const rawRef = useRef(rawView);
  rawRef.current = rawView;
  const graderRef = useRef<Grader | null>(null);
  /** This clip's LUT: put back on the shared grader before each picture (the slides use it too). */
  const videoLut = useRef<Float32Array | null>(null);
  const [lutRev, setLutRev] = useState(0);
  const [lutReload, setLutReload] = useState(0);
  const lutId = grade?.lut?.id;
  useEffect(() => {
    let off = false;
    setLook(LOOKS.get(lutId ?? "") ?? null); setLookErr(null);
    if (!lutId) return;
    const known = LOOKS.get(lutId);
    if (known) { setLook(known); return; }
    const want = settingsRef.current.grade?.lut;
    void (async () => {
      const b = await lutFile(lutId, want);
      if (off) return;
      if (!b) { setLookErr(t("This LUT is not on this device: import it again.")); return; }
      try { const l = parseCube(await b.text()); LOOKS.set(lutId, l); if (!off) setLook(l); }
      catch (e) { if (!off) setLookErr(e instanceof Error ? e.message : String(e)); }
    })();
    return () => { off = true; };
  }, [lutId, lutReload]); // eslint-disable-line react-hooks/exhaustive-deps
  const colourKey = gradeKey(grade);
  /** A LUT's file: on this device, else the same LUT under another id here, else its copy in the user's Drive (kept here then). */
  async function lutFile(lutId: string, want: LutRef | undefined): Promise<Blob | undefined> {
    let b = await getMedia(`lut:${lutId}`).catch(() => undefined);
    if (!b && want) {
      const twin = knownLuts().find((l) => l.name === want.name && l.id !== lutId);
      if (twin) b = await getMedia(`lut:${twin.id}`).catch(() => undefined);
      if (!b) {
        try {
          const id = want.driveId ?? lutLibraryRef.current?.find((l) => l.id === lutId)?.driveId ?? await findInAppFolder(`${want.name}.cube`);
          if (id) b = await downloadDriveFile(id);
        } catch (e) { console.warn("[grade] LUT download from Drive failed", e); }
      }
      if (b) { void putMedia(`lut:${lutId}`, b).catch(() => {}); rememberLut(lutId, want.name, want.kind); }
    }
    return b ?? undefined;
  }
  /** The grade of this video is still loading (its LUT): the preview waits rather than showing the log. */
  const gradePendingRef = useRef(false);
  gradePendingRef.current = !!colourKey && !lookErr && (lutRev === 0 || (!!lutId && !look));
  useEffect(() => {
    if (!colourKey || !grade || (lutId && !look && !lookErr)) return;
    graderRef.current = Grader.shared();
    // A lighter LUT for the preview, so the sliders react at once; the export uses 65 points.
    videoLut.current = buildGradeLut(grade, lutId ? look : null, 33);
    graderRef.current?.setLut(videoLut.current, 33);
    setLutRev((n) => n + 1);
  }, [colourKey, look, lookErr]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- multicam: the other cameras (videos of the release on the same audio), each with its sync, framing, grade ----
  const anglesRef = useRef(new Map<string, Angle>());
  /** A take's file linked again: its player is read again. */
  const [takeFilesRev, setTakeFilesRev] = useState(0);
  const [angleRev, setAngleRev] = useState(0);
  // The video over the post's video (overlay) is read the same way: a hidden player, its grade (never one of the
  // project's cameras: those play as cameras).
  /** The video over it is numbered (and coloured) after the cameras: camera 1 white, then violet, green, gold. */
  /** The videos over it, from the bottom up (an older single `overlay` read as one); never camera 1 nor a camera. */
  const overlaysOf = (s: VideoSettings): VideoOverlay[] => {
    const seen = new Set<string>();
    return (s.overlays ?? (s.overlay ? [s.overlay] : [])).filter((o) => o && o.clip !== clip.id && !(s.angles ?? []).includes(o.clip) && !seen.has(o.clip) && !!seen.add(o.clip));
  };
  /** The one over it of this take (none: not over it). */
  const overlayOf = (s: VideoSettings, id: string | null | undefined) => (id ? overlaysOf(s).find((o) => o.clip === id) ?? null : null);
  /** The videos over it written (the older single field dropped). */
  const withOverlays = (list: VideoOverlay[]): Partial<VideoSettings> => ({ overlays: list.length ? list : undefined, overlay: undefined });
  /** One of them changed (`patch`), or taken off (null). */
  const patchOverlay = (id: string, patch: Partial<VideoOverlay> | null) => {
    const list = overlaysOf(settingsRef.current);
    setV(withOverlays(patch ? list.map((o) => (o.clip === id ? { ...o, ...patch } : o)) : list.filter((o) => o.clip !== id)));
  };
  /** Its number's colour (0-based): after the cameras, from the bottom up. */
  const overNo = (s: VideoSettings, id: string) => Math.min(MAX_CAMS - 1, (s.angles ?? []).filter(Boolean).length + 1 + Math.max(0, overlaysOf(s).findIndex((o) => o.clip === id)));
  /** Videos in the project: camera 1, the cameras, the ones over it (4 at most). */
  const videosIn = (s: VideoSettings) => 1 + (s.angles ?? []).filter(Boolean).length + overlaysOf(s).length;
  const ovClips = overlaysOf(settings).map((o) => clips.find((c) => c.id === o.clip)).filter((c): c is VideoSetup => !!c);
  const angleClips = [...(settings.angles ?? []).map((id) => clips.find((c) => c.id === id && c.id !== clip.id) ?? null), ...ovClips];
  // What a camera needs (its file, its offset, framing and grade): read again when one of them changes.
  const anglesKey = JSON.stringify(angleClips.map((c) => c && [c.id, c.media, c.videoSize, c.offset, c.frame, c.desqueeze, c.matte, c.push, c.pushIn, c.clipVolume, c.grade, lutLibrary?.find((l) => l.id === c.grade?.lut?.id)]));
  useEffect(() => {
    let off = false;
    const map = anglesRef.current;
    const want = new Set(angleClips.filter(Boolean).map((c) => c!.id));
    for (const [id, a] of map) if (!want.has(id)) { a.el.pause(); a.el.removeAttribute("src"); a.el.load(); a.el.remove(); URL.revokeObjectURL(a.url); map.delete(id); }
    void (async () => {
      for (const c of angleClips) {
        if (!c || off) continue;
        const media = c.media ?? c.id;
        let a = map.get(c.id);
        if (!a || a.media !== media) {
          // The camera file on this device, else its Drive working copy kept here, else that copy fetched from the Drive.
          const kept = await getMedia(`video:${media}`).catch(() => undefined);
          // (another file under its key on this device: not its own, never shown in its place)
          const own = kept && c.videoSize && kept.size !== c.videoSize ? undefined : kept;
          let blob = own ?? (await getMedia(`copy:${c.id}`).catch(() => undefined));
          if (!blob && c.drive?.copy?.id) {
            try { blob = (await downloadDriveFile(c.drive.copy.id)) ?? undefined; if (blob) void putMedia(`copy:${c.id}`, blob).catch(() => {}); }
            catch (e) { console.warn("[takes] Drive copy not fetched", e); }
          }
          if (off) return;
          if (!blob) {
            // Its old player (another file before) goes too: left in the page with its file in memory otherwise.
            if (a) { a.el.removeAttribute("src"); a.el.load(); a.el.remove(); URL.revokeObjectURL(a.url); }
            map.delete(c.id); continue;
          }
          const el = document.createElement("video");
          el.muted = true; el.playsInline = true; el.preload = "auto";
          // In the page, tiny and nearly transparent, as the studio's own player: a video out of the page (or seen as
          // hidden) is no longer decoded by the browser, its first pictures after a cut were frozen, then catching up.
          el.className = "video-src";
          (videoRef.current?.parentElement ?? document.body).appendChild(el);
          const url = URL.createObjectURL(blob);
          el.src = url;
          const redraw = () => { if (!sourceRef.current) drawAt(headRef.current); };
          el.addEventListener("seeked", redraw);
          el.addEventListener("loadeddata", redraw);
          if (a) { a.el.removeAttribute("src"); a.el.load(); a.el.remove(); URL.revokeObjectURL(a.url); }
          a = { id: c.id, media, blob, el, url, offset: 0, frame: undefined, desqueeze: undefined, grade: undefined, look: null, lut: null, fromCopy: !own };
          map.set(c.id, a);
        }
        a.offset = c.offset; a.frame = c.frame; a.desqueeze = c.desqueeze; a.matte = c.matte; a.push = c.push; a.pushIn = c.pushIn; a.volume = c.clipVolume;
        // The new grade is made ready apart and put in at once: the camera keeps its current look until then (cleared
        // first, it was drawn black while its LUT was being read, at each move of a colour setting).
        const grade = withLutSettings(c.grade);
        const lutRef = grade?.lut;
        let look: CubeLut | null = null;
        if (lutRef) {
          look = LOOKS.get(lutRef.id) ?? null;
          if (!look) {
            const b = await lutFile(lutRef.id, lutRef);
            try { if (b) { look = parseCube(await b.text()); LOOKS.set(lutRef.id, look); } } catch { /* not a LUT */ }
          }
          if (off) return;
        }
        // Its LUT nowhere (not here, not on the Drive): graded without it rather than not at all, as camera 1.
        a.grade = grade; a.look = look;
        a.lut = gradesColour(grade) ? buildGradeLut(grade, lutRef ? look : null, 33) : null;
      }
      if (!off) { setAngleRev((n) => n + 1); drawAt(headRef.current); }
    })();
    return () => { off = true; };
  }, [anglesKey, takeFilesRev]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { for (const a of anglesRef.current.values()) { a.el.removeAttribute("src"); a.el.load(); a.el.remove(); URL.revokeObjectURL(a.url); } }, []);
  /** The camera (2 to 4) of the shot at official time `time`; null: this video's own. */
  const angleAt = (time: number): Angle | null => {
    const cfg = settingsRef.current;
    const cam = camAt(cfg.cuts, time);
    return cam > 0 ? anglesRef.current.get(cfg.angles?.[cam - 1] ?? "") ?? null : null;
  };
  /** A camera's picture at official time `time` (paused: its player placed there first). */
  const anglePicture = (a: Angle, time: number, still: boolean): Picture | null | undefined => {
    const el = a.el, target = time - a.offset;
    if (target < -0.001 || (Number.isFinite(el.duration) && target > el.duration + 0.001)) return null;
    if (still && !el.seeking && Math.abs(el.currentTime - target) > 0.02) el.currentTime = Math.max(0, target);
    return el.readyState >= 2 && el.videoWidth && !el.seeking ? { src: el, w: el.videoWidth, h: el.videoHeight } : undefined;
  };
  /** The videos over it at official time `time`, from the bottom up (each outside its part: left out). */
  const overlayPictures = (time: number, still: boolean) =>
    overlaysOf(settingsRef.current).filter((o) => !o.hidden).map((o) => overlayPicture(o, time, still)).filter((x): x is { pic: Picture; a: Angle; o: VideoOverlay; stale?: boolean } => !!x);
  /** One over it: its player and picture at official time `time` (paused: placed there first); none outside its part. */
  const overlayPicture = (o: VideoOverlay, time: number, still: boolean): { pic: Picture; a: Angle; o: VideoOverlay; stale?: boolean } | null => {
    const a = anglesRef.current.get(o.clip);
    if (!a) return null;
    const el = a.el, target = time - o.offset;
    const [ci, co] = clipSpan(o, Number.isFinite(el.duration) ? el.duration : Infinity);
    if (target < ci - 0.001 || target > co + 0.001 || isOff(o, target)) return null;
    if (still && !el.seeking && Math.abs(el.currentTime - target) > 0.02) el.currentTime = Math.max(0, target);
    // Ready: its picture, copied (a player that seeks or starts gives none for a moment: the copy is shown then,
    // never a blink of the video under it).
    let cv = overlayKeep.current.get(o.clip);
    if (el.readyState >= 2 && el.videoWidth && !el.seeking) {
      const cw = Math.min(1280, el.videoWidth), ch = Math.round((cw * el.videoHeight) / el.videoWidth);
      if (!cv) { cv = document.createElement("canvas"); overlayKeep.current.set(o.clip, cv); }
      if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
      cv.getContext("2d")?.drawImage(el, 0, 0, cw, ch);
      return { pic: { src: el, w: el.videoWidth, h: el.videoHeight }, a, o };
    }
    // (its last picture: the player is still looking for this one)
    return cv ? { pic: { src: cv, w: cv.width, h: cv.height }, a, o, stale: true } : null;
  };
  /** Each one's last picture (by take), shown while its player seeks: never a blink of the video under it. */
  const overlayKeep = useRef(new Map<string, HTMLCanvasElement>());
  /** While playing: every camera plays with the sound, so a cut shows the next one at once (no black frame). */
  /**
   * While playing, the cameras 2 to 4 follow the sound. Only the one on screen and the one of the next cut (started
   * `PREROLL` before it, placed and already playing at the cut) are decoded: every camera at once (4K, 10 bits) was too
   * much, a camera fell behind, jumped back in place, and its first pictures after a cut stayed frozen meanwhile.
   * Before its recording starts a camera waits, paused, on its first picture (it used to jump back to it every 0.4 s).
   */
  const PREROLL = 1.5;
  const syncAngles = (heard: number) => {
    const cfg = settingsRef.current;
    const live = new Set<string>();
    const add = (cam: number) => { const id = cam > 0 ? cfg.angles?.[cam - 1] : undefined; if (id) live.add(id); };
    add(camAt(cfg.cuts, heard));
    for (const c of cfg.cuts ?? []) if (c.at > heard && c.at <= heard + PREROLL) add(c.cam);
    const ovs = overlaysOf(cfg);
    for (const a of anglesRef.current.values()) {
      const ov = ovs.find((o) => o.clip === a.id), isOv = !!ov;
      const el = a.el, target = heard - (isOv ? ov!.offset : a.offset);
      // The overlay: playing over its part kept on its track (started a moment before), its own sound at its volume.
      if (isOv) {
        const [ci, co] = clipSpan(ov!, Number.isFinite(el.duration) ? el.duration : Infinity);
        if (target > ci - PREROLL && target < co) live.add(a.id);
        const vol = clamp(ov!.volume ?? 0, 0, 1), audible = vol > 0 && target >= ci && target <= co && !isOff(ov!, target);
        if (el.muted === audible) el.muted = !audible;
        if (audible && Math.abs(el.volume - vol) > 0.005) el.volume = vol;
      }
      // A camera of the multicam: its sound on its own shots, at its volume.
      if (!isOv) {
        const vol = clamp(a.volume ?? 0, 0, 1), k = (cfg.angles ?? []).indexOf(a.id) + 1;
        const audible = vol > 0 && k > 0 && camAt(cfg.cuts, heard) === k && target >= 0;
        if (el.muted === audible) el.muted = !audible;
        if (audible && Math.abs(el.volume - vol) > 0.005) el.volume = vol;
      }
      const inFile = target > -PREROLL && (!Number.isFinite(el.duration) || target < el.duration);
      if (!live.has(a.id) || !inFile) {
        if (!el.paused) { el.pause(); el.playbackRate = 1; }
        // (soon recording: waiting on its first picture)
        if (inFile && target < 0 && live.has(a.id) && el.currentTime > 0.05 && !el.seeking) el.currentTime = 0;
        continue;
      }
      if (target < 0) { if (!el.paused) el.pause(); if (el.currentTime > 0.05 && !el.seeking) el.currentTime = 0; continue; }
      const diff = target - el.currentTime;
      if (el.paused) {
        // A little ahead: the time the seek takes, the sound goes on (it is caught up by the speed below).
        if (Math.abs(diff) > 0.05) el.currentTime = target + (diff > 0 || diff < -0.3 ? 0.12 : 0);
        void el.play().catch(() => {});
      } else if (Math.abs(diff) > 0.4) {
        if (!el.seeking) { console.debug(`[multicam] camera ${a.id} ${Math.round(diff * 1000)} ms off: placed again`); el.currentTime = target + 0.12; el.playbackRate = 1; }
      } else el.playbackRate = Math.abs(diff) < 0.02 ? 1 : Math.min(1.1, Math.max(0.9, 1 + diff * 0.8));
    }
  };

  /** Frame of the camera file at the playhead, read with ffmpeg while the player gives none (see pictureOf). */
  const stillRef = useRef<{ src: string; at: number; bmp: ImageBitmap } | null>(null);
  const stillWant = useRef<number | null>(null);
  /** The camera file (its URL) of which the player has given a picture: no frame read from the file is needed any more. */
  const playerSeen = useRef<string | null>(null);

  // ---- poster: the last graded picture of the clip, shown at once while a big camera file opens ----
  const posterRef = useRef<ImageBitmap | HTMLCanvasElement | null>(null);
  const posterTimer = useRef(0);
  // This video's files on the device: its own, or the ones of the video it duplicates (see VideoSetup.media).
  const mediaId = clip.media ?? clip.id;
  /** The project and video the files were last read for ("<project>|<video>"): see the files effect. */
  const loadedFor = useRef("");
  /** Another video of the release reads these device files too (a duplicate, or the video it was made from). */
  const sharedFiles = (key = mediaId) => clips.some((c) => c.id !== clip.id && (c.media ?? c.id) === key);
  const posterKey = `poster:${mediaId}`;
  const posterKeyRef = useRef(posterKey);
  posterKeyRef.current = posterKey;
  /** Copy the picture just drawn (before the texts) and save it a moment after the preview stops moving. */
  const keepPoster = useCallback((src: HTMLCanvasElement) => {
    const c = document.createElement("canvas");
    c.width = Math.round(src.width / 2); c.height = Math.round(src.height / 2);
    c.getContext("2d")!.drawImage(src, 0, 0, c.width, c.height);
    posterRef.current = c;
    clearTimeout(posterTimer.current);
    const key = posterKeyRef.current;
    posterTimer.current = window.setTimeout(() => {
      c.toBlob((b) => { if (b) void putMedia(key, b).catch(() => {}); }, "image/jpeg", 0.85);
    }, 1500);
  }, []);
  useEffect(() => () => clearTimeout(posterTimer.current), []);

  /** The <video> as a picture at official time `time`; none outside the part of the track the camera recorded. */
  const pictureOf = (el: HTMLVideoElement | null, time: number): Picture | null => {
    // This video has no camera file (yet), or the player still holds the previous video's: nothing to show.
    if (!videoUrlRef.current || fileClip.current !== clipIdRef.current) return null;
    const off = settingsRef.current.offset;
    // (the part kept on the video track: black before and after it)
    const [ci, co] = clipSpan(settingsRef.current, Number.isFinite(el?.duration) ? el!.duration : Infinity);
    // (a piece of it turned off: nothing there, as outside it)
    const inVideo = time >= off + ci - 0.001 && time <= off + co + 0.001 && !isOff(settingsRef.current, time - off);
    // No picture from the player yet (Safari, before the first play): the frame read from the file. Only until the
    // player gave one: ffmpeg's decoding differs slightly in colour, so coming back on that frame later (a seek, the
    // pause going back to the start) flashed another grade for a moment.
    const still = stillRef.current;
    if (el && el.readyState >= 2) playerSeen.current = el.currentSrc;
    // While playing starts, keep it on screen until the player has its first picture (no black flash).
    if (el && inVideo && el.readyState < 2 && still && still.src === el.currentSrc && playerSeen.current !== el.currentSrc
      && (!el.paused || Math.abs(still.at - (time - off)) < 0.08)) {
      const w = el.videoWidth || still.bmp.width, h = el.videoHeight || still.bmp.height;
      return { src: still.bmp, w, h, part: { x: 0, y: 0, w, h } };
    }
    return el && el.videoWidth && inVideo ? { src: el, w: el.videoWidth, h: el.videoHeight } : null;
  };
  /**
   * The picture of the post at official time `time`: the framed camera video, the lyrics, then the hook.
   * Used by the preview and the export. Returns where the texts were drawn, to drag them on the preview.
   */
  const drawScene = useCallback((g: CanvasRenderingContext2D, W: number, H: number, pic: Picture | null, time: number, preview?: { raw: boolean; keep: boolean },
    /** Multicam: another camera's picture, with its own framing and grade. */
    angle?: AngleLook,
    /** The videos over it (picture in picture), from the bottom up: each one's picture, its take's look, where it goes. */
    overs?: { pic: Picture; a: AngleLook; o: VideoOverlay }[]) => {
    const cfg = settingsRef.current;
    const lookFrame = angle ? angle.frame : cfg.frame, lookGrade = angle ? angle.grade : cfg.grade;
    // The camera's own bars and progressive zoom, else the project's.
    const matte = (angle ? ownOr(angle.matte, cfg.matte) : cfg.matte) || undefined;
    const pushK = (angle ? ownOr(angle.push, cfg.push) : cfg.push) || undefined, pushIn = angle ? ownOr(angle.pushIn, cfg.pushIn) : cfg.pushIn;
    const raw = !!preview?.raw;
    g.fillStyle = "#000";
    g.fillRect(0, 0, W, H);
    // The video under the others hidden (its eye): black there (the ones over it, the bars and the texts stay).
    if (cfg.videoHidden) pic = null;
    // Preview, before the video is ready (a big camera file takes a while to open): its last picture; only where the
    // video is (past its end, or before it, black: never its last picture held there).
    const vEl = videoRef.current, [vci, vco] = clipSpan(cfg, vEl && Number.isFinite(vEl.duration) ? vEl.duration : Infinity);
    const inVideo = time >= cfg.offset + vci - 0.01 && time <= cfg.offset + vco + 0.01;
    if (preview && !pic && !cfg.videoHidden && inVideo && posterRef.current && !(videoRef.current && videoRef.current.readyState >= 2)) g.drawImage(posterRef.current, 0, 0, W, H);
    if (pic && pic.w && pic.h) {
      // Anamorphic lens: the picture drawn wider, as it was meant to be seen (everything below works on that size).
      pic = desqueeze(pic, angle ? angle.desqueeze : cfg.desqueeze);
      let f = picOf(lookFrame ?? DEFAULT_VIDEO.frame, matte);
      // Progressive zoom: ×1 at the start of the segment, `push` on its last frame. The whole framed picture around the
      // centre, or (`pushIn`) only what is inside its frame, around the frame's centre (below).
      const push = pushK ?? 1;
      const k = push > 1 ? 1 + (push - 1) * clamp((time - cfg.crop.start) / Math.max(0.1, cfg.crop.duration), 0, 1) : 1;
      const inside = !!pushIn && k > 1;
      if (k > 1 && !inside) f = zoomPic(f, f.zoom * k);
      // A camera of the multicam can be graded while camera 1 is not: the shared grader then made for it.
      const grader = graderRef.current ?? (angle?.lut ? (graderRef.current = Grader.shared()) : null);
      const wantGrade = !raw && !pic.graded && gradesColour(lookGrade);
      const lut = angle ? angle.lut : videoLut.current;
      if (wantGrade && (angle ? !lut : !grader?.ready && gradePendingRef.current)) { console.debug("[grade] waiting for the grade (LUT loading)"); pic = null; }
      else if (wantGrade && grader && !grader.lost && lut) {
        grader.setLut(lut, 33);
        // Grade only what the post shows, at the size it is drawn.
        const region = visibleRegion(f, pic.w, pic.h, W, H);
        const s = (f.framing === "fill" ? Math.max(W / pic.w, H / pic.h) : Math.min(W / pic.w, H / pic.h)) * f.zoom * (inside ? k : 1);
        const ow = Math.min(4096, region.w * s), oh = Math.min(4096, region.h * s);
        const paused = pic.src instanceof HTMLVideoElement && pic.src.paused;
        const graded = grader.grade(pic, region, ow, oh);
        // A paused video can reach the GPU black: grade a 2D copy of it instead.
        const black = paused && grader.gotBlack();
        if (black) console.debug("[grade] paused video reached the GPU black: graded from a 2D copy");
        pic = black ? grader.grade(copyRegion(pic, region, ow, oh), region, ow, oh) : graded;
      }
      if (pic) {
        drawFramed(g, pic.src, pic.w, pic.h, f, W, H, pic.part);
        if (inside) {
          // The frame stays where it is (a mask); the picture grows inside it from the frame's centre.
          const { x, y, s } = framedAt(f, pic.w, pic.h, W, H);
          const w = pic.w * s, h = pic.h * s;
          const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(W, x + w), y1 = Math.min(H, y + h);
          g.save();
          g.beginPath();
          g.rect(x0, y0, x1 - x0, y1 - y0);
          g.clip();
          drawPictureAt(g, pic.src, pic.w, pic.h, x + (w * (1 - k)) / 2, y + (h * (1 - k)) / 2, s * k, pic.part);
          g.restore();
        }
        if (!raw && lookGrade) drawLook(g, W, H, lookGrade, Math.round(time * GRAIN_FPS));
        if (preview?.keep && !raw && !angle) keepPoster(g.canvas);
      } else if (preview && posterRef.current) g.drawImage(posterRef.current, 0, 0, W, H);
    }
    // The videos over it: each whole, at its size and place, its corners rounded, graded as its take; under the bars and
    // texts; the last one on top.
    const boxes: { id: string; box: TextBox }[] = [];
    for (const over of overs ?? []) {
      if (!over.pic.w || !over.pic.h || over.o.hidden) continue;
      const o = over.o;
      let op: Picture | null = desqueeze(over.pic, over.a.desqueeze);
      const w = (W * clamp(o.w, 5, 400)) / 100, h = (w * op.h) / op.w;
      const x = (W * o.x) / 100 - w / 2, y = (H * o.y) / 100 - h / 2;
      if (!raw && !op.graded && over.a.lut && gradesColour(over.a.grade)) {
        const grader = graderRef.current ?? (graderRef.current = Grader.shared());
        if (grader && !grader.lost) { grader.setLut(over.a.lut, 33); op = grader.grade(op, { x: 0, y: 0, w: op.w, h: op.h }, Math.min(4096, w), Math.min(4096, h)); }
      }
      if (op) {
        const r = (Math.min(w, h) * clamp(o.radius ?? 0, 0, 50)) / 100;
        g.save();
        g.beginPath();
        g.roundRect(x, y, w, h, r);
        g.clip();
        // Its own framing inside its frame (its zoom and place, as the video under it in the post), its progressive
        // zoom and its black bars: the same settings as any video, drawn in its box (its own only: never the post's).
        const oa = over.a, push = oa.push && oa.push > 1 ? oa.push : 1;
        const k = push > 1 ? 1 + (push - 1) * clamp((time - cfg.crop.start) / Math.max(0.1, cfg.crop.duration), 0, 1) : 1;
        const inside = !!oa.pushIn && k > 1;
        let f = picOf(oa.frame ?? DEFAULT_VIDEO.frame, oa.matte || undefined);
        if (k > 1 && !inside) f = zoomPic(f, f.zoom * k);
        g.translate(x, y);
        drawFramed(g, op.src, op.w, op.h, f, w, h, op.part);
        if (inside) {
          const fa = framedAt(f, op.w, op.h, w, h), pw = op.w * fa.s, ph = op.h * fa.s;
          g.save();
          g.beginPath();
          g.rect(Math.max(0, fa.x), Math.max(0, fa.y), Math.min(w, fa.x + pw) - Math.max(0, fa.x), Math.min(h, fa.y + ph) - Math.max(0, fa.y));
          g.clip();
          drawPictureAt(g, op.src, op.w, op.h, fa.x + (pw * (1 - k)) / 2, fa.y + (ph * (1 - k)) / 2, fa.s * k, op.part);
          g.restore();
        }
        if (oa.matte) drawMatte(g, w, h, oa.matte);
        g.restore();
        boxes.push({ id: o.clip, box: { x, y, w, h } as TextBox });
      }
    }
    overlayBoxes.current = boxes;
    // Black bars to a picture format (the post's choice): over the picture, under the texts.
    drawMatte(g, W, H, matte);
    // The texts at the very end of the segment (the playhead dragged to the end, or stopped there) are those of its
    // last frame, as in the export: a hook running to the end must not vanish there.
    // Outside the segment (the preview, the loop off): what is under the playhead there, as in an editing app (the song's
    // line for its own time only, a hook that runs there).
    const segEnd = cfg.crop.start + cfg.crop.duration, outside = !!preview && (time < cfg.crop.start || time > segEnd + 0.05);
    const at = outside ? time : Math.min(time, segEnd - 0.5 / exportSettings(cfg.source?.fps, exportPrefsRef.current).fps);
    const cue = cfg.captions ? activeRef.current(at) : null;
    const lit = cue && cfg.captionMode === "lit" ? { words: litWords(cue.words, at, !!cfg.litSweep), dim: (cfg.litDim ?? 35) / 100 } : undefined;
    const caption = cue ? drawStyledText(g, cue.text, cueStyleRef.current(cue), W, H, lit) : null;
    const hook = cfg.showHooks === false ? undefined : hookAt(cfg, at);
    return { caption, hook: hook ? drawStyledText(g, hook.text, hookStyleRef.current, W, H) : null };
  }, []);
  const captionBox = useRef<TextBox | null>(null);
  /** Where each video over it was drawn, from the bottom up (to drag it on the preview: the top one first). */
  const overlayBoxes = useRef<{ id: string; box: TextBox }[]>([]);
  const hookBox = useRef<TextBox | null>(null);
  /** Editing aids of the preview (TikTok zones, centre lines while a text is dragged): never in the export. */
  const [aids, setAidsRaw] = useState<{ zones: boolean; guides: boolean }>(() => {
    try { return { zones: false, guides: true, ...JSON.parse(localStorage.getItem("tktgen-video-aids") ?? "{}") }; } catch { return { zones: false, guides: true }; }
  });
  const setAids = (patch: Partial<typeof aids>) => setAidsRaw((cur) => {
    const next = { ...cur, ...patch };
    try { localStorage.setItem("tktgen-video-aids", JSON.stringify(next)); } catch { /* private mode */ }
    return next;
  });
  const [snap, setSnap] = useState({ v: false, h: false });
  const aidsRef = useRef({ zones: false, guideV: false, guideH: false });
  // The alignment guides always show while dragging (as on every social app): only the zones can be turned off.
  /** The preview is in full screen (set further down, where the full screen lives). */
  const fullRef = useRef(false);
  // The full screen shows the picture as it will be posted: never TikTok's zones over it.
  aidsRef.current = { zones: aids.zones && settings.format !== "16:9", guideV: snap.v, guideH: snap.h };
  /** Paused: since when the drawing waits for a video still looking for its picture (see drawAt), and its retry. */
  const holdSince = useRef<number | null>(null);
  const holdRetry = useRef(0);
  const drawAt = useCallback((time: number) => {
    const c = canvasRef.current;
    const g = c?.getContext("2d");
    if (!c || !g) return;
    const el = videoRef.current;
    // Multicam: the camera of the shot at this time (its own picture, framing and grade).
    const pin = !sourceRef.current ? pinRef.current : null;
    const ang = pin ? (pin === "main" ? null : anglesRef.current.get(pin) ?? null) : angleAt(time);
    // A camera chosen there whose file is not on this device: black (never camera 1's picture passed for it).
    const lostCam = !ang && (pin ? pin !== "main" : camAt(settingsRef.current.cuts, time) > 0);
    const keep = !ang && !sourceRef.current && !!el && el.readyState >= 2 && fileClip.current === clipIdRef.current && !!videoUrlRef.current;
    const pic = lostCam ? null : ang ? anglePicture(ang, time, !sourceRef.current) : pictureOf(el, time);
    // (every video over it asked for its picture at this time first: they all look for it together)
    const overs = overlayPictures(time, !sourceRef.current);
    // A camera not ready yet (starting, placing itself): the last picture stays on screen, never a black frame.
    if (pic === undefined) return;
    // Paused (the playhead moved by hand): drawn only once every video shown has its picture of this time, all together
    // (else the one under it changed first and the one over it a moment later: they looked out of sync). Never held
    // more than 0.3 s (a player slow to answer): then drawn as they are.
    if (!sourceRef.current) {
      const busy = (!ang && !lostCam && !!el && el.seeking) || overs.some((x) => x.stale && !x.o.hidden);
      if (busy) {
        const now = performance.now();
        holdSince.current ??= now;
        if (now - holdSince.current < 300) {
          if (!holdRetry.current) holdRetry.current = window.setTimeout(() => { holdRetry.current = 0; drawAt(headRef.current); }, 60);
          return;
        }
      }
      holdSince.current = null;
    }
    const boxes = drawScene(g, c.width, c.height, pic, time, lostCam ? undefined : { raw: rawRef.current, keep }, ang ?? (lostCam ? { lut: null } : undefined), overs);
    captionBox.current = boxes.caption;
    hookBox.current = boxes.hook;
    drawHelpers(g, c.width, c.height, fullRef.current ? { ...aidsRef.current, zones: false } : aidsRef.current);
    // The first picture of the video (or its last picture kept from before) is on screen: the splash can go.
    if (!shownOnce.current && (pic || posterRef.current)) { shownOnce.current = true; window.dispatchEvent(new Event("rollout:video-ready")); }
  }, [drawScene]);
  drawAtRef.current = drawAt;
  const shownOnce = useRef(false);
  // The camera file is read from this device: the splash's bar moves on.
  useEffect(() => { if (videoBlob) window.dispatchEvent(new Event("rollout:video-file")); }, [!!videoBlob]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Draw the paused picture now, and again a little later: right after a load or a seek, the frame of the
   * hidden <video> may not be decoded yet (the browser gives black). Timers, not requestVideoFrameCallback:
   * that one waits for the video to be painted on screen, which never happens for the hidden player.
   */
  const headRef = useRef(head);
  // The state follows the playback a few times a second; the playback writes the ref every frame: the ref only takes the
  // state's value when the state itself changes (a click, a key), never an older one back.
  const headSeen = useRef(head);
  if (headSeen.current !== head) { headSeen.current = head; headRef.current = head; }
  const drawWhenShown = useCallback((el: HTMLVideoElement) => {
    drawAt(headRef.current);
    for (const ms of [80, 250, 600]) setTimeout(() => { if (el.paused && !sourceRef.current) drawAt(headRef.current); }, ms);
  }, [drawAt]);

  const loadT0 = useRef(0);


  /** Each start or stop gets a number: a start still waiting gives up when it is no longer the last one. */
  const playToken = useRef(0);
  const stop = useCallback(() => {
    playToken.current++;
    cancelAnimationFrame(rafRef.current);
    // What the timeline showed while playing (drawn every frame, the state a few times a second) becomes the state.
    if (sourceRef.current) { setHead(headRef.current); commitView(); }
    const src = sourceRef.current, fade = fadeRef.current;
    sourceRef.current = null;
    fadeRef.current = null;
    if (src) {
      // The sound fades out over a moment, then stops (the picture stops at once).
      const ctx = src.context, now = ctx.currentTime;
      try {
        if (fade) {
          fade.gain.cancelScheduledValues(now);
          fade.gain.setValueAtTime(fade.gain.value, now);
          fade.gain.linearRampToValueAtTime(0, now + FADE);
        }
        src.stop(fade ? now + FADE + 0.01 : 0);
      } catch { /* already stopped */ }
      const mute = muteNode.current; muteNode.current = null;
      window.setTimeout(() => { src.disconnect(); fade?.disconnect(); mute?.disconnect(); }, fade ? FADE * 1000 + 60 : 0);
    }
    if (videoRef.current) { videoRef.current.pause(); videoRef.current.playbackRate = 1; }
    for (const a of anglesRef.current.values()) { a.el.pause(); a.el.playbackRate = 1; }
    setPlaying(false);
  }, []);

  // ---- files ----
  useEffect(() => {
    let off = false;
    const token = ++ioRef.current;
    syncRef.current?.abort();
    stop();
    // Another video became the base of this same project (a clip dragged in the timeline): only the camera file
    // changes. The official audio, its waveform, the playhead and the picture on screen stay (they used to be read
    // again, as if the page was reloaded).
    // (only when the camera file changed and the audio is there: run again for the same file — React runs it twice on
    // opening in development, the first run cancelled —, everything is read, never an audio left out)
    const prev = loadedFor.current, here = `${project.id}|${clip.id}|`;
    const swapOnly = !!audioBuf && prev.startsWith(here) && prev !== here + mediaId;
    loadedFor.current = here + mediaId;
    if (!swapOnly) {
      setAudioBlob(null);
      setAudioBuf(null);
      setPeaks([]);
      setVideoBlob(null);
      setVideoDur(0);
      setLoadedClip(null);
      setHead(savedHead(clip.id) ?? settingsRef.current.crop.start);
    } else setVideoDur(settingsRef.current.source?.duration ?? 0);
    setErr(null);
    setNote(null);
    void (async () => {
      try {
        const t0 = performance.now();
        // Nothing of the previous video stays on screen.
        fileClip.current = null;
        posterRef.current = null;
        stillRef.current?.bmp.close();
        stillRef.current = null;
        stillWant.current = null;
        void getMedia(posterKey).then(async (p) => {
          if (!p || off || token !== ioRef.current) return;
          try { posterRef.current = await createImageBitmap(p); drawAt(swapOnly ? headRef.current : settingsRef.current.crop.start); } catch { /* not a picture */ }
        });
        const [shared, legacy, b0] = await Promise.all([getMedia(projectAudioKey), getMedia(`audio:${clip.id}`), getMedia(`video:${mediaId}`)]);
        if (off || token !== ioRef.current) return;
        // Not its file (another one kept under its key on this device: another browser's history, a take swapped…): never
        // shown in its place; the video is "not here", to link again.
        const want = settingsRef.current.videoSize;
        const b = b0 && want && b0.size !== want ? (console.warn(`[load] the file kept for ${mediaId} is not this video's (${b0.size} ≠ ${want} bytes)`), undefined) : b0;
        console.debug(`[load] files read from the device in ${Math.round(performance.now() - t0)} ms (video ${b ? Math.round(b.size / 1e6) + " MB" : "none"})`);
        loadT0.current = t0;
        // The release has one official audio; older workspaces kept a copy per video: it becomes the project's.
        let a = shared ?? legacy;
        // Not on this device (another computer, browser data cleared): back from the Drive file.
        if (!a && !swapOnly && project.audioDriveId) {
          setNote(t("Getting the official audio back from Google Drive…"));
          try {
            const blob = await downloadDriveFile(project.audioDriveId);
            if (off || token !== ioRef.current) return;
            a = blob;
            void putMedia(projectAudioKey, blob).catch(() => {});
            setNote(null);
          } catch {
            if (!off) setErr(t("The official audio could not be fetched from Google Drive. Check it is still there, or import it again."));
          }
        }
        if (!shared && legacy) {
          void putMedia(projectAudioKey, legacy).then(() => delMedia(`audio:${clip.id}`)).catch(() => {});
          if (!project.audioName && settingsRef.current.audioName) onProject((p) => ({ ...p, audioName: settingsRef.current.audioName }));
        }
        if (a && !swapOnly) {
          setAudioBlob(a);
          const ta = performance.now();
          decodeAudio(getCtx(), a)
            .then((buf) => {
              if (off || token !== ioRef.current) return;
              console.debug(`[load] official audio decoded in ${Math.round(performance.now() - ta)} ms (${Math.round(a.size / 1e6)} MB, ready to play ${Math.round(performance.now() - t0)} ms after opening)`);
              setAudioBuf(buf);
              setPeaks(peaksOf(buf.getChannelData(0)));
            })
            .catch(() => { if (!off && token === ioRef.current) setErr(t("Could not read this audio file.")); });
        }
        setOnCopy(false);
        if (b) { fileClip.current = clip.id; setVideoBlob(b); }
        else {
          // No camera file: a picture kept by mistake for this video (older versions) is dropped.
          posterRef.current = null; void delMedia(`poster:${clip.id}`).catch(() => {});
          // Its working copy instead (kept on this device, else fetched from the Drive): work goes on here.
          const cp = clip.drive?.copy;
          if (cp) {
            const cb = await copyBlob(cp, () => off);
            if (cb && !off && token === ioRef.current) { fileClip.current = clip.id; copyShown.current = cp.id; setOnCopy(true); setVideoBlob(cb); }
          }
        }
        setLoadedClip(clip.id);
      } catch { if (!off) setLoadedClip(clip.id); /* IndexedDB unavailable */ }
    })();
    return () => { off = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip.id, project.id, mediaId]); // (mediaId: another video became the base, its file is read)

  useEffect(() => {
    setSectionId(project.lyricsSectionId ?? project.lyrics[0]?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  useEffect(() => {
    if (!videoBlob) {
      setVideoUrl(null);
      const el = videoRef.current;
      if (el) { el.pause(); el.removeAttribute("src"); el.load(); }
      return;
    }
    const url = URL.createObjectURL(videoBlob);
    setPlayerReady(false);
    setVideoUrl(url);
    // Never stuck on "opening" if the browser stays silent: the timeline comes back after 30 s anyway.
    const late = window.setTimeout(() => setPlayerReady(true), 30_000);
    return () => { clearTimeout(late); URL.revokeObjectURL(url); };
  }, [videoBlob]);

  // ---- Google Drive: the camera file, on request, to open the clip on another device ----
  useEffect(() => { void canWriteDrive().then(setDriveWrite).catch(() => setDriveWrite(false)); }, []);
  useEffect(() => () => driveAc.current?.abort(), []);
  /** This video's working copy: kept on this device, else fetched from the Drive (and kept). Null when it cannot be. */
  const copyBlob = async (cp: { id: string; size?: number }, gone: () => boolean): Promise<Blob | null> => {
    const kept = await getMedia(`copy:${clip.id}`);
    if (kept && (!cp.size || kept.size === cp.size)) return kept; // an older copy (other size) is fetched again
    setDriveJob({ kind: "fetch", p: 0 });
    try {
      const cb = await downloadDriveFileProgress(cp.id, (p) => { if (!gone()) setDriveJob({ kind: "fetch", p }); }, new AbortController().signal);
      void putMedia(`copy:${clip.id}`, cb).catch(() => {});
      return cb;
    } catch (e) {
      console.warn("[copy] download failed", e);
      if (!gone()) setErr(t("The Drive copy of this video could not be fetched. Check your connection, or pick the camera file."));
      return null;
    } finally { setDriveJob(null); } // even when gone: never a fetch shown forever
  };
  const driveName = (what: string) => safeName(`${project.name || "RAW"} - ${clip.name} - ${what}.mp4`);
  // ---- the account's LUTs: listed on every device, each file on the Drive (Utils / LUTS) as soon as it is imported ----
  /** The LUTs to choose from: the account's, and the ones of this device it does not list yet. */
  const lutChoices = useMemo(() => {
    const lib = lutLibrary ?? [];
    return [...lib, ...knownLuts().filter((l) => !lib.some((x) => sameLut(x, l)))];
  }, [lutLibrary, lutReload]);
  // The LUTs of this device the account does not list (imported before the library, or on another address of the
  // app): they join it.
  useEffect(() => {
    if (!onLutLibrary) return;
    const lib = lutLibrary ?? [];
    const missing = knownLuts().filter((l) => !lib.some((x) => sameLut(x, l)));
    if (missing.length) onLutLibrary((cur) => [...cur, ...missing.filter((m) => !cur.some((x) => x.id === m.id))], true);
  }, [!!lutLibrary, lutReload]); // eslint-disable-line react-hooks/exhaustive-deps
  // Each LUT of the account whose file is on this device and not yet on the Drive: sent there, its copy noted.
  const lutSent = useRef(new Set<string>());
  useEffect(() => {
    if (!driveWrite || !onLutLibrary) return;
    for (const l of lutLibrary ?? []) {
      if (l.driveId || lutSent.current.has(l.id)) continue;
      lutSent.current.add(l.id);
      void (async () => {
        const b = await getMedia(`lut:${l.id}`).catch(() => undefined);
        if (!b) { lutSent.current.delete(l.id); return; } // imported on another device: it sends it from there (looked at again when the library changes)
        try {
          const driveId = await uploadToDrive(b, `${l.name}.cube`, () => {}, new AbortController().signal, "application/octet-stream", { tktgen: "lut" }, DRIVE_PATHS.luts);
          onLutLibrary((cur) => cur.map((x) => (x.id === l.id ? { ...x, driveId } : x)), true);
          onSaveNow();
        } catch (e) { console.warn("[grade] LUT upload to Drive failed", e); lutSent.current.delete(l.id); }
      })();
    }
  }, [lutLibrary, driveWrite]); // eslint-disable-line react-hooks/exhaustive-deps

  // The look LUT is small: it goes to Drive by itself, so every browser and device finds it (see the LUT loading above).
  const lutUp = useRef<string | null>(null);
  useEffect(() => {
    const lut = settings.grade?.lut;
    if (!lut || lut.driveId || !look || !driveWrite || lutUp.current === lut.id) return;
    lutUp.current = lut.id;
    void (async () => {
      const b = await getMedia(`lut:${lut.id}`);
      if (!b) return;
      try {
        const driveId = await uploadToDrive(b, `${lut.name}.cube`, () => {}, new AbortController().signal, "application/octet-stream", { tktgen: "lut" }, DRIVE_PATHS.luts);
        // Every clip of the release using this LUT gets the link.
        onProject((p) => ({ ...p, videos: clipsOf(p).map((c) => (c.grade?.lut?.id === lut.id ? { ...c, grade: { ...c.grade, lut: { ...c.grade.lut, driveId } } } : c)) }));
        onSaveNow();
      } catch (e) {
        console.warn("[grade] LUT upload to Drive failed", e);
        lutUp.current = null;
      }
    })();
  }, [settings.grade?.lut, look, driveWrite]); // eslint-disable-line react-hooks/exhaustive-deps

  // The official audio imported from the computer goes to Drive by itself (once): any browser or device gets it back.
  // Each version of it too (its Drive id goes to that version, whichever video is open when the upload ends).
  const audioUp = useRef(new Set<string>());
  const uploadAudio = (blob: Blob, versionId: string, fileName?: string) => {
    const key = `${versionId}|${blob.size}`;
    if (!driveWrite || audioUp.current.has(key)) return;
    audioUp.current.add(key);
    const rel = releaseRef.current;
    const name = safeName(`${rel.name || "RAW"} - ${t("official audio")} - ${fileName ?? "audio"}`);
    void uploadToDrive(blob, name, () => {}, new AbortController().signal, blob.type || "application/octet-stream", { tktgen: "audio", project: rel.id }, DRIVE_PATHS.audios(rel.name || "Release"))
      .then((id) => {
        // Still the same file of the same version: remember where it is.
        onRelease((p) => (p.id !== rel.id ? p : versionId === mainAudioId(p)
          ? (p.audioSize === blob.size && !p.audioDriveId ? { ...p, audioDriveId: id } : p)
          : { ...p, audios: p.audios?.map((a) => (a.id === versionId && a.audioSize === blob.size && !a.audioDriveId ? { ...a, audioDriveId: id } : a)) }));
        onSaveNow();
      })
      .catch((e) => { console.warn("[drive] audio upload failed", e); audioUp.current.delete(key); });
  };
  useEffect(() => {
    // The blob must be this version's file (right after a switch it is still the previous version's: same size = same file).
    if (audioBlob && !project.audioDriveId && (!project.audioSize || project.audioSize === audioBlob.size)) uploadAudio(audioBlob, audioId, project.audioName);
  }, [audioBlob, project.audioDriveId, driveWrite, project.id, audioId]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The camera file from Drive, on a device that does not have it. */
  const fetchOriginal = async () => {
    const id = settings.drive?.originalId;
    if (!id || driveJob) return;
    const ac = new AbortController();
    driveAc.current = ac;
    setDriveErr(null);
    setDriveJob({ kind: "fetch", p: 0 });
    try {
      const blob = await downloadDriveFileProgress(id, (p) => setDriveJob({ kind: "fetch", p }), ac.signal);
      await putMedia(`video:${mediaId}`, blob).catch(() => {});
      fileClip.current = clip.id;
      setVideoBlob(blob);
    } catch (e) {
      if (!ac.signal.aborted) setDriveErr(t("The camera file could not be fetched from Google Drive."));
      console.warn("[drive] original download failed", e);
    } finally {
      if (driveAc.current === ac) driveAc.current = null;
      setDriveJob(null);
    }
  };

  // ---- The working copy for the other devices: made by itself once the take is synced ----
  // The passage used (+2 s), as rich as the take (lib/convert copyPlanFor), on the Drive; made again when the passage
  // moves out of it; 15 s after the last change (not while the sync is being set). Never from a copy.
  /**
   * The part of a camera file a working copy holds: what of it falls on the song where it is placed (the timeline is the
   * song: nothing past it is ever seen), its part kept on its track (`span`, trimmed); a little more on each side. A video
   * longer than the song: the song's length of it; shorter: all of it; never synced, a 10 min file: still only what lies
   * on the song where it was put (moved, its copy is made again).
   */
  const copyNeed = (off: number, span: [number, number], dur: number): [number, number] => {
    const song = audioBuf?.duration ?? Infinity;
    return [Math.max(0, span[0], -off), Math.min(dur, span[1], song - off)];
  };
  const copyRange = (off: number, span: [number, number], dur: number): [number, number] => {
    const [a, b] = copyNeed(off, span, dur);
    return [Math.max(0, a - 0.5), Math.min(dur, b + 0.5)];
  };
  /** A copy holds what it must (within 0.1 s: a sync nudged a hair needs no new copy). */
  const copyHolds = (cp: { from: number; to: number } | undefined, need: [number, number]) => !!cp && cp.from <= need[0] + 0.1 && cp.to >= need[1] - 0.1;
  const makeCopy = async (take?: { c: VideoSetup; blob: Blob; dur: number; off?: number; span?: [number, number] }) => {
    const blob = take ? take.blob : videoBlob;
    if (!blob || (!take && onCopy) || copyAc.current) return;
    const cur = settingsRef.current;
    const clipId = take ? take.c.id : clip.id;
    const videoDur = take ? take.dur : videoDurRef.current;
    // What of it falls on the song where it is placed (a camera of the multicam: its own sync; the video over it: its
    // place on its track; camera 1: the project's), its part kept on its track.
    const [from, to] = take
      ? copyRange(take.off ?? take.c.offset, take.span ?? [0, videoDur], videoDur)
      : copyRange(cur.offset, clipSpan(cur, videoDur), videoDur);
    const key = `${clipId}|${blob.size}|${from.toFixed(1)}|${to.toFixed(1)}`;
    if (to <= from || copyFailed.current === key) return;
    const ac = new AbortController();
    copyAc.current = ac;
    copyClip.current = clipId;
    const job = { clip: clipId, project: project.id, label: `${project.name} · ${clipName(take ? take.c : clip)}` };
    setCopyJob({ step: "make", p: 0, ...job });
    try {
      const plan = copyPlanFor(take ? take.c.source : cur.source);
      const name = take ? safeName(`${project.name || "RAW"} - ${clipName(take.c)} - ${t("copy")}.mp4`) : driveName(t("copy"));
      // The device's video chip first (seconds), ffmpeg when it cannot (minutes).
      const t0 = performance.now();
      // The progress redraws the studio: once per percent, not once per picture (that made the playback stutter).
      const every = (step: CopyJob["step"]) => { let shown = -1; return (p: number) => { const n = Math.floor(p * 100); if (n !== shown) { shown = n; setCopyJob({ step, p, ...job }); } }; };
      const onP = every("make");
      // While the video plays, the copy leaves the video chip to the player (it goes on once paused).
      const whilePlaying = () => !playingRef.current ? undefined : new Promise<void>((resolve) => {
        const id = window.setInterval(() => { if (!playingRef.current || ac.signal.aborted) { clearInterval(id); resolve(); } }, 250);
      });
      let copy: Blob | null = null, chip = false;
      try {
        const fast = await fastWorkCopy(blob, plan, from, to, onP, ac.signal, whilePlaying);
        if (fast) { copy = fast.blob; chip = true; }
      } catch (e) {
        if (ac.signal.aborted) throw e;
        console.warn("[copy] video chip failed, ffmpeg instead", e);
      }
      copy ??= await makeWorkCopy(blob, plan, from, to, onP, ac.signal);
      const tMade = performance.now();
      setCopyJob({ step: "send", p: 0, ...job });
      const id = await uploadToDrive(copy, name, every("send"), ac.signal, "video/mp4",
        { tktgen: "copy", clip: clipId, project: project.id, from: from.toFixed(3), to: to.toFixed(3), of: String(blob.size), bits: plan.tenBit ? "10" : "8" },
        DRIVE_PATHS.videos(project.name || "Release"));
      if (ac.signal.aborted) { void deleteDriveFile(id); return; }
      // Saved on its own video, even if another one is open now.
      let old: string | undefined;
      onProject((p) => ({ ...p, videos: clipsOf(p).map((c) => {
        if (c.id !== clipId) return c;
        old = c.drive?.copy?.id;
        return { ...c, drive: { ...(c.drive ?? {}), copy: { id, from, to, of: blob.size, size: copy.size, tenBit: plan.tenBit } } };
      }) }));
      onSaveNow();
      if (old && old !== id) void deleteDriveFile(old);
      setCopyErr(null);
      const secs = (ms: number) => String(Math.max(1, Math.round(ms / 1000)));
      setCopyTook({ clip: clipId, text: t("made in {make} s by {how}, sent in {send} s, {size} MB", {
        make: secs(tMade - t0), send: secs(performance.now() - tMade), how: chip ? t("the video chip") : "ffmpeg", size: String(Math.round(copy.size / 1e6)) }) });
      onToast?.(t("Drive copy updated: {video} (made in {make} s by {how}, sent in {send} s, {size} MB)", {
        video: job.label, make: secs(tMade - t0), send: secs(performance.now() - tMade),
        how: chip ? t("the video chip") : "ffmpeg", size: String(Math.round(copy.size / 1e6)),
      }));
    } catch (e) {
      if (!ac.signal.aborted) {
        console.warn("[copy] not made", e);
        copyFailed.current = key;
        setCopyErr(clipId);
        onToast?.(t("The Drive copy of {video} could not be made", { video: job.label }));
      }
    } finally {
      if (copyAc.current === ac) { copyAc.current = null; copyClip.current = null; }
      setCopyJob(null);
    }
  };
  useEffect(() => {
    // (also a video never synced, placed by hand on the video track: its copy holds the passage shown)
    if (!videoBlob || onCopy || !driveWrite || copyJob || !videoDur || !audioBuf) return; // (the song decides what to copy)
    // (what of the file falls on the song where it is placed: the copy holds it all)
    const need = copyNeed(settings.offset, clipSpan(settings, videoDur), videoDur);
    if (need[1] - need[0] < 0.5) return;
    const cp = settings.drive?.copy;
    if (cp && cp.of === videoBlob.size && copyHolds(cp, need)) return;
    const DELAY = 15_000;
    setCopyDueAt(Date.now() + DELAY);
    dueTimer.current = window.setTimeout(() => { dueTimer.current = null; setCopyDueAt(null); void makeCopy(); }, DELAY);
    return () => { if (dueTimer.current) clearTimeout(dueTimer.current); dueTimer.current = null; setCopyDueAt(null); };
  }, [videoBlob, onCopy, driveWrite, copyJob, settings.score, settings.offset, settings.clipIn, settings.clipOut, settings.drive?.copy, videoDur, audioBuf]); // eslint-disable-line react-hooks/exhaustive-deps
  // The project's other cameras: each gets its Drive working copy too (one after the other, after this video's own),
  // so another device opens the multicam. 15 s after the passage last moved, never while playing.
  useEffect(() => {
    if (!driveWrite || copyJob || copyDueAt || playing || !audioBuf) return;
    // (and the videos over it, placed on their own tracks: each copy holds what of it falls on the song there)
    const ovs = overlaysOf(settings);
    const next = [...(settings.angles ?? []), ...ovs.map((o) => o.clip)].map((id) => [clips.find((c) => c.id === id), anglesRef.current.get(id)] as const).find(([c, a]) => {
      const ov = c ? ovs.find((o) => o.clip === c.id) : undefined;
      if (!c || !a || a.fromCopy || (c.score === undefined && !ov)) return false;
      const dur = a.el.duration;
      if (!Number.isFinite(dur)) return false;
      const off = ov ? ov.offset : c.offset, need = copyNeed(off, ov ? clipSpan(ov, dur) : [0, dur], dur), cp = c.drive?.copy;
      if (need[1] - need[0] < 0.5) return false;
      return !(cp && cp.of === a.blob.size && copyHolds(cp, need));
    });
    if (!next) return;
    const [c, a] = next;
    const nov = ovs.find((o) => o.clip === c!.id), dur = a!.el.duration;
    const id = window.setTimeout(() => void makeCopy({ c: c!, blob: a!.blob, dur, off: nov ? nov.offset : undefined, span: nov ? clipSpan(nov, dur) : undefined }), 15_000);
    return () => clearTimeout(id);
  }, [driveWrite, copyJob, copyDueAt, playing, angleRev, anglesKey, audioBuf, overlaysOf(settings).map((o) => `${o.offset}|${o.clipIn}|${o.clipOut}`).join()]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Make the copy now (no countdown). */
  const copyNow = () => {
    if (dueTimer.current) { clearTimeout(dueTimer.current); dueTimer.current = null; }
    setCopyDueAt(null);
    copyFailed.current = null;
    setCopyErr(null);
    void makeCopy();
  };
  // The countdown moves once a second.
  useEffect(() => {
    if (!copyDueAt) return;
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [copyDueAt]);
  // The passage changed and the copy already holds it: said for a moment (nothing to make).
  const cropSeen = useRef<string | null>(null);
  useEffect(() => {
    const k = `${clip.id}|${settings.crop.start}|${settings.crop.duration}`;
    const first = cropSeen.current === null || !cropSeen.current.startsWith(clip.id + "|");
    cropSeen.current = k;
    const cp = settings.drive?.copy;
    if (first || !cp || !videoBlob || onCopy || copyJob) return;
    const segS = settings.crop.start - settings.offset, segE = segS + settings.crop.duration;
    if (!(cp.from <= Math.max(0, segS - 0.3) + 1e-3 && cp.to >= Math.min(videoDur || Infinity, segE + 0.3) - 1e-3)) return;
    setCopyFits(true);
    const id = window.setTimeout(() => setCopyFits(false), 2500);
    return () => clearTimeout(id);
  }, [settings.crop.start, settings.crop.duration]); // eslint-disable-line react-hooks/exhaustive-deps
  // Another video: no message of the previous one.
  useEffect(() => { setCopyFits(false); setCopyErr(null); }, [clip.id]);

  /**
   * Where the Drive copy of the open video stands, one wording for every place (under the preview, the library's
   * tile): its state, how far it is (the ring), and what can be done (make it now, try again).
   */
  const copyState = ((): null | { text: string; p: number; busy?: boolean; ok?: boolean; bad?: boolean; action?: { label: string; run: () => void }; hint?: string } => {
    const cp = settings.drive?.copy;
    const q = cp?.tenBit ? t("10-bit, as filmed") : t("1080p+, as filmed");
    // (Linking the original is in the video's "⋯" menu, in the library: not again here.)
    if (onCopy && cp) return { text: t("You work on the Drive copy"), p: 1,
      hint: t("The camera file is not in this browser (imported on another device, in another browser, or at another address of the app: a website never sees your files by itself). You work here on its copy from your Drive ({quality}, the passage used). If the original is on this computer, “Link the original file” (the video's ⋯ menu, in the library) plugs it back: the sync and the settings are kept.", { quality: q }) };
    if (copyJob?.clip === clip.id) return { text: copyJob.step === "make" ? t("Copy for your other devices… {n}%", { n: Math.round(copyJob.p * 100) }) : t("Sending the copy to your Drive… {n}%", { n: Math.round(copyJob.p * 100) }),
      p: copyJob.p, busy: true, hint: t("Keep this page open until it is done: leaving it stops the copy (it starts again next time).") };
    if (copyJob) return { text: t("Another video's copy first: {video}", { video: copyJob.label }), p: 0, busy: true };
    if (copyErr === clip.id) return { text: t("The Drive copy could not be made"), p: 0, bad: true, action: { label: t("Try again"), run: copyNow } };
    if (copyDueAt) {
      const n = Math.max(1, Math.ceil((copyDueAt - Date.now()) / 1000));
      return { text: cp ? t("The passage goes past the copy: new copy in {n} s", { n }) : t("Drive copy in {n} s", { n }), p: 0, busy: true, action: { label: t("Now"), run: copyNow } };
    }
    const took = copyTook?.clip === clip.id ? ` · ${copyTook.text}` : "";
    if (copyFits) return { text: t("Passage already in the copy") + took, p: 1, ok: true };
    if (cp && videoBlob && cp.of === videoBlob.size) return { text: t("Drive copy up to date") + took, p: 1, ok: true,
      hint: t("A copy of the passage used ({quality}) is on your Drive: open this video on another device to go on working there.", { quality: q }) };
    return null;
  })();
  const copyStatusEl = (compact = false) => compact && onCopy && settings.drive?.copy ? (
    // The library's tile, on the copy: its badge and the part of the take it holds, on one line.
    // "whole": it holds the whole take (the phone's library then leaves out its range: the length is beside the name).
    <span className={"copy-status compact on-copy xs" + (settings.drive.copy.from < 0.5 && settings.drive.copy.to >= (settings.source?.duration ?? videoDur) - 0.5 ? " whole" : "")}>
      <span className="pill-copy">{t("Drive copy")}</span>
      <span className="mono">{fmtLength(settings.drive.copy.from)} → {fmtLength(settings.drive.copy.to)}</span>
      {copyState?.hint && <Hint text={copyState.hint} />}
    </span>
  ) : compact && copyState?.ok ? (
    // The library's tile, the copy on the Drive and up to date (this device works on the original): "Backed up", outlined
    // with a ✓ (the filled "Drive copy" says the copy is the one in use); its (i): on the Drive, for the other devices.
    <span className="copy-status compact xs" title={copyState.text}>
      <span className="pill-copy ready"><Icon name="check" size={10} />{t("Backed up")}</span>
      {copyState.hint && <Hint text={copyState.hint} />}
    </span>
  ) : copyState && (
    <span className={"copy-status copy-full xs" + (copyState.busy ? " busy" : "") + (copyState.ok ? " ok" : "") + (copyState.bad ? " bad" : "") + (compact ? " compact" : "")}>
      {copyState.ok ? <Icon name="check" size={12} /> : <span className="bg-ring" style={{ "--p": copyState.p } as CSSProperties} aria-hidden />}
      <span className={copyState.busy ? "shine" : undefined}>{copyState.text}</span>
      {/* What can be done, and its (i): together, under the text when the tile is narrow. */}
      {(copyState.action || copyState.hint) && (
        <span className="copy-tail">
          {copyState.action && <button type="button" className="btn sm quiet copy-act" onClick={copyState.action.run}>{copyState.action.label}</button>}
          {copyState.hint && <Hint text={copyState.hint} />}
        </span>
      )}
    </span>
  );

  // No camera file here and no copy opened: its copy arrived since (the data came after the video opened), or it is on
  // the Drive without the data saying so (the page that made it was left at once): found by its label, opened.
  const copyLook = useRef<string | null>(null);
  useEffect(() => {
    if (videoBlob || onCopy || loadedClip !== clip.id || !settings.videoName || driveJob) return;
    const want = `${clip.id}|${clip.drive?.copy?.id ?? ""}`;
    if (copyLook.current === want) return;
    copyLook.current = want;
    let off = false;
    void (async () => {
      let cp: { id: string; size: number } | undefined = clip.drive?.copy;
      if (!cp) {
        const found = (await listAppFiles("copy").catch(() => [])).filter((f) => f.appProperties?.clip === clip.id);
        const f = found[found.length - 1];
        if (!f) return;
        cp = { id: f.id, size: Number(f.size ?? 0) };
        copyLook.current = `${clip.id}|${f.id}`; // the data gets this copy below: not looked for (nor fetched) again
        const a = f.appProperties;
        // Written into the data, so every device finds it at once next time.
        if (a.to && a.of) onProject((p) => ({ ...p, videos: clipsOf(p).map((c) => (c.id === clip.id && !c.drive?.copy
          ? { ...c, drive: { ...(c.drive ?? {}), copy: { id: f.id, from: Number(a.from ?? 0), to: Number(a.to), of: Number(a.of), size: Number(f.size ?? 0), tenBit: a.bits === "10" } } } : c)) }));
      }
      const cb = await copyBlob(cp, () => off);
      if (cb && !off && openClip.current === clip.id) { fileClip.current = clip.id; copyShown.current = cp.id; setOnCopy(true); setVideoBlob(cb); }
    })();
    return () => { off = true; };
  }, [videoBlob, onCopy, loadedClip, clip.id, clip.drive?.copy?.id, settings.videoName]); // eslint-disable-line react-hooks/exhaustive-deps

  // On the copy, the passage goes past it: a longer copy of this video may be on the Drive without the data saying
  // so (made on the other device, its save lost): looked for by its label, written into the data (then fetched below).
  const longerLook = useRef<string | null>(null);
  useEffect(() => {
    const cp = settings.drive?.copy;
    if (!onCopy || !cp) return;
    const segS = settings.crop.start - settings.offset, segE = segS + settings.crop.duration;
    if (segS >= cp.from - 0.05 && segE <= cp.to + 0.05) return;
    const key = `${clip.id}|${cp.id}|${segS.toFixed(1)}|${segE.toFixed(1)}`;
    if (longerLook.current === key) return;
    longerLook.current = key;
    void listAppFiles("copy").then((files) => {
      const better = files
        .filter((f) => f.appProperties?.clip === clip.id && f.id !== cp.id && f.appProperties.to)
        .map((f) => ({ f, from: Number(f.appProperties.from ?? 0), to: Number(f.appProperties.to) }))
        .filter((x) => x.to > cp.to + 0.05 || x.from < cp.from - 0.05)
        .sort((a, b) => (b.to - b.from) - (a.to - a.from))[0];
      if (!better) return;
      const a = better.f.appProperties;
      onProject((p) => ({ ...p, videos: clipsOf(p).map((c) => (c.id === clip.id
        ? { ...c, drive: { ...(c.drive ?? {}), copy: { id: better.f.id, from: better.from, to: better.to, of: Number(a.of ?? cp.of), size: Number(better.f.size ?? 0), tenBit: a.bits ? a.bits === "10" : cp.tenBit } } } : c)) }));
      onSaveNow();
    }).catch(() => {});
  }, [onCopy, settings.drive?.copy?.id, settings.crop.start, settings.crop.duration, settings.offset]); // eslint-disable-line react-hooks/exhaustive-deps

  // The copy was made again on the device that has the camera file (a longer passage): this one gets the new copy.
  useEffect(() => {
    const id = settings.drive?.copy?.id;
    if (!onCopy || !id || !copyShown.current || copyShown.current === id) return;
    copyShown.current = null;
    void delMedia(`copy:${clip.id}`).catch(() => {});
    setOnCopy(false);
    setVideoBlob(null); // the copy finder above fetches the new one
  }, [onCopy, settings.drive?.copy?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // The shell shows the copy's progress wherever the user is.
  useEffect(() => { onCopyJob?.(copyJob); }, [copyJob]); // eslint-disable-line react-hooks/exhaustive-deps

  // A copy on its way: leaving the page (reload, close) would lose it, the browser asks first. Opening another video
  // does not stop it: it ends and is saved on its own video.
  // While a copy is made, the screen stays on (a phone that sleeps stops the page, and the copy with it).
  const copying = !!copyJob;
  useEffect(() => {
    if (!copying) return;
    type Lock = { release: () => Promise<void> };
    const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<Lock> } };
    let lock: Lock | null = null;
    let off = false;
    const take = () => { if (document.visibilityState === "visible") nav.wakeLock?.request("screen").then((l) => { if (off) void l.release(); else lock = l; }).catch(() => {}); };
    take();
    document.addEventListener("visibilitychange", take); // the lock goes when the page is hidden: taken again on return
    return () => { off = true; document.removeEventListener("visibilitychange", take); void lock?.release().catch(() => {}); };
  }, [copying]);
  useEffect(() => {
    if (!copyJob) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [copyJob]);

  useEffect(() => () => { stop(); syncRef.current?.abort(); genRef.current?.abort(); stopTranscribe(); stopAlign(); ctxRef.current?.close().catch(() => {}); }, [stop]);
  // Hidden behind the carousel: the sound stops; a sync or a lyrics placement in progress goes on and ends by itself.
  useEffect(() => { if (!active) stop(); }, [active, stop]);


  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 3500);
    return () => clearTimeout(id);
  }, [note]);

  // ---- the versions of the audio (lib/audioVersions): a demo, the master, a sped up… each video on one of them ----
  /** A new audio while this video has one: kept next to it as another version; asked first which videos go on it. */
  const [audioAsk, setAudioAsk] = useState<{ f: File; driveId?: string; busy?: boolean } | null>(null);
  const [remapReport, setRemapReport] = useState<(RemapReport & { notSame?: boolean; to?: string }) | null>(null);
  /** Videos going onto another version (what is being done). */
  const [audioBusy, setAudioBusy] = useState<string | null>(null);
  /** Below this share of the earlier version found in the other one, it is not the same song. */
  const SAME_SONG = 0.4;

  /** A version's audio, decoded: the open one as it is, another one read from the device or fetched from the Drive. */
  const bufferOf = async (id: string): Promise<{ blob: Blob; buf: AudioBuffer } | null> => {
    if (id === audioId && audioBlob && audioBuf) return { blob: audioBlob, buf: audioBuf };
    const v = audioVersionsOf(releaseRef.current).find((x) => x.id === id);
    let blob = await getMedia(audioKey(id)).catch(() => undefined);
    if (!blob && v?.audioDriveId) {
      try { blob = await downloadDriveFile(v.audioDriveId); void putMedia(audioKey(id), blob).catch(() => {}); } catch { /* not reachable now */ }
    }
    if (!blob) return null;
    try { return { blob, buf: await decodeAudio(getCtx(), blob) }; } catch { return null; }
  };
  /** Where the music of one version is in another (lib/audioRemap). */
  const mapBetween = (a: AudioBuffer, b: AudioBuffer) => trackMap(alignTracks(monoOf(a), a.sampleRate, monoOf(b), b.sampleRate), a.duration, b.duration);

  /**
   * Videos put on another version of the audio (`to`): each one moved to where its music is in it, from whichever
   * version it was on (its sync, its takes, every version's segment); one on another song starts its sync over. The
   * open one plays the new version at once. `known`: the target already decoded, maps already made.
   */
  const switchAudio = async (ids: string[], to: string, known?: { blob: Blob; buf: AudioBuffer; maps?: Map<string, TrackMap | null>; name?: string; label?: string; words?: { moved: number; dropped: number } }) => {
    const rel = releaseRef.current;
    const from = [...new Set(clipsOf(rel).filter((c) => ids.includes(c.id) && audioIdOf(rel, c) !== to).map((c) => audioIdOf(rel, c)))];
    if (!from.length) return;
    const ver = audioVersionsOf(rel).find((x) => x.id === to);
    stop();
    syncRef.current?.abort();
    setAudioBusy(t("Finding the music of each video in this version…"));
    await new Promise((r) => setTimeout(r, 40));
    try {
      const target = known ?? await bufferOf(to);
      if (!target) { setErr(t("This version of the audio could not be read on this device (nor fetched from the Drive).")); return; }
      const maps = new Map<string, TrackMap | null>(known?.maps ?? []);
      for (const id of from) if (!maps.has(id)) { const src = await bufferOf(id); maps.set(id, src ? mapBetween(src.buf, target.buf) : null); }
      const name = known?.name ?? ver?.audioName;
      const videos: RemapReport["videos"] = [];
      let restarted = 0;
      onRelease((p) => ({
        ...p,
        videos: clipsOf(p).map((c) => {
          const fromId = audioIdOf(p, c);
          if (!ids.includes(c.id) || fromId === to) return c;
          const m = maps.get(fromId);
          const audio = { audioId: to === mainAudioId(p) ? undefined : to, audioName: name };
          if (!m || sharedShare(m) < SAME_SONG) {
            restarted++;
            return { ...c, ...audio, offset: 0, score: undefined, musicStart: undefined, musicEnd: undefined, anchors: undefined, takes: undefined, linked: false };
          }
          const r = remapClip(c, m);
          videos.push(r.report);
          return { ...r.clip, ...audio };
        }),
      }));
      if (ids.includes(clip.id)) {
        setAudioBlob(target.blob);
        setAudioBuf(target.buf);
        setPeaks(peaksOf(target.buf.getChannelData(0)));
        setHead(settingsRef.current.crop.start);
      }
      const only = maps.size === 1 ? [...maps.values()][0] : null;
      setRemapReport({ shift: only ? uniformShift(only) : null, coverage: only ? coverage(only) : 1, videos, words: known?.words ?? { moved: 0, dropped: 0 },
        notSame: restarted > 0 && !videos.length, to: known?.label ?? (ver ? audioLabel(ver) : undefined) });
      onSaveNow();
    } finally { setAudioBusy(null); }
  };

  /** A new version of the audio, kept next to the others; this video, all of them, or none go on it. Its lyrics
   *  timing comes from the open version's (moved to where the same words are sung in it). */
  const addAudioVersion = async (f: File, driveId: string | undefined, use: "this" | "all" | "keep") => {
    setAudioAsk({ f, driveId, busy: true });
    const id = uid();
    try {
      void askPersistentStorage();
      try { await putMedia(audioKey(id), f); } catch { /* private mode: in memory only */ }
      let buf: AudioBuffer;
      try { buf = await decodeAudio(getCtx(), f); } catch { setErr(t("Could not read this audio file.")); return; }
      await new Promise((r) => setTimeout(r, 40));
      const m = audioBuf ? mapBetween(audioBuf, buf) : null;
      const sameSong = !!m && sharedShare(m) >= SAME_SONG;
      const words = { moved: 0, dropped: 0 };
      const cur = project;
      const version: AudioVersion = {
        id, audioName: f.name, audioSize: f.size, audioDriveId: driveId,
        ...(sameSong && m ? { lyricWords: remapWords(m, cur.lyricWords, words), heardWords: remapWords(m, cur.heardWords), lyricsPlacedFrom: cur.lyricsPlacedFrom, lyricsAlignV: cur.lyricsAlignV } : null),
      };
      // An excerpt of the song (clearly shorter): the written lines found in it are the only ones it will ever place.
      if (sameSong && m && m.newDur < m.oldDur * 0.85) {
        const ls = (version.lyricWords ?? []).map((w) => w.line).filter((l): l is number => l !== undefined);
        const was = cur.lyricLines;
        if (ls.length) version.lyricLines = [Math.max(was?.[0] ?? 0, Math.min(...ls)), Math.min(was?.[1] ?? Infinity, Math.max(...ls))];
        // (the longer one had its lyrics placed, none sung in this part, an intro: no line here)
        else if (cur.lyricWords?.length) version.lyricLines = [0, -1];
      }
      onRelease((p) => ({ ...p, audios: [...(p.audios ?? []), version] }));
      if (!driveId) uploadAudio(f, id, f.name);
      if (use === "keep") { onSaveNow(); onToast?.(t("“{name}” is in the library: pick it for a video when you need it.", { name: audioLabel(version) })); return; }
      const ids = use === "all" ? clipsOf(releaseRef.current).map((c) => c.id) : [clip.id];
      await switchAudio(ids, id, { blob: f, buf, maps: new Map([[audioId, m]]), name: f.name, label: audioLabel(version), words });
    } finally { setAudioAsk(null); }
  };

  /**
   * Import the official audio. `driveId`: picked from Google Drive, so it can be fetched again anywhere. Another file
   * while this video has its audio: a new version of it, kept next to it (asked first which videos go on it, `use`).
   */
  const pickAudio = async (f: File, driveId?: string, use?: "this" | "all" | "keep") => {
    // Same file again (lost from this device, or another computer): the lyrics timing and the sync stay.
    const same = project.audioSize === f.size && project.audioName === f.name;
    if (!same && audioBlob && project.audioName) {
      if (use) await addAudioVersion(f, driveId, use);
      else setAudioAsk({ f, driveId });
      return;
    }
    const token = ++ioRef.current;
    syncRef.current?.abort();
    stop();
    setErr(null); setNote(null);
    setAudioBlob(f);
    setAudioBuf(null);
    setPeaks([]);
    // Another file where this version's was lost from the device: it takes its place, the previous file of it goes to
    // the Drive's bin (if no other release uses it).
    const old = !same && !driveId ? project.audioDriveId : undefined;
    if (old && !audioUsedElsewhere?.(old)) void trashDriveFile(old);
    onProject((p) => (same
      ? { ...p, audioName: f.name, audioDriveId: driveId ?? p.audioDriveId }
      : { ...p, audioName: f.name, audioSize: f.size, audioDriveId: driveId, heardWords: undefined, lyricWords: undefined }));
    if (!same) setV({ audioName: f.name, offset: 0, score: undefined, musicStart: undefined, musicEnd: undefined, anchors: undefined, takes: undefined, linked: false });
    void askPersistentStorage();
    try { await putMedia(projectAudioKey, f); } catch { /* private mode: keep it in memory */ }
    onSaveNow();
    try {
      const buf = await decodeAudio(getCtx(), f);
      if (token !== ioRef.current) return;
      setAudioBuf(buf);
      setPeaks(peaksOf(buf.getChannelData(0)));
      const cur = settingsRef.current;
      const d = Math.min(cur.crop.duration, buf.duration);
      const start = Math.max(0, Math.min(cur.crop.start, buf.duration - d));
      setV({ crop: { start, duration: d } });
      setHead(start);
      onSaveNow();
    } catch {
      if (token === ioRef.current) setErr(t("Could not read this audio file."));
    }
  };

  /**
   * "Replace from this computer": another file for the open version of the audio (a new master, a longer export…), the
   * same version kept. The same song: its lyrics and the videos on it move to where the same music is in the new file (as
   * for a new version); another song: everything starts again, as a first import. The old file leaves the device and the
   * Drive (to the bin, unless another release uses it).
   */
  const replaceAudio = async (f: File) => {
    const old = audioBuf;
    stop();
    syncRef.current?.abort();
    setErr(null); setNote(null);
    setAudioBusy(t("Finding the music of each video in this version…"));
    try {
      let buf: AudioBuffer;
      try { buf = await decodeAudio(getCtx(), f); } catch { setErr(t("Could not read this audio file.")); return; }
      await new Promise((r) => setTimeout(r, 40));
      const m = old ? mapBetween(old, buf) : null;
      const sameSong = !!m && sharedShare(m) >= SAME_SONG;
      const id = audioId, oldDrive = project.audioDriveId;
      try { await putMedia(audioKey(id), f); } catch { /* private mode: in memory only */ }
      const words = { moved: 0, dropped: 0 };
      // The version's own fields (its file, its lyrics), moved or started again.
      onProject((p) => ({ ...p, audioName: f.name, audioSize: f.size, audioDriveId: undefined, lyricLines: undefined,
        ...(sameSong && m ? { lyricWords: remapWords(m, p.lyricWords, words), heardWords: remapWords(m, p.heardWords) } : { lyricWords: undefined, heardWords: undefined }) }));
      // Every video on this version: moved with the music, or its sync to do again.
      const videos: RemapReport["videos"] = [];
      onRelease((p) => ({ ...p, videos: clipsOf(p).map((c) => {
        if (audioIdOf(p, c) !== id) return c;
        if (!sameSong || !m) return { ...c, audioName: f.name, offset: 0, score: undefined, musicStart: undefined, musicEnd: undefined, anchors: undefined, takes: undefined, linked: false };
        const r = remapClip(c, m);
        videos.push(r.report);
        return { ...r.clip, audioName: f.name };
      }) }));
      setAudioBlob(f);
      setAudioBuf(buf);
      setPeaks(peaksOf(buf.getChannelData(0)));
      uploadAudio(f, id, f.name);
      if (oldDrive && !audioUsedElsewhere?.(oldDrive)) void trashDriveFile(oldDrive);
      if (sameSong && m) setRemapReport({ shift: uniformShift(m), coverage: coverage(m), videos, words, notSame: false, to: f.name.replace(/\.[a-z0-9]{2,4}$/i, "") });
      else onToast?.(t("Another song: its lyrics and the sync of its videos start again."));
      onSaveNow();
    } finally { setAudioBusy(null); }
  };
  /** A version of the audio taken out of the library: its videos go back on the main audio first (moved with the
   *  music), its file leaves the device and the Drive (to the bin, unless another release uses it). */
  const removeAudioVersion = async (id: string) => {
    const rel = releaseRef.current;
    const v = rel.audios?.find((x) => x.id === id);
    if (!v) return;
    const on = clipsOf(rel).filter((c) => audioIdOf(rel, c) === id).map((c) => c.id);
    if (on.length) await switchAudio(on, mainAudioId(rel));
    onRelease((p) => ({ ...p, audios: p.audios?.filter((x) => x.id !== id) }));
    void delMedia(audioKey(id)).catch(() => {});
    if (v.audioDriveId && !audioUsedElsewhere?.(v.audioDriveId)) void trashDriveFile(v.audioDriveId);
    onSaveNow();
  };

  /**
   * The same camera file again (another browser, another address of the app, data cleared): plugged back, the sync and
   * every setting kept. `anyName`: the user said it is the original (its size decides, the name may have changed).
   */
  const relinkVideo = async (f: File, anyName = false): Promise<boolean> => {
    const cur = settingsRef.current;
    if (!((!videoBlob || onCopy) && (cur.videoName === f.name || (anyName && cur.videoSize)))) return false;
    {
      const info = await probeVideo(f);
      const same = cur.videoSize ? cur.videoSize === f.size
        : !!info.duration && !!cur.source?.duration && Math.abs(info.duration - cur.source.duration) < 0.05;
      if (same) {
        fileClip.current = clip.id;
        // Back on the camera file (it was the Drive copy): the original is used again, the copy stays on the Drive.
        if (onCopy) { setOnCopy(false); void delMedia(`copy:${clip.id}`).catch(() => {}); }
        setVideoBlob(f);
        if (!cur.videoSize) setV({ videoSize: f.size });
        void askPersistentStorage();
        try { await putMedia(`video:${mediaId}`, f); } catch { /* private mode: keep it in memory */ }
        setNote(t("Camera file found again: the sync and the settings are kept."));
        return true;
      }
    }
    return false;
  };
  /** "Link the original file": only the same camera file is taken (never a new take by mistake). */
  const pickOriginal = async (f: File) => {
    syncRef.current?.abort();
    stop();
    setErr(null);
    if (!(await relinkVideo(f, true))) setErr(t("This is not the same camera file ({name}). Pick the original, or use “Replace” for another take.", { name: settingsRef.current.videoName ?? "" }));
  };

  const pickVideo = async (f: File) => {
    syncRef.current?.abort();
    stop();
    setErr(null);
    const cur = settingsRef.current;
    if (await relinkVideo(f)) return;
    // A new take: the working copy of the previous one leaves the Drive and this device.
    stopCopyOf(clip.id);
    if (cur.drive?.copy?.id) void deleteDriveFile(cur.drive.copy.id);
    setOnCopy(false);
    void delMedia(`copy:${clip.id}`).catch(() => {});
    // The light copy and the picture of the previous file go first, so they are never shown for this one.
    posterRef.current = null;
    stillRef.current = null;
    // Its own files from now on: the ones read by another video (its duplicate, or the one it duplicates) stay.
    if (!sharedFiles()) {
      await delMedia(posterKey).catch(() => {});
      if (clip.media) await delMedia(`video:${clip.media}`).catch(() => {}); // the files it was reading, nobody's now
    }
    const media = sharedFiles(clip.id) ? uid() : undefined; // its own key is still another video's: a new one
    fileClip.current = clip.id;
    setVideoBlob(f);
    setVideoDur(0);
    setV({ media, videoName: f.name, videoSize: f.size, source: undefined, drive: undefined, offset: 0, score: undefined, musicStart: undefined, musicEnd: undefined, anchors: undefined, takes: undefined, linked: false });
    setHead(settingsRef.current.crop.start);
    void askPersistentStorage();
    void describeVideo(f, true);
    try { await putMedia(`video:${media ?? clip.id}`, f); } catch { /* private mode: keep it in memory */ }
    onSaveNow();
  };

  /**
   * Read what the file is (camera or phone, log / HDR / SDR). Log and HDR footage gets the matching
   * conversion at once (log: with the last look LUT imported); standard SDR footage is left as it is.
   */
  const describeVideo = async (f: Blob, fresh: boolean) => {
    const info = await probeVideo(f);
    const cur = settingsRef.current;
    if (cur.grade && !fresh) { setV({ source: info }); return; } // an older video read again: its grade stays as set
    setV({ source: info, ...gradeForSource(info, cur.grade) });
  };
  /** The grade a file gets when it comes in. */
  const gradeForSource = (info: VideoSourceInfo, prevGrade: VideoGrade | undefined): { grade?: VideoGrade } => {
    // A phone that says nothing about its colours films standard SDR.
    const colour = info.colour === "unknown" && info.kind === "phone" ? "sdr" : info.colour;
    if (colour === "log" && info.profile) {
      // Log: the camera's conversion, the look LUT and the sliders of the previous video (same camera, most likely).
      const prev = prevGrade?.profile !== "none" && prevGrade?.profile !== "hlg" && prevGrade?.profile !== "pq" && prevGrade?.profile !== "rec709" ? prevGrade : undefined;
      return { grade: { ...NEUTRAL_GRADE, ...(prev ?? {}), profile: info.profile, lut: prev?.lut ?? lastLut() } };
    }
    // HDR: brought down to SDR, no look LUT (made for log footage) and no log sliders.
    if (colour === "hdr" && info.profile) return { grade: { ...NEUTRAL_GRADE, profile: info.profile } };
    // Standard video: no log conversion, no LUT; the simple sliders are there, all at zero (the picture as it is).
    if (colour === "sdr") return { grade: { ...NEUTRAL_GRADE, profile: "rec709" } };
    return {};
  };
  // Standard SDR video: no log conversion, no LUT, nothing applied (sliders at zero) unless turned back on by hand.
  // Also puts right a video graded by an older version (LUT, vignette and grain copied from a log video).
  const sdrSource = settings.source?.colour === "sdr" || (settings.source?.kind === "phone" && settings.source.colour === "unknown");
  useEffect(() => {
    const g = settings.grade;
    if (sdrSource && g && !g.sdrOverride && (g.lut || g.profile !== "rec709")) setV({ grade: { ...NEUTRAL_GRADE, profile: "rec709" } });
  }, [sdrSource, settings.grade]); // eslint-disable-line react-hooks/exhaustive-deps

  // Videos imported before the detection existed (or before it read the duration, the frame rate): read them once.
  useEffect(() => {
    if (videoBlob && !onCopy && (!settings.source || settings.source.duration === undefined || settings.source.fps === undefined)) void describeVideo(videoBlob, false);
  }, [videoBlob, clip.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // The duration read from the file's index: the video band shows at once, before the player opened the file.
  useEffect(() => {
    const d = settings.source?.duration;
    if (videoBlob && d && !videoDur) setVideoDur(d);
  }, [videoBlob, settings.source?.duration, videoDur]);

  const removeAudio = async () => {
    ioRef.current++;
    syncRef.current?.abort();
    stop();
    setAudioBlob(null);
    setAudioBuf(null);
    setPeaks([]);
    setConfirmRemove(false);
    onProject((p) => ({ ...p, audioName: undefined, audioSize: undefined, audioDriveId: undefined, heardWords: undefined, lyricWords: undefined }));
    setV({ audioName: undefined, offset: 0, score: undefined, musicStart: undefined, musicEnd: undefined, anchors: undefined, takes: undefined, linked: false });
    setHead(settingsRef.current.crop.start);
    await delMedia(projectAudioKey);
    await delMedia(`audio:${clip.id}`);
    onSaveNow();
  };

  const removeVideo = async () => {
    syncRef.current?.abort();
    stopCopyOf(clip.id);
    stop();
    if (settingsRef.current.drive?.copy?.id) void deleteDriveFile(settingsRef.current.drive.copy.id);
    setOnCopy(false);
    void delMedia(`copy:${clip.id}`).catch(() => {});
    setVideoBlob(null);
    setVideoDur(0);
    // Another video still reads these files: they stay, this one stops reading them (a duplicate: its own key, empty;
    // the video it was made from: a new, empty one).
    const shared = sharedFiles();
    setV({ ...(shared ? { media: clip.media ? undefined : uid() } : {}), videoName: undefined, source: undefined, drive: undefined, offset: 0, score: undefined, musicStart: undefined, musicEnd: undefined, anchors: undefined, takes: undefined, linked: false });
    setHead(settingsRef.current.crop.start);
    posterRef.current = null;
    if (!shared) { await delMedia(`video:${mediaId}`); await delMedia(posterKey); }
    onSaveNow();
  };

  /** "Video 3": the next free number (after a deletion, clips.length + 1 could repeat a name). */
  // (this release's videos only: the takes imported are stored as videos too, and made "Video 7" of the second one)
  const nextClipName = () => `Video ${Math.max(projects.length, ...projects.map((c) => Number(/^Video (\d+)$/.exec(c.name)?.[1] ?? 0))) + 1}`;
  /** The same video again: same camera file (read, not copied), sync and every version. To try other choices without
   *  touching this one; its Drive working copy is made for it (one per video: each one's passage). */
  const duplicateClip = () => {
    syncRef.current?.abort();
    stop();
    const cur = settingsRef.current;
    const id = uid();
    onProject((p) => ({
      ...p,
      videos: [...clipsOf(p), {
        ...cur,
        id,
        name: nextClipName(),
        media: mediaId,
        versions: cur.versions?.length ? withShown(cur) : undefined,
        drive: cur.drive ? { ...cur.drive, copy: undefined } : undefined,
      }],
      videoId: id,
    }));
    onSaveNow();
    onToast?.(t("Video duplicated: change anything on it, the first one stays as it was"));
  };
  /**
   * A new video on the release, from scratch: the release's song (the same version of the audio) and its lyrics (shared,
   * locked lines kept), the lyrics' look and the segment; no camera file, no takes, no hooks, no videos over it, no
   * grade. ("Duplicate" in the ⋯ menu is the same video again.)
   */
  const addVideo = async () => {
    syncRef.current?.abort();
    stop();
    const id = uid();
    const name = nextClipName();
    const cur = settingsRef.current;
    onProject((p) => ({
      ...p,
      videos: [
        ...clipsOf(p),
        {
          ...defaultVideo(),
          id,
          name,
          audioId: cur.audioId,
          audioName: audioBlob ? cur.audioName : undefined,
          crop: cur.crop,
          format: cur.format,
          // the lyrics as they look on the others
          captions: cur.captions,
          captionMode: cur.captionMode,
          captionStyle: cur.captionStyle,
          lineChars: cur.lineChars,
          wordTiming: cur.wordTiming,
          litDim: cur.litDim,
          litSweep: cur.litSweep,
        },
      ],
      videoId: id,
    }));
    onSaveNow();
  };

  const [clipDialog, setClipDialog] = useState<null | "rename" | "delete">(null);
  /** Shown name of a video: the automatic "Video 2" in the interface language. */
  /** The videos by what their file needs: to be graded (log, HDR, from a camera or a phone), standard (SDR), then
   *  the others (no file yet, colours unknown); one group alone has no title. */
  const clipGroups = (list: VideoSetup[]) => {
    const kind = (c: VideoSetup) => {
      const col = c.source?.colour === "unknown" && c.source.kind === "phone" ? "sdr" : c.source?.colour; // as describeVideo
      // A file that does not say (a camera file without its Sony note…) graded with a log profile: log.
      const logGraded = !!c.grade?.profile && ["slog3", "slog3-cine", "applelog"].includes(c.grade.profile);
      // Log (to grade), HDR (a phone's, mostly: brought down to SDR by itself), standard SDR, then the others.
      return col === "log" || ((!col || col === "unknown") && logGraded) ? 0 : col === "hdr" ? 1 : col === "sdr" ? 2 : 3;
    };
    const groups = [t("Log"), "HDR", t("Standard"), t("Others")].map((label, k) => ({ label, items: list.filter((c) => kind(c) === k) })).filter((g) => g.items.length);
    return groups.length > 1 ? groups : [{ label: "", items: list }];
  };
  const clipName = (c: VideoSetup) => { const m = /^Video (\d+)$/.exec(c.name); return m ? t("Video {n}", { n: m[1] }) : c.name; };
  const renameClip = (name: string) => {
    const n = name.trim();
    if (!n) return;
    onProject((p) => ({ ...p, videos: clipsOf(p).map((c) => (c.id === clip.id ? { ...c, name: n } : c)) }));
    onSaveNow();
  };
  /** Remove this video from the release: its camera file and its own settings. The audio and the lyrics stay. */
  const deleteClip = async () => {
    if (projects.length < 2) return;
    syncRef.current?.abort();
    stop();
    setPinCam(null);
    const id = clip.id;
    const rest = clips.filter((c) => c.id !== id);
    // The project before it opens (a project: never a take imported for the library).
    const others = projects.filter((c) => c.id !== id);
    const nextId = others[Math.max(0, projects.indexOf(clip) - 1)].id;
    // Its file is a camera of another project: the project goes, its take stays (that edit is not broken).
    if (usedAsCamera(id)) {
      onProject((p) => ({ ...p, videos: clipsOf(p).map((c) => (c.id === id ? { ...c, takeOnly: true, angles: undefined, cuts: undefined, versions: undefined } : c)), videoId: nextId }));
      onSaveNow();
      return;
    }
    onProject((p) => ({ ...p, videos: clipsOf(p).filter((c) => c.id !== id), videoId: nextId }));
    onSaveNow();
    // Its Drive copy and its files on the device, unless another video still uses them (a duplicate).
    const copyId = clip.drive?.copy?.id;
    if (copyId && !rest.some((c) => c.drive?.copy?.id === copyId)) void deleteDriveFile(copyId);
    stopCopyOf(id);
    if (!sharedFiles()) {
      await delMedia(`video:${mediaId}`).catch(() => {});
      await delMedia(`poster:${mediaId}`).catch(() => {});
    }
    await delMedia(`copy:${id}`).catch(() => {});
    await delMedia(`strip:${id}`).catch(() => {});
    await delMedia(`audio:${id}`).catch(() => {});
  };


  const isVideoFile = (f: File) => f.type.startsWith("video/") || /\.(mp4|mov|webm|m4v|avi|mxf)$/i.test(f.name);
  /**
   * Several videos chosen at once (the file picker or a drop): the first is this video's own when it has none yet, the
   * others go on their own tracks over it (`importTakes`), 4 videos at most in a project — the ones past it are said
   * and wait in the release's other takes.
   */
  const pickVideos = async (files: File[]) => {
    const vids = files.filter(isVideoFile);
    if (!vids.length) return;
    const hasOwn = !!settingsRef.current.videoName || !!videoBlob;
    if (!hasOwn) await pickVideo(vids[0]);
    const rest = hasOwn ? vids : vids.slice(1);
    if (rest.length) await importTakes(rest);
  };
  const onDropFile = (files: File[]) => {
    const f = files[0];
    if (!f) return;
    if (files.some(isVideoFile)) void pickVideos(files);
    else if (f.type.startsWith("audio/") || /\.(mp3|wav|m4a|aac|ogg|flac|aiff)$/i.test(f.name)) void pickAudio(f);
  };

  // ---- playback ----
  const playRef = useRef<() => Promise<void>>(async () => {});
  /** Where the last play started, to go back there at the pause (`playReturn`). */
  const playStartRef = useRef<number | null>(null);
  const playReturnRef = useRef(playReturn);
  playReturnRef.current = playReturn;
  /** The user's pause: the playhead back where play started (as editing apps do), or left where it stopped. */
  const pause = () => {
    stop();
    // (the ref too: equal to the state's last value, a set alone would not reach it)
    if (playReturnRef.current && playStartRef.current !== null) { headRef.current = playStartRef.current; setHead(playStartRef.current); }
  };
  const play = async () => {
    // Not before the video can play: a click would otherwise start everything later, by surprise.
    if (!audioBuf || (videoUrl && !playerReady)) return;
    const token = ++playToken.current;
    setPinCam(null); // playing: the cuts choose the camera again
    const ctx = getCtx();
    await ctx.resume();
    if (token !== playToken.current) return;
    stop(); // a start that waited is dropped when another start or a stop came meanwhile
    const mine = ++playToken.current;
    const cfg = settingsRef.current;
    let until = Math.min(audioBuf.duration, cfg.crop.start + cfg.crop.duration);
    // Unlocked, the playhead outside the segment: played from there to the song's end (else the segment, as always).
    // The loop off: from the playhead (anywhere) to the song's end, through the segment and past it.
    const outside = !loopRef.current && head < audioBuf.duration - 0.2;
    if (outside) until = audioBuf.duration;
    let from = outside ? head : head >= until - 0.15 || head < cfg.crop.start ? cfg.crop.start : head;
    playStartRef.current = from;
    // (the arrows start again: their first press takes the line nearest to it)
    tapCursor.current = null;
    const cfgStart = outside ? 0 : cfg.crop.start;
    const from0 = from;
    // The view keeps the playhead where it is when play is pressed (between a third and 3/4): no jump back to a third.
    const v0 = viewRef.current;
    followAt.current = v0 && v0.d > 0 && from >= v0.s && from <= v0.s + v0.d ? clamp((from - v0.s) / v0.d, FOLLOW_AT, 0.75) : FOLLOW_AT;
    // The sound is heard this much after it is played (the phone's output, Bluetooth headphones…): the picture shows
    // what is heard, not what was just sent.
    const ac = ctx as AudioContext & { outputLatency?: number };
    const lat = Math.min(0.5, Math.max(0, (ac.outputLatency ?? 0) + (ac.baseLatency ?? 0)));
    // No camera file: only the sound plays, at once.
    const el = videoUrl && fileClip.current === clip.id ? videoRef.current : null;
    if (el) {
      el.muted = true; // (its own sound, when it has a volume: turned on by the playback below, in the part kept)
      el.playbackRate = 1;
      await whenReady(el);
      if (mine !== playToken.current) return;
      // The picture first (placed, then started: a phone takes a moment), the sound then starts from where the
      // picture really is, so they leave together instead of the picture catching up.
      el.currentTime = Math.max(0, from - cfg.offset);
      await new Promise<void>((ok) => { if (!el.seeking) ok(); else { el.addEventListener("seeked", () => ok(), { once: true }); window.setTimeout(ok, 1500); } });
      if (mine !== playToken.current) return;
      // (A browser may keep play() pending: never wait more than a moment, the sound starts anyway.)
      await Promise.race([el.play().catch(() => undefined), new Promise((ok) => window.setTimeout(ok, 700))]);
      if (mine !== playToken.current) { el.pause(); return; }
      // (only where the video is: the playhead before or after it, the player stays at its edge and the sound starts at
      // the playhead, never brought back to where the video could be)
      const inVideo = from - cfg.offset >= 0 && (!Number.isFinite(el.duration) || from - cfg.offset < el.duration - 0.05);
      if (!el.paused && inVideo) from = Math.min(until - 0.05, Math.max(cfgStart, el.currentTime + cfg.offset + lat));
    }
    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    // A short fade in (and out at the stop), as music apps do: no click when it starts or stops.
    const fade = ctx.createGain();
    fade.gain.setValueAtTime(0, ctx.currentTime);
    fade.gain.linearRampToValueAtTime(1, ctx.currentTime + FADE);
    src.connect(fade);
    const mute = ctx.createGain();
    mute.gain.value = mutedRef.current ? 0 : 1;
    fade.connect(mute); mute.connect(ctx.destination);
    muteNode.current = mute;
    originRef.current = ctx.currentTime;
    src.start(0, from, until - from);
    sourceRef.current = src;
    fadeRef.current = fade;
    if (el && el.paused) void el.play().catch(() => {});
    setPlaying(true);
    const tick = () => {
      const now = from + (ctx.currentTime - originRef.current);
      // (the loop on: the segment again from its start, until paused)
      if (now >= until && loopRef.current && !outside) { stop(); const s0 = settingsRef.current.crop.start; headRef.current = s0; setHead(s0); window.setTimeout(() => void playRef.current(), 30); return; }
      if (now >= until) { stop(); const back = playReturnRef.current ? from0 : until; headRef.current = back; setHead(back); return; }
      // The playhead and the lyrics follow what is heard (the sound sent, minus the output's delay).
      // (until the sound reaches the speakers the playhead waits where it was, never stepping back first)
      const heard = Math.max(cfgStart, from0, now - lat);
      // The timeline every frame, straight (paintTimeline); the rest of the studio (time shown, the line playing, the
      // list) through the state, a dozen times a second: a render of the whole studio every frame made it stutter.
      headRef.current = heard;
      followHead(heard);
      paintTimeline(heard);
      if (performance.now() - lastHeadState > 80) { lastHeadState = performance.now(); setHead(heard); }
      if (el) {
        // What is heard right now, in the camera file's time.
        const target = Math.max(0, heard - settingsRef.current.offset);
        const diff = target - el.currentTime; // + : the picture is behind
        // A big gap: jump there. A small one: the picture runs a little faster or slower until it is caught up
        // (no visible jumps).
        if (Math.abs(diff) > 0.4) { el.currentTime = target; el.playbackRate = 1; }
        else el.playbackRate = Math.abs(diff) < 0.02 ? 1 : Math.min(1.1, Math.max(0.9, 1 + diff * 0.8));
        // The camera's own sound at its volume, only in the part of the file kept (trimmed on the video track).
        const cfgNow = settingsRef.current, vol = clamp(cfgNow.clipVolume ?? 0, 0, 1);
        const [ci, co] = clipSpan(cfgNow, Number.isFinite(el.duration) ? el.duration : Infinity);
        // (multicam: on its own shots only, as each camera's sound on its shots)
        const t0 = heard - cfgNow.offset, audible = vol > 0 && t0 >= ci && t0 <= co && !isOff(cfgNow, t0) && camAt(cfgNow.cuts, heard) === 0;
        if (el.muted === audible) el.muted = !audible;
        if (audible && Math.abs(el.volume - vol) > 0.005) el.volume = vol;
      }
      syncAngles(heard);
      drawAt(heard);
      // Measure of the sync while playing (console, debug level): video behind (+) or ahead (−) of the sound.
      if (el && performance.now() - lastLog > 1000) {
        lastLog = performance.now();
        const target = heard - settingsRef.current.offset;
        console.debug(`[sync] video ${((target - el.currentTime) * 1000).toFixed(0)} ms behind · rate ${el.playbackRate.toFixed(3)} · readyState ${el.readyState} · audio output delay ${Math.round(lat * 1000)} ms`);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    let lastLog = 0, lastHeadState = 0;
    rafRef.current = requestAnimationFrame(tick);
  };

  useEffect(() => {
    if (!playing) drawAt(head);
  }, [drawAt, head, playing, settings, cues, captionStyle, hookStyle, videoUrl, fonts, aids, snap, lutRev, rawView, fontPreview]);

  // Paused: keep the picture on the frame that matches the playhead, so trimming and re-syncing are seen live.
  useEffect(() => {
    if (playing) return;
    const el = videoRef.current;
    if (!el || !videoUrl) return;
    const target = head - settings.offset;
    if (target < 0 || (Number.isFinite(el.duration) && target > el.duration)) { drawAt(head); return; }
    if (Math.abs(el.currentTime - target) > 0.01) el.currentTime = target;
    else drawAt(head);
  }, [head, settings.offset, playing, videoUrl, videoDur, drawAt]);

  // Safari shows no picture of a paused video before it played: read the frame under the playhead from the file.
  useEffect(() => {
    const el = videoRef.current;
    if (playing || exporting || !videoBlob || !videoDur || !el) return;
    const target = head - settings.offset;
    if (target < 0 || target > videoDur) return;
    const id = window.setTimeout(() => {
      if (el.readyState >= 2 || !el.paused || playerSeen.current === el.currentSrc) return; // the player has pictures: nothing to do
      const s = stillRef.current;
      if (s && s.src === el.currentSrc && Math.abs(s.at - target) < 0.08) return;
      const src = el.currentSrc;
      stillWant.current = target;
      const t0 = performance.now();
      grabFrame(videoBlob, target).then((bmp) => {
        if (stillWant.current !== target) { bmp.close(); return; } // the playhead moved on
        console.debug(`[load] frame read from the file in ${Math.round(performance.now() - t0)} ms`);
        stillRef.current?.bmp.close();
        stillRef.current = { src, at: target, bmp };
        drawAt(headRef.current);
      }).catch((e) => console.debug("[load] could not read a frame from the file", e));
    }, 250);
    return () => clearTimeout(id);
  }, [head, settings.offset, playing, exporting, videoBlob, videoDur, drawAt]);

  // ---- audio sync ----
  /** The sound of a camera / phone file, mono: the browser's decoder for a file that fits in memory (quick), else
   *  ffmpeg reading the sound track only (a camera file of several GB, sound in PCM…: seconds). Null: neither could. */
  const readSound = async (recording: Blob, duration: number, onP: (p: number) => void, signal: AbortSignal) => {
    if (recording.size <= SYNC_DECODE_MAX) {
      try {
        const vbuf = await Promise.race([
          decodeAudio(getCtx(), recording),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("decode")), 15000)),
        ]);
        return { samples: monoOf(vbuf), rate: vbuf.sampleRate };
      } catch { /* next way */ }
    }
    if (signal.aborted) return null;
    try {
      const RATE = 22050;
      const raw = await ffmpegAlone(recording, ["-i", "/in/source", "-map", "0:a:0", "-vn", "-ac", "1", "-ar", String(RATE), "-f", "f32le", "sound.raw"],
        "sound.raw", Math.max(1, duration), onP, signal);
      const bytes = raw.byteOffset % 4 ? raw.slice() : raw;
      const samples = new Float32Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
      if (samples.length > RATE) return { samples, rate: RATE };
    } catch (e) {
      if (signal.aborted) throw e;
      console.info("[sync] sound not read by ffmpeg", e);
    }
    return null;
  };
  const autoSync = async () => {
    const official = audioBuf;
    const recording = videoBlob;
    if (!official) return;
    // No camera file for the base here: the other videos are still synced.
    if (!recording) { tellSync(null, await syncOthers()); return; }
    syncRef.current?.abort();
    stop();
    void askNotifyPermission(); // inside the click: lets the browser tell the user when the analysis is over
    let outcome: { title: string; body: string } | null = null;
    // Why the base found no place (told with the others' result, once they are all tried).
    let baseFail: string | null = null;
    setSyncBusy(true); setSyncPct(0); setErr(null); setNote(null);
    // Start the real-time capture right away, inside the click: the video cannot be muted
    // (mute zeroes the samples before the Web Audio graph), so it needs the user gesture.
    // `ac` = "this analysis is still the current one" (aborted when the clip/files change).
    // `capAc` = "stop the real-time capture" (aborted as soon as the fast decode worked).
    // They MUST be separate: aborting `ac` after a successful decode made the result look stale and it was thrown away.
    const ac = new AbortController();
    syncRef.current = ac;
    const capAc = new AbortController();
    ac.signal.addEventListener("abort", () => capAc.abort());
    // Its progress shows only once it is the way used (the faster ways below show theirs meanwhile).
    let captureShown = false;
    const capture = videoUrl
      ? capturePcm(videoUrl, MAX_CAPTURE, (p) => { if (captureShown) setSyncPct(p); }, capAc.signal)
      : null;
    if (capture) void capture.catch(() => {});
    try {
      let clip = await readSound(recording, videoRef.current?.duration || videoDur || 60, (p) => setSyncPct(p), ac.signal);
      if (clip) capAc.abort(); // read: no need for the real-time capture
      else {
        // 3. Last resort: the sound captured while the video plays (real time). Phone MOV/MP4 the others refused.
        if (!capture) throw new Error("no-url");
        captureShown = true;
        clip = await capture;
      }
      // Let the spinner paint before the (CPU-heavy) analysis blocks the main thread for a moment.
      await new Promise((resolve) => setTimeout(resolve, 30));
      const cfg = settingsRef.current;
      const r = syncAudio(clip.samples, clip.rate, monoOf(official), official.sampleRate, { from: cfg.crop.start, to: cfg.crop.start + cfg.crop.duration });
      // The clip, the project or the files may have changed while we were analysing.
      if (ac.signal.aborted) {
        /* result ignored */
      } else if (!r.anchors || r.score < 0.4) {
        // Nothing in the official track resembles this recording: keep the current offset untouched.
        baseFail = t("No match found in the official audio. Check it is the right track, or sync by ear.");
      } else {
        const takes = r.takes.map((k) => ({ offset: round2(k.offset), musicStart: round2(k.musicStart), musicEnd: round2(k.musicEnd) }));
        const kept = takes.length > 1 ? takes : undefined;
        // Synced the first time: its own sound is the official audio heard by the camera, so it is turned off (up again
        // by hand; a sync done again keeps that choice).
        setV({ score: round2(r.score), anchors: r.anchors, takes: kept, ...(settingsRef.current.score === undefined ? { clipVolume: undefined } : null) });
        const used = takes.find((k) => Math.abs(k.offset - r.offset) < 0.02);
        if (used) applyTake(used, kept);
        else {
          // No clear take: link on the whole video.
          const cur = settingsRef.current;
          const range = linkRangeOf({ ...cur, offset: round2(r.offset), takes: undefined });
          const crop = range ? fitCrop(cur.crop.start, cur.crop.duration, range) : cur.crop;
          setV({ offset: round2(r.offset), musicStart: r.musicStart === null ? undefined : round2(r.musicStart), musicEnd: r.musicEnd === null ? undefined : round2(r.musicEnd), linked: true, crop });
          setHead(crop.start);
        }
        setNote(takes.length > 1
          ? t("{n} takes found in the video", { n: takes.length }) + " · " + t("Sync quality {n}%", { n: Math.round(r.score * 100) })
          : t("Sync quality {n}%", { n: Math.round(r.score * 100) }));
        if (r.score < 0.7) setErr(t("Low confidence: check the offset by ear."));
        outcome = {
          title: r.score < 0.7 ? t("Sync finished, low confidence") : t("Sync finished"),
          body: t("Sync quality {n}%", { n: Math.round(r.score * 100) }) + " · " + t("Offset (s)") + " " + round2(r.offset),
        };
        onSaveNow();
      }
    } catch (e) {
      if (!ac.signal.aborted) {
        console.error("auto sync failed", e);
        const reading = e instanceof Error && ["no-url", "silent", "decode"].includes(e.message);
        baseFail = reading ? t("The video has no readable audio track. Sync it manually.") : t("The analysis failed. Sync it by ear.");
      }
    }
    setSyncPct(0);
    // The project's other videos too (its cameras, the one over it), every one of them, whatever the base gave: each
    // one that matches the official audio is placed on it; one that does not stays free, where it is (to place by hand).
    const others = ac.signal.aborted ? null : await syncOthers();
    if (syncRef.current === ac) syncRef.current = null;
    setSyncBusy(false);
    if (!ac.signal.aborted && others) tellSync(baseFail ? { name: baseName(), why: baseFail } : null, others, outcome);
  };
  const baseName = () => settingsRef.current.videoName?.replace(/\.[^.]+$/, "") || clip.name;
  /** The project's other videos synced, one after the other: the names of those placed and of those left free. */
  const syncOthers = async () => {
    const cur = settingsRef.current;
    const synced: string[] = [], free: string[] = [];
    for (const id of [...(cur.angles ?? []).filter(Boolean), ...overlaysOf(cur).map((o) => o.clip)]) {
      const c = clips.find((x) => x.id === id);
      if (!c) continue;
      const first = c.score === undefined;
      const at = await resyncTake(c);
      (at === null ? free : synced).push(c.name);
      // One over it follows its sync (else it keeps the place it was given).
      if (at !== null && overlayOf(settingsRef.current, id)) patchOverlay(id, { offset: at, ...(first ? { volume: undefined } : null) });
    }
    return { synced, free };
  };
  /** One word on the whole sync: the base's result (`outcome`, or why it failed) with the other videos'. */
  const tellSync = (fail: { name: string; why: string } | null, others: { synced: string[]; free: string[] },
    outcome: { title: string; body: string } | null = null) => {
    const list = (n: string[]) => n.map((x) => `« ${x} »`).join(", ");
    const freeNames = [...(fail ? [fail.name] : []), ...others.free];
    if (fail && !others.synced.length) {
      // Nothing placed at all: the error, as before.
      setErr(fail.why);
      notify(t("Sync failed"), fail.why);
      if (others.free.length) onToast?.(t("No video matches the official audio: they stay free, place them by hand."));
      return;
    }
    const said = [
      ...(fail ? [t("{a} synced.", { a: list(others.synced) })] : []),
      ...(freeNames.length ? [freeNames.length === 1 ? t("{a} does not match the official audio (no sound in common): it stays free, place it by hand.", { a: list(freeNames) })
        : t("{a} do not match the official audio (no sound in common): they stay free, place them by hand.", { a: list(freeNames) })] : []),
    ].join(" ");
    if (said) onToast?.(said);
    if (outcome) notify(outcome.title, said ? `${outcome.body} · ${said}` : outcome.body);
    else if (said) notify(t("Sync finished"), said);
  };

  // ---- audio ↔ video link ----
  /**
   * Where the segment may sit while linked: the whole video, or, when it holds several takes, the
   * part between the neighbouring takes (what was filmed before and after the music of this take stays reachable).
   */
  const linkRangeOf = (v: Pick<VideoSettings, "offset" | "musicStart" | "musicEnd" | "takes"> & { angles?: string[] }): [number, number] | null => {
    if (!audioBuf || !videoBlob || videoDur <= 0) return null;
    let a = 0, b = videoDur;
    if ((v.takes?.length ?? 0) > 1 && v.musicStart != null && v.musicEnd != null) {
      for (const k of v.takes!) {
        if (k.musicEnd <= v.musicStart + 0.01) a = Math.max(a, k.musicEnd);
        if (k.musicStart >= v.musicEnd - 0.01) b = Math.min(b, k.musicStart);
      }
    }
    const lo = Math.max(0, v.offset + a);
    const hi = Math.min(audioBuf.duration, v.offset + b);
    if (hi - lo < 1) return null;
    // Multicam: the part every camera of the project filmed (a shorter take ends the segment's room), unless they
    // share less than a second (then camera 1's alone, never a locked segment).
    let clo = lo, chi = hi;
    for (const id of v.angles ?? settingsRef.current.angles ?? []) {
      const c = clips.find((x) => x.id === id);
      const d = c?.source?.duration ?? anglesRef.current.get(id)?.el.duration;
      if (!c || c.score === undefined || !d || !Number.isFinite(d)) continue;
      clo = Math.max(clo, c.offset); chi = Math.min(chi, c.offset + d);
    }
    return chi - clo >= 1 ? [clo, chi] : [lo, hi];
  };
  /** Limits of the segment: the linked range, else the whole official track. */
  const boundsOf = (v: VideoSettings): [number, number] =>
    (v.linked && linkRangeOf(v)) || [0, audioBuf?.duration ?? v.crop.start + v.crop.duration];
  const fitCrop = (start: number, duration: number, [lo, hi]: [number, number]) => {
    const d = clamp(duration, 1, Math.max(1, hi - lo));
    return { start: round2(clamp(start, lo, Math.max(lo, hi - d))), duration: round2(d) };
  };

  // Takes saved by an older sync could be one performance cut in two (same offset): joined back into one.
  useEffect(() => {
    const ks = settings.takes;
    if (!ks || ks.length < 2) return;
    const joined: VideoTake[] = [];
    for (const k of [...ks].sort((p, q) => p.musicStart - q.musicStart)) {
      const same = joined.find((j) => Math.abs(j.offset - k.offset) < 0.15);
      if (same) { same.musicStart = Math.min(same.musicStart, k.musicStart); same.musicEnd = Math.max(same.musicEnd, k.musicEnd); }
      else joined.push({ ...k });
    }
    if (joined.length === ks.length) return;
    const used = joined.find((j) => Math.abs(j.offset - settings.offset) < 0.15);
    setV({ takes: joined.length > 1 ? joined : undefined, ...(used ? { musicStart: used.musicStart, musicEnd: used.musicEnd } : {}) });
  }, [settings.takes]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Use one take of the video: audio and video get linked on it, and the segment moves inside it if needed. */
  // ---- versions of the video (A/B): every choice of the post of their own (segment, texts, styles, framing, grade) ----
  const versions = settings.versions ?? [];
  const versionName = (v: VideoVersion, i: number) => v.name?.trim() || t("Version {x}", { x: String.fromCharCode(65 + i) });
  /** The shown version's values put back in its entry (they are edited in the video's own fields). */
  const withShown = (cur: VideoSettings) => (cur.versions ?? []).map((x) => (x.id === cur.activeVersion ? { ...x, v: versionOf(cur), all: true } : x));
  /** A version's values to show. An older one (no framing, format, grade of its own) keeps the video's as they are;
   *  the camera profile is the file's, the same in every version. */
  const valuesOf = (v: VideoVersion) => {
    const cur = settingsRef.current;
    const own = Object.fromEntries(VERSION_KEYS.filter((k) => v.all || !LOOK_KEYS.includes(k)).map((k) => [k, v.v[k]])) as Partial<VideoSettings>;
    if (own.grade && cur.grade) own.grade = { ...own.grade, profile: cur.grade.profile, sdrOverride: cur.grade.sdrOverride };
    return own;
  };
  const switchVersion = (id: string) => {
    const cur = settingsRef.current;
    if (cur.activeVersion === id) return;
    const list = withShown(cur);
    const target = list.find((x) => x.id === id);
    if (!target) return;
    stop();
    setV({ ...valuesOf(target), versions: list, activeVersion: id });
    setHead(target.v.crop?.start ?? cur.crop.start);
    onSaveNow();
  };
  /** A new version, a copy of the one shown (the first time: the video as it is becomes A, its copy B). */
  const addVersion = () => {
    const cur = settingsRef.current;
    const list = cur.versions?.length ? withShown(cur) : [{ id: uid(), v: versionOf(cur), all: true }];
    const next = { id: uid(), v: versionOf(cur), all: true };
    setV({ versions: [...list, next], activeVersion: next.id });
    onSaveNow();
    onToast?.(t("{name} made: change anything on it (segment, texts, framing, grade) to compare", { name: versionName(next, list.length) }));
  };
  const renameVersion = (id: string, name: string) => setV({ versions: (settingsRef.current.versions ?? []).map((x) => (x.id === id ? { ...x, name: name.trim() || undefined } : x)) });
  const removeVersion = (id: string) => {
    const cur = settingsRef.current;
    const list = withShown(cur).filter((x) => x.id !== id);
    const shown = cur.activeVersion === id ? list[0] : undefined;
    // One left: it stays, with its name (shown alone, ready for a new one).
    if (!list.length) setV({ versions: undefined, activeVersion: undefined });
    else setV({ ...(shown ? valuesOf(shown) : {}), versions: list, ...(shown ? { activeVersion: shown.id } : {}) });
    if (shown?.v.crop) setHead(shown.v.crop.start);
    onSaveNow();
  };
  const [renaming, setRenaming] = useState<string | null>(null);
  /** The phone layout: the same pieces, placed for a small screen. */
  const phone = usePhone();
  // ---- phone: the preview full screen (the picture itself grows to fill the screen; a swipe down or the cross
  // puts it back). The dock's player stays over it, faint while playing; a tap on the picture hides or shows it. ----
  const [full, setFull] = useState(false);
  fullRef.current = full;
  // (the board measured before it opens: the picture glides into the right place)
  const toggleFull = (on: boolean) => { if (on) fitBoard(true); setFullLeaving(false); setFull(on); };
  /** The full screen is gliding back (it closes once there): the dock opens again meanwhile. */
  const [fullLeaving, setFullLeaving] = useState(false);
  const slimDock = full && !fullLeaving;
  // Into or out of the full screen: the picture drawn again, with or without the zones.
  useEffect(() => { if (!playing) drawAt(headRef.current); }, [full]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const root = document.documentElement;
    // Computer: the player pinned where it is now, so the full screen does not move it.
    if (full && !root.classList.contains("pv-full")) {
      const p = document.querySelector<HTMLElement>(".board-player")?.getBoundingClientRect();
      if (p?.width) {
        root.style.setProperty("--fp-x", `${p.left}px`);
        root.style.setProperty("--fp-y", `${p.top}px`);
        root.style.setProperty("--fp-w", `${p.width}px`);
        root.classList.add("pv-pinned");
      }
    }
    if (!full) root.classList.remove("pv-pinned");
    root.classList.toggle("pv-full", full);
    return () => { root.classList.remove("pv-full"); };
  }, [full]);
  // Phone: into the full screen, the dock closes on its player (its icons go down and out, the block gets shorter),
  // and opens again on the way out; the same movement as the picture's glide, at the same time.
  const dockWas = useRef(false);
  /** Where the dock's height was when a move was taken over by the opposite one (it goes on from there). */
  const dockFrom = useRef<number | null>(null);
  useEffect(() => {
    const root = document.documentElement;
    const dock = document.querySelector<HTMLElement>(".mobile-tabs");
    const player = dock?.querySelector<HTMLElement>(".dock-player");
    const was = dockWas.current;
    dockWas.current = slimDock;
    const settle = () => root.classList.toggle("pv-dock-slim", slimDock);
    if (slimDock === was || !dock || !player || !player.childElementCount || getComputedStyle(dock).display === "none"
      || matchMedia("(prefers-reduced-motion: reduce)").matches) { settle(); return; }
    const icons = [...dock.children].filter((x): x is HTMLElement => x instanceof HTMLElement && !x.classList.contains("dock-player"));
    // The pill behind the open page's button keeps its place (its own translate): it only fades.
    const cs = getComputedStyle(dock);
    const slim = player.getBoundingClientRect().height + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    root.classList.remove("pv-dock-slim"); // the icons laid out while they go
    const whole = dock.getBoundingClientRect().height;
    const ease = "cubic-bezier(.2,.8,.2,1)";
    for (const a of dock.getAnimations()) a.cancel();
    dock.style.overflow = "hidden";
    // Two steps, one after the other: going, the icons leave (down, fading), then the block closes on the player (it
    // goes down with it); coming back, the block opens, then the icons come up into it.
    const ICONS = 180, BLOCK = 320, OVERLAP = 60;
    const from = dockFrom.current ?? (slimDock ? whole : slim);
    dockFrom.current = null;
    // The block: soft at both ends (the player glides down, no jolt at the start).
    const go = dock.animate([{ height: `${from}px` }, { height: `${slimDock ? slim : whole}px` }],
      { duration: BLOCK, delay: slimDock ? ICONS - OVERLAP : 0, easing: "cubic-bezier(.4,0,.2,1)", fill: "both" });
    const out = [{ opacity: 1, translate: "0 0" }, { opacity: 0, translate: "0 16px" }];
    const fades = icons.map((el) => {
      const frames = el.classList.contains("dock-thumb") ? out.map(({ opacity }) => ({ opacity })) : out;
      return el.animate(slimDock ? frames : [...frames].reverse(), { duration: ICONS, delay: slimDock ? 0 : BLOCK - OVERLAP, easing: ease, fill: "both" });
    });
    const done = () => { dock.style.overflow = ""; for (const a of fades) a.cancel(); go.cancel(); };
    let live = true;
    void Promise.all([go.finished, ...fades.map((a) => a.finished)]).then(() => { if (live) { settle(); done(); } }, () => {});
    // Taken over by the next one (in or out again): it starts from where this one is, without this one's end.
    return () => { if (live && go.playState === "running") dockFrom.current = dock.getBoundingClientRect().height; live = false; done(); };
  }, [slimDock]);
  useEffect(() => () => document.documentElement.classList.remove("pv-dock-slim"), []);
  // The window resized while full screen: the player goes back to its centred place.
  useEffect(() => {
    if (!full) return;
    const r = () => document.documentElement.classList.remove("pv-pinned");
    window.addEventListener("resize", r);
    return () => window.removeEventListener("resize", r);
  }, [full]);
  // On a computer, as on a video site: the player fades once the mouse rests (or
  // leaves the window), and comes back as soon as it moves; the cursor hides with it.
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    if (!full) { setIdle(false); return; }
    let timer = 0;
    const wake = () => { setIdle(false); clearTimeout(timer); timer = window.setTimeout(() => setIdle(true), 900); };
    const away = () => { clearTimeout(timer); setIdle(true); };
    window.addEventListener("mousemove", wake);
    document.documentElement.addEventListener("mouseleave", away);
    wake();
    return () => { window.removeEventListener("mousemove", wake); document.documentElement.removeEventListener("mouseleave", away); clearTimeout(timer); };
  }, [full]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { document.documentElement.classList.toggle("pv-idle", full && idle); return () => document.documentElement.classList.remove("pv-idle"); }, [full, idle]);
  // Computer, the columns beside the board: the full screen covers the middle board only (its blur and the picture in
  // its centre), the header and both columns stay seen and usable (the colour adjusted while watching it big).
  const centerRef = useRef<HTMLElement>(null);
  const fitBoard = (on: boolean) => {
    const root = document.documentElement, c = centerRef.current?.getBoundingClientRect();
    const beside = on && !!c && c.width > 0 && c.width < window.innerWidth - 100;
    if (beside) {
      const top = Math.max(0, c.top), bottom = Math.min(window.innerHeight, c.bottom);
      root.style.setProperty("--fs-l", `${c.left}px`);
      root.style.setProperty("--fs-t", `${top}px`);
      root.style.setProperty("--fs-w", `${c.width}px`);
      root.style.setProperty("--fs-h", `${bottom - top}px`);
    }
    root.classList.toggle("pv-board", beside);
  };
  useEffect(() => {
    if (!full) { fitBoard(false); return; }
    const r = () => fitBoard(true);
    window.addEventListener("resize", r);
    return () => window.removeEventListener("resize", r);
  }, [full]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => document.documentElement.classList.remove("pv-board"), []);
  /** A tap on the full-screen picture plays or pauses (the player stays, under the picture, on a phone too). */
  const fullTap = () => { if (playing) pause(); else void play(); };
  /** What the video shows (lyrics, hook): the same two toggles in the computer's "Shown" row and under the phone's
   *  picture. */
  const shownToggles = (cls: string, reachable = true) => {
    const hookOn = !!hooks.length && settings.showHooks !== false;
    return (<>
      <button className={cls + (settings.captions ? " on" : "")} aria-pressed={settings.captions} tabIndex={reachable ? 0 : -1}
        onClick={() => setV({ captions: !settings.captions })}><Icon name="type" size={14} />{t("Lyrics")}</button>
      <button className={cls + (hookOn ? " on" : "")} aria-pressed={hookOn} tabIndex={reachable ? 0 : -1}
        onClick={() => { if (!hooks.length) { setTab("hook"); addHook(); } else setV({ showHooks: settings.showHooks === false }); }}>
        <Icon name="sparkle" size={14} />{t("Hook")}</button>
    </>);
  };
  /** The lock of audio and video (on the phone above the tracks, on a computer in the segment's row). */
  const lockEl = (where = "") => videoBlob && videoDur > 0 ? (
    <button className={"btn sm icon tr-lock " + where + (linked ? " on" : "")} aria-pressed={linked} onClick={toggleLink}
      aria-label={linked ? t("Audio and video linked") : t("Link audio and video")}
      title={(linked ? t("Audio and video linked") : t("Link audio and video")) + " · " + (linked ? t("Unlink to move the sync by hand") : t("Keep the sync while you move the segment"))}>
      <Icon name={linked ? "lock" : "unlock"} size={13} />
    </button>
  ) : null;
  /** The loop (next to the padlock): playing kept in the segment, or on past it. */
  const loopEl = (where = "") => audioBuf ? (
    <button className={"btn sm icon tr-loop " + where + (loopSeg ? " on" : "")} aria-pressed={loopSeg} onClick={() => setLoopSeg(!loopSeg)}
      aria-label={loopSeg ? t("Loop on the segment") : t("Play on past the segment")}
      title={loopSeg ? t("Loop on the segment: playing stays in it and starts it again. Click to play on past it (the playhead anywhere).") : t("Playing goes on past the segment, the playhead anywhere in the song. Click to loop on the segment.")}>
      <Icon name="loop" size={13} />
    </button>
  ) : null;
  /** The studio's options (draws, preview, export format): in the head on a computer, under the picture on a phone. */
  /** Zoom of the waveform, for precise edges: also a pinch, or ctrl + wheel on a computer. */
  const zoomEl = (where = "") => (
    <div className={"wave-zoom " + where} role="group" aria-label={t("Zoom of the waveform")}
      title={t("Zoom: ⌘ + wheel, or hold the wheel down and drag up or down (sideways to move along the track). Zoomed in, to move along the track: two fingers, Alt + drag, or Shift + the wheel.")}>
      <button className="btn icon sm" aria-label={t("Zoom out")} disabled={!view} onClick={() => { const v = viewOf(); zoomTo(v.d * 2, v.s + v.d / 2); }}><Icon name="minus" size={12} /></button>
      <button className="btn icon sm" aria-label={t("Zoom in")} onClick={() => { const v = viewOf(), c = settingsRef.current.crop; const mid = view ? v.s + v.d / 2 : c.start + c.duration / 2; zoomTo(v.d / 2, mid); }}><Icon name="plus" size={12} /></button>
      <button className="btn sm wave-fit" onClick={fitView} title={t("Show the segment large, or the whole track")}><span className="lbl-long">{view ? t("Whole track") : t("Fit segment")}</span><span className="lbl-short">{view ? t("Track") : t("Segment")}</span></button>
    </div>
  );
  /** The only version named (it becomes a version of its own, ready for a B). Once, from Enter or leaving the field. */
  const nameSolo = (raw: string) => {
    if (renaming !== "solo") return;
    setRenaming(null);
    const name = raw.trim();
    const cur = settingsRef.current;
    if (cur.versions?.[0]) renameVersion(cur.versions[0].id, name);
    else if (name) { const id = uid(); setV({ versions: [{ id, name, v: versionOf(cur), all: true }], activeVersion: id }); onSaveNow(); }
  };
  /** Every version exported, one after the other (file names end with the version's name); the one shown comes back. */
  const exportVersions = async () => {
    const back = settingsRef.current.activeVersion;
    const list = settingsRef.current.versions ?? [];
    if (list.length < 2) return;
    lastFiles.current = [];
    let done = 0;
    for (let i = 0; i < list.length; i++) {
      switchVersion(list[i].id);
      for (let k = 0; k < 60 && settingsRef.current.activeVersion !== list[i].id; k++) await new Promise((r) => setTimeout(r, 50));
      const r = await exportVideo(true, versionName(list[i], i));
      if (r === "cancelled") break;
      if (r === "done") done++;
    }
    if (back) switchVersion(back);
    notify(t("Videos exported"), t("{n} of {m} videos are in your downloads.", { n: done, m: list.length }));
    if (done) onVariants?.(list.flatMap((v) => videoVariants(v.id === settingsRef.current.activeVersion ? settingsRef.current.hooks : v.v.hooks, hookPools)));
  };

  const applyTake = (k: VideoTake, takes = settingsRef.current.takes) => {
    const cur = settingsRef.current;
    const range = linkRangeOf({ offset: k.offset, musicStart: k.musicStart, musicEnd: k.musicEnd, takes });
    const crop = range ? fitCrop(cur.crop.start, cur.crop.duration, range) : cur.crop;
    setV({ offset: k.offset, musicStart: k.musicStart, musicEnd: k.musicEnd, linked: true, crop });
    if (crop.start !== cur.crop.start) setHead(crop.start);
    onSaveNow();
  };

  playRef.current = play;

  /**
   * While playing (as Musixmatch), the arrows set where lines start, right at the moment pressed (no delay taken off):
   * ↓ = the next line starts now (a line late: it had not started yet; the one playing ends just before), ↑ = the line lit
   * starts now (a line early: it was already playing; ↓ pressed too early too). The line lit: the one playing, or the
   * last one started, then the one the last arrow placed. Its words keep their rhythm inside it (`placeLine`), retouched
   * (kept at the next sync).
   */
  const lineStartsNow = (which: "next" | "this") => {
    const at = round2(Math.max(0, headRef.current));
    let words = lyricWordsRef.current ?? [];
    const opts = { lineChars, wordTiming: settingsRef.current.wordTiming };
    let cs = buildCues(words, "phrase", opts);
    // The line lit (playing, or the last one started: the list under the timeline shows it), or the one the last arrow
    // placed: ↓ takes the one after it, ↑ that one.
    const cur = tapCursor.current ?? cs.reduce((k, x, j) => (x.start - 0.02 <= at ? j : k), -1);
    const i = which === "next" ? cur + 1 : Math.max(0, cur), c = cs[i];
    if (!c || i < 0) return;
    if (lockedCue(c)) { tapCursor.current = i; return; } // (locked: it stays, the next arrow goes on from it)
    if (cs[i - 1] && lockedCue(cs[i - 1]) && at < cs[i - 1].end) return; // (never over a locked line)
    const next = cs[i + 1], before = cs[i - 1]?.end;
    // (its end: as long as it was, never past the next line unless that one starts sooner than now)
    words = placeLine(words, c, at, at + Math.max(0.3, Math.min(c.end - c.start, next && next.start > at ? next.start - 0.04 - at : Infinity)));
    if (i > 0 && before !== undefined) {
      // The line before keeps its own end (it never stretches to the moved line: a line placed later leaves a blank),
      // only cut short when it would run into it.
      cs = buildCues(words, "phrase", opts);
      const p = cs[i - 1];
      if (p && p.start < at && !lockedCue(p)) words = setCueEnd(words, p, Math.max(p.start + 0.1, Math.min(before, at - 0.04)));
    }
    // Its words follow the voice inside it (the model's letters there, when it listened to this song in this session):
    // stretched in the old rhythm, a line placed by hand lit its words late or all at once.
    const em = audioBuf ? cachedEmissions(audioBuf) : null, ln = c.words[0]?.line;
    if (em && ln !== undefined) words = inLines(words, em, looksFrench(words.map((w) => faNorm(w.w))), new Set([ln]));
    tapCursor.current = i;
    lyricWordsRef.current = words;
    onProject((x) => ({ ...x, lyricWords: words }));
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!sourceRef.current || !tapCues.length || e.metaKey || e.ctrlKey || e.altKey) return;
      if (/INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement)?.tagName ?? "") || (e.target as HTMLElement)?.isContentEditable) return;
      // (a control that takes the arrows itself — a colour wheel, a dial, a menu — keeps them)
      if ((e.target as HTMLElement)?.closest?.('[role="slider"], [role="listbox"], [aria-haspopup], .dd-list')) return;
      if (e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); lineStartsNow("next"); }
      else if (e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); lineStartsNow("this"); }
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }); // (every render: the handlers read the current lines)

  /** The padlock (the sync only): every synced video of the project locked or unlocked at once (the one under them, the
   *  cameras, the ones over it, these put back on their synced place). */
  const toggleLink = () => {
    const cur = settingsRef.current;
    const takes = [...(cur.angles ?? []).filter(Boolean), ...overlaysOf(cur).map((o) => o.clip)]
      .map((id) => clips.find((c) => c.id === id)).filter((c): c is VideoSetup => !!c && c.score !== undefined);
    if (cur.linked) {
      setV({ linked: false });
      for (const c of takes) patchTake(c.id, { linked: false });
      return;
    }
    const range = linkRangeOf(cur);
    const crop = range ? fitCrop(cur.crop.start, cur.crop.duration, range) : cur.crop;
    const ovs = overlaysOf(cur).map((o) => { const c = takes.find((x) => x.id === o.clip); return c ? { ...o, offset: c.offset } : o; });
    setV({ linked: true, crop, ...withOverlays(ovs) });
    for (const c of takes) patchTake(c.id, { linked: true });
  };
  const linked = !!settings.linked && !!linkRangeOf(settings);

  // ---- crop ----
  const setCropStart = (v: number) => {
    const cfg = settingsRef.current;
    const crop = fitCrop(v, cfg.crop.duration, boundsOf(cfg));
    setV({ crop });
    setHead(crop.start);
  };
  const setCropDuration = (v: number) => {
    const cfg = settingsRef.current;
    setV({ crop: fitCrop(cfg.crop.start, v, boundsOf(cfg)) });
  };

  // ---- the waveform's view: the whole track, or a zoomed part of it (pinch, ctrl + wheel, the − / + buttons) ----
  const [view, setViewState] = useState<{ s: number; d: number } | null>(null);
  // The view as shown: changed at once by a zoom or a slide, and every frame by the playhead's follow while playing
  // (the state then catches up a few times a second, commitView).
  const viewRef = useRef(view);
  const viewCommittedAt = useRef(0);
  const commitView = () => { viewCommittedAt.current = performance.now(); setViewState(viewRef.current); };
  // Every change of the view is seen at once by whoever reads it next (the playhead's follow reads it every frame: it
  // used to put back the view of the frame before, undoing a zoom made while playing).
  const setView = (v: { s: number; d: number } | null) => { viewRef.current = v; setViewState(v); };
  const viewOf = () => viewRef.current ?? { s: 0, d: audioBuf?.duration ?? 1 };
  // Kept on this device, per release: the zoom and where it looks, the last one set, the same on every video of the
  // release and after a refresh (on another version of the audio too, kept within its length).
  const viewKey = `tktgen-tl-view:${release.id}`;
  // The playhead too, per video: where it was left (outside the segment as well), found again after a refresh. Saved once
  // it stops (not while playing).
  useEffect(() => {
    if (playing || !audioBuf) return;
    const id = window.setTimeout(() => { try { localStorage.setItem(`tktgen-tl-head:${clip.id}`, String(round2(head))); } catch { /* private mode */ } }, 400);
    return () => clearTimeout(id);
  }, [head, playing, audioBuf, clip.id]);
  useEffect(() => {
    if (!audioBuf) { setView(null); return; }
    try {
      const v = JSON.parse(localStorage.getItem(viewKey) ?? "null") as { s: number; d: number } | null;
      const dur = audioBuf.duration;
      if (v && v.d > 0 && v.d < dur) { setView({ s: clamp(v.s, 0, dur - v.d), d: v.d }); return; }
    } catch { /* storage blocked: the whole track */ }
    setView(null);
  }, [audioBuf]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // (not while playing: the view then follows the playhead, a few times a second; saved once it stops)
    if (!audioBuf || playing) return;
    try { if (view) localStorage.setItem(viewKey, JSON.stringify({ ...view, dur: audioBuf.duration })); else localStorage.removeItem(viewKey); } catch { /* private mode */ }
  }, [view, playing]); // eslint-disable-line react-hooks/exhaustive-deps
  /**
   * While playing, zoomed in, the track scrolls under the playhead once it has reached a third of the view (what is
   * coming stays in sight, as Logic or Premiere). Paused, the view stays where it is (to work on it);
   * a view slid by hand while playing is left alone for a moment. Near the track's ends the playhead moves instead.
   */
  const userPanAt = useRef(0);
  const FOLLOW_AT = 1 / 3;
  /** Where on the view (fraction from the left) the playhead is held while the track scrolls, for this playback: a third,
   * or where it was when play was pressed if further right (up to 3/4): the view never jumps to bring it to a third. */
  const followAt = useRef(FOLLOW_AT);
  const followHead = (t: number) => {
    const v = viewRef.current, dur = audioBuf?.duration ?? 0;
    if (!v || !dur || dragWave.current || performance.now() - userPanAt.current < 1500) return;
    // The playhead moves on its own until it reaches a third of the view, then the track scrolls under it (no jump to
    // that third when play starts left of it); out of view (started off screen, a jump by hand), the view goes to it.
    const out = t < v.s || t > v.s + v.d;
    if (!out && t <= v.s + v.d * followAt.current) return;
    const s = clamp(t - v.d * (out ? FOLLOW_AT : followAt.current), 0, Math.max(0, dur - v.d));
    if (Math.abs(s - v.s) < 1e-4) return;
    viewRef.current = { s, d: v.d };
    if (performance.now() - viewCommittedAt.current > 250) commitView();
  };
  /** Zoom to `d` seconds shown, `around` (seconds) staying where it is on screen. */
  const zoomTo = (d: number, around: number) => {
    const dur = audioBuf?.duration ?? 0;
    if (!dur) return;
    d = clamp(d, Math.min(2, dur), dur);
    if (d >= dur - 1e-3) { setView(null); return; }
    const cur = viewOf();
    const k = clamp((around - cur.s) / cur.d, 0, 1);
    setView({ s: clamp(around - k * d, 0, dur - d), d });
  };
  /** The segment filling most of the view (or the whole track when it is already shown so). */
  const fitView = () => {
    const dur = audioBuf?.duration ?? 0, c = settingsRef.current.crop;
    if (!dur) return;
    // Zoomed (by any means): the button reads "Whole track", and does that.
    if (viewRef.current) { setView(null); return; }
    const d = Math.min(dur, c.duration * 1.4 + 2);
    if (d >= dur - 1e-3) return;
    setView({ s: clamp(c.start + c.duration / 2 - d / 2, 0, dur - d), d });
  };

  /** "press": down inside the segment, not moved yet: a click places the playhead, a drag moves the segment.
   *  "pan": down outside it, zoomed: a drag slides the view (a click does nothing: the segment never jumps). */
  const dragWave = useRef<null | { mode: "start" | "end" | "move" | "offset" | "head" | "press" | "pan" | "none"; x: number; px: number; start: number; duration: number; vs: number; vd: number }>(null);
  const pointers = useRef(new Map<number, number>());
  const wavePos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1);
  };
  const waveDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!audioBuf) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, e.clientX);
    const rect = e.currentTarget.getBoundingClientRect();
    const v = viewOf();
    // (two fingers: the timeline's pinch, `timelineTouch`)
    const f = wavePos(e);
    const cfg = settingsRef.current;
    const px = e.clientX;
    // Zoomed, Alt + drag: the view slides, wherever it starts (the segment too). (The wheel button: `wheelDrag`.)
    // (sliding the view or pinching never stops what is playing)
    if (viewRef.current && e.altKey) {
      e.preventDefault();
      dragWave.current = { mode: "pan", x: f, px, vs: v.s, vd: v.d, start: cfg.crop.start, duration: cfg.crop.duration };
      return;
    }
    stop();
    const xOf = (t: number) => rect.left + ((t - v.s) / v.d) * rect.width;
    const near = (t: number, r = 6) => Math.abs(e.clientX - xOf(t)) <= r;
    const t = v.s + f * v.d;
    const base = { x: f, px, vs: v.s, vd: v.d };
    // Top strip of the violet "video available" band: slide it to move the sync by hand.
    if (!cfg.linked && !camTakeRef.current && videoBlob && videoDur > 0 && (e.clientY - rect.top) / rect.height < 0.2 && t >= cfg.offset + clipSpan(cfg, videoDur)[0] && t <= cfg.offset + clipSpan(cfg, videoDur)[1]) {
      dragWave.current = { mode: "offset", ...base, start: cfg.offset, duration: 0 };
      return;
    }
    const seg = { ...base, start: cfg.crop.start, duration: cfg.crop.duration };
    const end = cfg.crop.start + cfg.crop.duration;
    // The playhead first (a thin line inside the segment), then the edges (each one crops its side), then the segment.
    if (near(head) && (head < cfg.crop.start + 0.05 || head > end - 0.05 || Math.abs(head - cfg.crop.start) > 0.05 && Math.abs(head - end) > 0.05)) dragWave.current = { mode: "head", ...seg };
    else if (near(cfg.crop.start, 9) && (!near(end, 9) || Math.abs(e.clientX - xOf(cfg.crop.start)) <= Math.abs(e.clientX - xOf(end)))) dragWave.current = { mode: "start", ...seg };
    else if (near(end, 9)) dragWave.current = { mode: "end", ...seg };
    else if (t > cfg.crop.start && t < end) dragWave.current = { mode: "press", ...seg };
    // Unlocked: outside the segment, the playhead goes there (and follows the drag).
    // Outside the segment: the playhead goes there (and follows the drag), loop on or off.
    else { setHead(headAt(f)); dragWave.current = { mode: "head", ...seg }; }
  };  /**
   * Lyrics and hook tracks: drag anywhere to move the playhead; a click on a caption goes to its start,
   * a click elsewhere puts the playhead there. `onCue`: also called for a click on a caption.
   */
  const scrubRef = useRef<{ px: number; at: number | null; pick: string | null; moved: boolean;
    /** A line grabbed by its body (as a clip in an editor: moved whole, its length kept): which, and the lines then. */
    mv?: { i: number; cues: Cue[]; words: LyricWord[]; w: { s: number; d: number }; width: number } } | null>(null);
  const scrub = (onCue?: () => void) => {
    const timeOf = (el: HTMLElement, x: number) => {
      const r = el.getBoundingClientRect();
      const w = viewRef.current ?? twRef.current; // what is on screen (live while playing)
      const [lo, hi] = headRange();
      return round2(clamp(w.s + clamp((x - r.left) / r.width, 0, 1) * w.d, lo, hi));
    };
    return {
      onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
        if (e.button === 1) return; // the wheel pressed: not a click on the track, playback goes on
        stop();
        e.currentTarget.setPointerCapture(e.pointerId);
        const cue = (e.target as HTMLElement).closest<HTMLElement>("[data-at]");
        scrubRef.current = { px: e.clientX, at: cue ? Number(cue.dataset.at) : null, pick: cue?.dataset.pick ?? null, moved: false };
        // A line's body: dragged, the line moves whole (the segment's lines or the song's, outside it).
        const line = (e.target as HTMLElement).closest<HTMLElement>("[data-mv]");
        if (line && mode !== "word") {
          const [kind, n] = (line.dataset.mv ?? "").split(":");
          dragHead.current = headRef.current;
          scrubRef.current.mv = { i: Number(n), cues: kind === "song" ? songCues : cues, words: project.lyricWords ?? [], w: viewRef.current ?? twRef.current, width: e.currentTarget.getBoundingClientRect().width };
        }
      },
      onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
        const d = scrubRef.current;
        if (!d) return;
        if (!d.moved && Math.abs(e.clientX - d.px) < 4) return;
        d.moved = true;
        if (d.mv) {
          const { i, cues: cs, words, w, width } = d.mv, c = cs[i];
          if (!c) return;
          let delta = ((e.clientX - d.px) / Math.max(1, width)) * w.d;
          // (its start, else its end, to the segment's start or the playhead within 8 px; ⌘: free)
          const pps = width / w.d, ms = magnet(e, c.start + delta, pps), me = ms === null ? magnet(e, c.end + delta, pps) : null;
          if (ms !== null) delta = ms - c.start; else if (me !== null) delta = me - c.end;
          // (back where it started: the start again, never the last move kept)
          const out = moveCueBy(words, cs, i, delta) ?? words;
          setTab("lyrics"); onProject((p) => ({ ...p, lyricWords: out }));
          return;
        }
        const t = timeOf(e.currentTarget, e.clientX);
        setHead(t);
        scrubSound(t);
      },
      onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => {
        const d = scrubRef.current;
        scrubRef.current = null;
        if (d?.moved && d.mv) { setPick(d.pick); onSaveNow(); return; }
        if (!d || d.moved) return;
        if (d.at !== null) { setHead(round2(d.at)); setPick(d.pick); onCue?.(); }
        else { setHead(timeOf(e.currentTarget, e.clientX)); setPick(null); }
      },
      onPointerCancel: () => { scrubRef.current = null; },
    };
  };
  /** Time under the pointer, kept inside the segment (where the playhead lives). */
  const headAt = (f: number) => {
    const v = viewOf(), [lo, hi] = headRange();
    return round2(clamp(v.s + f * v.d, lo, hi));
  };
  /**
   * Where the playhead may go: the segment while the video is locked to the audio (the padlock); unlocked, anywhere in
   * the song (to try things outside the synced video: the intro, another passage), played from there to the song's end.
   */
  const headRange = (): [number, number] => {
    const cfg = settingsRef.current;
    // (anywhere, loop on or off: the loop only keeps the playing in the segment)
    return [0, Math.max(0, (audioBuf?.duration ?? cfg.crop.start + cfg.crop.duration) - 0.05)];
  };
  const waveMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, e.clientX);
    const d = dragWave.current;
    if (!d || !audioBuf) return;
    const dur = audioBuf.duration;
    const f = wavePos(e);
    if (d.mode === "none") return;
    if (d.mode === "head") { const t = headAt(f); setHead(t); scrubSound(t); return; }
    if (d.mode === "press") {
      if (Math.abs(e.clientX - d.px) < 4) return;
      d.mode = "move"; // it is a drag: the segment moves
    }
    const delta = (f - d.x) * d.vd;
    // The segment's edges stick to the camera video's start and end within 8 px, always on its inside: dropped "right on
    // it" by eye, a few pixels past made the video "stop before the segment ends".
    const pxSec = d.vd / Math.max(1, e.currentTarget.getBoundingClientRect().width);
    const snapIn = (t: number, edge: "start" | "end") => {
      if (!videoBlob || videoDur <= 0) return t;
      // (the same length the notice checks: on the Drive copy, the take's own)
      const cur = settingsRef.current;
      const len = onCopy && cur.source?.duration ? cur.source.duration : videoDur;
      const [ci, co] = clipSpan(cur, len);
      const off = cur.offset + ci, vEnd = cur.offset + co;
      if (edge === "end" && Math.abs(t - vEnd) <= 8 * pxSec) return Math.floor(vEnd * 100) / 100;
      if (edge === "start" && Math.abs(t - off) <= 8 * pxSec) return Math.ceil(off * 100) / 100;
      return t;
    };
    if (d.mode === "pan") { userPanAt.current = performance.now(); setView({ s: clamp(d.vs - delta, 0, dur - d.vd), d: d.vd }); return; }
    const bounds = boundsOf(settingsRef.current);
    // The preview follows the edge being dragged: the picture shown is the one under that edge.
    if (d.mode === "offset") {
      // The video may start before the song (negative offset) or end after it.
      setV({ offset: round2(clamp(d.start + delta, 1 - videoDur, Math.max(0, dur - 1))) });
    } else if (d.mode === "start") {
      // The left edge crops the start: the end stays where it is.
      const endT = d.start + d.duration;
      const start = Math.min(endT - 1, Math.max(round2(clamp(snapIn(d.start + delta, "start"), bounds[0], endT - 1)), bounds[0]));
      setV({ crop: { start, duration: round2(endT - start) } });
      setHead(start);
    } else if (d.mode === "end") {
      const endT = Math.min(bounds[1], snapIn(d.start + clamp(d.duration + delta, 1, Math.max(1, bounds[1] - d.start)), "end"));
      const duration = Math.max(1, Math.floor((endT - d.start) * 100 + 1e-6) / 100); // never past the edge it sticks to, nor its bounds
      setV({ crop: { start: d.start, duration } });
      setHead(round2(Math.max(d.start, d.start + duration - 0.1)));
    } else {
      // Moved whole: an edge brought next to the video's start or end sticks to it.
      let s = d.start + delta;
      const sEnd = snapIn(s + d.duration, "end");
      if (sEnd !== s + d.duration) s = sEnd - d.duration;
      else s = snapIn(s, "start");
      const crop = fitCrop(s, d.duration, bounds);
      setV({ crop });
      setHead(crop.start);
    }
  };
  const waveUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    pointers.current.delete(e.pointerId);
    const d = dragWave.current;
    dragWave.current = null;
    if (d?.mode === "press") setHead(headAt(wavePos(e))); // a click inside the segment: the playhead goes there
  };
  /**
   * Two fingers anywhere on the timeline (waveform, lyrics, hooks, cameras): pinch to zoom, slide both to move along
   * the track, the moment under the fingers' middle staying under it. What the first finger started (a scrub, a drag)
   * is dropped; once pinched, the fingers left do nothing until all are lifted. Playback goes on.
   */
  const touches = useRef(new Map<number, number>());
  const pinch = useRef<{ dist: number; vd: number; mid: number; left: number; width: number; done?: boolean } | null>(null);
  const timelineTouch = {
    onPointerDownCapture: (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerType !== "touch" || !audioBuf) return;
      touches.current.set(e.pointerId, e.clientX);
      if (pinch.current) { e.stopPropagation(); return; }
      if (touches.current.size < 2) return;
      e.stopPropagation();
      dragWave.current = null; scrubRef.current = null; cutDrag.current = null; edgeRef.current = null;
      const el = (e.target as HTMLElement).closest<HTMLElement>(".wave, .lyric-track") ?? waveRef.current;
      const r = el?.getBoundingClientRect();
      if (!r?.width) return;
      const [a, b] = [...touches.current.values()], v = viewOf();
      pinch.current = { dist: Math.max(10, Math.abs(a - b)), vd: v.d, mid: v.s + clamp(((a + b) / 2 - r.left) / r.width, 0, 1) * v.d, left: r.left, width: r.width };
    },
    onPointerMoveCapture: (e: React.PointerEvent<HTMLDivElement>) => {
      if (!touches.current.has(e.pointerId)) return;
      touches.current.set(e.pointerId, e.clientX);
      const p = pinch.current;
      if (!p || !audioBuf) return;
      e.stopPropagation();
      if (p.done || touches.current.size < 2) return;
      const dur = audioBuf.duration;
      const [a, b] = [...touches.current.values()];
      userPanAt.current = performance.now();
      const span = clamp(p.vd * (p.dist / Math.max(10, Math.abs(a - b))), Math.min(2, dur), dur);
      if (span >= dur - 1e-3) { setView(null); return; }
      const k = clamp(((a + b) / 2 - p.left) / p.width, 0, 1);
      setView({ s: clamp(p.mid - k * span, 0, dur - span), d: span });
    },
    onPointerUpCapture: (e: React.PointerEvent<HTMLDivElement>) => touchUp(e.pointerId),
    onPointerCancelCapture: (e: React.PointerEvent<HTMLDivElement>) => touchUp(e.pointerId),
  };
  function touchUp(id: number) {
    touches.current.delete(id);
    if (!pinch.current) return;
    pinch.current.done = true;
    if (!touches.current.size) pinch.current = null;
  }
  /**
   * The wheel button held down anywhere on the timeline (waveform and tracks), as in Ableton: drag down to zoom in,
   * up to zoom out, sideways to move along the track; the moment grabbed stays under the pointer. Playback goes on.
   */
  const wheelDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 1 || !audioBuf) return;
    e.preventDefault();
    e.stopPropagation(); // not a click on the waveform or a track
    const dur = audioBuf.duration;
    const el = (e.target as HTMLElement).closest<HTMLElement>(".wave, .lyric-track") ?? waveRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const v0 = viewOf();
    const at = v0.s + clamp((e.clientX - r.left) / r.width, 0, 1) * v0.d;
    const y0 = e.clientY;
    const move = (m: PointerEvent) => {
      userPanAt.current = performance.now();
      const d = clamp(v0.d * Math.exp((m.clientY - y0) * -0.008), Math.min(2, dur), dur);
      if (d >= dur - 1e-3) { setView(null); return; }
      const k = (m.clientX - r.left) / r.width;
      setView({ s: clamp(at - k * d, 0, dur - d), d });
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  // Anywhere on the timeline (waveform, lyrics, hooks, cameras): a trackpad pinch (ctrl + wheel) or ⌘ + the wheel zooms
  // around the pointer, a sideways swipe (or Shift + the wheel) slides the view. A plain vertical wheel scrolls the
  // page, as anywhere else.
  const timelineRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const c = timelineRef.current;
    if (!c || !audioBuf) return;
    const h = (e: WheelEvent) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>(".wave, .lyric-track");
      if (!el) return;
      const r = el.getBoundingClientRect();
      const v = viewOf();
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomTo(v.d * Math.exp(e.deltaY * 0.012), v.s + clamp((e.clientX - r.left) / r.width, 0, 1) * v.d);
      } else if (viewRef.current && (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY))) {
        // A sideways swipe, or Shift + the mouse wheel: the view slides along the track.
        e.preventDefault();
        userPanAt.current = performance.now();
        const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        setView({ s: clamp(v.s + (dx / r.width) * v.d, 0, audioBuf.duration - v.d), d: v.d });
      }
    };
    c.addEventListener("wheel", h, { passive: false });
    return () => c.removeEventListener("wheel", h);
  }, [audioBuf]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The track's envelope, as Ableton draws it: the lowest and highest sample of every 256 (about 5 ms), and the
   *  loudest sample (the scale of the whole waveform, zoomed or not). Read by `paintWave`, never per frame from the samples. */
  const waveEnv = useMemo(() => {
    if (!audioBuf) return null;
    const ch = audioBuf.getChannelData(0), hop = 256, n = Math.ceil(ch.length / hop);
    const lo = new Float32Array(n), hi = new Float32Array(n);
    let m = 1e-9;
    for (let k = 0; k < n; k++) {
      let a = 0, b = 0;
      for (let i = k * hop, e = Math.min(ch.length, i + hop); i < e; i++) { const x = ch[i]; if (x < a) a = x; else if (x > b) b = x; }
      lo[k] = a; hi[k] = b;
      if (-a > m) m = -a;
      if (b > m) m = b;
    }
    return { lo, hi, hop, max: m };
  }, [audioBuf]);
  const peakMax = waveEnv?.max ?? 1;
  // The tracks' inner width (px), for placing their clips by transform (see `place`).
  const [trackW, setTrackW] = useState(0);
  const trackRo = useRef<ResizeObserver | null>(null);
  const trackRef = useCallback((el: HTMLDivElement | null) => {
    trackRo.current?.disconnect();
    if (!el) return;
    setTrackW(el.clientWidth);
    trackRo.current = new ResizeObserver(() => setTrackW(el.clientWidth));
    trackRo.current.observe(el);
  }, []);
  // The waveform is drawn at the size it is shown, in screen pixels (Retina included): never stretched, always sharp.
  const [waveBox, setWaveBox] = useState({ w: 0, dpr: 1 });
  useEffect(() => {
    const c = waveRef.current;
    if (!c) return;
    const ro = new ResizeObserver(() => setWaveBox({ w: Math.round(c.clientWidth), dpr: window.devicePixelRatio || 1 }));
    ro.observe(c);
    return () => ro.disconnect();
  }, [audioBuf]);
  /**
   * The waveform drawn for a view and a playhead. While playing it is called every frame by the playback itself
   * (paintTimeline), not through a render of the whole studio: the timeline glides. Kept fresh in a ref.
   */
  /** Where the video set in the right column is on the track (its part kept), and its camera number (its colour). */
  const bandOf = (): { off: number; ci: number; co: number; cam: number } => {
    const ovSet = overlayOf(settings, ovTake?.id);
    if (ovTake && ovSet) {
      const a = anglesRef.current.get(ovTake.id), len = a && Number.isFinite(a.el.duration) ? a.el.duration : ovTake.source?.duration ?? 0;
      const [i, o] = clipSpan(ovSet, len);
      return { off: ovSet.offset, ci: i, co: o, cam: overNo(settings, ovTake.id) };
    }
    if (camTake) {
      const a = anglesRef.current.get(camTake.id), len = a && Number.isFinite(a.el.duration) ? a.el.duration : camTake.source?.duration ?? 0;
      return { off: camTake.offset, ci: 0, co: len, cam: Math.max(0, (settings.angles ?? []).indexOf(camTake.id) + 1) };
    }
    const [i, o] = clipSpan(settings, videoDur);
    return { off: settings.offset, ci: i, co: o, cam: 0 };
  };
  /** Desktop: one playhead crosses the whole timeline (the phone keeps one per line, the waveform's in it). */
  const wideTimeline = () => typeof window !== "undefined" && window.matchMedia("(min-width: 641px)").matches;
  const paintWave = (vw: { s: number; d: number } | null, at: number) => {
    const c = waveRef.current;
    if (!c || !peaks.length || !audioBuf || !waveBox.w) return;
    const W = waveBox.w, H = c.clientHeight || 90, dur = audioBuf.duration, dpr = waveBox.dpr;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const g = c.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS pixels
    // The app's colours (globals.css): the accent, the camera video (violet) and the music in it (green).
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue("--accent").trim() || "#f0eee8";
    const head0 = css.getPropertyValue("--accent-hi").trim() || "#ffffff";
    // The band shows the video set in the right column (camera 1, a camera of the multicam, the one over it), in its colour.
    const bandSel = bandOf();
    const vid = css.getPropertyValue(["--accent", "--video", "--music", "--lyrics"][bandSel.cam] ?? "--video").trim() || "#a184ff";
    g.fillStyle = "#16161c";
    g.fillRect(0, 0, W, H);
    const v = vw ?? { s: 0, d: dur };
    const X = (t: number) => ((t - v.s) / v.d) * W;
    const x0 = X(settings.crop.start);
    const x1 = X(Math.min(dur, settings.crop.start + settings.crop.duration));
    // Where the camera video exists on the official track.
    const ci = bandSel.ci, co = bandSel.co;
    // A video running past the view's edge has no rounded corner there (the waveform's corners clipped its band: it
    // looked as if it started at the view's start).
    const past = videoBlob && videoDur > 0 && co > ci;
    c.style.borderTopLeftRadius = c.style.borderBottomLeftRadius = past && X(bandSel.off + ci) < 0 ? "0" : "";
    c.style.borderTopRightRadius = c.style.borderBottomRightRadius = past && X(bandSel.off + co) > W ? "0" : "";
    if (videoBlob && videoDur > 0 && co > ci) {
      const v0 = clamp(X(bandSel.off + ci), 0, W);
      const v1 = clamp(X(bandSel.off + co), 0, W);
      g.fillStyle = vid;
      g.globalAlpha = 0.14;
      g.fillRect(v0, 0, Math.max(0, v1 - v0), H);
      g.globalAlpha = 1;
      g.fillRect(v0, 0, Math.max(0, v1 - v0), 15);
    }
    g.fillStyle = accent; // the segment: a faint ground of the accent
    g.globalAlpha = 0.09;
    g.fillRect(x0, 0, Math.max(0, x1 - x0), H);
    g.globalAlpha = 1;
    // A filled waveform (as Ableton: the sound's lowest and highest point in every pixel column, one shape, no bars).
    // Each column is a fixed slice of the track (a grid in seconds, not in the view): when the view slides (playing,
    // zoomed) the shape moves along with the sound instead of being cut again at every step, which made it shimmer.
    // Zoomed in further than the envelope's 5 ms, read from the samples themselves (only the view's few).
    const env = waveEnv;
    const sr = audioBuf.sampleRate;
    const bin = v.d / W; // seconds per CSS pixel
    const ch = env && bin * sr < env.hop * 2 ? audioBuf.getChannelData(0) : null;
    // Around the playhead the shape lights up in white, fading back to grey on both sides (what is playing).
    // (on the screen's pixel grid: not zoomed, the playhead moves less than a pixel a frame, and drawn between pixels
    // it blurred and sharpened in turn, which read as stutter)
    const hx = Math.round(X(at) * dpr) / dpr, trail = 70;
    // Under the video's band (top, 15 px) when there is a camera video, never under it; else centred on the whole height.
    const band = videoBlob && videoDur > 0;
    const top = band ? 17 : 9, room = H - top - (band ? 6 : 9), mid = top + room / 2, half = room / 2;
    const xs: number[] = [], ups: number[] = [], downs: number[] = [];
    for (let k = Math.floor(v.s / bin) - 1; k * bin < v.s + v.d + bin; k++) {
      const t0 = k * bin, t1 = t0 + bin;
      let a = 0, b = 0;
      if (t1 > 0 && t0 < dur) {
        if (ch) {
          const i0 = Math.max(0, Math.floor(t0 * sr)), i1 = Math.min(ch.length, Math.max(i0 + 1, Math.ceil(t1 * sr)));
          for (let q = i0; q < i1; q++) { const x = ch[q]; if (x < a) a = x; else if (x > b) b = x; }
        } else if (env) {
          const i0 = Math.max(0, Math.floor((t0 * sr) / env.hop)), i1 = Math.min(env.lo.length, Math.max(i0 + 1, Math.ceil((t1 * sr) / env.hop)));
          for (let q = i0; q < i1; q++) { if (env.lo[q] < a) a = env.lo[q]; if (env.hi[q] > b) b = env.hi[q]; }
        }
      }
      xs.push(X(t0 + bin / 2));
      ups.push(mid - Math.max(0.5, Math.min(1, b / peakMax) * half));
      downs.push(mid + Math.max(0.5, Math.min(1, -a / peakMax) * half));
    }
    if (xs.length) {
      g.beginPath();
      g.moveTo(xs[0], ups[0]);
      for (let j = 1; j < xs.length; j++) g.lineTo(xs[j], ups[j]);
      for (let j = xs.length - 1; j >= 0; j--) g.lineTo(xs[j], downs[j]);
      g.closePath();
      g.fillStyle = "#6f6e78";
      g.fill();
      if (hx + trail > 0 && hx - trail < W) {
        // Centred on the playhead: the grey far on each side, white around the playhead.
        const glow = g.createLinearGradient(hx - trail, 0, hx + trail, 0);
        glow.addColorStop(0, "rgba(255,255,255,0)");
        glow.addColorStop(0.5, head0);
        glow.addColorStop(1, "rgba(255,255,255,0)");
        g.fillStyle = glow;
        g.fill();
      }
    }
    // Linked: what lies outside the synced video is out of reach for the segment.
    const range = settings.linked ? linkRangeOf(settings) : null;
    if (range) {
      g.fillStyle = "rgba(10,10,14,.62)";
      const r0 = clamp(X(range[0]), 0, W), r1 = clamp(X(range[1]), 0, W);
      g.fillRect(0, 0, r0, H);
      g.fillRect(r1, 0, W - r1, H);
    }
    // Edges of the segment: the accent, dimmed, with a grip; the playhead: the bright accent. Never mistaken.
    g.fillStyle = accent;
    g.globalAlpha = 0.6;
    g.fillRect(x0 - 1, 0, 3, H);
    g.fillRect(x1 - 2, 0, 3, H);
    g.globalAlpha = 1;
    g.fillRect(x0 - 3, H / 2 - 10, 5, 20);
    g.fillRect(x1 - 2, H / 2 - 10, 5, 20);
    if (!wideTimeline()) { g.fillStyle = head0; g.fillRect(hx - 1, 0, 2, H); }
    if (videoBlob && videoDur > 0 && co > ci) {
      const v0 = clamp(X(bandSel.off + ci), 0, W);
      if (clamp(X(bandSel.off + co), 0, W) - v0 > 80) {
        // As on its clip: the film icon, then « VIDÉO 2 » (the number of the video set: its colour is the band's).
        g.fillStyle = g.strokeStyle = "#0c0c0e";
        g.save();
        g.translate(Math.round(v0 + 5), 2.5);
        g.scale(10 / 24, 10 / 24);
        g.lineWidth = 2.4;
        g.lineJoin = "round";
        g.stroke(FILM_PATH);
        g.restore();
        g.font = "600 10px ui-monospace, 'JetBrains Mono', monospace";
        g.textBaseline = "middle";
        g.fillText(`${t("Video").toLocaleUpperCase()} ${bandSel.cam + 1}`, Math.round(v0 + 19), 8);
      }
    }
  };
  const paintWaveRef = useRef(paintWave);
  paintWaveRef.current = paintWave;
  useEffect(() => { paintWaveRef.current(viewRef.current, headRef.current); }, [peaks, settings.crop, settings.offset, settings.clipIn, settings.clipOut, settings.linked, settings.takes, head, view, audioBuf, videoBlob, videoDur, waveBox, peakMax]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- lyrics timing ----

  /**
   * Plan B: a section's lines spread over the segment (on the attacks of the official audio when there is one),
   * as placed words: the same list as the synced lyrics, fine-tuned with − / +.
   */
  const spreadLyrics = () => {
    if (!section) return;
    const sung = parseLyrics(section.text).text.split("\n").map((x) => x.trim()).filter(Boolean);
    if (!sung.length) return;
    const cfg = settingsRef.current;
    const from = cfg.crop.start, to = cfg.crop.start + cfg.crop.duration;
    const starts = audioBuf
      ? autoLineTimes(sung, envelopeOf(audioBuf.getChannelData(0), audioBuf.sampleRate, RATE), RATE, from, to)
      : sung.map((_, k) => from + 0.4 + ((to - from - 0.8) * k) / sung.length);
    const words: LyricWord[] = [];
    sung.forEach((line, k) => {
      const a = starts[k], b = k + 1 < sung.length ? starts[k + 1] : Math.min(to, a + 4);
      const ws = line.split(/\s+/).filter(Boolean);
      const d = Math.max(0.05, (b - a - 0.1) / ws.length);
      ws.forEach((w, j) => words.push({ w, s: round2(a + j * d), e: round2(a + (j + 1) * d), line: 10000 + k }));
    });
    onProject((p) => ({ ...p, lyricWords: [...(p.lyricWords ?? []).filter((x) => x.e <= from || x.s >= to), ...words].sort((x, y) => x.s - y.s) }));
    if (!cfg.captions) setV({ captions: true });
    setNote(t("Lyrics spread on the segment: adjust each line with − / +."));
    onSaveNow();
  };

  // ---- lyrics from the official audio ----
  const writtenOf = (src: string, p: Project) =>
    // Linked: the song is the release's sections (the same text as the carousel's).
    src === "song" && p.lyricsLinked ? sungOf(p.lyrics) : parseLyrics(src === "none" ? "" : src === "song" ? p.songLyrics ?? ""
      : src === "all" ? p.lyrics.map((l) => l.text).join("\n") : p.lyrics.find((l) => l.id === src)?.text ?? "").text;
  const lyricsLinked = !!project.lyricsLinked;
  const sungLines = useMemo(() => { const s = sungOf(project.lyrics); return s ? s.split("\n").length : 0; }, [project.lyrics]);

  /**
   * Put the written lyrics on the heard words: the text shown is exactly the written one, the speech
   * model only says when each word is sung. The whole song is placed on the whole track; one section
   * only on the post's segment.
   */
  const placeWords = (heard: LyricWord[], src: string, p: Project, segFrom: number, segTo: number): { words: LyricWord[]; info: string; approx?: boolean } => {
    // An excerpt of the song: only the lines it holds (the others would be piled at its start).
    const r = placeAll(heard, src, p, segFrom, segTo), ln = p.lyricLines;
    return ln ? { ...r, words: r.words.filter((w) => w.line === undefined || (w.line >= ln[0] && w.line <= ln[1])) } : r;
  };
  const placeAll = (heard: LyricWord[], src: string, p: Project, segFrom: number, segTo: number): { words: LyricWord[]; info: string; approx?: boolean } => {
    const written = writtenOf(src, p);
    if (!written.trim()) return { words: [], info: t("No lyrics: paste them to show them on the video.") };
    // Never words "as heard": the written ones always. Too few of them recognised in the audio (a sung, busy mix): they
    // are spread over the singing heard, in order, to retouch, rather than no lyrics at all.
    const rough = (on: LyricWord[]) => {
      const words = spreadOnHeard(written, on);
      return words
        ? { words, approx: true, info: t("Your lyrics were placed roughly on the singing (few words recognised in this mix): check them, retouch a line with − / +, or try the Precise model.") }
        : { words: [], info: t("Your lyrics could not be placed on this audio. Check it is the same song, or set the language.") };
    };
    if (src === "song" || src === "all") {
      const aligned = alignSong(written, heard);
      // Words placed by forced alignment are exact: the tightening and snapping made for the speech model's looser
      // times would only move them (a line pushed 1 s late).
      const exact = heard.length > 0 && heard.every((x) => x.exact);
      return aligned
        ? { words: exact ? aligned.words : snapLines(tightenLineStarts(aligned.words), onsetsRef.current), info: t("Your lyrics are synced on the whole song: {n} words, {p}% recognised in the audio", { n: aligned.words.length, p: Math.round(aligned.coverage * 100) }) }
        : rough(heard);
    }
    const inSeg = heard.filter((x) => x.e > segFrom && x.s < segTo);
    const aligned = inSeg.length ? alignLyrics(written, inSeg) : null;
    if (!aligned) {
      const r = rough(inSeg);
      return r.words.length ? { ...r, words: [...heard.filter((x) => x.e <= segFrom || x.s >= segTo), ...r.words].sort((x, y) => x.s - y.s) } : r;
    }
    return {
      words: [...heard.filter((x) => x.e <= segFrom || x.s >= segTo), ...snapLines(tightenLineStarts(aligned.words), onsetsRef.current)].sort((x, y) => x.s - y.s),
      info: t("{n} words heard, the segment placed on your written lyrics", { n: heard.length }),
    };
  };

  /**
   * Place the written lyrics again on the words already heard: instant, no new analysis.
   * The lines retimed by hand keep their timing, unless `fresh` (back to the automatic timing).
   */
  const resyncLyrics = (src = writtenSrc, p = project, fresh = false) => {
    const heard = p.heardWords;
    if (!heard?.length) { void generateLyrics(); return; }
    const cfg = settingsRef.current;
    const r = placeWords(heard, src, p, cfg.crop.start - 0.5, cfg.crop.start + cfg.crop.duration + 0.5);
    onProject((x) => ({ ...x, lyricWords: fresh ? keepLocked(x.lyricWords ?? [], r.words) : keepManual(x.lyricWords ?? [], r.words), lyricsPlacedFrom: writtenOf(src, p), lyricsAlignV: LYRICS_ALIGN_V }));
    setGenInfo(r.info);
    if (r.words.length && !cfg.captions) setV({ captions: true });
    onSaveNow();
  };

  // The way the lyrics are placed got better (a word the model missed now always shows, inside its line): the
  // lyrics already timed are placed again once, on the words already heard, the retouches kept. Never emptied.
  useEffect(() => {
    if (genBusy || (project.lyricsAlignV ?? 0) >= LYRICS_ALIGN_V || !project.heardWords?.length || !project.lyricWords?.length) return;
    const id = setTimeout(() => {
      const cfg = settingsRef.current;
      const r = writtenOf(writtenSrc, project).trim() ? placeWords(project.heardWords!, writtenSrc, project, cfg.crop.start - 0.5, cfg.crop.start + cfg.crop.duration + 0.5) : null;
      onProject((x) => (r?.words.length
        ? { ...x, lyricWords: keepManual(x.lyricWords ?? [], r.words), lyricsPlacedFrom: writtenOf(writtenSrc, x), lyricsAlignV: LYRICS_ALIGN_V }
        : { ...x, lyricsAlignV: LYRICS_ALIGN_V }));
      onSaveNow();
    }, 800);
    return () => clearTimeout(id);
  }, [project.id, project.lyricsAlignV, !!project.heardWords?.length, genBusy]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pasted lyrics are saved as you type (nothing lost on a reload), and once the song has been
  // heard, every edit re-places the lyrics at once: the timed lines below follow the text.
  useEffect(() => {
    if (paste === (project.songLyrics ?? "")) return;
    const id = setTimeout(() => {
      // Linked: the song edited here goes back into the release's sections (the carousel's slides follow);
      // the lyrics are placed again by the effect below.
      if (lyricsLinked) {
        if (paste.trim() && sungOf(project.lyrics) !== parseLyrics(paste).text) {
          onProject((p) => refreshLyricSlides({ ...p, songLyrics: paste, lyrics: mergeSong(p.lyrics, paste, (n) => t("Part {n}", { n }), t("Chorus")) }));
        }
        return;
      }
      onProject((p) => ({ ...p, songLyrics: paste }));
      if (writtenSrc === "song" && project.heardWords?.length && !genBusy) resyncLyrics("song", { ...project, songLyrics: paste });
      else onSaveNow();
    }, 700);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paste]);

  // Lyrics written in the Library after the release was opened: linked at once (otherwise the sync button
  // stayed greyed until a reload, `linkLyrics` only ran on loading). Only when nothing else is pasted here.
  useEffect(() => {
    if (project.lyricsLinked || !sungOf(project.lyrics).trim()) return;
    const linked = linkLyrics(project);
    if (!linked.lyricsLinked) return;
    setWrittenSrc("song");
    setPaste(songOf(project.lyrics));
    onProject((p) => linkLyrics(p));
  }, [project.lyrics, project.lyricsLinked]); // eslint-disable-line react-hooks/exhaustive-deps
  // Linked: the sections changed elsewhere (the carousel): the text here follows, unless it is being typed in.
  useEffect(() => {
    if (!lyricsLinked || document.activeElement === pasteRef.current) return;
    if (parseLyrics(paste).text !== sungOf(project.lyrics)) setPaste(songOf(project.lyrics));
  }, [project.lyrics, lyricsLinked]); // eslint-disable-line react-hooks/exhaustive-deps
  // ...and the video's lyrics are placed again on the words already heard: only the changed lines move,
  // the lines retimed by hand keep their timing. Nothing to do when the sung words are the same.
  useEffect(() => {
    if (!lyricsLinked || genBusy || !project.heardWords?.length) return;
    if (sungOf(project.lyrics) === (project.lyricsPlacedFrom ?? "")) return;
    const id = setTimeout(() => resyncLyrics("song", project), 400);
    return () => clearTimeout(id);
  }, [project.lyrics, project.lyricsPlacedFrom, lyricsLinked, genBusy]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Lyrics there are to place: the pasted ones (even not saved yet) or the chosen carousel ones. */
  const hasLyrics = !!(lyricsLinked ? sungOf(project.lyrics).trim() : writtenSrc === "song" ? parseLyrics(paste).text.trim() : writtenOf(writtenSrc, project).trim());

  /**
   * The one sync button: the video on the official audio (when there is one), then the written
   * lyrics on the audio (when there are some). The words already heard are reused: no new analysis.
   */
  const syncAll = async () => {
    // autoSync starts the audio capture of the video right away: it must run inside the click.
    const video = videoBlob ? autoSync() : Promise.resolve();
    await video;
    await syncLyrics();
  };

  /**
   * This audio is an excerpt of the song: the written lines it holds, read from a clearly longer version of the release
   * that has its lyrics placed (where this one sits in it, its lines there). None: not an excerpt, or nothing to tell.
   */
  const excerptLines = async (): Promise<[number, number] | undefined> => {
    // (an excerpt where the longer version sings nothing, an intro: [0, -1], no line)
    if (!audioBuf) return undefined;
    for (const v of audioVersionsOf(releaseRef.current)) {
      if (v.id === audioId || !v.lyricWords?.length) continue;
      const src = await bufferOf(v.id);
      if (!src || src.buf.duration * 0.85 <= audioBuf.duration) continue;
      await new Promise((r) => setTimeout(r, 30));
      const m = mapBetween(src.buf, audioBuf);
      if (sharedShare(m) < SAME_SONG) continue;
      const ls = (remapWords(m, v.lyricWords) ?? []).map((w) => w.line).filter((l): l is number => l !== undefined);
      console.info(`[lyrics] this audio is an excerpt of “${v.audioName}”: ${ls.length ? `lines ${Math.min(...ls)}–${Math.max(...ls)}` : "no line sung there"}`);
      return ls.length ? [Math.min(...ls), Math.max(...ls)] : [0, -1];
    }
    return undefined;
  };
  /** The written lyrics on the official audio only. They do not depend on the video: changing it never moves them. */
  /** "Re-place the lyrics" asked with lines retimed by hand: first a question (keep the locked ones, or lose them all). */
  const [askReplace, setAskReplace] = useState(false);
  /** The next placing from scratch drops the locks too (everything placed again). */
  const dropLocks = useRef(false);
  /** A line locked (padlock on its clip) or unlocked: kept as it is when the lyrics are placed again. */
  const toggleLock = (c: Cue) => {
    const mine = new Set(c.words), on = !c.words.every((x) => x.lock);
    const words = (project.lyricWords ?? []).map((x) => (mine.has(x) ? (on ? { ...x, lock: true as const } : (({ lock: _l, ...rest }) => rest)(x)) : x));
    lyricWordsRef.current = words;
    onProject((p) => ({ ...p, lyricWords: words }));
    onSaveNow();
  };
  /** Every line locked (or unlocked) at once: the padlock at the lyrics track's end. */
  const toggleAllLocks = (on: boolean) => {
    const words = (project.lyricWords ?? []).map((x) => (on ? { ...x, lock: true as const } : (({ lock: _l, ...rest }) => rest)(x)));
    lyricWordsRef.current = words;
    onProject((p) => ({ ...p, lyricWords: words }));
    onSaveNow();
  };
  const syncLyrics = async () => {
    let next = project;
    if (writtenSrc === "song" && !lyricsLinked && paste.trim() !== (project.songLyrics ?? "").trim()) {
      const text = paste.trim();
      next = { ...project, songLyrics: text, heardWords: project.heardWords };
      onProject((p) => ({ ...p, songLyrics: text }));
    }
    if (!hasLyrics || !audioBuf) return;
    // An excerpt of the song (a version added before it was known, or never told): the lines it holds found now, by
    // where it sits in a longer version that has its lyrics; kept with it.
    // Found again at each sync asked by hand (the lyrics may have changed since: lines added at the top shift the numbers,
    // the longer version placed again with a chorus it did not have); the one kept before only when none is found now.
    const longer = audioVersionsOf(releaseRef.current).some((v) => v.id !== audioId && v.lyricWords?.length);
    if (longer) setGenInfo(t("Finding which part of the song this audio is…"));
    const found = longer ? await excerptLines().catch(() => undefined) : undefined;
    if (longer) setGenInfo(null);
    const lines = found ?? next.lyricLines;
    if (found) onProject((p) => ({ ...p, lyricLines: found }));
    next = { ...next, lyricLines: lines };
    // An excerpt where the song sings none of the written lines (an intro): nothing to place, rather than the whole text
    // crammed into it.
    if (lines && lines[1] < lines[0]) {
      onProject((p) => ({ ...p, lyricWords: [], heardWords: undefined, lyricsPlacedFrom: writtenOf(writtenSrc, next) }));
      setGenInfo(t("This part of the song has no lyrics (none are sung there in the longer version): nothing to place."));
      onSaveNow();
      return;
    }
    // Asked by hand: always from scratch, nothing kept from an earlier placing (the words heard or aligned before, the
    // lines retimed by hand). Editing the text still re-places it at once on what was heard (resyncLyrics).
    // (the words heard before stay saved until the new placing replaces them: cancelled or failed, nothing is lost)
    await generateLyrics(audioBuf, { ...next, heardWords: undefined }, writtenSrc, true);
  };


  /**
   * Hear the whole track, window by window (the speech engine reports no progress inside one window):
   * the windows of the post's segment go first, and the words show up as each window is done.
   * Runs by itself when the official audio is imported.
   */
  // The voice's attacks of this audio, read once (a second or two, in the background) for the lyrics placed on it.
  useEffect(() => {
    onsetsRef.current = [];
    if (!audioBuf) return;
    let off = false;
    void voiceOnsets(audioBuf).then((o) => { if (!off) onsetsRef.current = o; }).catch((e) => console.warn("[lyrics] voice attacks not read", e));
    return () => { off = true; };
  }, [audioBuf]);
  /** `fresh`: the new placing replaces everything (the lines retimed by hand too): "Listen to the audio again". */
  const generateLyrics = async (buf: AudioBuffer | null = audioBuf, proj: Project = project, src = writtenSrc, fresh = false) => {
    if (!buf) return;
    genRef.current?.abort();
    const ac = new AbortController();
    genRef.current = ac;
    void askNotifyPermission();
    setGenBusy(true); setGenStep("library"); setGenPct(0); setGenDone(0); setGenInfo(null); setErr(null); setNote(null);
    const cfg = settingsRef.current;
    const segFrom = Math.max(0, cfg.crop.start - 0.5);
    const segTo = Math.min(buf.duration, cfg.crop.start + cfg.crop.duration + 0.5);
    const wins: [number, number][] = [];
    for (let a = 0; ; a += LYRICS_WIN - LYRICS_LAP) {
      wins.push([a, Math.min(buf.duration, a + LYRICS_WIN)]);
      if (a + LYRICS_WIN >= buf.duration) break;
    }
    const near = (w: [number, number]) => (w[1] > segFrom && w[0] < segTo ? 0 : Math.min(Math.abs(w[0] - segTo), Math.abs(w[1] - segFrom)) + 1);
    const order = wins.map((_, i) => i).sort((i, j) => near(wins[i]) - near(wins[j]) || i - j);
    let outcome: { title: string; body: string } | null = null;
    /** The whole track heard by model `m`, the segment's part first. */
    const listen = async (m: AsrModel) => {
      const out: LyricWord[] = [];
      setGenDone(0);
      for (let k = 0; k < order.length; k++) {
        const i = order[k];
        const [a, b] = wins[i];
        const samples = await prepareAudio(buf, a, b);
        // A word timed outside the excerpt heard is made up (the model's "Sous-titrage…" after the end): left out.
        const hear = async (x: number, y: number, pcm: Float32Array) => {
          const listen1 = (mode: "word" | "segment") => transcribe(pcm, { model: m, language, base: x, mode, onStep: setGenStep, onProgress: setGenPct, signal: ac.signal });
          let raw = await listen1("word");
          // The times of the words collapsed (a repeated chorus: all on one instant, or past the end): the same excerpt
          // heard again with the model's phrase times, which stay right, the words spread inside each phrase.
          // Or the excerpt gave hardly any word (the words are lost with their times): the phrases are tried too.
          const lost = lostCount(raw, x, y);
          if (lost >= 3 || (y - x > 12 && raw.length < (y - x) / 4)) {
            const segs = await listen1("segment");
            if (segs.length && lostCount(segs, x, y) < 3 && (lost >= 3 || segs.length > raw.length)) { console.info(`[lyrics] ${x}–${y} s: word times lost, phrase times used`); raw = segs; }
          }
          return respreadLost(cleanHeard(raw, writtenOf(src, proj)), x, y)
            .filter((w) => w.s >= x - 0.5 && w.s <= y + 0.5);
        };
        let words = await hear(a, b, samples);
        // The model can lose a whole excerpt on music (four made-up words for 28 s of a chorus): fewer than a word every
        // 4 s, it is heard again in two halves, the better kept (a passage with no words, an instrumental, stays empty).
        if (b - a > 12 && words.length < (b - a) / 4) {
          const mid = (a + b) / 2;
          const first = await hear(a, mid + 1, await prepareAudio(buf, a, mid + 1));
          const second = await hear(mid - 1, b, await prepareAudio(buf, mid - 1, b));
          const halves = [...first.filter((w) => (w.s + w.e) / 2 < mid), ...second.filter((w) => (w.s + w.e) / 2 >= mid)];
          if (halves.length > words.length) { console.info(`[lyrics] ${a}–${b} s heard again in halves: ${words.length} → ${halves.length} words`); words = halves; }
        }
        if (ac.signal.aborted) throw new Error("aborted");
        // The overlap between two windows belongs to the one that hears it whole (its middle).
        const lo = i === 0 ? -Infinity : a + LYRICS_LAP / 2;
        const hi = i === wins.length - 1 ? Infinity : b - LYRICS_LAP / 2;
        out.push(...words.filter((w) => { const mid = (w.s + w.e) / 2; return mid >= lo && mid < hi; }));
        out.sort((x, y) => x.s - y.s);
        setGenDone((k + 1) / order.length);
      }
      return out;
    };
    try {
      // The lyrics are written: placed on the audio by forced alignment (nothing to recognise, the written words are
      // only placed), the most exact there is. The speech model is the way out when it cannot run here.
      let forced: LyricWord[] | null = null;
      const writtenAll = src === "song" || src === "all" ? writtenOf(src, proj) : "";
      if (writtenAll.trim()) {
        try {
          // One progress for it all ("Placing the lyrics… n %"): the models' loading (from the browser's cache after the
          // first time), the alignment, the relay; not one bar per model, each looking like the one before failed.
          setGenStep("listen");
          forced = await placeByAlignment(buf, writtenAll, {
            model, language, onOverall: setGenDone, lines: proj.lyricLines,
            onRelay: () => setGenInfo(t("Some passages are hard to hear: listening to them again…")), signal: ac.signal,
          });
        } catch (e) {
          if (ac.signal.aborted || (e instanceof Error && e.message === "aborted")) return;
          throw e;
        }
        setGenStep("library"); setGenPct(0); setGenDone(0);
      }
      let heard = forced ?? await listen(model);
      // Too few words recognised for the lyrics: listened to again, once, by the other model; the better listening of the
      // two is kept (the one the lyrics hold on, else the one that heard more words), never simply the last one.
      if (!forced && writtenOf(src, proj).trim() && (!heard.length || placeWords(heard, src, proj, segFrom, segTo).approx)) {
        const other: AsrModel = model === "turbo" ? "small" : hasGpu() ? "turbo" : model === "small" ? "base" : "small";
        console.info(`[lyrics] few words recognised: listening again with the ${other} model`);
        setGenInfo(t("Few words recognised: listening again with another model…"));
        const again = await listen(other);
        const holds = (h: LyricWord[]) => h.length > 0 && !placeWords(h, src, proj, segFrom, segTo).approx;
        if (holds(again) && !holds(heard)) heard = again;
        else if (!holds(heard) && again.length > heard.length) heard = again;
        console.info(`[lyrics] kept: ${heard === again ? other : model} (${heard.length} words)`);
      }
      if (!heard.length) {
        const msg = t("No words were heard in this track. Try a more accurate model or set the language.");
        setErr(msg);
        outcome = { title: t("Lyrics not found"), body: msg };
      } else {
        // Cancelled, or replaced by a newer one, meanwhile: its result is dropped (it would undo the newer lyrics).
        if (ac.signal.aborted || genRef.current !== ac) return;
        const placed = placeWords(heard, src, proj, segFrom, segTo);
        const { info } = placed;
        // The lines the alignment doubts (the words keep their `line`): marked to check.
        const doubts = new Set((forced ?? []).filter((x) => x.doubt).map((x) => x.line));
        const words = doubts.size ? placed.words.map((x) => (x.line !== undefined && doubts.has(x.line) ? { ...x, doubt: true } : x)) : placed.words;
        // The heard words are kept: editing the written lyrics re-places them without a new analysis.
        onProject((p) => ({ ...p, heardWords: heard, lyricWords: fresh ? (dropLocks.current ? words : keepLocked(p.lyricWords ?? [], words)) : keepManual(p.lyricWords ?? [], words), lyricsPlacedFrom: writtenOf(src, proj) }));
        dropLocks.current = false;
        if (words.length && !settingsRef.current.captions) setV({ captions: true });
        const said = forced
          ? t("Your lyrics are placed on the audio, word by word ({n} words)", { n: words.length }) + (doubts.size ? " · " + (doubts.size === 1 ? t("1 line to check (yellow dot)") : t("{n} lines to check (yellow dot)", { n: doubts.size })) : "")
          : info;
        setGenInfo(said);
        outcome = { title: t("Lyrics ready"), body: said };
        onSaveNow();
      }
    } catch (e) {
      if (ac.signal.aborted || (e instanceof Error && e.message === "aborted")) return;
      console.error("lyrics generation failed", e);
      const msg = t("Lyrics generation failed. Check your connection (the speech model is downloaded once) and try again.");
      setErr(msg);
      outcome = { title: t("Lyrics failed"), body: msg };
    } finally {
      if (genRef.current === ac) {
        genRef.current = null;
        setGenBusy(false);
        setGenStep(null);
        if (outcome) notify(outcome.title, outcome.body);
      }
    }
  };

  /**
   * Every line's words placed again inside it, on the voice (`inLines`): the lines stay where they are, retouched ones
   * too. The model listens to the song once if it has not in this session.
   */
  const refitWords = async () => {
    const words = project.lyricWords;
    if (!audioBuf || !words?.length || genBusy) return;
    setGenBusy(true); setGenStep("listen"); setGenDone(0); setErr(null); setNote(null);
    try {
      const em = await alignEmissions(audioBuf, { onProgress: (p) => setGenDone(p) });
      const out = inLines(words, em, looksFrench(words.map((w) => faNorm(w.w))));
      lyricWordsRef.current = out;
      onProject((p) => ({ ...p, lyricWords: out }));
      onSaveNow();
      setNote(t("The words follow the voice in their lines (the lines did not move)."));
    } catch (e) {
      if (String(e).includes("aborted")) return;
      setErr(t("The words could not be placed again: {e}", { e: String(e) }));
    } finally { setGenBusy(false); setGenStep(null); setGenDone(0); }
  };
  const cancelLyrics = () => { genRef.current?.abort(); genRef.current = null; setGenBusy(false); setGenStep(null); };

  /** "Clear the timing" asked: what goes is said first (it is shared by the release's videos). */
  const [clearAsk, setClearAsk] = useState(false);
  const clearLyrics = () => {
    const cfg = settingsRef.current;
    const a = cfg.crop.start, b = cfg.crop.start + cfg.crop.duration;
    // The words heard / aligned before go too: the next "Sync the lyrics" listens again, nothing from the old placing.
    onProject((p) => ({ ...p, heardWords: undefined, lyricWords: (p.lyricWords ?? []).filter((x) => x.e <= a || x.s >= b) }));
    setGenInfo(null);
    onSaveNow();
  };

  // ---- export ----
  /** Last resort when the browser cannot encode MP4 itself: record a hidden playback in real time. */
  /** A take's sound, read once per file (for the exports that mix it in). */
  const takeSounds = useRef(new Map<Blob, AudioBuffer | null>());
  /**
   * The official audio with the takes' own sounds mixed in at their volume: the post's video (VideoSettings.clipVolume)
   * and the video over it (overlay.volume), each placed where its picture is and only in its part kept, as heard on
   * the preview. No volume, or a sound unreadable: left out.
   */
  const withCameraSound = async (official: AudioBuffer, cfg: VideoSettings, signal: AbortSignal): Promise<AudioBuffer> => {
    // Multicam: each camera heard on its own shots (`win`, official time); the others all along.
    const angles = (cfg.angles ?? []).filter(Boolean);
    const shots = angles.length ? shotsOf(cfg.cuts, 0, official.duration) : null;
    const winOf = (cam: number) => shots ? shots.filter((x) => x.cam === cam).map((x) => [x.from, x.to] as [number, number]) : null;
    const parts: { blob: Blob | null; vol: number; span: Pick<VideoSettings, "clipIn" | "clipOut"> & ClipParts; offset: number; len: number; win: [number, number][] | null }[] = [
      { blob: videoBlob, vol: clamp(cfg.clipVolume ?? 0, 0, 1), span: cfg, offset: cfg.offset, len: videoDur || 60, win: winOf(0) },
      ...angles.map((id, k) => {
        const a = anglesRef.current.get(id);
        return { blob: a?.blob ?? null, vol: clamp(a?.volume ?? 0, 0, 1), span: {}, offset: a?.offset ?? 0, len: a && Number.isFinite(a.el.duration) ? a.el.duration : 60, win: winOf(k + 1) };
      }),
      ...overlaysOf(cfg).map((ov) => {
        const ovA = anglesRef.current.get(ov.clip);
        return { blob: ovA?.blob ?? null, vol: clamp(ov.volume ?? 0, 0, 1), span: ov, offset: ov.offset, len: ovA && Number.isFinite(ovA.el.duration) ? ovA.el.duration : 60, win: null };
      }),
    ].filter((x) => x.blob && x.vol > 0);
    if (!parts.length) return official;
    const ctx = new OfflineAudioContext(official.numberOfChannels, official.length, official.sampleRate);
    const music = ctx.createBufferSource();
    music.buffer = official;
    music.connect(ctx.destination);
    music.start(0);
    let mixed = false;
    for (const x of parts) {
      let cam = takeSounds.current.get(x.blob!);
      if (cam === undefined) {
        const s = await readSound(x.blob!, x.len, () => {}, signal).catch(() => null);
        cam = null;
        if (s) { cam = new AudioBuffer({ length: s.samples.length, sampleRate: s.rate, numberOfChannels: 1 }); cam.copyToChannel(s.samples as Float32Array<ArrayBuffer>, 0); }
        takeSounds.current.set(x.blob!, cam);
      }
      if (!cam) { console.warn("[export] a take's sound could not be read: exported without it"); continue; }
      const [ci, co] = clipSpan(x.span, cam.duration);
      const gain = ctx.createGain();
      gain.gain.value = x.vol;
      gain.connect(ctx.destination);
      // Its part kept, on the official track, cut to its shots: each window played from its own place in the file.
      // (and never in a piece turned off)
      for (const [w0, w1] of x.win ?? [[-Infinity, Infinity]]) {
        const a0 = Math.max(0, x.offset + ci, w0), b0 = Math.min(official.duration, x.offset + co, w1);
        for (const [a, b] of b0 - a0 < 0.01 ? [] : onWindows(x.span, a0, b0, x.offset)) {
          if (b - a < 0.01) continue;
          const src = ctx.createBufferSource();
          src.buffer = cam;
          src.connect(gain);
          src.start(a, a - x.offset, b - a);
          mixed = true;
        }
      }
    }
    return mixed ? ctx.startRendering() : official;
  };
  const recordRealtime = async (el: HTMLVideoElement, W: number, H: number, from: number, until: number, signal: AbortSignal) => {
    const buf = audioBuf!;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const g = canvas.getContext("2d")!;
    const ctx = getCtx();
    await ctx.resume();
    const dest = ctx.createMediaStreamDestination(); // not connected to the speakers: the export is silent
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(dest);
    const mime = ["video/mp4;codecs=avc1.640028,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm"]
      .find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
    const rate = exportSettings(settingsRef.current.source?.fps, exportPrefsRef.current);
    const rec = new MediaRecorder(new MediaStream([...canvas.captureStream(rate.fps).getVideoTracks(), ...dest.stream.getAudioTracks()]),
      mime ? { mimeType: mime, videoBitsPerSecond: rate.bitrate } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const type = mime.startsWith("video/mp4") ? "video/mp4" : "video/webm";
    const finished = new Promise<Blob>((resolve) => { rec.onstop = () => resolve(new Blob(chunks, { type })); });
    const offset = settingsRef.current.offset;
    await seekVideo(el, Math.max(0, from - offset));
    rec.start(250);
    const origin = ctx.currentTime;
    src.start(0, from, until - from);
    void el.play().catch(() => {});
    await new Promise<void>((resolve) => {
      const tick = () => {
        const now = from + (ctx.currentTime - origin);
        if (now >= until || signal.aborted) { drawScene(g, W, H, pictureOf(el, Math.min(now, until)), Math.min(now, until)); resolve(); return; }
        const target = Math.max(0, now - offset);
        if (Math.abs(el.currentTime - target) > 0.25) el.currentTime = target;
        drawScene(g, W, H, pictureOf(el, now), now);
        setExp({ p: (now - from) / (until - from), step: "record" });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    rec.stop();
    try { src.stop(); } catch { /* already ended */ }
    el.pause();
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    return { blob: await finished, ext: type === "video/mp4" ? "mp4" : "webm" };
  };

  /**
   * Export the segment as an MP4 (H.264 + AAC, 1080×1920 or 1920×1080). The frames are drawn and
   * encoded one by one on a hidden copy of the video: nothing plays on screen, a window shows the progress.
   */
  const exportVideo = async (inBatch = false, suffix = ""): Promise<"done" | "failed" | "cancelled"> => {
    if (!audioBuf || !videoUrl) return "failed";
    stop();
    const cfg = settingsRef.current;
    const from = cfg.crop.start;
    const until = Math.min(audioBuf.duration, from + cfg.crop.duration);
    if (until - from < 0.5) { setErr(t("Video export failed")); return "failed"; }
    // Multicam: every camera used in the segment must have its file on this device.
    const lost = [...new Set(shotsOf(cfg.cuts, from, until).map((x) => x.cam))].filter((c) => c > 0 && !anglesRef.current.get(cfg.angles?.[c - 1] ?? ""));
    if (lost.length) { setErr(t("Camera {n} has no file on this device: open its video and pick its camera file.", { n: lost[0] + 1 })); return "failed"; }
    void askNotifyPermission();
    const ac = new AbortController();
    exportRef.current = ac;
    setErr(null); setNote(null); setExporting(true); setExpMode(null); setExp({ p: 0, step: "audio" });
    const [W, H] = OUT_SIZE(cfg.format);
    // The date and time at the end: two exports of the same video never take each other's name.
    const name = safeName(`${project.name || "RAW"} ${clip.name}${suffix ? ` ${suffix}` : ""} ${stamp()}`);
    let source: { frameAt: (t: number) => Promise<Picture | null>; close: () => void; codec: string } | null = null;
    let stopPlayer = () => {};
    /** The multicam cameras' readers, closed at the end. */
    const angleClose: (() => void)[] = [];
    const el = document.createElement("video");
    el.src = videoUrl;
    el.muted = true;
    el.playsInline = true;
    el.preload = "auto";
    try {
      await whenReady(el);
      let blob: Blob | null = null, ext = "mp4";
      // The recommended settings (the camera file's own rate: 25p stays 25p…), or the user's own (the Export part).
      const rate = exportSettings(settingsRef.current.source?.fps, exportPrefsRef.current);
      if (await mp4Support(W, H, exportSampleRate(audioBuf.sampleRate), Math.min(2, audioBuf.numberOfChannels), rate.fps, rate.bitrate, rate.audioBitrate)) {
        // Frames decoded from the file itself (works in a background tab); the hidden <video> only as a fallback.
        setExp({ p: 0, step: "read" });
        // A colour grade is applied by ffmpeg on the camera file itself (10-bit), not on the 8-bit frames of the browser.
        // Log / HDR footage: graded on the 10-bit camera file by ffmpeg. Standard footage with a few sliders: on the GPU.
        const bake = gradesColour(cfg.grade) && (convertsFootage(cfg.grade) || !!cfg.grade.lut) && (!cfg.grade.lut || !!look);
        const direct = () => videoBlob ? VideoSource.open(videoBlob, from - cfg.offset, until - cfg.offset, (p) => setExp({ p: p * 0.05, step: "read" }), ac.signal) : Promise.resolve(null);
        source = bake ? null : await direct();
        let graded = false;
        const vdur = el.duration;
        /** Camera time at the start of the frames `source` gives (not 0 when they come from a converted segment). */
        let base = 0;
        /** The converted copy holds only this region of the camera picture (ow×oh). */
        let part: ConvertCrop | undefined;
        const ow = el.videoWidth, oh = el.videoHeight;
        let detail = source?.codec ?? "";
        // Log / HDR graded: on the GPU from the decoded 10-bit frames (seconds), else by ffmpeg below (minutes).
        if (bake && videoBlob && ow && oh && cfg.grade && !ac.signal.aborted) {
          const crop = cropFor(picOf(cfg.frame ?? DEFAULT_VIDEO.frame, cfg.matte), ow, oh, W, H, cfg.push ?? 1, cfg.desqueeze);
          const lut = buildGradeLut(withLutSettings(cfg.grade)!, cfg.grade.lut ? look : null, 65);
          const t0 = performance.now();
          const gpu = await gpuGradedSource(videoBlob, Math.max(0, from - cfg.offset), until - cfg.offset, crop, ow, oh, lut, 65,
            (p) => setExp({ p: p * 0.05, step: "read" }), ac.signal).catch((e) => { console.info("[grade10] not used:", e); return null; });
          setGpuWhy(gpu ? "" : gpuGradeReason);
          if (gpu) {
            source = gpu; part = crop; graded = true;
            detail = t("colour grade applied on the graphics card (10-bit)");
            console.info(`[grade10] ready in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
          }
        }
        if (!source && videoBlob && !ac.signal.aborted) {
          // A format the browser cannot decode (4:2:2 10-bit, ProRes…): ffmpeg converts the segment first.
          const why = bake ? "" : VideoSource.lastReason;
          const vs = Math.max(0, from - cfg.offset - 0.2);
          const ve = Math.min(Number.isFinite(vdur) ? vdur : Infinity, until - cfg.offset + 0.2);
          if (ve > vs) {
            try {
              // Only what the post shows, at the camera's resolution (unknown size: the whole picture, not scaled).
              const crop = ow && oh ? cropFor(picOf(cfg.frame ?? DEFAULT_VIDEO.frame, cfg.matte), ow, oh, W, H, cfg.push ?? 1, cfg.desqueeze) : undefined;
              const key = `${clip.id}|${videoBlob.size}|${vs.toFixed(2)}|${ve.toFixed(2)}|${JSON.stringify(crop ?? null)}|${bake ? gradeKey(withLutSettings(cfg.grade)) : ""}`;
              let proxy = proxyRef.current?.key === key ? proxyRef.current.blob : null;
              if (!proxy) {
                const lut = bake && cfg.grade ? new TextEncoder().encode(toCube(buildGradeLut(withLutSettings(cfg.grade)!, cfg.grade.lut ? look : null, 65), 65)) : undefined;
                proxy = await convertSegment(videoBlob, vs, ve, (p, step) => setExp({ p, step }), ac.signal, crop, lut);
                proxyRef.current = { key, blob: proxy }; // exporting the same segment again skips the conversion
              }
              source = await VideoSource.open(proxy, 0, ve - vs, (p) => setExp({ p: p * 0.05, step: "read" }), ac.signal);
              if (source) {
                base = vs; part = crop; graded = bake;
                detail = bake ? t("colour grade applied on the camera file") : t("converted from {format}", { format: why.replace(/ not decodable.*$/, "") });
              }
            } catch (e) {
              if (ac.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) throw e;
              console.warn("[export] conversion failed, using the browser's player", e);
              VideoSource.lastReason = `${why || t("colour grade")} · ${t("conversion failed")}: ${e instanceof Error ? e.message : String(e)}`;
            }
          }
          // The grade could not be applied by ffmpeg: frames decoded by the browser, graded on the GPU.
          if (!source && bake && !ac.signal.aborted) source = await direct();
        }
        const src = source;
        setExpMode(src ? { direct: true, detail } : { direct: false, detail: VideoSource.lastReason });
        let lastSig = "", sameSince = from;
        let player: ReturnType<typeof playerFrames> | null = null;
        stopPlayer = () => player?.stop();
        /** The hidden player only shows new frames while the tab is visible: wait instead of freezing the picture. */
        const visible = () => new Promise<void>((resolve) => {
          if (!document.hidden) { resolve(); return; }
          setExpPaused(true);
          el.pause();
          const back = () => {
            if (document.hidden) return;
            document.removeEventListener("visibilitychange", back);
            setExpPaused(false);
            if (player) void el.play().catch(() => {});
            resolve();
          };
          document.addEventListener("visibilitychange", back);
          ac.signal.addEventListener("abort", () => { document.removeEventListener("visibilitychange", back); resolve(); }, { once: true });
        });
        // Multicam: each other camera read from its own file when its first shot comes (graded on the GPU from its
        // 10-bit frames when it needs it), its player as the last resort; closed at the end.
        const angleSrc = new Map<number, Promise<(time: number) => Promise<Picture | null>>>();
        // The videos over it: each one's file read in order over its part (graded when drawn, as on the preview).
        const overOne = (ov: VideoOverlay) => {
        const ovA = anglesRef.current.get(ov.clip);
        let ovSrc: Promise<((time: number) => Promise<Picture | null>) | null> | null = null;
        return async (time: number) => {
          if (!ovA) return null;
          const [ci, co] = clipSpan(ov, Number.isFinite(ovA.el.duration) ? ovA.el.duration : Infinity);
          const tt = time - ov.offset;
          if (tt < ci - 0.001 || tt > co + 0.001 || isOff(ov, tt)) return null;
          ovSrc ??= (async () => {
            await whenReady(ovA.el);
            const s0 = Math.max(0, from - ov.offset, ci), s1 = Math.min(until - ov.offset, co);
            const direct = await VideoSource.open(ovA.blob, s0, s1, undefined, ac.signal).catch(() => null);
            if (direct) { angleClose.push(() => direct.close()); return (t: number) => direct.frameAt(t - ov.offset); }
            const pf = playerFrames(ovA.el, s0);
            angleClose.push(() => pf.stop());
            return async (t: number) => { await visible(); await pf.frameAt(t - ov.offset); return ovA.el.readyState >= 2 ? { src: ovA.el, w: ovA.el.videoWidth, h: ovA.el.videoHeight } : null; };
          })();
          const at = await ovSrc;
          const pic = at ? await at(time) : null;
          return pic ? { pic, a: ovA as AngleLook, o: ov } : null;
        };
        };
        const overs = overlaysOf(cfg).filter((o) => !o.hidden).map(overOne);
        const overAt = async (time: number) => {
          const out: { pic: Picture; a: AngleLook; o: VideoOverlay }[] = [];
          for (const f of overs) { const x = await f(time); if (x) out.push(x); }
          return out;
        };
        const openAngle = async (a: Angle): Promise<(time: number) => Promise<Picture | null>> => {
          await whenReady(a.el);
          const aw = a.el.videoWidth, ah = a.el.videoHeight;
          const s0 = Math.max(0, from - a.offset), s1 = until - a.offset;
          const g = a.grade;
          if (g && aw && ah && gradesColour(g) && (convertsFootage(g) || !!g.lut) && (!g.lut || a.look)) {
            const crop = cropFor(picOf(a.frame ?? DEFAULT_VIDEO.frame, ownOr(a.matte, cfg.matte) || undefined), aw, ah, W, H, ownOr(a.push, cfg.push) || 1, a.desqueeze);
            const gpu = await gpuGradedSource(a.blob, s0, s1, crop, aw, ah, buildGradeLut(g, g.lut ? a.look : null, 65), 65, () => {}, ac.signal).catch(() => null);
            if (gpu) { angleClose.push(() => gpu.close()); return async (time) => { const p = await gpu.frameAt(time - a.offset); return p && { src: p.src, w: aw, h: ah, part: crop, graded: true }; }; }
          }
          const direct = await VideoSource.open(a.blob, s0, s1, undefined, ac.signal).catch(() => null);
          if (direct) { angleClose.push(() => direct.close()); return (time) => direct.frameAt(time - a.offset); }
          const pf = playerFrames(a.el, s0);
          angleClose.push(() => pf.stop());
          return async (time) => { await visible(); await pf.frameAt(time - a.offset); return a.el.readyState >= 2 ? { src: a.el, w: aw, h: ah } : null; };
        };
        blob = await exportMp4({
          width: W, height: H, fps: rate.fps, bitrate: rate.bitrate, audioBitrate: rate.audioBitrate, from, until, audio: await withCameraSound(audioBuf, cfg, ac.signal), signal: ac.signal,
          onProgress: (p, step) => setExp({ p: 0.05 + p * 0.95, step }),
          frame: async (g, time) => {
            const cam = camAt(cfg.cuts, time);
            const ang = cam > 0 ? anglesRef.current.get(cfg.angles?.[cam - 1] ?? "") : undefined;
            if (ang) {
              if (!angleSrc.has(cam)) angleSrc.set(cam, openAngle(ang));
              const at = await angleSrc.get(cam)!;
              const tt = time - ang.offset;
              drawScene(g, W, H, tt >= -0.001 ? await at(time) : null, time, undefined, ang, await overAt(time));
              return;
            }
            const target = time - cfg.offset;
            const [ci, co] = clipSpan(cfg, Number.isFinite(vdur) ? vdur : Infinity);
            const inside = target >= ci - 0.001 && target <= co + 0.001 && !isOff(cfg, target);
            let pic: Picture | null = null;
            if (inside && src) {
              pic = await src.frameAt(target - base);
              if (pic && part) pic = { src: pic.src, w: ow, h: oh, part, graded };
              else if (pic && graded) pic = { ...pic, graded };
            }
            else if (inside) {
              await visible();
              await (player ??= playerFrames(el, Math.max(0, target))).frameAt(target);
              pic = pictureOf(el, time);
              // The player can stop decoding a format it does not really handle: the picture would
              // stay frozen while sound and lyrics go on. Stop with an explanation instead.
              const sig = pic ? fingerprint(pic.src) : "";
              if (sig && sig === lastSig) { if (time - sameSince >= 2) throw new FrozenVideo(target); }
              else { lastSig = sig; sameSince = time; }
            }
            drawScene(g, W, H, pic, time, undefined, undefined, await overAt(time));
          },
        }).catch((e) => {
          // The encoder gave no sound: record instead of handing over a silent video.
          if (e instanceof Error && e.message === "no-audio") return null;
          throw e;
        });
      }
      if (!blob) ({ blob, ext } = await recordRealtime(el, W, H, from, until, ac.signal));
      const file = `${name} clip.${ext}`;
      saveBlob(blob, file);
      lastFiles.current = [...(inBatch ? lastFiles.current : []), { name: file, blob, caption: cfg.caption?.trim() || undefined }];
      // The text of the post next to it, ready to paste in TikTok (when the video has one).
      if (cfg.caption?.trim()) saveBlob(new Blob([cfg.caption.trim() + "\n"], { type: "text/plain" }), `${name} caption.txt`);
      setExp({ p: 1, step: "finish", done: true, file });
      if (!inBatch) {
        notify(t("Video exported"), t("{name} is in your downloads.", { name: file }));
        onVariants?.(videoVariants(cfg.hooks, hookPools));
      }
      return "done";
    } catch (e) {
      const cancelled = ac.signal.aborted || (e instanceof DOMException && e.name === "AbortError");
      if (!inBatch || cancelled) setExp(null);
      if (e instanceof FrozenVideo) {
        const msg = t("The camera video stopped giving pictures at {s}: this browser cannot read its format frame by frame ({why}). Export it as H.264 or HEVC, 8-bit 4:2:0 (from DaVinci, or use the camera's proxy file), then import that file.", { s: fmtTime(e.at), why: VideoSource.lastReason || "?" });
        setErr(msg);
        notify(t("Video export failed"), msg);
      } else if (!cancelled) {
        console.error("video export failed", e);
        setErr(t("Video export failed"));
        if (!inBatch) notify(t("Video export failed"), t("The export stopped before the end. Try again."));
      }
      return cancelled ? "cancelled" : "failed";
    } finally {
      source?.close();
      for (const close of angleClose.splice(0)) close();
      stopPlayer();
      setExpPaused(false);
      el.pause();
      el.removeAttribute("src");
      el.load();
      if (exportRef.current === ac) exportRef.current = null;
      setExporting(false);
    }
  };
  const closeExport = () => {
    exportRef.current?.abort();
    setExp(null);
    setBatch(null);
    setShareOpen(false);
  };

  /**
   * Every video of the release, one after the other: each is opened (its camera file, its grade), exported
   * when ready, then the next. A video whose camera file is not on this device is left out. At the end, the
   * video that was open comes back.
   */
  const exportAll = () => {
    const ids = projects.map((c) => c.id); // the projects (posts): never a take imported for the library
    if (!ids.length) return;
    void askNotifyPermission();
    setErr(null);
    lastFiles.current = [];
    setBatch({ ids, i: 0, res: {}, back: clip.id });
  };
  useEffect(() => {
    if (!batch || batchBusy.current) return;
    if (batch.i >= batch.ids.length) return; // finished: the window shows the results
    const id = batch.ids[batch.i];
    const next = (r: "done" | "failed" | "skipped") => setBatch((b) => (b ? { ...b, res: { ...b.res, [id]: r }, i: b.i + 1 } : b));
    if (clip.id !== id) { onProject((p) => ({ ...p, videoId: id })); return; }
    if (loadedClip !== id) return; // its files are being read
    if (!videoBlob) { next("skipped"); return; }
    if (!audioBlob) { next("failed"); return; }
    const lutReady = !settings.grade?.lut || !!look || !!lookErr;
    if (!audioBuf || !videoUrl || !videoDur || !playerReady || !lutReady) return; // still opening
    // Its other cameras are read in the background: waited for (15 s at most: a camera with no file never comes).
    if ((settings.angles ?? []).some((a) => clips.some((c) => c.id === a) && !anglesRef.current.has(a))) {
      batchAngleSince.current ||= Date.now();
      if (Date.now() - batchAngleSince.current < 15000) { setTimeout(() => setAngleRev((r) => r + 1), 1000); return; }
    }
    batchAngleSince.current = 0;
    batchBusy.current = true;
    void exportVideo(true).then((r) => {
      batchBusy.current = false;
      if (r !== "cancelled") next(r);
    });
  }, [batch, clip.id, loadedClip, videoBlob, audioBlob, audioBuf, videoUrl, videoDur, playerReady, look, lookErr, angleRev]); // eslint-disable-line react-hooks/exhaustive-deps
  const batchAngleSince = useRef(0);
  // Another release opened during the batch: it stops (its videos are not this release's).
  const batchProject = useRef(project.id);
  useEffect(() => {
    if (batch && batchProject.current !== project.id) { exportRef.current?.abort(); setExp(null); setBatch(null); }
    batchProject.current = project.id;
  }, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Finished: one notification, and the video that was open comes back.
  const batchDone = !!batch && batch.i >= batch.ids.length;
  useEffect(() => {
    if (!batch || !batchDone) return;
    const n = Object.values(batch.res).filter((r) => r === "done").length;
    notify(t("Videos exported"), t("{n} of {m} videos are in your downloads.", { n, m: batch.ids.length }));
    if (clip.id !== batch.back && clips.some((c) => c.id === batch.back)) onProject((p) => ({ ...p, videoId: batch.back }));
  }, [batchDone]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- progressive zoom: a preset of the menu, or its own factor ("Custom…", on a slider) ----
  const [pushCustom, setPushCustom] = useState(false);
  const timesText = (v: number) => `×${String(Math.round(v * 100) / 100).replace(".", lang === "fr" ? "," : ".")}`;
  // ---- framing on the preview: drag the video or the lyrics, wheel to zoom / resize, double-click to reset ----
  // ---- multicam: the camera the right column sets (colour, effects, framing) = the one on the paused preview: a take
  //      pinned from the library, else the shot under the playhead. Kept in the take (every project using it). ----
  const shotTake = (() => { const k = camAt(settings.cuts, head); return k > 0 ? settings.angles?.[k - 1] ?? null : null; })();
  const lookId = pinCam ?? (playing ? null : shotTake);
  // The video over it, picked on the preview or its track: the right column sets its take (colour, framing…).
  // (the take of the one picked; none: the column sets the video under them)
  const [overLook, setOverLook] = useState<string | null>(null);
  /** The clip clicked on the timeline, one for all kinds ("text:<line>", "hook:<id>", "video"): lit, the others not. */
  const [pick, setPick] = useState<string | null>(null);
  const ovSel = overlayOf(settings, overLook);
  const ovTake = ovSel ? clips.find((c) => c.id === ovSel.clip) : undefined;
  useEffect(() => { if (pinCam) setOverLook(null); }, [pinCam]);
  useEffect(() => { if (overLook && !overlayOf(settings, overLook)) setOverLook(null); }, [settings.overlays, settings.overlay, settings.angles]); // eslint-disable-line react-hooks/exhaustive-deps
  const camTake = ovTake ?? (lookId && lookId !== "main" && settings.angles?.includes(lookId) ? clips.find((c) => c.id === lookId) : undefined);
  const camTakeRef = useRef(camTake);
  camTakeRef.current = camTake;
  // The waveform's band follows the video set (another one picked, the one over it moved or trimmed).
  useEffect(() => { paintWaveRef.current(viewRef.current, headRef.current); }, [camTake?.id, camTake?.offset, settings.overlays, settings.overlay, angleRev]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Its look written where it belongs: the take's, or this project's own (camera 1). */
  const writeLook = (patch: Partial<VideoSettings>) => { const c = camTakeRef.current; if (c) patchTake(c.id, patch); else setV(patch); };
  const panelGrade = camTake ? withLutSettings(camTake.grade) : grade;
  /** Log / HDR or standard: a colour is only copied between cameras of the same kind. */
  const lookKind = (c: VideoSettings) => (c.source?.colour === "log" || c.source?.colour === "hdr" ? "graded" : "std");
  const camsOfProject = [clip, ...(settings.angles ?? []).map((id) => clips.find((c) => c.id === id)).filter((c): c is VideoSetup => !!c)];
  const lookOwner = camTake ?? clip;
  const otherCams = camsOfProject.filter((c) => c.id !== lookOwner.id && lookKind(c) === lookKind(lookOwner));
  const copyLookToCams = (g: VideoGrade) => {
    for (const c of otherCams) { if (c.id === clip.id) setV({ grade: g }); else patchTake(c.id, { grade: g }); }
    onToast?.(t("Colour copied on {n} cameras", { n: otherCams.length }));
  };
  const curFrame = () => (camTakeRef.current ? camTakeRef.current.frame : settingsRef.current.frame) ?? DEFAULT_VIDEO.frame;
  const frame = (camTake ? camTake.frame : settings.frame) ?? DEFAULT_VIDEO.frame;
  const desq = camTake ? camTake.desqueeze : settings.desqueeze;
  // The camera's own bars and progressive zoom (written in its take), else the project's (camera 1's).
  // (a camera of the multicam takes the post's when it has none of its own; a video over it has only its own: it is
  // drawn in its frame, the post's bars and zoom are not its)
  const lookMatte = (ovTake ? ovTake.matte : camTake ? ownOr(camTake.matte, settings.matte) : settings.matte) || undefined;
  const lookPush = (ovTake ? ovTake.push : camTake ? ownOr(camTake.push, settings.push) : settings.push) || undefined;
  const lookPushIn = ovTake ? ovTake.pushIn : camTake ? ownOr(camTake.pushIn, settings.pushIn) : settings.pushIn;
  const setPush = (k: number | undefined) => writeLook({ push: camTake ? k ?? 0 : k });
  const pushIsCustom = pushCustom || (!!lookPush && !PUSH_PRESETS.includes(lookPush));
  const setFrame = (patch: Partial<VideoFrame>) => writeLook({ frame: { ...curFrame(), ...patch } });
  /** Offsets kept in bounds, as for the carousel photos (a drag reacts at once in the other direction). */
  const fitFrame = (f: VideoFrame, squeeze = (camTakeRef.current ? camTakeRef.current.desqueeze : settingsRef.current.desqueeze) ?? 1): VideoFrame => {
    const take = camTakeRef.current;
    const el = take ? anglesRef.current.get(take.id)?.el : videoRef.current, c = canvasRef.current;
    if (!el?.videoWidth || !c) return f;
    const p = clampPic(picOf(f, (take ? ownOr(take.matte, settingsRef.current.matte) : settingsRef.current.matte) || undefined), el.videoWidth * squeeze, el.videoHeight, c.width, c.height);
    return { ...f, ox: p.ox, oy: p.oy };
  };
  const pdrag = useRef<null | { kind: "text" | "hook" | "pic" | "over"; id?: string; sx: number; sy: number; ox: number; oy: number; k: number; cue?: { key: string; st: TextStyle } }>(null);
  const toCv = (e: { clientX: number; clientY: number }) => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    const k = c.width / r.width;
    return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k, k };
  };
  const inBox = (b: TextBox | null, x: number, y: number, pad = 30) => {
    return !!b && x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad;
  };
  /** The video over it under the pointer on the preview (the top one where they cross). */
  const overUnder = (x: number, y: number) => {
    const hit = [...overlayBoxes.current].reverse().find((b) => inBox(b.box, x, y, 0));
    return hit ? overlayOf(settingsRef.current, hit.id) : null;
  };
  /** Which text is under the pointer: the hook (drawn on top), the lyrics, or none. */
  const textAt = (x: number, y: number): "hook" | "text" | null =>
    inBox(hookBox.current, x, y) ? "hook" : inBox(captionBox.current, x, y) ? "text" : null;
  const cvDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!videoBlob) return;
    const c = toCv(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    const textKind = textAt(c.x, c.y);
    // Under the texts, the video over the picture (picture in picture): dragged to move it.
    const ovNow = textKind ? null : overUnder(c.x, c.y);
    if (ovNow) {
      // Picked: the right column sets it (its colour, its framing inside its box).
      setPinCam(null); setOverLook(ovNow.clip);
      pdrag.current = { kind: "over", id: ovNow.clip, sx: e.clientX, sy: e.clientY, ox: ovNow.x, oy: ovNow.y, k: c.k };
      return;
    }
    // The video over it was picked: a press beside it only gives the right column back to the picture under it.
    if (!textKind && overLook) { setOverLook(null); return; }
    const kind = textKind;
    const f = fitFrame(curFrame());
    // The lyrics: the caption shown alone when it has its own look (or "this word" is chosen), else all of them.
    const here = kind === "text" ? cueHere() : null;
    const one = here?.one ? { key: here.key, st: cueStyleRef.current(here.cue) } : undefined;
    const st = kind === "hook" ? hookStyleRef.current : one ? one.st : styleRef.current;
    pdrag.current = { kind: kind ?? "pic", sx: e.clientX, sy: e.clientY, ox: kind ? st.x : f.ox, oy: kind ? st.y : f.oy, k: c.k, cue: one };
  };
  const cvMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = pdrag.current, c = canvasRef.current;
    if (!d || !c) return;
    const dx = (e.clientX - d.sx) * d.k, dy = (e.clientY - d.sy) * d.k;
    // ⌘ (Ctrl) held: no snapping, as in design apps.
    const free = e.metaKey || e.ctrlKey;
    if (d.kind === "over") {
      let x = clamp(d.ox + (dx / c.width) * 100, 0, 100), y = clamp(d.oy + (dy / c.height) * 100, 0, 100);
      const sv = !free && Math.abs(x - 50) < 1.5, sh = !free && Math.abs(y - 50) < 1.5;
      if (sv) x = 50;
      if (sh) y = 50;
      if (sv !== snap.v || sh !== snap.h) setSnap({ v: sv, h: sh });
      if (d.id) patchOverlay(d.id, { x: round2(x), y: round2(y) });
    } else if (d.kind !== "pic") {
      let x = clamp(d.ox + (dx / c.width) * 100, 0, 100), y = clamp(d.oy + (dy / c.height) * 100, 0, 100);
      // Snaps to the centre lines, shown in blue while dragging.
      const sv = !free && Math.abs(x - 50) < 1.5, sh = !free && Math.abs(y - 50) < 1.5;
      if (sv) x = 50;
      if (sh) y = 50;
      if (sv !== snap.v || sh !== snap.h) setSnap({ v: sv, h: sh });
      if (d.kind === "hook") setV({ hookStyle: { ...hookStyleRef.current, x, y } });
      else if (d.cue) setCueLook(d.cue.key, { ...d.cue.st, x, y });
      else setV({ captionStyle: { ...styleRef.current, x, y } });
    } else {
      // Its centre snaps to the middle lines, as a text does (the blue guides show).
      const sn = snapPic(d.ox + dx / c.width, d.oy + dy / c.height, free ? 0 : undefined);
      const room = fitFrame({ ...curFrame(), ox: 1, oy: 1 });
      const gv = sn.v && room.ox > 0.001, gh = sn.h && room.oy > 0.001; // a guide only where it can move
      if (gv !== snap.v || gh !== snap.h) setSnap({ v: gv, h: gh });
      writeLook({ frame: fitFrame({ ...curFrame(), ox: sn.ox, oy: sn.oy }) });
    }
  };
  const cvUp = (e?: React.PointerEvent<HTMLCanvasElement>) => {
    const d = pdrag.current;
    pdrag.current = null;
    if (snap.v || snap.h) setSnap({ v: false, h: false });
    // A tap (no drag): the icons over the picture (zones, full screen) show for a few seconds, as a player's controls.
    if (d && e && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 6) revealControls();
  };
  const [controlsOn, setControlsOn] = useState(false);
  const controlsTimer = useRef(0);
  const revealControls = () => {
    setControlsOn(true);
    clearTimeout(controlsTimer.current);
    controlsTimer.current = window.setTimeout(() => setControlsOn(false), 3000);
  };
  // An icon over the picture acts only when the press began on it while it was shown. Hidden, it takes no press at
  // all; the tap that shows the icons must not also press the one under the finger (its click comes right after).
  const pressedOn = useRef<EventTarget | null>(null);
  const shownPress = (act: () => void) => ({
    onPointerDown: (e: React.PointerEvent) => { pressedOn.current = e.currentTarget; },
    onClick: (e: React.MouseEvent) => {
      const own = pressedOn.current === e.currentTarget;
      pressedOn.current = null;
      if (e.detail !== 0 && !own) return; // a pointer click that did not start here (the keyboard: detail 0)
      act();
    },
  });
  const wheelRef = useRef<(e: WheelEvent) => void>(() => {});
  wheelRef.current = (e) => {
    if (!videoBlob) return;
    e.preventDefault();
    const c = toCv(e);
    const dir = e.deltaY < 0 ? 1 : -1;
    const kind = textAt(c.x, c.y);
    // The video over the picture: the wheel sets its size.
    const ovNow = kind ? null : overUnder(c.x, c.y);
    if (ovNow) {
      patchOverlay(ovNow.clip, { w: clamp(Math.round(ovNow.w + dir * 2), 5, 400) });
      return;
    }
    if (kind) {
      const here = kind === "text" ? cueHere() : null;
      const st = kind === "hook" ? hookStyleRef.current : here?.one ? cueStyleRef.current(here.cue) : styleRef.current;
      const next = { ...st, size: clamp(Math.round(st.size + dir * 3), 18, 200) };
      if (kind === "hook") setV({ hookStyle: next });
      else if (here?.one) setCueLook(here.key, next);
      else setV({ captionStyle: next });
      return;
    }
    const f = fitFrame(curFrame());
    const z = zoomPic(picOf(f), clamp(+(f.zoom + dir * 0.05).toFixed(2), 0.15, 4));
    writeLook({ frame: fitFrame({ ...f, zoom: z.zoom, ox: z.ox, oy: z.oy }) });
  };
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const h = (e: WheelEvent) => wheelRef.current(e);
    el.addEventListener("wheel", h, { passive: false });
    return () => el.removeEventListener("wheel", h);
  }, []);
  const cvDouble = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const c = toCv(e);
    if (!textAt(c.x, c.y)) setFrame({ zoom: 1, ox: 0, oy: 0 });
  };
  const [outW, outH] = OUT_SIZE(settings.format);

  // ---- layout ----
  /** Files still opening: the panels wait (greyed) so nothing is edited half-loaded. */
  const studioLoading = !!audioBlob && (!audioBuf || (!!videoUrl && !playerReady));
  const [tab, setTab] = useState<"lyrics" | "hook" | "caption">("lyrics");
  // Phone: the video's style opens as a sheet under the preview (no Style tab), on the part chosen under it.
  const rightColRef = useRef<HTMLElement>(null);
  const vParts: SheetPart<VPart>[] = [
    { id: "framing", label: t("Framing") }, { id: "lyrics", label: t("Lyrics") }, { id: "hook", label: t("Hook") }, { id: "color", label: t("Colour") },
    { id: "export", label: t("Output") },
  ];
  const vStyle = useStyleParts<VPart>({
    column: () => rightColRef.current,
    parts: { framing: '[data-sec="video-render"]', lyrics: ".sheet-text", hook: ".sheet-text", color: "#video-color", export: "#video-export" },
    all: ':scope > [data-sec="video-render"], :scope > .sheet-text, :scope > #video-color, :scope > #video-export',
    first: "framing",
    active: active && stylePage,
    swap: tab,
  });
  const pickVPart = (p: VPart) => { if (p === "lyrics" || p === "hook") setTab(p); vStyle.pick(p); };
  // The lyrics / hook part follows the tabs (a hook picked in the Video page shows its style here).
  const vPart: VPart = vStyle.part === "lyrics" || vStyle.part === "hook" ? (tab === "hook" ? "hook" : "lyrics") : vStyle.part;
  // Phone: the player sits on top of the dock (Studio's slot), always at hand.
  const [dockSlot, setDockSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!active) { setDockSlot(null); return; }
    const mq = matchMedia(PHONE_QUERY);
    const pick = () => setDockSlot(mq.matches ? document.getElementById("dock-player") : null);
    pick();
    mq.addEventListener("change", pick);
    return () => mq.removeEventListener("change", pick);
  }, [active]);
  const dockDrag = useRef<{ was: boolean } | null>(null);
  // The film strip of the dock's timeline: a few small pictures of the take along the segment, made in the
  // background from the file already open (a hidden player of its own, never the one on screen).
  const [strip, setStrip] = useState<string[]>([]);
  /** Where the release stands, shown next to the export button. */
  const status: { text: string; tone: "" | "ok" | "warn" } =
    !audioBlob ? { text: t("Audio missing"), tone: "warn" }
    : !videoBlob ? (settings.videoName ? { text: t("Video missing"), tone: "warn" } : { text: t("No camera video yet"), tone: "" })
    : syncBusy || genBusy ? { text: t("Syncing…"), tone: "" }
    : settings.score === undefined ? { text: t("Not synced yet"), tone: "warn" }
    : { text: t("Sync quality {n}%", { n: Math.round(settings.score * 100) }), tone: settings.score >= 0.7 ? "ok" : "warn" };
  /** The release's state (sync, lyrics…): beside the video picker on a computer, in the Segment block on a phone. */
  const statusBadge = <span className={"badge video-status" + (status.tone ? " " + status.tone : "")}><span className={syncBusy || genBusy ? "shine" : undefined}>{status.text}</span></span>;
  const segLen = Math.max(0.1, end - settings.crop.start);
  // A hook's edges (seconds from the segment's start): anywhere in the song, before the segment as after it (the post
  // shows what of it falls in the segment; the preview, outside it, the rest).
  const hookMin = -settings.crop.start, hookMax = Math.max(segLen, (audioBuf?.duration ?? end) - settings.crop.start);
  // The tracks under the waveform (lyrics, hooks, shots) show what it shows, at the same scale: zoomed in, their lines,
  // edges and cuts can be worked on in detail.
  // Exactly the waveform's view (zoomed or the whole track), at its scale: what is above is above, the segment marked.
  // (on a phone, not zoomed: the segment, a whole song on a phone's width would leave a few pixels for each line)
  const tw = view ?? (audioBuf && !phone ? { s: 0, d: audioBuf.duration } : { s: settings.crop.start, d: segLen });
  const twRef = useRef(tw);
  twRef.current = tw;
  const trackWRef = useRef(trackW);
  trackWRef.current = trackW;
  /**
   * The timeline at playhead `at`, straight on the page (no render): the waveform redrawn, the tracks' content slid by
   * how far the live view has gone from the one they were laid out for, the playhead lines and the glow on the text
   * playing moved. Every frame while playing; after each render too (the tracks laid out again for a new view).
   */
  /** The timeline's moving parts, found once per layout (not searched for at every frame). */
  /** The timeline's frame and its one playhead (desktop). */
  const stackRef = useRef<HTMLDivElement>(null);
  const tlHeadRef = useRef<HTMLSpanElement>(null);
  const timelineEls = useRef<{ contents: HTMLElement[]; clips: HTMLElement[][]; vclips: { el: HTMLElement; name: HTMLElement | null; at: number }[]; headOff: number; heads: HTMLElement[]; bars: HTMLElement[]; playing: HTMLElement[]; dock: HTMLElement[]; dockHeads: HTMLElement[] } | null>(null);
  const findTimelineEls = () => {
    const root = waveRef.current?.closest(".timeline");
    const all = (sel: string, r: ParentNode | null | undefined = root) => (r ? [...r.querySelectorAll<HTMLElement>(sel)] : []);
    const contents = all(".lyric-track .track-content");
    timelineEls.current = {
      contents, clips: contents.map((c) => all(":scope > .cue[data-a]", c)),
      // (where the tracks' time starts in the frame: the one playhead is placed from there)
      headOff: (() => { const st = stackRef.current, tr = st?.querySelector<HTMLElement>(".lyrics-track"); if (!st || !tr) return 0; return tr.getBoundingClientRect().left + tr.clientLeft - st.getBoundingClientRect().left - st.clientLeft; })(),
      vclips: all(".lyric-track .video-clip[data-va]").map((el) => { const name = el.querySelector<HTMLElement>(".vc-name .truncate"); return { el, name, at: name?.offsetLeft ?? 0 }; }), heads: all(".lyric-track .lyric-head"),
      bars: all(".lyric-track .cue-bar-glow[data-a]"), playing: all(".lyric-track .cue.on[data-a]"),
      dock: all(".dp-track .dp-played", document), dockHeads: all(".dp-track .dp-head", document),
    };
  };
  const paintTimeline = (at: number) => { paintWaveRef.current(viewRef.current, at); paintTracks(at); };
  const paintTracks = (at: number) => {
    const els = timelineEls.current;
    if (!els) return;
    // The phone dock's player (the segment's progress), moved the same way.
    const crop = settingsRef.current.crop, f = `${clamp((at - crop.start) / Math.max(0.1, crop.duration), 0, 1) * 100}%`;
    els.dock.forEach((el) => { el.style.width = f; });
    els.dockHeads.forEach((el) => { el.style.left = f; });
    const laid = twRef.current, live = viewRef.current ?? laid, W = trackWRef.current, dpr = waveBox.dpr || 1;
    const px = (x: number) => Math.round(x * dpr) / dpr;
    const xOf = (t: number) => px(((t - laid.s) / laid.d) * W);
    const dx = px(((laid.s - live.s) / laid.d) * W);
    els.contents.forEach((el) => { el.style.transform = `translate3d(${dx}px,0,0)`; });
    const hx = xOf(clamp(at, live.s, live.s + live.d));
    els.heads.forEach((el) => { el.style.transform = `translate3d(${hx}px,0,0)`; });
    // The one playhead across the frame: where the tracks' playheads are (their slide, then their place).
    if (tlHeadRef.current) tlHeadRef.current.style.transform = `translate3d(${els.headOff + dx + hx}px,0,0)`;
    // On each track a clip whose start has gone past the left edge of what is on screen keeps its left side (its edge,
    // its text) on that edge and ends at its own end, as a video clip, until that end leaves too: its text goes out with
    // it, never before. Never wider than it is: nothing of it shows past its end.
    const stuckAt = new Map<HTMLElement, number>();
    els.clips.forEach((list) => {
      for (const el of list) {
        const a = Number(el.dataset.a), b = Number(el.dataset.b);
        const from = a < live.s && b > live.s ? live.s : a;
        stuckAt.set(el, from);
        const x0 = xOf(from);
        el.style.transform = `translate3d(${x0}px,0,0)`;
        el.style.width = `${Math.max(3, xOf(b) - x0)}px`;
        el.classList.toggle("stuck", from > a);
      }
    });
    // A video clip (long: never moved whole, it would show past its end): once its start has gone past the left edge of
    // what is on screen, its left side (its coloured edge, its name) stays on that edge and it ends at its own end, until
    // that end reaches the edge too. Its name glows where the playhead is on it, as a text's.
    const hxPx = xOf(at);
    els.vclips.forEach(({ el, name, at: nameAt }) => {
      const a = Number(el.dataset.va), b = Number(el.dataset.vb), from = Math.min(Math.max(a, live.s), b);
      const x0 = xOf(from);
      el.style.transform = `translate3d(${x0}px,0,0)`;
      el.style.width = `${Math.max(0, xOf(b) - x0)}px`;
      el.classList.toggle("stuck", from > a);
      if (name && el.classList.contains("on")) name.style.setProperty("--hx", `${hxPx - x0 - nameAt}px`);
    });
    // The playing clip's bar: at its start, or on the left edge once its start has gone past it; its text glows under the playhead.
    els.bars.forEach((el) => { el.style.transform = `translate3d(${xOf(Math.max(Number(el.dataset.a), live.s))}px,0,0)`; });
    els.playing.forEach((el) => {
      const a = Number(el.dataset.a), b = Number(el.dataset.b), from = stuckAt.get(el) ?? a;
      el.style.setProperty("--hx", `${b > from ? clamp((at - from) / (b - from), 0, 1) * 100 : 0}%`);
    });
  };
  // (the tracks laid out again: their slide put back to what is on screen, before it is seen)
  // After every layout (the elements may have changed, and their positions were set back by it): the tracks put back.
  useLayoutEffect(() => { findTimelineEls(); paintTracks(headRef.current); });
  /**
   * Where something sits on the tracks, moved by the graphics card (transform, to the sub-pixel) rather than laid out
   * again (left): while the view slides under the playhead, the clips and their text glide instead of shaking.
   */
  const place = (t: number): React.CSSProperties => {
    // On the screen's pixel grid (device pixels): crisp at rest and when moving slowly (not zoomed), still smooth zoomed.
    const dpr = waveBox.dpr || 1;
    return { left: 0, transform: `translate3d(${Math.round(((t - tw.s) / tw.d) * trackW * dpr) / dpr}px,0,0)` };
  };
  /** A clip's full width (not cut to the view: the track's edge hides what is out, the clip slides in and out whole). */
  const wFull = (a: number, b: number) => `${(Math.max(0, b - a) / tw.d) * 100}%`;
  /** Clips laid out on the tracks: the view and as much again on each side, so while the view slides under the playhead
   * (between two layouts) the next ones are already there, coming in whole from the right. */
  const onTrack = (a: number, b: number) => b > tw.s - tw.d && a < tw.s + 2 * tw.d;
  /**
   * Where the playing clip's bar goes: at its start, or, when its start has left the view on the left (zoomed, scrolling)
   * while it still plays, on the view's left edge, where the clip itself is drawn from. Null when none of it is in view.
   */
  const barAt = (a: number, b: number) => (b > tw.s && a < tw.s + tw.d ? Math.max(a, tw.s) : null);
  /** Where the playhead is across a clip shown from `a` to `b` (its visible part), as a % of its width: its text glows there. */
  const hxIn = (a: number, b: number) => `${b > a ? clamp((head - a) / (b - a), 0, 1) * 100 : 0}%`;
  // ---- takes: the release's camera / phone files (lib "Prises"), up to 4 per project (multicam) ----
  /** Takes of this release on the same audio as this project, other than its own (camera 1). */
  const camChoices = clips.filter((c) => c.id !== clip.id && audioIdOf(release, c) === audioId && c.videoName);
  const [takeJobs, setTakeJobs] = useState<Record<string, { p: number; err?: string }>>({});
  const patchTake = (id: string, patch: Partial<VideoSetup>) =>
    onProject((p) => ({ ...p, videos: clipsOf(p).map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
  /** A take read (what it is, the grade it gets) and synced on the official audio, in the background. */
  /** Its offset on the official audio once synced; null: it did not match (it stays where it was, free). */
  const prepareTake = async (id: string, file: Blob, grade0: VideoGrade | undefined, fresh: boolean): Promise<number | null> => {
    const official = audioBuf;
    const cfg = settingsRef.current; // the passage of the audio it is placed on: read now, with `official` (a project opened meanwhile has others)
    setTakeJobs((j) => ({ ...j, [id]: { p: 0 } }));
    try {
      const info = await probeVideo(file);
      patchTake(id, { source: info, ...(fresh ? gradeForSource(info, grade0) : null) });
      if (!official) { setTakeJobs((j) => { const n = { ...j }; delete n[id]; return n; }); return null; }
      const sound = await readSound(file, info.duration ?? 60, (p) => setTakeJobs((j) => ({ ...j, [id]: { p: p * 0.9 } })), new AbortController().signal);
      if (!sound) throw new Error(t("Its sound could not be read."));
      await new Promise((r) => setTimeout(r, 30));
      const r = syncAudio(sound.samples, sound.rate, monoOf(official), official.sampleRate, { from: cfg.crop.start, to: cfg.crop.start + cfg.crop.duration });
      // No match: not a fault, it stays free (placed by hand on its track), quietly.
      if (!r.anchors || r.score < 0.4) { setTakeJobs((j) => { const n = { ...j }; delete n[id]; return n; }); return null; }
      patchTake(id, { offset: round2(r.offset), score: round2(r.score), anchors: r.anchors, takes: undefined, linked: true,
        ...(clips.find((c) => c.id === id)?.score === undefined ? { clipVolume: undefined } : null) });
      onSaveNow();
      setTakeJobs((j) => { const n = { ...j }; delete n[id]; return n; });
      return round2(r.offset);
    } catch (e) {
      console.warn("[takes] not synced", e);
      setTakeJobs((j) => ({ ...j, [id]: { p: 0, err: e instanceof Error ? e.message : String(e) } }));
      return null;
    }
  };
  /** Takes imported (one or many): each a take of the release, the first ones joining this project as cameras. */
  const importTakes = async (files: File[]) => {
    const cur = settingsRef.current;
    const made: { c: VideoSetup; f: File }[] = files.filter((f) => f.type.startsWith("video/") || /\.(mp4|mov|m4v|mxf)$/i.test(f.name)).map((f) => ({ f, c: {
      ...cur, id: uid(), name: f.name.replace(/\.[^.]+$/, ""), takeOnly: true, media: undefined, videoName: f.name, videoSize: f.size,
      source: undefined, drive: undefined, offset: 0, score: undefined, musicStart: undefined, musicEnd: undefined, anchors: undefined,
      takes: undefined, linked: false, versions: undefined, angles: undefined, cuts: undefined,
      // (a take holds only its own file: never the project's other videos, nor its cuts)
      overlays: undefined, overlay: undefined, clipIn: undefined, clipOut: undefined, splits: undefined, offParts: undefined, box: undefined,
    } as VideoSetup }));
    // A file already in the release (same name and size): not a new take; it joins this project if it is not in it.
    const known = (f: File) => clips.find((c) => c.videoName === f.name && c.videoSize === f.size);
    const again = made.filter((m) => known(m.f));
    if (again.length) {
      const ids = again.map((m) => known(m.f)!.id).filter((id) => id !== clip.id && !(cur.angles ?? []).includes(id) && !overlayOf(cur, id));
      const room0 = Math.max(0, MAX_CAMS - videosIn(cur));
      const back = ids.slice(0, room0).map((id) => clips.find((c) => c.id === id)).filter((c): c is VideoSetup => !!c);
      if (back.length) setV(withOverlays([...overlaysOf(cur), ...back.map(overlayFor)]));
      onToast?.(again.length === 1 ? t("“{name}” is already in the release: not imported again.", { name: again[0].f.name })
        : t("{n} files are already in the release: not imported again.", { n: again.length }));
      made.splice(0, made.length, ...made.filter((m) => !known(m.f)));
    }
    if (!made.length) return;
    for (const m of made) await putMedia(`video:${m.c.id}`, m.f).catch(() => {});
    // Imported = wanted on the timeline: each on its own track over the video, on top of the others (4 videos at most;
    // the others wait with the release's other takes). Dragged afterwards wherever wanted (under, multicam…).
    const now = settingsRef.current;
    const join = made.slice(0, Math.max(0, MAX_CAMS - videosIn(now))).map((m) => m.c);
    onProject((p) => ({ ...p, videos: [...clipsOf(p), ...made.map((m) => m.c)] }));
    if (join.length) setV(withOverlays([...overlaysOf(now), ...join.map((c) => ({ ...overlayFor(c), offset: round2(now.crop.start) }))]));
    if (made.length > join.length) {
      const left = made.length - join.length;
      onToast?.(left === 1 ? t("1 video was not added: {n} videos at most in a project (it waits in the release's other takes).", { n: MAX_CAMS })
        : t("{k} videos were not added: {n} videos at most in a project (they wait in the release's other takes).", { k: left, n: MAX_CAMS }));
    }
    onSaveNow();
    void askPersistentStorage();
    for (const m of made) {
      const at = await prepareTake(m.c.id, m.f, cur.grade, true);
      // Synced: it goes where its sound is in the official audio (else it stays at the segment's start, to place by hand).
      if (at !== null && overlayOf(settingsRef.current, m.c.id)) patchOverlay(m.c.id, { offset: at });
    }
  };
  /**
   * "Link the original file" for a take (any of the project's videos, not only camera 1): the same camera file found
   * again on this computer (its size decides, the name may have changed), its sync and settings kept.
   */
  const takeOriginal = useRef<HTMLInputElement>(null);
  const relinkFor = useRef<string | null>(null);
  const relinkTake = async (id: string, f: File) => {
    const c = clips.find((x) => x.id === id);
    if (!c) return;
    let same = c.videoSize ? c.videoSize === f.size : false;
    if (!c.videoSize) { const info = await probeVideo(f); same = !!info.duration && !!c.source?.duration && Math.abs(info.duration - c.source.duration) < 0.05; }
    if (!same) { onToast?.(t("This is not the same camera file ({name}). Pick the original, or use “Replace” for another take.", { name: c.videoName ?? "" })); return; }
    try { await putMedia(`video:${c.media ?? c.id}`, f); } catch { /* private mode */ }
    void delMedia(`copy:${c.id}`).catch(() => {});
    if (!c.videoSize) patchTake(c.id, { videoSize: f.size });
    // Its player read again from the file (it may have shown its Drive copy, or nothing).
    const a = anglesRef.current.get(c.id);
    if (a) { a.el.pause(); a.el.removeAttribute("src"); a.el.load(); a.el.remove(); URL.revokeObjectURL(a.url); anglesRef.current.delete(c.id); }
    setTakeJobs((j) => { const n = { ...j }; delete n[c.id]; return n; });
    setTakeFilesRev((n) => n + 1);
    void askPersistentStorage();
    onToast?.(t("Camera file found again: the sync and the settings are kept."));
  };
  /**
   * "Replace from this computer" for a take: another file in its place (a montage with the song under it, a new export),
   * its row, size and place kept; synced at once (the song in it: placed on it and locked, else left free).
   */
  const replaceFor = useRef<string | null>(null);
  const takeReplace = useRef<HTMLInputElement>(null);
  const replaceTake = async (id: string, f: File) => {
    const c = clips.find((x) => x.id === id);
    if (!c) return;
    stop();
    // Nothing of the previous file stays: its working copy (Drive and device), its file on the device unless another
    // video still reads it.
    const oldKey = c.media ?? c.id;
    if (c.drive?.copy?.id) void deleteDriveFile(c.drive.copy.id);
    void delMedia(`copy:${id}`).catch(() => {});
    if (!clips.some((x) => x.id !== id && (x.media ?? x.id) === oldKey)) void delMedia(`video:${oldKey}`).catch(() => {});
    // (its own key on the device: never the previous file's, another video may still read it)
    const media = uid();
    try { await putMedia(`video:${media}`, f); } catch { /* private mode */ }
    patchTake(id, { media, videoName: f.name, videoSize: f.size, name: f.name.replace(/\.[^.]+$/, ""), source: undefined, drive: undefined,
      score: undefined, anchors: undefined, musicStart: undefined, musicEnd: undefined, takes: undefined, linked: false, clipIn: undefined, clipOut: undefined });
    const a = anglesRef.current.get(id);
    if (a) { a.el.pause(); a.el.removeAttribute("src"); a.el.load(); a.el.remove(); URL.revokeObjectURL(a.url); anglesRef.current.delete(id); }
    setTakeFilesRev((n) => n + 1);
    void askPersistentStorage();
    const at = await prepareTake(id, f, c.grade, true);
    if (at !== null && overlayOf(settingsRef.current, id)) patchOverlay(id, { offset: at });
    onToast?.(at !== null ? t("“{name}” replaced and synced.", { name: f.name }) : t("“{name}” replaced: no match with the official audio, it stays free.", { name: f.name }));
  };
  const resyncTake = async (c: VideoSetup): Promise<number | null> => {
    const b = await getMedia(`video:${c.media ?? c.id}`).catch(() => undefined);
    if (!b) { setTakeJobs((j) => ({ ...j, [c.id]: { p: 0, err: t("Not in this browser: pick it again.") } })); return null; }
    return prepareTake(c.id, b, c.grade, false);
  };
  /** Camera `i + 2` taken out of this project: its shots go back to camera 1. */
  /** `more`: set together (a camera that becomes the video over it). */
  const removeAngle = (i: number, more: Partial<VideoSettings> = {}) => {
    const angles = [...(settings.angles ?? [])];
    // The take on the preview, or unfolded: back to the shots (never a black preview for a camera gone).
    if (pinCam === angles[i]) setPinCam(null);
    if (takeOpen === angles[i]) setTakeOpen(null);
    angles.splice(i, 1);
    const cuts = settings.cuts?.map((c) => (c.cam === i + 1 ? { ...c, cam: 0 } : c.cam > i + 1 ? { ...c, cam: c.cam - 1 } : c));
    setV({ angles: angles.length ? angles : undefined, cuts: angles.length ? cuts : undefined, ...more });
  };
  /** A take only imported, used by no project: off the release, its file off this device. */
  const deleteTake = (c: VideoSetup) => {
    const rest = clips.filter((x) => x.id !== c.id), media = c.media ?? c.id;
    onProject((p) => ({ ...p, videos: clipsOf(p).filter((x) => x.id !== c.id) }));
    onSaveNow();
    // Its files (the one it reads: a replaced take has its own key) and its Drive copy, unless another video uses them.
    if (!rest.some((x) => (x.media ?? x.id) === media)) { void delMedia(`video:${media}`).catch(() => {}); void delMedia(`poster:${media}`).catch(() => {}); }
    const copyId = c.drive?.copy?.id;
    if (copyId && !rest.some((x) => x.drive?.copy?.id === copyId)) void deleteDriveFile(copyId);
    stopCopyOf(c.id);
    void delMedia(`copy:${c.id}`).catch(() => {});
  };
  /** A camera chosen (button or key 1-4): playing, or paused in the middle of a shot, it cuts there to it; paused at a
   *  shot's start (a click on a shot puts the playhead there), the whole shot takes it. */
  const chooseCam = (cam: number) => {
    const cfg = settingsRef.current;
    if (cam > 0 && !cfg.angles?.[cam - 1]) return;
    const at = playing ? headRef.current : head;
    const shot = shotsOf(cfg.cuts, cfg.crop.start, cfg.crop.start + cfg.crop.duration).find((x) => at >= x.from - 1e-3 && at < x.to);
    const atStart = !playing && (!shot || at - shot.from < 0.06);
    setV({ cuts: atStart ? setShotCam(cfg.cuts, at, cam, cfg.crop.start) : cutTo(cfg.cuts, at, cam) });
  };
  // What each video's file is (log, HDR, SDR…), read again once per version of the detection, in the background, for
  // the files on this device: a project could keep what an older reading said (a phone's SDR take shown as log). Its
  // grade is never touched, only what the file is.
  const probedOnce = useRef(new Set<string>());
  useEffect(() => {
    let off = false;
    void (async () => {
      for (const c of clips) {
        if (off) return;
        if (!c.videoName || c.source?.v === PROBE_VERSION || probedOnce.current.has(c.id)) continue;
        probedOnce.current.add(c.id);
        const b = await getMedia(`video:${c.media ?? c.id}`).catch(() => undefined);
        if (!b || off) continue;
        const info = await probeVideo(b);
        if (off) return;
        // What the player or the index read (length, rate) kept when this reading has none.
        patchTake(c.id, { source: { ...c.source, ...info, duration: info.duration ?? c.source?.duration, fps: info.fps ?? c.source?.fps } });
      }
    })();
    return () => { off = true; };
  }, [release.id, clips.length]); // eslint-disable-line react-hooks/exhaustive-deps
  /** A project uses this take: as a camera of its multicam or as a video over it. */
  const usedAsCamera = (id: string) => clips.some((c) => c.id !== id && (c.angles?.includes(id) || [...(c.overlays ?? []), ...(c.overlay ? [c.overlay] : [])].some((o) => o?.clip === id)));
  // The same file imported twice (same name and size: before the check, or on two devices): one take kept (a
  // project's own first), every project using the other one uses it, its cuts kept on the right camera.
  useEffect(() => {
    const all = clips;
    const winner = new Map<string, string>();
    for (const c of all) {
      if (!c.takeOnly || !c.videoName) continue;
      const w = all.find((x) => x !== c && x.videoName === c.videoName && x.videoSize === c.videoSize && (!x.takeOnly || all.indexOf(x) < all.indexOf(c)));
      if (w) winner.set(c.id, w.id);
    }
    if (!winner.size) return;
    onProject((p) => ({ ...p, videos: clipsOf(p).filter((c) => !winner.has(c.id)).map((c) => {
      if (!c.angles?.length) return c;
      // Old camera number (1-3) → new one (0 when it went: its shots back on camera 1).
      const next: string[] = [], to = new Map<number, number>();
      c.angles.forEach((id0, k) => {
        const id = winner.get(id0) ?? id0;
        if (!id || id === c.id) { to.set(k + 1, 0); return; }
        const at = next.indexOf(id);
        if (at >= 0) to.set(k + 1, at + 1); else { next.push(id); to.set(k + 1, next.length); }
      });
      return { ...c, angles: next.length ? next : undefined, cuts: next.length ? c.cuts?.map((x) => ({ ...x, cam: x.cam ? to.get(x.cam) ?? 0 : 0 })) : undefined };
    }) }));
    // Not a file another video reads (a duplicate points at it through `media`).
    for (const id of winner.keys()) if (!all.some((c) => c.media === id || c.media === `${id}`)) void delMedia(`video:${id}`).catch(() => {});
    onSaveNow();
  }, [clips]); // eslint-disable-line react-hooks/exhaustive-deps
  const cutDrag = useRef<{ i: number; left: number; width: number } | null>(null);
  const takeInput = useRef<HTMLInputElement>(null);
  /** What a file is (device, curve, codec) and what the app does with its colours: the (i) beside LOG / SDR. */
  const sourceNote = (src: VideoSourceInfo) => [
    [src.device ?? (src.kind === "camera" ? t("Camera") : src.kind === "phone" ? t("Phone") : null), src.curve, src.codec].filter(Boolean).join(" · "),
    src.colour === "log" ? (src.profile
      ? t("Log footage: converted like a CST in DaVinci, with your look LUT. Adjust it in the Colour tab.")
      : t("Log footage this app does not convert yet: pick the closest profile in the Colour tab."))
      : src.colour === "hdr" ? t("HDR footage: brought down to standard SDR for TikTok, without burnt highlights. Adjust it in the Colour tab.")
      : src.colour === "unknown" ? t("The file does not say how it recorded the colours: if it looks flat and grey, it is log, pick its profile in the Colour tab.")
      : t("Standard video, used as it is."),
    src.convert ? t("The browser cannot read this format frame by frame: the export converts it first (slower), without losing quality.") : "",
  ].filter(Boolean).join("\n");
  const colourTag = (src?: VideoSourceInfo) => (src?.colour === "log" ? "LOG" : src?.colour === "hdr" ? "HDR" : src?.colour === "sdr" ? "SDR" : "?");
  /** A take's Drive copy, as camera 1's: being made, "Backed up" (up to date), or "Drive copy" (the one used here). */
  const takeCopyEl = (c: VideoSetup) => {
    const a = anglesRef.current.get(c.id), cp = c.drive?.copy;
    if (copyJob?.clip === c.id) return <span className="copy-status compact busy xs"><span className="shine">{copyJob.step === "make" ? t("Copy for your other devices… {n}%", { n: Math.round(copyJob.p * 100) }) : t("Sending the copy to your Drive… {n}%", { n: Math.round(copyJob.p * 100) })}</span></span>;
    if (a?.fromCopy && cp) return <span className="copy-status compact on-copy xs"><span className="pill-copy">{t("Drive copy")}</span></span>;
    if (a && cp && cp.of === a.blob.size) return <span className="copy-status compact xs"><span className="pill-copy ready"><Icon name="check" size={10} />{t("Backed up")}</span></span>;
    return null;
  };
  /** The take whose line is unfolded (its details), one at a time. */
  // Camera 1 unfolded by default (its full card); unfolding another take folds it, one card open at a time.
  const [takeOpen, setTakeOpen] = useState<string | null>(clip.id);
  useEffect(() => { setTakeOpen(clip.id); }, [clip.id]);
  // The block of takes slides to its new height when a take unfolds or folds (FLIP: its old height, then the new one).
  // Each copy of the column (computer, phone) has its own block; their heights kept up to date between two folds.
  const takesH = useRef(new WeakMap<HTMLElement, number>());
  /** A take unfolded (or none): the blocks' heights noted first, for the slide. */
  const foldTo = (id: string | null) => {
    for (const el of document.querySelectorAll<HTMLElement>(".takes-branch")) if (!el.style.height) takesH.current.set(el, el.offsetHeight);
    setTakeOpen(id);
  };
  useLayoutEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const undo: (() => void)[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(".takes-branch")) {
      const before = takesH.current.get(el), after = el.offsetHeight;
      takesH.current.set(el, after);
      if (!before || before === after || !el.getClientRects().length) continue;
      el.style.height = `${before}px`;
      el.style.overflow = "hidden";
      void el.offsetHeight;
      el.style.transition = "height .22s ease";
      el.style.height = `${after}px`;
      const done = () => { el.style.height = ""; el.style.overflow = ""; el.style.transition = ""; el.removeEventListener("transitionend", end); };
      // Its own transition only (a child's, a hover…, bubbles up here too).
      const end = (e: TransitionEvent) => { if (e.target === el && e.propertyName === "height") done(); };
      el.addEventListener("transitionend", end);
      const id = window.setTimeout(done, 300);
      undo.push(() => { window.clearTimeout(id); done(); });
    }
    return () => undo.forEach((f) => f());
  }, [takeOpen]);

  /** The library's takes: the project's cameras 2 to 4 under its own take, the import, then the release's others. */
  const takesEl = (part: "first" | "rest") => {
    const angles = (settings.angles ?? []).filter(Boolean);
    // The videos over it are the project's takes too (listed with them, not with the release's others).
    const ovIds = overlaysOf(settings).map((o) => o.clip);
    const others = camChoices.filter((c) => !angles.includes(c.id) && !ovIds.includes(c.id));
    const room = videosIn(settings) < MAX_CAMS;
    const card = (c: VideoSetup, cam: number | null) => {
      const isOver = cam === null && ovIds.includes(c.id);
      const job = takeJobs[c.id];
      const i = cam === null ? -1 : cam - 1;
      const open = takeOpen === c.id;
      // Camera 1 unfolded: its own full card (file, Drive copy, sync) shows in its place, just below.
      if (open && cam === 0) return null;
      // A camera whose file is not on this device (its shots stay black: never another camera's picture instead).
      const missing = ((cam !== null && cam > 0) || isOver) && angleRev > 0 && !anglesRef.current.has(c.id);
      const name = c.videoName?.replace(/\.[^.]+$/, "") ?? clipName(c);
      const toggle = () => { stop(); foldTo(open ? null : c.id); if (cam !== null) { setPinCam(cam === 0 ? "main" : c.id); setPick("video"); } };
      const sync = job && !job.err ? <span className="xs muted">{Math.round(job.p * 100)} %</span>
        : missing ? <span className="xs warn-text">{t("File not on this device")}</span>
        : job?.err ? <span className="xs warn-text" title={job?.err}>{t("Not synced")}</span>
        : c.score === undefined ? <span className="xs muted">{t("Not synced")}</span>
        : null;
      // What it can do, by where it is: on its own track (over the video) → into the multicam; a camera of the multicam →
      // onto its own track; either → out of the project (back with the release's other takes); not in it → added (on
      // its own track, on top, as an import).
      const menu = (close: () => void) => (<>
        {isOver && <button onClick={() => { close(); stop(); setV({ angles: [...angles, c.id], ...withOverlays(overlaysOf(settingsRef.current).filter((o) => o.clip !== c.id)) }); }}>{t("Put in the multicam")}</button>}
        {cam !== null && cam > 0 && <button onClick={() => { close(); stop(); removeAngle(i, withOverlays([...overlaysOf(settingsRef.current), overlayFor(c)])); }}>{t("Put on its own track (over the video)")}</button>}
        {cam === null && !isOver && <button disabled={!room} onClick={() => { close(); putOverlay(c); }}>{t("Add to the project")}</button>}
        {(isOver || (cam !== null && cam > 0)) && <button onClick={() => { close(); stop(); if (isOver) patchOverlay(c.id, null); else removeAngle(i); }}>{t("Take out of the project")}</button>}
        <button disabled={(!!job && !job.err) || (cam === 0 && (!videoBlob || syncBusy))} onClick={() => { close(); if (cam === 0) void autoSync(); else void resyncTake(c); }}>{t("Sync again")}</button>
        {/* Its camera file found again on this computer (camera 1: in its own card's menu). */}
        {cam !== 0 && <button onClick={() => { close(); relinkFor.current = c.id; takeOriginal.current?.click(); }}>{t("Link the original file")}</button>}
        {cam !== 0 && <button onClick={() => { close(); replaceFor.current = c.id; takeReplace.current?.click(); }}>{t("Replace from this computer")}</button>}
        {c.takeOnly && <>
          <div className="sep" />
          <button className="danger" style={{ color: "var(--danger)" }} disabled={usedAsCamera(c.id)}
            title={usedAsCamera(c.id) ? t("A project uses it as a camera.") : undefined}
            onClick={() => { close(); deleteTake(c); }}>{t("Delete this take")}</button>
        </>}
      </>);
      // The one over it: numbered and coloured as the next camera (as on its track).
      const shown = isOver ? overNo(settings, c.id) : cam;
      const cls = "take" + (shown === null ? " other" : " cam-" + shown) + (open ? " open" : "");
      // Unfolded: the same full card as camera 1's (its name, file, what it is, its sync), in place of its line.
      if (open) return (
        <div key={c.id} className={cls} {...takeDrag(c, cam)}>
          <MediaTile icon="film" name={c.videoName ?? null} warn={missing} loading={!!job && !job.err} menu={cam === 0 ? false : menu}
            label={<button className="take-label" onClick={toggle} title={t("Fold")}>{shown !== null && <b>{shown + 1}</b>}{shown !== null && " · "}{clipName(c)} <Icon name="chevron" size={11} /></button>}
            meta={<>
              {c.source?.duration ? <span className="mono">{fmtLength(c.source.duration)}</span> : null}
              {c.source && <span className="row" style={{ gap: 4 }}>{colourTag(c.source)}<Hint text={sourceNote(c.source)} /></span>}
              {takeCopyEl(c)}
              {sync}
            </>} />
        </div>
      );
      // Folded: one slim line (all the cameras seen at once), number and colour as on the shots track.
      return (
        <div key={c.id} className={cls}>
        <div className={"take-row" + (job && !job.err ? " shine-box" : "")} {...takeDrag(c, cam)}>
          <button className="take-main" aria-expanded={false}
            title={cam !== null ? t("Show it on the preview and set its colour and framing") : undefined} onClick={toggle}>
            {shown !== null ? <b className="take-n">{shown + 1}</b> : <Icon name="film" size={13} />}
            <span className="take-name" title={c.videoName ?? ""}>{name}</span>
          </button>
          {c.source?.duration ? <span className="mono muted xs">{fmtLength(c.source.duration)}</span> : null}
          {/* On the line, an icon (its words in the unfolded card): the name keeps the room. */}
          {job && !job.err ? sync
            : missing || job?.err ? <span className="warn-text take-warn" title={missing ? t("File not on this device") : job?.err}><Icon name="alert" size={13} /></span>
            // Not synced is not a fault (a video placed by hand on the video track): said quietly.
            : c.score === undefined ? <span className="muted xs take-free" title={t("Not synced")}>—</span>
            : <Icon name="check" size={12} />}
          {cam === null && !isOver && room && <button className="btn icon sm quiet" aria-label={t("Add to the project")} title={t("Add to the project")} onClick={() => putOverlay(c)}><Icon name="plus" size={12} /></button>}
          {<Menu float trigger={(_, tg) => <button className="btn icon sm quiet" aria-label={t("Options")} onClick={tg}><Icon name="more" size={14} /></button>}>{menu}</Menu>}
        </div>
        </div>
      );
    };
    // Camera 1 (the project's own take): its line when another one is unfolded (its full card above otherwise).
    if (part === "first") { const one = card(clip, 0); return one && <div className="takes">{one}</div>; }
    return (
      <div className="takes">
        {angles.map((id, k) => { const c = clips.find((x) => x.id === id); return c ? card(c, k + 1) : null; })}
        {ovIds.map((id) => { const c = clips.find((x) => x.id === id); return c ? card(c, null) : null; })}
        <button className="btn sm take-import" onClick={() => takeInput.current?.click()} title={t("One or several camera / phone files: each synced on the official audio by itself.")}>
          <Icon name="plus" size={14} />{t("Import takes")}
        </button>
        <input ref={takeInput} type="file" accept="video/*,.mxf" multiple hidden
          onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ""; void importTakes(f); }} />
        <input ref={takeReplace} type="file" accept="video/*,.mxf" hidden
          onChange={(e) => { const f = e.target.files?.[0], id = replaceFor.current; e.target.value = ""; replaceFor.current = null; if (f && id) void replaceTake(id, f); }} />
        <input ref={takeOriginal} type="file" accept="video/*,.mxf" hidden
          onChange={(e) => { const f = e.target.files?.[0], id = relinkFor.current; e.target.value = ""; relinkFor.current = null; if (f && id) void relinkTake(id, f); }} />
        {others.length > 0 && (
          <details className="takes-more">
            <summary>{t("Other takes of the release ({n})", { n: others.length })}</summary>
            {clipGroups(others).map((g) => (
              <div key={g.label || "all"} className="takes-group">
                {g.label && <div className="dd-group">{g.label}</div>}
                {g.items.map((c) => card(c, null))}
              </div>
            ))}
          </details>
        )}
      </div>
    );
  };
  /**
   * The video track, one camera (no multicam): the camera file as a clip on the timeline. Not locked to the audio, it
   * can be edited as in any editor: dragged to slide it along the track, its edges to trim it (black where there is
   * no picture). Locked (synced and linked): shown, not moved.
   */
  const clipDrag = useRef<{ mode: "move" | "in" | "out"; px: number; py: number; el: HTMLElement; left: number; width: number; s: number; d: number; offset: number; ci: number; co: number; moved?: boolean } | null>(null);
  /**
   * A clip cut and a piece of it turned off, as in Premiere (right click on a video clip, C, Shift + E): `which` is the
   * video ("base" or the take over it), `t` the file time under the pointer.
   */
  const [clipMenu, setClipMenu] = useState<{ x: number; y: number; which: string; t: number } | null>(null);
  const partsOf = (which: string) => {
    const cur = settingsRef.current;
    if (which === "base") {
      const len = onCopy && cur.source?.duration ? cur.source.duration : videoDurRef.current || Infinity;
      const [ci, co] = clipSpan(cur, len);
      return { p: cur as ClipParts, ci, co, offset: cur.offset, set: (x: ClipParts) => setV({ splits: x.splits, offParts: x.offParts }) };
    }
    const o = overlayOf(cur, which);
    if (!o) return null;
    const a = anglesRef.current.get(o.clip);
    const [ci, co] = clipSpan(o, a && Number.isFinite(a.el.duration) ? a.el.duration : Infinity);
    return { p: o as ClipParts, ci, co, offset: o.offset, set: (x: ClipParts) => patchOverlay(o.clip, { splits: x.splits, offParts: x.offParts }) };
  };
  /** The video the keys act on: the one clicked (over it, or the base). */
  const pickedVideo = () => (pick === "video" ? overLook ?? "base" : null);
  const cutVideoAt = (which: string, at: number) => { const x = partsOf(which); if (x) { const n = splitClip(x.p, at - x.offset, x.ci, x.co); if (n !== x.p) x.set(n); } };
  const togglePart = (which: string, at: number) => { const x = partsOf(which); if (x) { x.set(togglePiece(x.p, at - x.offset, x.ci, x.co)); requestAnimationFrame(() => drawAt(headRef.current)); } };
  /** On a video clip: its cuts (thin lines) and pieces turned off (greyed), laid on the track as the clip is. */
  const partsEl = (p: ClipParts, offset: number, ci: number, co: number) => (<>
    {(p.offParts ?? []).map(([a, b]) => { const s0 = offset + Math.max(a, ci), s1 = offset + Math.min(b, co); return s1 > s0 && onTrack(s0, s1) ? <span key={"o" + a} className="vc-off" style={{ ...place(s0), width: wFull(s0, s1) }} /> : null; })}
    {(p.splits ?? []).filter((x) => x > ci && x < co).map((x) => onTrack(offset + x, offset + x) ? <span key={"s" + x} className="vc-split" style={place(offset + x)} /> : null)}
  </>);
  /** Right click on a video clip: its menu (cut here, turn this piece off or on, join, whole again). */
  const clipCtx = (which: string) => (e: React.MouseEvent<HTMLElement>) => {
    e.preventDefault(); e.stopPropagation();
    const tr = (e.currentTarget.closest(".lyric-track") ?? e.currentTarget).getBoundingClientRect(), w = viewRef.current ?? twRef.current;
    const at = w.s + ((e.clientX - tr.left) / Math.max(1, tr.width)) * w.d;
    setPick("video"); setOverLook(which === "base" ? null : which); if (which === "base") setPinCam("main");
    setClipMenu({ x: e.clientX, y: e.clientY, which, t: at });
  };
  /** The eye at the end of a video track: hidden, the video is not drawn (preview and export), its sound stays. */
  const eyeEl = (hidden: boolean, toggle: () => void) => (
    <button className={"btn icon sm quiet track-eye" + (hidden ? " off" : "")} aria-pressed={hidden} aria-label={hidden ? t("Show the video") : t("Hide the video")}
      title={hidden ? t("Show the video") : t("Hide the video (preview and export; its sound stays)")} onClick={() => { toggle(); requestAnimationFrame(() => drawAt(headRef.current)); }}>
      <Icon name={hidden ? "eye-off" : "eye"} size={14} />
    </button>
  );
  /** The song's mute, in the header of the waveform (studio only: the export keeps it). */
  const muteEl = (
    <button className={"btn icon sm quiet track-eye" + (musicMuted ? " off" : "")} aria-pressed={musicMuted}
      aria-label={musicMuted ? t("Hear the song") : t("Mute the song")}
      title={musicMuted ? t("Hear the song") : t("Mute the song in the studio (the export keeps it)")}
      onClick={() => {
        const m = !musicMuted; setMusicMuted(m);
        try { localStorage.setItem("tktgen-music-muted", m ? "1" : "0"); } catch { /* private window */ }
        const g = muteNode.current; if (g) g.gain.setTargetAtTime(m ? 0 : 1, g.context.currentTime, 0.01);
      }}>
      <Icon name={musicMuted ? "volume-off" : "volume"} size={14} />
    </button>
  );
  /** The eye of a text track (hooks, lyrics): hidden, not drawn on the preview nor in the export. */
  const textEye = (shown: boolean, toggle: () => void, what: "hooks" | "lyrics") => (
    <button className={"btn icon sm quiet track-eye" + (shown ? "" : " off")} aria-pressed={!shown}
      aria-label={shown ? (what === "hooks" ? t("Hide the hooks") : t("Hide the lyrics")) : (what === "hooks" ? t("Show the hooks") : t("Show the lyrics"))}
      title={shown ? (what === "hooks" ? t("Hide the hooks") : t("Hide the lyrics")) : (what === "hooks" ? t("Show the hooks") : t("Show the lyrics"))}
      onClick={() => { toggle(); requestAnimationFrame(() => drawAt(headRef.current)); }}>
      <Icon name={shown ? "eye" : "eye-off"} size={14} />
    </button>
  );
  const videoTrackEl = () => {
    if (!videoBlob || videoDur <= 0 || !audioBuf) return null;
    const len = onCopy && settings.source?.duration ? settings.source.duration : videoDur;
    const [ci, co] = clipSpan(settings, len);
    const a = settings.offset + ci, b = settings.offset + co;
    const locked = !!settings.linked;
    const trimmed = ci > 0.01 || co < len - 0.01;
    const vol = clamp(settings.clipVolume ?? 0, 0, 1);
    const down = (mode: "move" | "in" | "out") => (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) { if (e.button === 2) e.stopPropagation(); return; } // (right: its menu, never the track's scrub; trimmed even locked: the sync stays)
      e.stopPropagation(); stop();
      e.currentTarget.setPointerCapture(e.pointerId);
      const r = (e.currentTarget.closest(".lyric-track") ?? e.currentTarget).getBoundingClientRect();
      const w = viewRef.current ?? twRef.current;
      clipDrag.current = { mode, px: e.clientX, py: e.clientY, el: e.currentTarget, left: r.left, width: r.width, s: w.s, d: w.d, offset: settings.offset, ci, co };
      dragHead.current = headRef.current;
    };
    // The preview follows the edge being moved (the picture there), as the segment's edges do.
    const inSeg = (t: number) => round2(clamp(t, settings.crop.start, end - 0.05));
    const move = (e: React.PointerEvent<HTMLElement>) => {
      if (moveVdrag(e)) return;
      const d = clipDrag.current;
      if (!d) return;
      // Up or down more than sideways: the clip is carried to another row (multicam, over or under another video).
      if (d.mode === "move" && vertical(e, d)) {
        clipDrag.current = null;
        if (d.moved) setV({ offset: d.offset }); // (the little sideways move before: undone)
        startVdrag("base", 0, d.el, e, d.px, d.py);
        return;
      }
      if (!d.moved && Math.abs(e.clientX - d.px) < 4) return;
      d.moved = true;
      const dt = ((e.clientX - d.px) / Math.max(1, d.width)) * d.d;
      const dur = audioBuf.duration;
      if (d.mode === "move") {
        if (locked) return; // (locked to the audio: it only changes rows)
        // (its start, else its end, on a magnet: the segment's start or the playhead; the playhead stays where it is)
        let offset = round2(clamp(d.offset + dt, -d.co + 0.5, dur - d.ci - 0.5));
        const px = d.width / d.d, ma = magnet(e, offset + d.ci, px), mb = ma === null ? magnet(e, offset + d.co, px) : null;
        if (ma !== null) offset = round2(ma - d.ci); else if (mb !== null) offset = round2(mb - d.co);
        setV({ offset });
      } else if (d.mode === "in") {
        let clipIn = round2(clamp(d.ci + dt, 0, d.co - 0.2));
        const m = magnet(e, d.offset + clipIn, d.width / d.d);
        if (m !== null) clipIn = round2(clamp(m - d.offset, 0, d.co - 0.2));
        setV({ clipIn });
        headOnEdge(d.offset + clipIn, inSeg);
      } else {
        let clipOut = round2(clamp(d.co + dt, d.ci + 0.2, len));
        const m = magnet(e, d.offset + clipOut, d.width / d.d);
        if (m !== null) clipOut = round2(clamp(m - d.offset, d.ci + 0.2, len));
        setV({ clipOut });
        headOnEdge(d.offset + clipOut - 0.05, inSeg);
      }
    };
    // A click (no drag): the playhead goes there, as on the other tracks.
    const up = (e: React.PointerEvent<HTMLElement>) => {
      if (vdragRef.current) { endVdrag(); return; }
      const d = clipDrag.current;
      clipDrag.current = null;
      // A click: the playhead there, and the right column (and the waveform's band) on this video.
      if (d && !d.moved) { setHead(inSeg(d.s + clamp((e.clientX - d.left) / Math.max(1, d.width), 0, 1) * d.d)); setOverLook(null); setPinCam("main"); setPick("video"); }
    };
    return (<>
        <div className="tl-row"><div className="tl-hd" onPointerDown={(e) => e.stopPropagation()}>
            {eyeEl(!!settings.videoHidden, () => setV({ videoHidden: settings.videoHidden ? undefined : true }))}
            {trimmed && !locked && (
              <button className="btn icon sm quiet" aria-label={t("Whole video")} title={t("Whole video")} onClick={() => setV({ clipIn: undefined, clipOut: undefined })}>
                <Icon name="refresh" size={13} />
              </button>
            )}
            <Menu float trigger={(_, toggle) => (
              <button className={"btn icon sm quiet" + (vol > 0 ? " on" : "")} aria-label={t("Video sound")} title={vol > 0 ? `${t("Video sound")} · ${Math.round(vol * 100)} %` : `${t("Video sound")} · ${t("Muted")}`} onClick={toggle}>
                <Icon name={vol > 0 ? "volume" : "volume-off"} size={14} />
              </button>
            )}>
              {() => (
                <div className="sound-pop" data-keep>
                  <Range label={t("Video sound")} value={Math.round(vol * 100)} display={vol > 0 ? `${Math.round(vol * 100)} %` : t("Muted")}
                    min={0} max={100} step={1} onChange={(n) => setV({ clipVolume: n > 0 ? n / 100 : undefined })} />
                  <p className="muted xs">{t("The take's own sound, over the official audio, only in the part kept.")}</p>
                </div>
              )}
            </Menu>
          </div><div className={"lyric-track video-track" + (settings.videoHidden ? " is-hidden" : "")} role="group" aria-label={t("Video")} {...scrub()}>
          {/* At the track's end, as in CapCut: the clip's own sound (a slider opens from the speaker), and the whole
              video back when it was trimmed. They stay put while the track slides. */}
          <div className="track-tools" onPointerDown={(e) => e.stopPropagation()}>
            {eyeEl(!!settings.videoHidden, () => setV({ videoHidden: settings.videoHidden ? undefined : true }))}
            {trimmed && !locked && (
              <button className="btn icon sm quiet" aria-label={t("Whole video")} title={t("Whole video")} onClick={() => setV({ clipIn: undefined, clipOut: undefined })}>
                <Icon name="refresh" size={13} />
              </button>
            )}
            <Menu float trigger={(_, toggle) => (
              <button className={"btn icon sm quiet" + (vol > 0 ? " on" : "")} aria-label={t("Video sound")} title={vol > 0 ? `${t("Video sound")} · ${Math.round(vol * 100)} %` : `${t("Video sound")} · ${t("Muted")}`} onClick={toggle}>
                <Icon name={vol > 0 ? "volume" : "volume-off"} size={14} />
              </button>
            )}>
              {() => (
                <div className="sound-pop" data-keep>
                  <Range label={t("Video sound")} value={Math.round(vol * 100)} display={vol > 0 ? `${Math.round(vol * 100)} %` : t("Muted")}
                    min={0} max={100} step={1} onChange={(n) => setV({ clipVolume: n > 0 ? n / 100 : undefined })} />
                  <p className="muted xs">{t("The take's own sound, over the official audio, only in the part kept.")}</p>
                </div>
              )}
            </Menu>
          </div>
          <div className="track-content">
            {onTrack(a, b) && (
              <div className={"cue video-clip cam-0" + (locked ? " locked" : "") + (head >= a && head < b ? " on" : "") + (pick === "video" && !camTake ? " sel" : "")}
                style={{ ...place(a), width: wFull(a, b) }} data-va={a} data-vb={b}
                title={locked ? t("Locked to the audio (synced): unlock it to slide or trim the video freely.") : t("Drag to slide the video along the track, its edges to trim it.")}
                onPointerDown={down("move")} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { clipDrag.current = null; }} onContextMenu={clipCtx("base")}>
                <span className="clip-edge in" onPointerDown={down("in")} />
                <span className="vc-name">
                  <span className="cue-ico" aria-hidden><Icon name="film" size={11} /></span><b className="vc-no">1</b>
                  {/* Its own padlock, as the ones over it (the one above the tracks: every video at once). */}
                  {settings.score !== undefined && <button className="clip-lock" aria-label={locked ? t("Audio and video linked") : t("Link audio and video")}
                    title={(locked ? t("Audio and video linked") : t("Link audio and video")) + " · " + (locked ? t("Unlink to move the sync by hand") : t("Keep the sync while you move the segment"))}
                    onPointerDown={(e) => e.stopPropagation()} onClick={() => { stop(); if (locked) setV({ linked: false }); else { const range = linkRangeOf(settingsRef.current); setV({ linked: true, ...(range ? { crop: fitCrop(settingsRef.current.crop.start, settingsRef.current.crop.duration, range) } : null) }); } }}>
                    <Icon name={locked ? "lock" : "unlock"} size={11} /></button>}
                  <span className="truncate" data-text={settings.videoName?.replace(/\.[^.]+$/, "") ?? clipName(clip)}>{settings.videoName?.replace(/\.[^.]+$/, "") ?? clipName(clip)}</span>
                </span>
                <span className="clip-edge out" onPointerDown={down("out")} />
              </div>
            )}
            {partsEl(settings, settings.offset, ci, co)}
            {head >= a && head < b && barAt(a, b) !== null && <span className="cue-bar-glow cam-glow cam-0" data-a={a} data-b={b} style={place(barAt(a, b)!)} />}
            <span className="lyric-head" style={{ ...place(clamp(head, Math.max(settings.crop.start, tw.s), Math.min(end, tw.s + tw.d))) }} />
          </div>
        </div></div>
        </>
    );
  };
  /** A take of the release over the post's video (picture in picture): from the library's take menu. Synced, it starts
   *  in place; else at the segment's start. Top right, 42 % wide, corners slightly rounded. */
  /**
   * Another video becomes the base (camera 1) and the base goes in its place, as a clip dragged under another in an
   * editor: what belongs to the camera file (the file itself, by reference: never copied; its sync, framing, colour,
   * trim, sound, Drive copy) is exchanged between this project and that take. `where`: the one over it changes its
   * place with the base (the base goes over, at the place it had; the new base at the place it had over it).
   */
  const CAM_KEYS = ["media", "videoName", "videoSize", "source", "offset", "score", "anchors", "musicStart", "musicEnd", "takes", "linked", "frame",
    "desqueeze", "grade", "drive", "clipIn", "clipOut", "splits", "offParts", "clipVolume", "matte", "push", "pushIn", "box"] as const satisfies readonly (keyof VideoSetup)[];
  /** A video's size and place over another one: its own (`VideoSettings.box`), else top right, 42 % wide. */
  const boxOr = (b: VideoSettings["box"]) => ({ x: b?.x ?? 70, y: b?.y ?? 28, w: b?.w ?? 42, radius: b?.radius ?? 8 });
  const boxOf = (o: VideoOverlay): NonNullable<VideoSettings["box"]> => ({ x: o.x, y: o.y, w: o.w, radius: o.radius });
  // Each one over the video keeps its size and place in its own take (it finds them again wherever it goes).
  useEffect(() => {
    for (const o of overlaysOf(settings)) {
      const c = clips.find((x) => x.id === o.clip);
      if (c && JSON.stringify(c.box) !== JSON.stringify(boxOf(o))) patchTake(o.clip, { box: boxOf(o) });
    }
  }, [JSON.stringify(overlaysOf(settings).map(boxOf)), overlaysOf(settings).map((o) => o.clip).join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const swapBase = (x: VideoSetup, more: Partial<VideoSettings> = {}) => {
    stop();
    setPinCam(null); setOverLook(null);
    const cur = settingsRef.current, base = clips.find((c) => c.id === clip.id) ?? clip, ov = overlayOf(cur, x.id);
    const pick = (c: VideoSetup) => Object.fromEntries(CAM_KEYS.map((k) => [k, k === "media" ? c.media ?? c.id : c[k]])) as Partial<VideoSetup>;
    const mine = pick(base), theirs = pick(x);
    let place: Partial<VideoSettings> = {};
    if (ov) {
      // Its place over the video goes to the old base (same track, same rank), and the base takes the place it had.
      // (each keeps its own size and place over a video: the base finds the one it had last time it was over one)
      // (still where its sync put it: it stays locked to the audio as the base)
      theirs.offset = ov.offset; theirs.clipIn = ov.clipIn; theirs.clipOut = ov.clipOut; theirs.box = boxOf(ov);
      (theirs as Partial<VideoSettings>).splits = ov.splits; (theirs as Partial<VideoSettings>).offParts = ov.offParts;
      theirs.linked = x.score !== undefined && Math.abs(ov.offset - x.offset) < 0.01;
      // (hidden or not, as each video was)
      place = { ...withOverlays(overlaysOf(cur).map((o) => (o.clip === x.id ? { ...o, ...boxOr(base.box), offset: base.offset, clipIn: base.clipIn, clipOut: base.clipOut, splits: cur.splits, offParts: cur.offParts, hidden: cur.videoHidden || undefined } : o))),
        videoHidden: ov.hidden || undefined };
    }
    onProject((p) => ({ ...p, videos: clipsOf(p).map((c) => (c.id === clip.id ? { ...c, ...theirs, ...place, ...more } : c.id === x.id ? { ...c, ...mine } : c)) }));
    onSaveNow();
  };
  /**
   * A video clip dragged up or down on the video block: the rows are the videos over it (the top one first) then the
   * base line ("base": camera 1, or the multicam's shots). `target`: the row it is over (above the block: the top one,
   * under it: the base line, `out`).
   */
  type VAct = "swap" | "order" | "multicam" | "over";
  const [vdrag, setVdrag] = useState<null | { from: "base" | "over" | "cam"; id?: string; cam: number; label: string; colour: number; x: number; y: number; w: number; grab: number;
    el: HTMLElement; x0: number; y0: number; target: string | null; at: number; act: VAct | null; cutX: number }>(null);
  const vdragRef = useRef(vdrag);
  vdragRef.current = vdrag;
  /** The video rows on screen, from the top: each one's key (the take over it, or "base") and element. */
  const videoRows = () => [...document.querySelectorAll<HTMLElement>(".video-block .over-track[data-ov], .video-block .cam-track, .video-block .video-track:not(.over-track)")]
    .map((el) => ({ key: el.dataset.ov ?? "base", el, r: el.getBoundingClientRect() }));
  /** Where the video on a row starts on the track. */
  const rowStart = (key: string) => {
    const cur = settingsRef.current;
    if (key === "base") return cur.offset + clipSpan(cur, videoDurRef.current || Infinity)[0];
    const o = overlayOf(cur, key), a = o ? anglesRef.current.get(o.clip) : undefined;
    return o ? o.offset + clipSpan(o, a && Number.isFinite(a.el.duration) ? a.el.duration : Infinity)[0] : null;
  };
  /** What letting go there would do, the row it is about, and the time its start lands on (its left edge under the pointer). */
  const landing = (d: { from: "base" | "over" | "cam"; id?: string; grab: number }, x: number, y: number) => {
    const block = document.querySelector<HTMLElement>(".video-block")?.getBoundingClientRect();
    // (the time is read on a track, right of the rows' headers; the cut is drawn in the block)
    const track = document.querySelector<HTMLElement>(".video-block .lyric-track")?.getBoundingClientRect() ?? block;
    const w = viewRef.current ?? twRef.current;
    const left = x - d.grab;
    const at = track ? round2(w.s + ((left - track.left) / Math.max(1, track.width)) * w.d) : 0;
    const none = { at, act: null as VAct | null, target: null as string | null, cutX: block && track ? clamp(left - track.left, 0, track.width) + track.left - block.left : 0 };
    const rows = videoRows();
    if (!rows.length) return none;
    const mine = d.from === "over" ? d.id ?? "" : "base";
    const me = rows.findIndex((r) => r.key === mine);
    // The row under the pointer (between two: the nearer), or outside the block (above / under it).
    const above = y < rows[0].r.top, under = y > rows[rows.length - 1].r.bottom;
    let ti = above ? 0 : under ? rows.length - 1 : rows.findIndex((r, i) => y <= (rows[i + 1] ? (r.r.bottom + rows[i + 1].r.top) / 2 : Infinity));
    if (ti < 0) ti = rows.length - 1;
    const tr = rows[ti];
    // Past its middle (its lower half going down, its upper half going up), or out of the block on that side.
    const past = above || under || (ti > me ? y > tr.r.top + tr.r.height / 2 : y < tr.r.top + tr.r.height / 2);
    let act: VAct | null = null;
    if (d.from === "cam") {
      // A shot of the multicam: up onto a row over it (its own track there), or under the block (it becomes the base).
      act = tr.key !== "base" || above ? "over" : under ? "swap" : null;
    } else if (tr.key === mine) act = null;
    else if (tr.key !== "base" && mine !== "base") act = past ? "order" : null;
    else {
      // The base and one over it: past the middle, or on the other's start, they change places; further along the other's
      // line: both in the multicam, cut there.
      const s0 = rowStart(tr.key);
      act = past ? "swap" : s0 === null ? null : at <= s0 + 0.3 ? "swap" : "multicam";
    }
    return { ...none, act, target: act ? tr.key : null };
  };
  /** A clip pressed and moved goes to another row once it went up or down by half a row (a little sideways first does
   *  not stop it), or sooner when it goes more up or down than sideways. */
  const vertical = (e: React.PointerEvent, d: { px: number; py: number }) => {
    const dy = Math.abs(e.clientY - d.py), dx = Math.abs(e.clientX - d.px);
    return dy > 16 || (dy > 8 && dy > dx);
  };
  /** Start following a vertical drag (called by a clip's move once it goes more up or down than sideways). */
  const startVdrag = (from: "base" | "over" | "cam", cam: number, el: HTMLElement, e: React.PointerEvent, x0?: number, y0?: number, id?: string) => {
    const r = el.getBoundingClientRect();
    const c = from === "over" ? clips.find((q) => q.id === id) : cam > 0 ? clips.find((q) => q.id === settingsRef.current.angles?.[cam - 1]) : clip;
    // Held where it was grabbed (its start stays the same distance left of the pointer).
    const grab = clamp((x0 ?? e.clientX) - r.left, 0, r.width);
    setVdrag({ from, id, cam, label: c?.videoName?.replace(/\.[^.]+$/, "") ?? (c ? clipName(c) : ""), colour: from === "over" && id ? overNo(settingsRef.current, id) : cam,
      x: e.clientX, y: e.clientY, w: clamp(r.width, 80, 320), grab, el, x0: x0 ?? e.clientX, y0: y0 ?? e.clientY, ...landing({ from, id, grab }, e.clientX, e.clientY) });
  };
  const moveVdrag = (e: React.PointerEvent) => {
    const d = vdragRef.current;
    if (!d) return false;
    setVdrag({ ...d, x: e.clientX, y: e.clientY, ...landing(d, e.clientX, e.clientY) });
    return true;
  };
  // The clip carried follows the pointer (held by the video block, over the other rows); when letting go would make two
  // videos change places, the other one slides into its row already and the one carried snaps into the row left free,
  // as in CapCut.
  useLayoutEffect(() => {
    const d = vdrag;
    if (!d) return;
    const el = d.el;
    el.classList.add("lifted");
    el.style.translate = `${d.x - d.x0}px ${d.y - d.y0}px`;
    let other: HTMLElement | null = null;
    if ((d.act === "swap" || d.act === "order") && d.target) {
      const rows = videoRows(), row = rows.find((r) => r.key === d.target);
      other = row?.el.querySelector<HTMLElement>(".video-clip, .cam-shot.on") ?? null;
      const mine = el.closest(".lyric-track");
      if (other && mine && row) {
        const gap = mine.getBoundingClientRect().top - row.r.top;
        other.classList.add("shifted"); other.style.translate = `0 ${gap}px`;
        // ...(letting go keeps both at their times)
        el.classList.add("shifted"); el.style.translate = `0 ${-gap}px`;
      } else other = null;
    }
    return () => {
      el.classList.remove("lifted", "shifted"); el.style.translate = "";
      if (other) { other.classList.remove("shifted"); other.style.translate = ""; }
    };
  }, [vdrag]);
  /**
   * Let go. Past the middle of another row (or out of the block): the two change places (the base and one over it), or
   * their order (two over it). Further along the base's line (or the base along another's): both in the multicam, cut
   * where it was dropped. A shot of the multicam dropped up: on its own track.
   */
  const endVdrag = () => {
    const d = vdragRef.current;
    setVdrag(null);
    if (!d || !d.act || !d.target) return;
    const cur = settingsRef.current, angles = (cur.angles ?? []).filter(Boolean), ovs = overlaysOf(cur);
    const segStart = cur.crop.start;
    stop();
    if (d.from === "base" || d.from === "over") {
      if (d.act === "order") {
        const a = ovs.findIndex((o) => o.clip === d.id), b = ovs.findIndex((o) => o.clip === d.target);
        if (a < 0 || b < 0) return;
        const list = [...ovs];
        [list[a], list[b]] = [list[b], list[a]];
        setV(withOverlays(list));
        return;
      }
      // The one over it concerned: the one dragged, or the one the base was dropped on.
      const ovId = d.from === "over" ? d.id : d.target, ov = overlayOf(cur, ovId), take = ov ? clips.find((c) => c.id === ov.clip) : undefined;
      if (!ov || !take) return;
      if (d.act === "swap") { swapBase(take); return; }
      if (angles.length >= MAX_CAMS - 1) { onToast?.(t("Up to {n} cameras.", { n: MAX_CAMS })); return; }
      // Both on the base line: the one over it joins the cameras at the place it had (its offset), and a cut is made.
      const k = angles.length + 1, at = clamp(d.at, segStart, segStart + cur.crop.duration - 0.1);
      patchTake(take.id, { offset: ov.offset, clipIn: ov.clipIn, clipOut: ov.clipOut });
      const cuts = d.from === "over"
        ? [...(cur.cuts ?? []).filter((c) => c.at < at - 0.05), { at, cam: k }]
        // (the base dragged onto the line of one over it: that one first, the base from the drop)
        : [{ at: Math.min(segStart, cur.cuts?.[0]?.at ?? segStart), cam: k }, { at, cam: 0 }];
      setOverLook(null);
      setV({ angles: [...angles, take.id], ...withOverlays(ovs.filter((o) => o.clip !== take.id)), cuts: cuts.sort((a, b) => a.at - b.at) });
      return;
    }
    // A shot of the multicam: on its own track, just above the row it was dropped on (above the block: on top).
    const at = d.target === "base" ? ovs.length : ovs.findIndex((o) => o.clip === d.target) + 1;
    const insert = (o: VideoOverlay) => { const list = [...ovs]; list.splice(clamp(at, 0, list.length), 0, o); return withOverlays(list); };
    if (d.cam === 0) {
      // Camera 1 up: camera 2 becomes the base, camera 1 goes on its own track.
      const next = clips.find((c) => c.id === angles[0]);
      if (!next || d.act !== "over") return;
      swapBase(next, { angles: angles.slice(1).length ? angles.slice(1) : undefined, cuts: undefined,
        ...insert({ ...overlayFor(next), ...boxOr(cur.box), offset: cur.offset, clipIn: cur.clipIn, clipOut: cur.clipOut }) });
      return;
    }
    const id = angles[d.cam - 1], c = clips.find((q) => q.id === id);
    if (!c) return;
    if (d.act === "over") { removeAngle(d.cam - 1, insert(overlayFor(c))); setOverLook(c.id); }
    else if (d.act === "swap") swapBase(c);
  };
  const overlayFor = (c: VideoSetup): VideoOverlay => ({ clip: c.id, offset: c.score !== undefined ? c.offset : round2(settings.crop.start), ...boxOr(c.box) });
  /** A take added to the project: on its own track, on top of the others (4 videos at most). */
  const putOverlay = (c: VideoSetup) => {
    stop();
    const cur = settingsRef.current;
    if (videosIn(cur) >= MAX_CAMS && !overlayOf(cur, c.id)) { onToast?.(t("Up to {n} videos in a project.", { n: MAX_CAMS })); return; }
    setV(withOverlays([...overlaysOf(cur).filter((o) => o.clip !== c.id), overlayFor(c)]));
  };
  /**
   * A take dragged from the library onto the video block (as in CapCut): dropped on the base line it joins the cameras
   * (the multicam's buttons then show), dropped above it, it goes over the video. Camera 1 stays the base.
   */
  const [dragTake, setDragTake] = useState<string | null>(null);
  const [dropRow, setDropRow] = useState<"over" | "main" | null>(null);
  /** Where the dragged take would land over the video: its start on the track (s), and in the block (px). */
  const [dropAt, setDropAt] = useState<{ t: number; x: number; w: number } | null>(null);
  // Only a take not in the project yet ("Other takes of the release") is dragged from the library: one of the project's
  // is already on the timeline (moved there, on its track), and its line is only clicked (shown, set, unfolded).
  const takeDrag = (c: VideoSetup, _cam: number | null) => c.id === clip.id || (settings.angles ?? []).includes(c.id) || !!overlayOf(settings, c.id) ? {} : {
    draggable: true,
    onDragStart: (e: React.DragEvent) => { e.dataTransfer.setData("text/x-raw-take", c.id); e.dataTransfer.effectAllowed = "move"; setDragTake(c.id); },
    onDragEnd: () => { setDragTake(null); setDropRow(null); setDropAt(null); },
  };
  const rowOf = (e: React.DragEvent<HTMLElement>): "over" | "main" => {
    const main = e.currentTarget.querySelector<HTMLElement>(".video-track:not(.over-track), .cam-track");
    return main && e.clientY < main.getBoundingClientRect().top - 1 ? "over" : "main";
  };
  const blockDrop = {
    onDragOver: (e: React.DragEvent<HTMLDivElement>) => {
      if (!dragTake) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const r = rowOf(e);
      if (r !== dropRow) setDropRow(r);
      // Over the video: the clip shown where it would land, following the pointer (its start under it).
      // (the time read on a track, right of the rows' headers; the ghost placed in the block)
      const blk = e.currentTarget.getBoundingClientRect(), w = viewRef.current ?? twRef.current;
      const box = e.currentTarget.querySelector<HTMLElement>(".lyric-track")?.getBoundingClientRect() ?? blk;
      const c = clips.find((x) => x.id === dragTake), len = c?.source?.duration ?? 10;
      const xt = clamp(e.clientX - box.left, 0, box.width), x = xt + box.left - blk.left;
      const t = round2(w.s + (xt / Math.max(1, box.width)) * w.d);
      if (r === "over") { if (!dropAt || Math.abs(dropAt.x - x) > 0.5) setDropAt({ t, x, w: (len / w.d) * box.width }); }
      else if (dropAt) setDropAt(null);
    },
    onDragLeave: (e: React.DragEvent<HTMLDivElement>) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) { setDropRow(null); setDropAt(null); } },
    onDrop: (e: React.DragEvent<HTMLDivElement>) => {
      const id = e.dataTransfer.getData("text/x-raw-take") || dragTake;
      const row = rowOf(e), at = dropAt?.t;
      setDragTake(null); setDropRow(null); setDropAt(null);
      const c = id ? clips.find((x) => x.id === id) : undefined;
      if (!c || c.id === clip.id) return;
      e.preventDefault();
      stop();
      const angles = (settings.angles ?? []).filter((x) => x && x !== c.id);
      if (videosIn(settings) >= MAX_CAMS) { onToast?.(t("Up to {n} videos in a project.", { n: MAX_CAMS })); return; }
      if (row === "over") {
        // On its own track, on top of the others, starting where it was dropped.
        setV(withOverlays([...overlaysOf(settings).filter((o) => o.clip !== c.id), { ...overlayFor(c), ...(at !== undefined ? { offset: at } : null) }]));
        setOverLook(c.id);
      } else setV({ angles: [...angles, c.id], ...withOverlays(overlaysOf(settings).filter((o) => o.clip !== c.id)) });
    },
  };
  /**
   * The overlay's track (over the video track): its take as a clip, dragged to slide it along the track, its edges to
   * trim it; at its end, its settings (size, corners, sound: the picture itself is moved and sized on the preview) and
   * the way out.
   */
  const ovDrag = useRef<{ mode: "move" | "in" | "out"; px: number; py?: number; el?: HTMLElement; left: number; width: number; s: number; d: number; o: VideoOverlay; ci: number; co: number; len: number; moved?: boolean } | null>(null);
  const overlayTrackEl = (o: VideoOverlay) => {
    const a = anglesRef.current.get(o.clip);
    const take = clips.find((c) => c.id === o.clip);
    if (!take || !audioBuf) return null;
    const no = overNo(settings, o.clip), picked = ovTake?.id === o.clip;
    // Synced on the official audio and still where its sync put it: locked as the video under it (it only moves up or
    // down, to another row); its padlock unlocks it, and locks it back on its synced place.
    const synced = take.score !== undefined;
    const locked = synced && !!take.linked && Math.abs(o.offset - take.offset) < 0.01;
    const toggleLock = () => {
      stop();
      if (locked) patchTake(take.id, { linked: false });
      else if (synced) { patchTake(take.id, { linked: true }); patchOverlay(o.clip, { offset: take.offset }); }
    };
    const len = a && Number.isFinite(a.el.duration) ? a.el.duration : take.source?.duration ?? 0;
    if (!len) return null;
    const [ci, co] = clipSpan(o, len);
    const a0 = o.offset + ci, b0 = o.offset + co;
    const vol = clamp(o.volume ?? 0, 0, 1);
    const trimmed = ci > 0.01 || co < len - 0.01;
    const setO = (patch: Partial<VideoOverlay>) => patchOverlay(o.clip, patch);
    const inSeg = (t: number) => round2(clamp(t, settings.crop.start, end - 0.05));
    const down = (mode: "move" | "in" | "out") => (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) { if (e.button === 2) e.stopPropagation(); return; } // (right: its menu, never the track's scrub; trimmed even locked: the sync stays)
      e.stopPropagation(); stop();
      e.currentTarget.setPointerCapture(e.pointerId);
      const r = (e.currentTarget.closest(".lyric-track") ?? e.currentTarget).getBoundingClientRect();
      const w = viewRef.current ?? twRef.current;
      ovDrag.current = { mode, px: e.clientX, py: e.clientY, el: e.currentTarget, left: r.left, width: r.width, s: w.s, d: w.d, o, ci, co, len };
      dragHead.current = headRef.current;
    };
    const move = (e: React.PointerEvent<HTMLElement>) => {
      if (moveVdrag(e)) return;
      const d = ovDrag.current;
      if (!d) return;
      // Up or down more than sideways: carried to another row (the base line: multicam; under it: it becomes the base).
      if (d.mode === "move" && d.py !== undefined && d.el && vertical(e, { px: d.px, py: d.py })) {
        ovDrag.current = null;
        if (d.moved) setO({ offset: d.o.offset, clipIn: d.o.clipIn, clipOut: d.o.clipOut });
        startVdrag("over", 0, d.el, e, d.px, d.py, o.clip);
        return;
      }
      if (!d.moved && Math.abs(e.clientX - d.px) < 4) return;
      d.moved = true;
      const dt = ((e.clientX - d.px) / Math.max(1, d.width)) * d.d, dur = audioBuf.duration;
      if (d.mode === "move") {
        if (locked) return; // (locked to the audio: it only changes rows)
        let offset = round2(clamp(d.o.offset + dt, -d.co + 0.5, dur - d.ci - 0.5));
        const px = d.width / d.d, ma = magnet(e, offset + d.ci, px), mb = ma === null ? magnet(e, offset + d.co, px) : null;
        if (ma !== null) offset = round2(ma - d.ci); else if (mb !== null) offset = round2(mb - d.co);
        setO({ offset });
      } else if (d.mode === "in") {
        let clipIn = round2(clamp(d.ci + dt, 0, d.co - 0.2));
        const m = magnet(e, d.o.offset + clipIn, d.width / d.d);
        if (m !== null) clipIn = round2(clamp(m - d.o.offset, 0, d.co - 0.2));
        setO({ clipIn });
        headOnEdge(d.o.offset + clipIn, inSeg);
      } else {
        let clipOut = round2(clamp(d.co + dt, d.ci + 0.2, d.len));
        const m = magnet(e, d.o.offset + clipOut, d.width / d.d);
        if (m !== null) clipOut = round2(clamp(m - d.o.offset, d.ci + 0.2, d.len));
        setO({ clipOut });
        headOnEdge(d.o.offset + clipOut - 0.05, inSeg);
      }
    };
    const up = (e: React.PointerEvent<HTMLElement>) => {
      if (vdragRef.current) { endVdrag(); return; }
      const d = ovDrag.current;
      ovDrag.current = null;
      // A click: the playhead there, and the right column on this video.
      if (d && !d.moved) { setHead(inSeg(d.s + clamp((e.clientX - d.left) / Math.max(1, d.width), 0, 1) * d.d)); setPinCam(null); setOverLook(o.clip); setPick("video"); }
    };
    return (<>
        <div className="tl-row" key={o.clip}><div className="tl-hd" onPointerDown={(e) => e.stopPropagation()}>
            {eyeEl(!!o.hidden, () => setO({ hidden: o.hidden ? undefined : true }))}
            <Menu float trigger={(_, toggle) => (
              <button className={"btn icon sm quiet" + (vol > 0 ? " on" : "")} aria-label={t("Settings")} title={t("Corners and sound of the video over it")} onClick={toggle}>
                <Icon name={vol > 0 ? "volume" : "tune"} size={14} />
              </button>
            )}>
              {(close) => (
                <div className="sound-pop" data-keep>
                  <Range label={t("Rounded corners")} value={Math.round(o.radius ?? 0)} display={`${Math.round(o.radius ?? 0)} %`} min={0} max={50} step={1} onChange={(n) => setO({ radius: n })} />
                  <Range label={t("Video sound")} value={Math.round(vol * 100)} display={vol > 0 ? `${Math.round(vol * 100)} %` : t("Muted")}
                    min={0} max={100} step={1} onChange={(n) => setO({ volume: n > 0 ? n / 100 : undefined })} />
                  <p className="muted xs">{t("Click it to set it in the right column (its size is the Zoom of the framing, its colour…); drag it on the video to move it.")}</p>
                  <div className="row" style={{ gap: 6 }}>
                    {trimmed && <button className="btn sm quiet" onClick={() => setO({ clipIn: undefined, clipOut: undefined })}>{t("Whole video")}</button>}
                    <span className="grow" />
                    <button className="btn sm quiet" style={{ color: "var(--danger)" }} onClick={() => { close(); stop(); patchOverlay(o.clip, null); }}>{t("Take out of the project")}</button>
                  </div>
                </div>
              )}
            </Menu>
          </div><div className={"lyric-track video-track over-track" + (o.hidden ? " is-hidden" : "")} data-ov={o.clip} role="group" aria-label={t("Video over it")} {...scrub()}>
          <div className="track-tools" onPointerDown={(e) => e.stopPropagation()}>
            {eyeEl(!!o.hidden, () => setO({ hidden: o.hidden ? undefined : true }))}
            <Menu float trigger={(_, toggle) => (
              <button className={"btn icon sm quiet" + (vol > 0 ? " on" : "")} aria-label={t("Settings")} title={t("Corners and sound of the video over it")} onClick={toggle}>
                <Icon name={vol > 0 ? "volume" : "tune"} size={14} />
              </button>
            )}>
              {(close) => (
                <div className="sound-pop" data-keep>
                  <Range label={t("Rounded corners")} value={Math.round(o.radius ?? 0)} display={`${Math.round(o.radius ?? 0)} %`} min={0} max={50} step={1} onChange={(n) => setO({ radius: n })} />
                  <Range label={t("Video sound")} value={Math.round(vol * 100)} display={vol > 0 ? `${Math.round(vol * 100)} %` : t("Muted")}
                    min={0} max={100} step={1} onChange={(n) => setO({ volume: n > 0 ? n / 100 : undefined })} />
                  <p className="muted xs">{t("Click it to set it in the right column (its size is the Zoom of the framing, its colour…); drag it on the video to move it.")}</p>
                  <div className="row" style={{ gap: 6 }}>
                    {trimmed && <button className="btn sm quiet" onClick={() => setO({ clipIn: undefined, clipOut: undefined })}>{t("Whole video")}</button>}
                    <span className="grow" />
                    <button className="btn sm quiet" style={{ color: "var(--danger)" }} onClick={() => { close(); stop(); patchOverlay(o.clip, null); }}>{t("Take out of the project")}</button>
                  </div>
                </div>
              )}
            </Menu>
          </div>
          <div className="track-content">
            {onTrack(a0, b0) && (
              <div className={"cue video-clip over-clip cam-" + no + (locked ? " locked" : "") + (head >= a0 && head < b0 ? " on" : "") + (pick === "video" && picked ? " sel" : "")} style={{ ...place(a0), width: wFull(a0, b0) }} data-va={a0} data-vb={b0}
                title={t("Drag to slide the video along the track, its edges to trim it.")}
                onPointerDown={down("move")} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { ovDrag.current = null; }} onContextMenu={clipCtx(o.clip)}>
                <span className="clip-edge in" onPointerDown={down("in")} />
                <span className="vc-name"><span className="cue-ico" aria-hidden><Icon name="film" size={11} /></span><b className="vc-no">{no + 1}</b>
                  {synced && <button className="clip-lock" aria-label={locked ? t("Unlock: slide it freely") : t("Lock it back on its synced place")}
                    title={locked ? t("Locked to the audio (synced): click to unlock and slide it freely.") : t("Click to put it back where its sync places it, locked.")}
                    onPointerDown={(e) => e.stopPropagation()} onClick={toggleLock}><Icon name={locked ? "lock" : "unlock"} size={11} /></button>}
                  <span className="truncate" data-text={take.videoName?.replace(/\.[^.]+$/, "") ?? clipName(take)}>{take.videoName?.replace(/\.[^.]+$/, "") ?? clipName(take)}</span></span>
                <span className="clip-edge out" onPointerDown={down("out")} />
              </div>
            )}
            {partsEl(o, o.offset, a0 - o.offset, b0 - o.offset)}
            {head >= a0 && head < b0 && barAt(a0, b0) !== null && <span className={"cue-bar-glow cam-glow cam-" + no} data-a={a0} data-b={b0} style={place(barAt(a0, b0)!)} />}
            <span className="lyric-head" style={{ ...place(clamp(head, Math.max(settings.crop.start, tw.s), Math.min(end, tw.s + tw.d))) }} />
          </div>
        </div></div>
        </>
    );
  };
  /** A shot pressed on the cameras' track: pulled up far enough, its camera goes over the video. */
  const liftRef = useRef<{ x: number; y: number; cam: number; el: HTMLElement } | null>(null);
  /** The cameras: their track (in the video block, under the video over it), or the multicam's buttons (under the
   *  block, only with two cameras or more). */
  const camsEl = (part: "track" | "controls") => {
    const angles = settings.angles ?? [];
    const used = angles.filter(Boolean).length;
    if (!used) return part === "track" ? videoTrackEl() : null;
    const shots = used ? shotsOf(settings.cuts, settings.crop.start, end) : [];
    const sortedCuts = [...(settings.cuts ?? [])].sort((a, b) => a.at - b.at);
    /** Camera `cam` (0-3) from a button: as its key (playing: cut to it now; paused: the shot under the playhead). */
    const pickCam = chooseCam;
    const camNow = camAt(settings.cuts, head);
    const pos = (x: number) => place(clamp(x, Math.max(settings.crop.start, tw.s), Math.min(end, tw.s + tw.d)));
    if (part === "track") return (<>
          <div className="tl-row"><div className="tl-hd" onPointerDown={(e) => e.stopPropagation()}>
              {eyeEl(!!settings.videoHidden, () => setV({ videoHidden: settings.videoHidden ? undefined : true }))}
              {(() => {
                const cams = [clip, ...angles.map((id) => clips.find((c) => c.id === id))];
                const anyOn = cams.some((c) => (c?.id === clip.id ? settings.clipVolume : c?.clipVolume) ?? 0);
                return (
                  <Menu float trigger={(_, toggle) => (
                    <button className={"btn icon sm quiet" + (anyOn ? " on" : "")} aria-label={t("Cameras' sound")} title={t("Cameras' sound")} onClick={toggle}>
                      <Icon name={anyOn ? "volume" : "volume-off"} size={14} />
                    </button>
                  )}>
                    {() => (
                      <div className="sound-pop" data-keep>
                        {cams.map((c, k) => {
                          if (!c) return null;
                          const vol = clamp((k === 0 ? settings.clipVolume : c.clipVolume) ?? 0, 0, 1);
                          const set = (n: number) => { const x = n > 0 ? n / 100 : undefined; if (k === 0) setV({ clipVolume: x }); else patchTake(c.id, { clipVolume: x }); };
                          return (
                            <Range key={c.id} label={`${k + 1} · ${c.videoName?.replace(/\.[^.]+$/, "") ?? clipName(c)}`} value={Math.round(vol * 100)}
                              display={vol > 0 ? `${Math.round(vol * 100)} %` : t("Muted")} min={0} max={100} step={1} onChange={set} />
                          );
                        })}
                        <p className="muted xs">{t("Each camera's own sound, over the official audio, heard on its shots.")}</p>
                      </div>
                    )}
                  </Menu>
                );
              })()}
            </div><div className={"lyric-track cam-track" + (settings.videoHidden ? " is-hidden" : "")} role="group" aria-label={t("Shots")} {...scrub()}
            // (the track holds the pointer while it is down: the pull up is followed here)
            onPointerMoveCapture={(e) => {
              if (moveVdrag(e)) { e.stopPropagation(); return; }
              const l = liftRef.current;
              if (!l || !vertical(e, { px: l.x, py: l.y })) return;
              liftRef.current = null; scrubRef.current = null;
              e.stopPropagation();
              startVdrag("cam", l.cam, l.el, e, l.x, l.y);
            }}
            onPointerUpCapture={(e) => { liftRef.current = null; if (vdragRef.current) { e.stopPropagation(); endVdrag(); } }}>
            {/* At its end: the eye (all its shots), each camera's own sound (heard on its shots). */}
            <div className="track-tools" onPointerDown={(e) => e.stopPropagation()}>
              {eyeEl(!!settings.videoHidden, () => setV({ videoHidden: settings.videoHidden ? undefined : true }))}
              {(() => {
                const cams = [clip, ...angles.map((id) => clips.find((c) => c.id === id))];
                const anyOn = cams.some((c) => (c?.id === clip.id ? settings.clipVolume : c?.clipVolume) ?? 0);
                return (
                  <Menu float trigger={(_, toggle) => (
                    <button className={"btn icon sm quiet" + (anyOn ? " on" : "")} aria-label={t("Cameras' sound")} title={t("Cameras' sound")} onClick={toggle}>
                      <Icon name={anyOn ? "volume" : "volume-off"} size={14} />
                    </button>
                  )}>
                    {() => (
                      <div className="sound-pop" data-keep>
                        {cams.map((c, k) => {
                          if (!c) return null;
                          const vol = clamp((k === 0 ? settings.clipVolume : c.clipVolume) ?? 0, 0, 1);
                          const set = (n: number) => { const x = n > 0 ? n / 100 : undefined; if (k === 0) setV({ clipVolume: x }); else patchTake(c.id, { clipVolume: x }); };
                          return (
                            <Range key={c.id} label={`${k + 1} · ${c.videoName?.replace(/\.[^.]+$/, "") ?? clipName(c)}`} value={Math.round(vol * 100)}
                              display={vol > 0 ? `${Math.round(vol * 100)} %` : t("Muted")} min={0} max={100} step={1} onChange={set} />
                          );
                        })}
                        <p className="muted xs">{t("Each camera's own sound, over the official audio, heard on its shots.")}</p>
                      </div>
                    )}
                  </Menu>
                );
              })()}
            </div>
            <div className="track-content">
            {shots.map((x, i) => {
              if (!onTrack(x.from, x.to)) return null; // far from view
              const a = x.cam > 0 ? clips.find((c) => c.id === angles[x.cam - 1]) : clip;
              // Its cut (the one that starts it, in the segment): its cross takes it away, the shot joins the one on its left.
              const own = x.cut >= 0 && Math.abs(sortedCuts[x.cut].at - x.from) < 1e-3 ? sortedCuts[x.cut] : null;
              const go = () => { stop(); setPinCam(null); setPick("video"); setHead(round2(x.from + 0.01)); };
              return (
                <div key={i} role="button" tabIndex={0} className={"cue cam-shot cam-" + x.cam + (head >= x.from - 1e-3 && head < x.to ? " on" : "")} data-at={x.from} data-a={x.from} data-b={x.to}
                  // Pulled up (as in CapCut): this camera leaves the cuts and goes over the video, on its own track.
                  onPointerDown={(e) => { if (e.button === 0) liftRef.current = { x: e.clientX, y: e.clientY, cam: x.cam, el: e.currentTarget }; }}

                  style={{ ...place(x.from), width: wFull(x.from, x.to) }}
                  title={`${x.cam + 1} · ${a ? a.videoName ?? clipName(a) : "?"}`}
                  onKeyDown={(e) => { if (e.key === "Enter") go(); }}>
                  <span className="cue-ico" aria-hidden><Icon name="film" size={11} /></span><b>{x.cam + 1}</b> {a ? a.videoName?.replace(/\.[^.]+$/, "") ?? clipName(a) : ""}
                  {own && (
                    <button className="shot-x" aria-label={t("Remove this cut")} title={t("Remove this cut: the shot joins the one on its left")}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); setV({ cuts: (settingsRef.current.cuts ?? []).filter((c) => c !== own && Math.abs(c.at - own.at) > 1e-6) }); }}>
                      <Icon name="x" size={11} />
                    </button>
                  )}
                </div>
              );
            })}
            {(() => { const x = shots.find((q) => head >= q.from - 1e-3 && head < q.to); const at = x ? barAt(x.from, x.to) : null; return at !== null ? <span className={"cue-bar-glow cam-glow cam-" + x!.cam} data-a={x!.from} data-b={x!.to} style={place(at)} /> : null; })()}
            {(settings.cuts ?? []).map((c, i) => c.at > settings.crop.start && c.at < end && onTrack(c.at, c.at) && (
              <span key={"k" + i} className="cam-cut" style={{ ...place(c.at) }} title={t("Drag to move this cut (it sticks to the lyrics, ⌘ to move it freely), double-click to remove it")}
                onDoubleClick={(e) => { e.stopPropagation(); setV({ cuts: (settingsRef.current.cuts ?? []).filter((x) => x !== c && Math.abs(x.at - c.at) > 1e-6) }); }}
                onPointerDown={(e) => {
                  if (e.button === 1) return;
                  e.stopPropagation(); stop();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  const r = (e.currentTarget.closest(".lyric-track") ?? e.currentTarget.parentElement!).getBoundingClientRect(); // the track (its content may be sliding)
                  cutDrag.current = { i: [...(settings.cuts ?? [])].sort((a, b) => a.at - b.at).indexOf(c), left: r.left, width: r.width };
                }}
                onPointerMove={(e) => {
                  const d = cutDrag.current;
                  if (!d) return;
                  const cfg = settingsRef.current;
                  const w = viewRef.current ?? twRef.current;
                  let at = clamp(w.s + clamp((e.clientX - d.left) / d.width, 0, 1) * w.d, cfg.crop.start, end);
                  // Drawn to the lyrics' lines and the hooks (their start or end) within 8 px, so a cut falls on the
                  // sound; ⌘ / Ctrl held: free.
                  if (!e.metaKey && !e.ctrlKey) {
                    const reach = (8 / d.width) * w.d;
                    const marks = [...cues.flatMap((q) => [q.start, q.end]), ...hooks.flatMap((h) => [cfg.crop.start + h.from, ...(h.to != null ? [cfg.crop.start + h.to] : [])])];
                    const near = marks.reduce((b, m) => (Math.abs(m - at) < Math.abs(b - at) ? m : b), Infinity);
                    if (Math.abs(near - at) <= reach) at = near;
                  }
                  setV({ cuts: moveCut(cfg.cuts ?? [], d.i, at) });
                }}
                onPointerUp={() => { cutDrag.current = null; }} onPointerCancel={() => { cutDrag.current = null; }} />
            ))}
            <span className="lyric-head" style={{ ...pos(head) }} />
            </div>
          </div></div>
        </>
    );
    return (
        <div className="row cams-row">
          <span className="label">{t("Edit")}<Hint text={t("Multicam edit: other videos of the release, synced on the same audio. Playing, keys 1 to 4 cut to a camera; paused, they change the shot under the playhead, C cuts it in two, Delete removes its cut. Drag a cut to move it.")} /></span>
          {[0, ...angles.map((_, k) => k + 1)].filter((k) => k === 0 || angles[k - 1]).map((k) => (
            <button key={k} className={"btn sm cam-btn cam-" + k + (camNow === k ? " on" : "")} onClick={() => pickCam(k)}
              title={t("Camera {n}: cut to it here (at a shot's start: the whole shot)", { n: k + 1 }) + ` (${k + 1})`}>{k + 1}</button>
          ))}
          <span className="muted xs">{t("A camera cuts to it at the playhead; at a shot's start, the whole shot.")}</span>
        </div>
    );
  };
  /** The strip's passage and file (not its grade): a change of colour only waits longer before it is made again. */
  const stripBase = useRef("");
  useEffect(() => {
    if (!active || !videoUrl) { if (!videoUrl) setStrip([]); return; }
    let off = false;
    const from = settings.crop.start, len = segLen, offset = settings.offset;
    // Already made for this video's file and this passage: at once, from memory or from this device (kept there,
    // one strip per video: switching videos or reloading never makes it again).
    const squeeze = settings.desqueeze ?? 1;
    // Its pictures wear the video's colour grade (once ready: the LUT may still be loading), as the preview does.
    const gradeNow = gradesColour(settings.grade) && !gradePendingRef.current && graderRef.current?.ready && videoLut.current ? settings.grade : undefined;
    const base = `${clip.id}|${videoBlob?.size ?? videoUrl}|${from.toFixed(2)}|${len.toFixed(2)}|${offset.toFixed(3)}${squeeze === 1 ? "" : `|${squeeze}`}`;
    // Multicam: each picture from the camera of its shot (its cuts and cameras' looks in the key).
    const multi = (settings.angles ?? []).some(Boolean) && (settings.cuts?.length ?? 0) > 0;
    const key = base + (gradeNow ? `|${colourKey}` : "") + (multi ? `|${JSON.stringify(settings.cuts)}|${anglesKey}|${angleRev}` : "");
    const disk = `strip:${clip.id}`;
    const known = STRIPS.get(key);
    if (known) { stripBase.current = base; setStrip(known); return; }
    // The first time, right away; while the segment is being moved, once it rests (the old pictures stay meanwhile);
    // only the colour changed (sliders being moved): once it rests a little longer.
    const wait = !strip.length ? 0 : stripBase.current === base ? 1500 : 450;
    stripBase.current = base;
    const timer = window.setTimeout(async () => {
      try {
        const saved = await getMedia(disk);
        const j = saved ? JSON.parse(await saved.text()) as { key: string; frames: string[] } : null;
        if (j?.key === key && j.frames.length) { STRIPS.set(key, j.frames); if (!off) setStrip(j.frames); return; }
      } catch { /* not kept: made below */ }
      if (off) return;
      const v = document.createElement("video");
      v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = videoUrl;
      /** The other cameras' players for the strip (their own, never the preview's). */
      const others = new Map<string, HTMLVideoElement>();
      const playerOf = async (a: Angle) => {
        let el = others.get(a.id);
        if (!el) {
          el = document.createElement("video");
          el.muted = true; el.playsInline = true; el.preload = "auto"; el.src = a.url;
          others.set(a.id, el);
          await new Promise<void>((ok) => { el!.onloadeddata = () => ok(); el!.onerror = () => ok(); window.setTimeout(ok, 4000); });
        }
        return el;
      };
      try {
        await new Promise<void>((ok, ko) => { v.onloadeddata = () => ok(); v.onerror = () => ko(new Error("load")); });
        // Big enough to stay sharp on a computer's wide strip (and on a Retina screen), lightly compressed.
        const N = 9, H = 240;
        const cv = document.createElement("canvas");
        const out: string[] = [];
        for (let i = 0; i < N && !off; i++) {
          const T = from + ((i + 0.5) / N) * len;
          const k = multi ? camAt(settings.cuts, T) : 0;
          const ang = k > 0 ? anglesRef.current.get(settings.angles?.[k - 1] ?? "") : undefined;
          const el = ang ? await playerOf(ang) : v;
          const sq = ang ? ang.desqueeze ?? 1 : squeeze;
          // Song time → camera time (the take is that far into the song).
          el.currentTime = clamp(T - (ang ? ang.offset : offset), 0, Math.max(0, (el.duration || 0) - 0.05));
          await new Promise<void>((ok) => { el.onseeked = () => ok(); window.setTimeout(ok, 2000); });
          if (!el.videoWidth) { if (ang) { out.push(out[out.length - 1] ?? ""); continue; } break; }
          cv.width = Math.round((H * el.videoWidth * sq) / el.videoHeight); cv.height = H;
          const g = cv.getContext("2d")!;
          g.drawImage(el, 0, 0, cv.width, cv.height);
          if (ang) {
            // That camera's own grade, as the preview shows it.
            const grader = graderRef.current ?? (ang.lut ? (graderRef.current = Grader.shared()) : null);
            if (ang.grade && gradesColour(ang.grade) && ang.lut && grader && !grader.lost) {
              grader.setLut(ang.lut, 33);
              const done = grader.grade({ src: cv, w: cv.width, h: cv.height }, { x: 0, y: 0, w: cv.width, h: cv.height }, cv.width, cv.height);
              g.drawImage(done.src, 0, 0);
              drawLook(g, cv.width, cv.height, { ...ang.grade, grain: 0 }, 0);
            }
            out.push(cv.toDataURL("image/jpeg", 0.82));
            if (!off && !wait) setStrip([...out]);
            continue;
          }
          const grader = graderRef.current;
          if (gradeNow && grader?.ready && videoLut.current) {
            // The same grade as the preview (its LUT put back: the slides share the grader), the vignette too
            // (no grain: noise at this size).
            grader.setLut(videoLut.current, 33);
            const done = grader.grade({ src: cv, w: cv.width, h: cv.height }, { x: 0, y: 0, w: cv.width, h: cv.height }, cv.width, cv.height);
            g.drawImage(done.src, 0, 0);
            drawLook(g, cv.width, cv.height, { ...gradeNow, grain: 0 }, 0);
          }
          out.push(cv.toDataURL("image/jpeg", 0.82));
          // Each picture takes its place as soon as it is made (the strip is at its full height from the start).
          if (!off && !wait) setStrip([...out]);
        }
        if (out.length === N) {
          STRIPS.set(key, out);
          void putMedia(disk, new Blob([JSON.stringify({ key, frames: out })], { type: "application/json" })).catch(() => {});
        }
        if (!off && out.length) setStrip(out);
      } catch { if (!off) setStrip([]); }
      finally { v.removeAttribute("src"); v.load(); for (const el of others.values()) { el.removeAttribute("src"); el.load(); } }
    }, wait);
    return () => { off = true; clearTimeout(timer); };
  }, [active, videoUrl, settings.crop.start, segLen, settings.offset, settings.desqueeze, colourKey, lutRev, JSON.stringify(settings.cuts ?? []), anglesKey, angleRev]); // eslint-disable-line react-hooks/exhaustive-deps
  const placed = (project.lyricWords?.length ?? 0) > 0;
  /** Nothing synced yet: one button does both. Afterwards each has its own, so changing the video never touches the lyrics. */
  const firstSync = hasLyrics && !placed && !!videoBlob && settings.score === undefined;
  const hooks = settings.hooks ?? [];
  const setHooks = (list: VideoHook[]) => setV({ hooks: list });
  // ---- the start of a lyrics line or a hook dragged on its track (as a multicam cut): no gap made by the drag,
  //      Alt held: only that one moves ----
  const edgeRef = useRef<{ left: number; width: number } | null>(null);
  /**
   * The magnets of the timeline: a clip's edge (lyrics, hook, video) within 8 px of the segment's start (to start exactly
   * at 0:00 of the post) or of the playhead sticks to it; ⌘ (Ctrl) held: placed freely.
   */
  /** The playhead where it was when a drag began: a clip's edge sticks to it (as in CapCut), the playhead never moving. */
  const dragHead = useRef(0);
  /** The magnet a time `t` sticks to within 8 px: the segment's start or the playhead; none (or ⌘ held): null. */
  const magnet = (e: { metaKey: boolean; ctrlKey: boolean }, t: number, pxPerS: number): number | null => {
    if (e.metaKey || e.ctrlKey) return null;
    let best: number | null = null;
    for (const m of [settingsRef.current.crop.start, dragHead.current]) if (Math.abs(t - m) * pxPerS < 8 && (best === null || Math.abs(t - m) < Math.abs(t - best))) best = m;
    return best;
  };
  /** The playhead put on an edge being trimmed (its picture shown), only while it is inside the segment. */
  const headOnEdge = (t: number, inSeg: (x: number) => number) => {
    const c = settingsRef.current.crop, h = dragHead.current;
    if (h >= c.start && h <= c.start + c.duration) setHead(inSeg(t));
  };
  // The drag follows the window, not the handle: the handle grabbed can go while it moves (a line's end brought onto
  // the next line: that border is the next line's start handle from then on), and the moves then reached the handle
  // under the pointer, which moved the next line and the playhead. The one grabbed keeps it until it is let go.
  const edgeDrag = (move: (at: number, free: boolean) => void, wholeSong = false, magnetToo = false) => ({
    onPointerDown: (e: React.PointerEvent<HTMLSpanElement>) => {
      if (e.button === 1) return;
      e.stopPropagation(); e.preventDefault(); stop();
      e.currentTarget.setPointerCapture(e.pointerId);
      const r = (e.currentTarget.closest(".lyric-track") ?? e.currentTarget.parentElement!).getBoundingClientRect(); // the track (its content may be sliding)
      edgeRef.current = { left: r.left, width: r.width };
      dragHead.current = headRef.current;
      const onMove = (ev: PointerEvent) => {
        const d = edgeRef.current;
        if (!d) return;
        const cfg = settingsRef.current;
        const w = viewRef.current ?? twRef.current;
        // (a line outside the segment: anywhere in the song)
        const lo = wholeSong ? 0 : cfg.crop.start, hi = wholeSong ? audioBuf?.duration ?? Infinity : cfg.crop.start + Math.max(0.1, cfg.crop.duration);
        let at = round2(clamp(w.s + clamp((ev.clientX - d.left) / d.width, 0, 1) * w.d, lo, hi));
        const m = wholeSong && !magnetToo ? null : magnet(ev, at, d.width / w.d);
        if (m !== null) at = m;
        move(at, ev.altKey);
      };
      const done = (save: boolean) => () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        if (edgeRef.current) { edgeRef.current = null; if (save) onSaveNow(); }
      };
      const up = done(true), cancel = done(false);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
    },
  });
  // (a line's edges: anywhere in the song, a line may run past the segment; the playhead stays on the edge, stopped
  // with it where the line can go no further: 0.2 s at least, as `moveCueStart` / `retimeCue`)
  /** A clip's own handles, inside it (as a video clip's): its start and its end, each its own even where two clips
   *  touch (one handle for both moved the next line when the end of this one was meant). Shown on hover. */
  /** A line's padlock, on its clip (shown on hover, always once locked): kept as it is when the lyrics are placed again. */
  /** A line locked (all its words): its icon shows a padlock instead of the T. */
  const lockedCue = (c: Cue) => c.words.length > 0 && c.words.every((x) => x.lock);
  /** A lyric clip's icon, its padlock too: T (on hover an open padlock: click to lock), locked a gold padlock (click to
   *  unlock). One icon, no button beside it. Word by word: the T only. */
  const cueIcon = (c: Cue) => {
    if (mode === "word") return <span className="cue-ico" aria-hidden><Icon name="type" size={11} /></span>;
    const on = lockedCue(c);
    return (
      <span role="button" tabIndex={-1} className={"cue-ico lockable" + (on ? " locked" : "")} aria-pressed={on}
        title={on ? t("Locked: kept as it is (not moved by hand nor when the lyrics are placed again). Click to unlock.") : t("Lock this line: kept as it is when the lyrics are placed again")}
        onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); toggleLock(c); }}>
        <span className="ico-idle"><Icon name={on ? "lock" : "type"} size={11} /></span>
        <span className="ico-hover"><Icon name={on ? "unlock" : "lock"} size={11} /></span>
      </span>
    );
  };
  const grips = (start: ReturnType<typeof edgeDrag>, end: ReturnType<typeof edgeDrag>) => (<>
    <span className="cue-grip in" title={t("Drag to move when it starts (Alt: only this one, a gap allowed)")} {...start} />
    <span className="cue-grip out" title={t("Drag to change when it leaves")} {...end} />
  </>);
  const moveLine = (i: number) => edgeDrag((at, free) => {
    const c = cues[i], prev = cues[i - 1];
    if (prev && lockedCue(prev)) at = Math.max(at, prev.end); // (a locked line before: it stops there)
    // (every move is from the gesture's start: back where it was, "nothing moved" is the start again, not the last move
    // kept — the line stayed a hair off a locked one it was brought back against)
    if (!c) return;
    const out = moveCueStart(project.lyricWords ?? [], cues, i, at, free) ?? project.lyricWords ?? [];
    setTab("lyrics");
    setHead(round2(clamp(at, prev ? prev.start + 0.2 : 0, c.end - 0.2)));
    onProject((p) => ({ ...p, lyricWords: out }));
  }, true, true);
  /** A line outside the segment (the whole song's lines, `songCues`): its start or its end moved the same way, anywhere
   *  in the song (to check and set the lyrics of a passage the post does not use yet, the segment locked elsewhere). */
  const moveSongLine = (i: number) => edgeDrag((at, free) => {
    const c = songCues[i], prev = songCues[i - 1];
    if (prev && lockedCue(prev)) at = Math.max(at, prev.end);
    const out = c ? moveCueStart(project.lyricWords ?? [], songCues, i, at, free) ?? project.lyricWords ?? [] : null;
    if (out && c) { setHead(round2(clamp(at, prev ? prev.start + 0.2 : 0, c.end - 0.2))); onProject((p) => ({ ...p, lyricWords: out })); }
  }, true);
  const moveSongLineEnd = (i: number) => edgeDrag((at) => {
    const c = songCues[i], next = songCues[i + 1];
    if (next && lockedCue(next)) at = Math.min(at, next.start);
    const out = c ? moveCueEnd(project.lyricWords ?? [], songCues, i, at) ?? project.lyricWords ?? [] : null;
    if (out && c) { setHead(round2(clamp(at, c.start + 0.2, next ? next.end - 0.2 : Infinity))); onProject((p) => ({ ...p, lyricWords: out })); }
  }, true);
  /** A line's end dragged (one followed by a gap, or the last: a glued end is the next line's start handle). */
  const moveLineEnd = (i: number) => edgeDrag((at) => {
    const c = cues[i], next = cues[i + 1];
    if (next && lockedCue(next)) at = Math.min(at, next.start); // (a locked line after: it stops there)
    if (!c) return;
    const out = moveCueEnd(project.lyricWords ?? [], cues, i, at) ?? project.lyricWords ?? [];
    setTab("lyrics");
    setHead(round2(clamp(at, c.start + 0.2, next ? next.end - 0.2 : Infinity))); // (on the edge pulled, exactly: as a hook's)
    onProject((p) => ({ ...p, lyricWords: out }));
  }, true, true);
  /** A hook's end dragged: later past the next hook's start, that one starts later (it keeps its end). */
  const moveHookEnd = (id: string) => edgeDrag((at) => {
    const h = hooks.find((x) => x.id === id);
    if (!h) return;
    const next = hooks.filter((x) => x.id !== id && x.from > h.from).sort((a, b) => a.from - b.from)[0];
    const to = round2(clamp(at - settings.crop.start, h.from + 0.2, next ? (next.to ?? segLen) - 0.2 : hookMax));
    setTab("hook");
    setHead(round2(settings.crop.start + to));
    setHooks(hooks.map((x) => (x.id === id ? { ...x, to } : next && x.id === next.id && to > next.from ? { ...x, from: to } : x)));
  }, true, true);
  const moveHook = (id: string) => edgeDrag((at, free) => {
    const h = hooks.find((x) => x.id === id);
    if (!h) return;
    const prev = hooks.filter((x) => x.id !== id && x.from < h.from).sort((a, b) => b.from - a.from)[0];
    const from = round2(clamp(at - settings.crop.start, prev ? prev.from + 0.2 : hookMin, (h.to ?? segLen) - 0.2));
    setTab("hook");
    setHead(round2(settings.crop.start + from));
    setHooks(hooks.map((x) => (x.id === id ? { ...x, from } : !free && prev && x.id === prev.id ? { ...x, to: from } : x)));
  }, true, true);
  const editHook = (id: string, patch: Partial<VideoHook>) => setHooks(hooks.map((h) => (h.id === id ? { ...h, ...patch } : h)));
  // ---- hook lists: the same as the carousel's; by default the one of the first slide of the release ----
  const slide1Pool = (() => {
    const src = project.slides[0]?.textSource;
    return src?.kind === "pool" && hookPools.some((p) => p.id === src.poolId) ? src.poolId : undefined;
  })();
  const hookPoolId = settings.hookPoolId && hookPools.some((p) => p.id === settings.hookPoolId) ? settings.hookPoolId : slide1Pool ?? hookPools[0]?.id;
  // A hook line edited in the carousel's list: every video of the release that uses it follows.
  // The lists are made again at each render: only their text decides when to look.
  const listsKey = hookPools.map((p) => `${p.id}\u0001${p.text}`).join("\u0002");
  const tagsByPool = useMemo(() => new Map(hookPools.map((p) => [p.id, p.kind === "hooks" ? poolTags(p) : []])), [listsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Where a hook is drawn from: its own list and tags (each hook its own), else the video's (by default slide 1's list). */
  const srcOf = (h?: VideoHook) => {
    const poolId = h?.pool && hookPools.some((p) => p.id === h.pool) ? h.pool : hookPoolId;
    const pool = hookPools.find((p) => p.id === poolId);
    const tagsOf = (poolId && tagsByPool.get(poolId)) || [];
    const groups = tagGroups(tagsOf);
    const own = h?.pool && h.pool === poolId ? h.tags : undefined;
    const ticked = (own ?? (poolId === hookPoolId ? sourceTags(settings.hookTags, settings.hookTheme) : undefined) ?? []).filter((x) => groups.some((g) => g.id === x));
    const all = pool ? textItems(pool) : [];
    // Its excluded tags (their −): never their texts, neither offered nor drawn.
    const notTicked = (h?.pool && h.pool === poolId ? h.notTags ?? [] : []).filter((x) => groups.some((g) => g.id === x));
    const items = all.filter((_, i) => !tagsOf[i]?.some((x) => notTicked.includes(x)) && (!ticked.length || tagsOf[i]?.some((x) => ticked.includes(x))));
    return { poolId, pool, groups, ticked, notTicked, items, count: tagsOf.length };
  };
  /** A hook drawn from its list (and tags), different from the ones already on the video. */
  const drawFor = (h: VideoHook | undefined, taken: string[]) => {
    const s = srcOf(h);
    return s.poolId ? onDrawHook(s.poolId, taken, s.ticked.length ? s.ticked : undefined, s.notTicked.length ? s.notTicked : undefined) : null;
  };
  /** A text of the list in a hook: linked to its line, so editing it in the list follows here. */
  const fromList = (h: VideoHook | undefined, text: string): Partial<VideoHook> => ({ text, link: hookLink(srcOf(h).pool, text) });
  const addHook = (text = "") => {
    const last = hooks[hooks.length - 1];
    const from = last ? round2(Math.min(segLen - 1, last.to ?? Math.min(3, segLen / 2))) : 0;
    const list = last && last.to === undefined ? hooks.map((h) => (h === last ? { ...h, to: from } : h)) : hooks;
    // A new hook draws from the same place as the one before (changed on its own afterwards).
    const src = last?.pool ? { pool: last.pool, tags: last.tags } : {};
    setHooks([...list, { id: uid(), text, from, to: last ? round2(Math.min(segLen, from + 3)) : undefined, ...src, link: text ? hookLink(srcOf(last).pool, text) : undefined }]);
    if (settings.showHooks === false) setV({ showHooks: true });
  };
  const drawInto = (id: string) => {
    const h = hooks.find((x) => x.id === id);
    const text = drawFor(h, hooks.filter((x) => x.id !== id).map((x) => x.text));
    if (text !== null) editHook(id, fromList(h, text));
  };
  useEffect(() => {
    // Nothing to follow: no change at all (no save, no undo step).
    if (!clipsOf(project).some((c) => c.hooks?.length && followLists(c.hooks, hookPools) !== c.hooks)) return;
    onProject((p) => ({ ...p, videos: clipsOf(p).map((c) => (c.hooks?.length ? { ...c, hooks: followLists(c.hooks, hookPools) } : c)) }));
  }, [listsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Move one edge of a hook by `d` seconds, anywhere in the song (only the segment's part is in the post), never
   *  shorter than 0.3 s. */
  const nudgeHook = (h: VideoHook, edge: "from" | "to", d: number) => {
    const to = h.to ?? segLen;
    if (edge === "from") editHook(h.id, { from: round2(clamp(h.from + d, hookMin, to - 0.3)) });
    else editHook(h.id, { to: round2(clamp(to + d, h.from + 0.3, hookMax)) });
    stop();
    setHead(round2(settings.crop.start + (edge === "from" ? clamp(h.from + d, hookMin, to - 0.3) : Math.max(h.from, clamp(to + d, h.from + 0.3, hookMax) - 0.3))));
  };
  const current = activeCue(cues, head);
  // The lyrics panel: the lyrics' style, or the own look of the caption under the playhead ("this word / phrase").
  const curKey = keyOf(current);
  const curOwn = !!curKey && !!looks[curKey];
  const panelOne = lookScope === "one" && !!curKey;
  const panelStyle = panelOne ? cueStyle(captionStyle, looks[curKey!]) : captionStyle;
  const setPanelStyle = (next: TextStyle) => (panelOne ? setCueLook(curKey!, next) : setV({ captionStyle: next }));
  // A word picked on the timeline (or the timeline let go) brings its line of the lyrics list to the middle of the
  // part of the list on screen (its bottom near the end), once the finger or the mouse is off, never while playing.
  const followList = useRef(false);
  useEffect(() => {
    // (A line picked in the list itself too: it comes to the middle.)
    const down = (e: PointerEvent) => { if ((e.target as HTMLElement).closest?.(".wave, .lyric-track, .hook-track, .dp-track, .lyric-timing .cue-text")) followList.current = true; };
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, []);
  // The line of the list under the timeline (every line of the song) lit and brought to the middle: the last one started
  // at the playhead, still lit in a gap (as Musixmatch or Spotify: where the song is, even between two lines).
  const currentIdx = songCues.reduce((k, c, i) => (c.start - 0.02 <= head ? i : k), -1);
  /** The line `idx` of the lyrics list to the middle of the part of the list on screen (between the header and the
   *  dock / the board's player); only the list scrolls, never the page; its own ends stop it. */
  const centreLine = (idx: number) => {
    const list = [...document.querySelectorAll<HTMLElement>(".lyric-timing")].find((e) => e.offsetParent);
    const row = list?.querySelectorAll<HTMLElement>(".cue-row")[idx];
    if (!list || !row) return;
    const l = list.getBoundingClientRect(), r = row.getBoundingClientRect();
    const top = Math.max(l.top, (document.querySelector(".app > .top") as HTMLElement | null)?.getBoundingClientRect().bottom ?? 0);
    const dock = document.querySelector<HTMLElement>(".mobile-tabs");
    const board = [...document.querySelectorAll<HTMLElement>(".board-player")].find((e) => e.offsetParent);
    let bottom = Math.min(l.bottom, dock?.offsetParent ? dock.getBoundingClientRect().top : window.innerHeight);
    if (board) bottom = Math.min(bottom, board.getBoundingClientRect().top);
    const aim = bottom > top ? (top + bottom) / 2 : l.top + l.height / 2;
    list.scrollBy({ top: r.top + r.height / 2 - aim, behavior: "smooth" });
  };
  // Paused: a line picked (on the timeline, in the list) comes to the middle once the finger is off.
  useEffect(() => {
    if (!followList.current || playing || currentIdx < 0) return;
    let timer = 0;
    const go = () => {
      // Still dragging: later.
      if (scrubRef.current || dragWave.current || dockDrag.current) { timer = window.setTimeout(go, 200); return; }
      followList.current = false;
      centreLine(currentIdx);
    };
    timer = window.setTimeout(go, 250);
    return () => clearTimeout(timer);
  }, [currentIdx, head, playing]); // eslint-disable-line react-hooks/exhaustive-deps
  // Playing: the line being sung always in the middle, gliding from one to the next (like a music app's lyrics).
  useEffect(() => {
    if (!playing || currentIdx < 0) return;
    centreLine(currentIdx);
  }, [currentIdx, playing]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Retime one caption by 0.1 s: "start" moves the whole line, "end" only when it leaves the screen. Never over its neighbours. */
  // Lyrics saved out of order by an older version of the ± buttons: put back in the order of the text, once.
  useEffect(() => {
    const ws = project.lyricWords;
    if (ws?.length && repairOrder(ws) !== ws) onProject((p) => ({ ...p, lyricWords: repairOrder(p.lyricWords ?? []) }));
  }, [project.lyricWords]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- a caption's text written again (a word the model missed), or cut in two at the cursor ----
  const [editCue, setEditCue] = useState<{ i: number; text: string } | null>(null);
  const cueInput = useRef<HTMLInputElement>(null);
  useEffect(() => { setEditCue(null); }, [mode, settings.crop.start, settings.crop.duration]);
  /** The edited text put in the words; with `cutAt` (characters), the caption is also cut there in two. */
  const saveCue = (cutAt?: number) => {
    const ed = editCue;
    const c = ed && songCues[ed.i];
    if (!ed || !c) { setEditCue(null); return; }
    const all = project.lyricWords ?? [];
    const text = ed.text.trim().replace(/\s+/g, " ");
    const same = text === c.words.map((x) => x.w).join(" ");
    let out = all, words = c.words;
    if (text && !same) {
      const before = new Set(all);
      out = rewriteCue(all, c, text);
      words = out.filter((x) => !before.has(x)).sort((a, b) => a.s - b.s);
    }
    if (cutAt !== undefined) {
      const k = ed.text.slice(0, cutAt).trim().split(/\s+/).filter(Boolean).length;
      out = splitCue(out, { ...c, words }, k);
    }
    setEditCue(null);
    if (out !== all) { onProject((p) => ({ ...p, lyricWords: out })); onSaveNow(); }
  };

  // (the list holds every line of the song, the segment's and the others: `songCues`)
  const retime = (i: number, what: "start" | "end", dir: 1 | -1) => {
    const c = songCues[i];
    if (!c || lockedCue(c) || (what === "end" && dir > 0 && songCues[i + 1] && lockedCue(songCues[i + 1]) && c.end + 0.1 > songCues[i + 1].start + 1e-3)
      || (what === "start" && dir < 0 && songCues[i - 1] && lockedCue(songCues[i - 1]) && c.start - 0.1 < songCues[i - 1].end - 1e-3)) return;
    // Word by word: that mode's own timing (the phrases never move from it).
    const out = c && (mode === "word" ? retimeWordCue : retimeCue)(project.lyricWords ?? [], songCues, i, what, dir * 0.1);
    if (!out) return;
    stop();
    // The preview shows the edge that moved (where the playhead may go).
    const [lo, hi] = headRange();
    setHead(round2(clamp(what === "start" ? c.start + dir * 0.1 : Math.max(c.start, c.end + dir * 0.1 - 0.3), lo, hi)));
    onProject((p) => ({ ...p, lyricWords: out }));
  };

  // ---- keyboard: Space play, ←/→ previous/next line, Alt+←/→ offset, I/O segment start/end, F full screen, G zones ----
  const stepTo = (dir: 1 | -1) => {
    const lo = settingsRef.current.crop.start;
    let to = head + dir;
    if (cues.length) {
      const next = dir > 0 ? cues.find((c) => c.start > head + 0.05) : [...cues].reverse().find((c) => c.start < head - 0.3);
      to = next ? next.start : dir > 0 ? end : lo;
    }
    setHead(round2(clamp(to, lo, end)));
  };
  const markIn = () => {
    const cfg = settingsRef.current;
    const crop = fitCrop(head, Math.max(1, cfg.crop.start + cfg.crop.duration - head), boundsOf(cfg));
    setV({ crop });
    setHead(crop.start);
  };
  const markOut = () => {
    const cfg = settingsRef.current;
    setV({ crop: fitCrop(cfg.crop.start, Math.max(1, head - cfg.crop.start), boundsOf(cfg)) });
  };
  /** The preview's right-click menu, where it was opened. */
  const [vctx, setVctx] = useState<{ x: number; y: number; text?: "hook" | "text" } | null>(null);
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e) => {
    if (!active) return; // hidden behind the carousel: its shortcuts are the carousel's
    const el = e.target as HTMLElement;
    if (/INPUT|TEXTAREA|SELECT/.test(el.tagName) || el.isContentEditable || e.metaKey || e.ctrlKey) return;
    if (document.querySelector(".ov")) return;
    const k = e.key;
    // The list of them all: ShortcutsDialog. F and G need the video only (in the full screen, F closes it: FullView).
    if (!e.altKey && k.toLowerCase() === "f") { if (videoBlob && !full) { e.preventDefault(); toggleFull(true); } return; }
    if (!e.altKey && k.toLowerCase() === "g") { if (videoBlob && settings.format !== "16:9") setAids({ zones: !aids.zones }); return; }
    if (!audioBuf) return;
    if (k === " ") { e.preventDefault(); if (playing) pause(); else void play(); }
    else if ((k === "ArrowLeft" || k === "ArrowRight") && e.altKey) {
      e.preventDefault();
      if (!linked) setV({ offset: round2(settingsRef.current.offset + (k === "ArrowLeft" ? -0.1 : 0.1)) });
    } else if (k === "ArrowLeft" || k === "ArrowRight") { e.preventDefault(); stop(); stepTo(k === "ArrowRight" ? 1 : -1); }
    else if (k.toLowerCase() === "i") markIn();
    else if (k.toLowerCase() === "o") markOut();
    // A video clip clicked: C cuts it at the playhead, Shift + E turns the piece under the playhead off or on (as in Premiere).
    else if (pickedVideo() && !playing && k.toLowerCase() === "e" && e.shiftKey) { e.preventDefault(); togglePart(pickedVideo()!, headRef.current); }
    else if (pickedVideo() && !playing && k.toLowerCase() === "c" && (pickedVideo() !== "base" || !settingsRef.current.angles?.some(Boolean))) { e.preventDefault(); cutVideoAt(pickedVideo()!, headRef.current); }
    else if (settingsRef.current.angles?.some(Boolean)) {
      // Multicam: 1 to 4 = a camera (playing: cut to it now; paused: the shot under the playhead shows it),
      // C = cut the shot here, Delete = remove the cut that starts it.
      const cfg = settingsRef.current;
      // By the key's place (Digit1…, the keypad too): on an AZERTY keyboard the top row gives & é " ' without Shift.
      const dig = /^(?:Digit|Numpad)([1-4])$/.exec(e.code);
      const cam = dig ? Number(dig[1]) - 1 : -1;
      if (cam >= 0) {
        if (cam > 0 && !cfg.angles?.[cam - 1]) return;
        e.preventDefault();
        chooseCam(cam);
      } else if (k.toLowerCase() === "c" && !playing) { e.preventDefault(); setV({ cuts: splitAt(cfg.cuts, head) }); }
      else if ((k === "Backspace" || k === "Delete") && !playing && cfg.cuts?.length) { e.preventDefault(); setV({ cuts: removeCutAt(cfg.cuts, head) }); }
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const audioPick = (
    <div className="row">
      <label className="btn sm primary">
        {t("Import the audio")}
        <input type="file" accept="audio/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void pickAudio(f); e.target.value = ""; }} />
      </label>
    </div>
  );

  /** The player (play, the segment's film strip to scrub, the time): one element, on the phone's dock or floating
   *  over the computer's board. */
  const playerEl = (
        <div className="dp">
          <button className="dp-play" aria-label={playing ? t("Pause") : t("Play")} disabled={!playing && !!videoUrl && !playerReady}
            onClick={() => (playing ? pause() : void play())}>
            {videoUrl && !playerReady && !playing ? <span className="spin-dot" aria-hidden />
              : playing
                // Solid: two thick bars, a full triangle (the dock's big button, read at a glance).
                ? <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden><rect x="5.5" y="4" width="4.5" height="16" rx="1.4" fill="currentColor" /><rect x="14" y="4" width="4.5" height="16" rx="1.4" fill="currentColor" /></svg>
                : <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden><path d="M7.5 4.6c0-1 1.1-1.6 2-1.1l10.3 6.4c.8.5.8 1.7 0 2.2L9.5 18.5c-.9.5-2-.1-2-1.1z" fill="currentColor" /></svg>}
          </button>
          {/* The segment: drag along it to move in the video (playing goes on from there once let go). */}
          <div className="dp-track" role="slider" aria-label={t("Position in the segment")} aria-valuemin={0} aria-valuemax={Math.round(segLen)} aria-valuenow={Math.round(head - settings.crop.start)}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              dockDrag.current = { was: playing };
              if (playing) stop();
              const r = e.currentTarget.getBoundingClientRect();
              setHead(round2(settings.crop.start + clamp((e.clientX - r.left) / r.width, 0, 1) * segLen));
            }}
            onPointerMove={(e) => {
              if (!dockDrag.current) return;
              const r = e.currentTarget.getBoundingClientRect();
              setHead(round2(settings.crop.start + clamp((e.clientX - r.left) / r.width, 0, 1) * segLen));
            }}
            onPointerUp={() => { const was = dockDrag.current?.was; dockDrag.current = null; if (was) setTimeout(() => void playRef.current(), 0); }}
            onPointerCancel={() => { dockDrag.current = null; }}>
            {/* A film strip of the segment (pictures of the take along it), or a plain rail without a take. */}
            <span className={"dp-strip" + (videoUrl ? " on" : "")}>
              {videoUrl ? Array.from({ length: 9 }, (_, i) => strip[i] ? <img key={i} src={strip[i]} alt="" draggable={false} /> : <i key={i} className="dp-slot" />) : null}
              <span className="dp-played" style={{ width: `${clamp((head - settings.crop.start) / segLen, 0, 1) * 100}%` }} />
            </span>
            <span className="dp-head" style={{ left: `${clamp((head - settings.crop.start) / segLen, 0, 1) * 100}%` }} />
          </div>
          <span className="dp-time mono">{mmss(head - settings.crop.start)}<span className="muted"> / {mmss(segLen)}</span></span>
        </div>
  );

  return (
    <div className="video-shell" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); onDropFile(Array.from(e.dataTransfer.files)); }}>
        {/* Left: the library. The release's files (audio, lyrics, this video's camera take), then the text lists
            shared with the carousel (hooks, captions). */}
        <aside className={"col side l video-col-l" + (studioLoading ? " is-loading" : "")}>
          <h2 className="lib-title">{t("Library")}</h2>
          <div className="stack media-list">
            {/* The two files of the clip, drawn the same way: empty, a drop zone with its buttons; filled, the name, one line of facts and a menu. */}
            <input id="audio-file" type="file" accept="audio/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void pickAudio(f); e.target.value = ""; }} />
            <input id="audio-replace" type="file" accept="audio/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void replaceAudio(f); e.target.value = ""; }} />
            <input id="video-file" type="file" accept="video/*" multiple hidden onChange={(e) => { const fs = Array.from(e.target.files ?? []); if (fs.length === 1) void pickVideo(fs[0]); else if (fs.length) void pickVideos(fs); e.target.value = ""; }} />
            <input id="video-original" type="file" accept="video/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void pickOriginal(f); e.target.value = ""; }} />
            {/* The release holds the audio (shared by all its videos); this video holds its camera file and its framing. */}
            <div className="tree-head" title={t("The audio and the lyrics belong to the release: every video of it uses them.")}>
              <span className="label">{t("Release")}</span>
            </div>
            {lyricsRow}
            {(() => {
              // The versions of the audio (a demo, the master, a sped up…): this video's one shown, the others to pick.
              const versions = audioVersionsOf(release);
              const cur = versions.find((v) => v.id === audioId);
              const isMain = audioId === mainAudioId(release);
              const used = videosOn(release, audioId);
              return (
            <MediaTile icon="music" label={versions.length > 1 && cur ? audioLabel(cur) : t("Audio")} loading={!!audioBlob && !audioBuf}
              name={audioBlob ? (project.audioName ?? settings.audioName ?? t("Official audio")) : null}
              meta={audioBlob && (<>
                {audioBusy ? <span className="shine">{audioBusy}</span>
                  : audioBuf ? <span className="mono">{fmtLength(audioBuf.duration)}</span> : <span className="shine">{t("Reading the audio…")}</span>}
                {clips.length > 1 && <span>{versions.length > 1 ? t(used === 1 ? "For 1 video" : "For {n} videos", { n: used }) : t("For its {n} videos", { n: clips.length })}</span>}
                {project.audioDriveId ? <span className="pill-drive">Drive</span>
                  : <span className="row" style={{ gap: 4 }}>{t("This computer only")}<Hint text={t("This audio is only on this computer for now: it goes to your Drive by itself as soon as Google Drive can be written to.")} /></span>}
              </>)}
              menu={audioBlob && ((close) => (<>
                <div className="label cap">{t("Versions")}</div>
                <button onClick={() => { close(); document.getElementById("audio-file")?.click(); }}><Icon name="plus" size={14} />{t("Add a version of the audio")}</button>
                <button onClick={() => { close(); setRenamingAudio(audioId); }}><Icon name="pencil" size={14} />{t("Rename this version")}</button>
                <button disabled={!!audioBusy} onClick={() => { close(); document.getElementById("audio-replace")?.click(); }}
                  title={t("Another file for this version (a new master…): the lyrics and the videos follow the music in it.")}><Icon name="upload" size={14} />{t("Replace from this computer")}</button>
                {versions.length > 1 && clips.length > 1 && used < clips.length && (
                  <button disabled={!!audioBusy} onClick={() => { close(); void switchAudio(clips.map((c) => c.id), audioId); }}><Icon name="film" size={14} />{t("Put every video on it")}</button>
                )}
                <div className="sep" />
                {isMain && versions.length > 1 ? (
                  <button disabled title={t("The other versions are kept next to this one: remove them first.")}>{t("Remove audio")}</button>
                ) : (
                  <button className="danger" style={{ color: "var(--danger)" }} onClick={() => { close(); setConfirmRemove(true); }}>{isMain ? t("Remove audio") : t("Remove this version")}</button>
                )}
              </>))}>
              {!audioBlob && audioPick}
              {/* Several versions: the one this video plays on, picked here (the video moves with the music). */}
              {audioBlob && versions.length > 1 && !confirmRemove && (
                <Select className="input sm" aria-label={t("Version of the audio for this video")} value={audioId} disabled={!!audioBusy}
                  onChange={(e) => { if (e.target.value !== audioId) void switchAudio([clip.id], e.target.value); }}>
                  {versions.map((v) => <option key={v.id} value={v.id}>{`${audioLabel(v)} · ${t(videosOn(release, v.id) === 1 ? "1 video" : "{n} videos", { n: videosOn(release, v.id) })}`}</option>)}
                </Select>
              )}
              {audioBlob && confirmRemove && (
                <div className="stack" style={{ gap: 6 }}>
                  <span className="xs">{isMain ? t("Remove it from every video of this release, with the lyrics timing?")
                    : used > 1 || (used === 1 && clips.length > 1) ? t("Remove this version? Its videos go back on the main audio (moved with the music).") : t("Remove this version? This video goes back on the main audio (moved with the music).")}</span>
                  <div className="row">
                    <button className="btn sm danger" onClick={() => { setConfirmRemove(false); void (isMain ? removeAudio() : removeAudioVersion(audioId)); }}>{t("Remove")}</button>
                    <button className="btn sm quiet" onClick={() => setConfirmRemove(false)}>{t("Cancel")}</button>
                  </div>
                </div>
              )}
            </MediaTile>
              );
            })()}
            {/* The release's videos side by side (a phone swipes them; a computer shows only the open one, its picker is
                above the board): the studio's one whole, the others greyed on each side, each with what it holds and
                its own button to open it in the studio (swiping never changes the studio's video). */}
            <div className="tree-branch takes-branch">
            {/* One title, still ("Video"): each card has its video's name, as the audio tile has "Audio". */}
            <div className="tree-head" title={t("Camera 1 is the project's own take; up to 3 more for a multicam edit.")}>
              <span className="label">{t("Project takes")}</span>
            </div>
            {settings.videoName && takesEl("first")}
            {/* Camera 1's card (its file, Drive copy, sync…): unfolded from its line, or always while it has no file. */}
            <div className={"clip-strip" + (settings.videoName && takeOpen !== clip.id ? " folded" : "")}>
            <div className="clip-card cam-0">
            {(() => {
              const d = settings.drive ?? {};
              const src = videoBlob ? settings.source : undefined;
              const note = src && sourceNote(src);
              const missing = !videoBlob && !!settings.videoName;
              return (
                <MediaTile icon="film" name={settings.videoName ?? null}
                  label={settings.videoName ? <button className="take-label cam-0" onClick={() => foldTo(null)} title={t("Fold")}><b>1</b> · {settings.videoName.replace(/\.[^.]+$/, "")} <Icon name="chevron" size={11} /></button> : clipName(clip)} warn={missing} loading={(!!videoBlob && (!videoDur || !playerReady)) || !!driveJob}
                  meta={settings.videoName && (missing
                    ? <span>{d.originalId ? t("On your Drive, not here.") : t("Not in this browser: pick it again.")}</span>
                    : <>
                      {videoDur > 0 ? <span className="mono">{fmtLength(onCopy && src?.duration ? src.duration : videoDur)}</span> : videoBlob && <span className="shine">{t("Opening the camera video…")}</span>}
                      {src && <span className="row" style={{ gap: 4 }}>{src.colour === "log" ? "LOG" : src.colour === "hdr" ? "HDR" : src.colour === "sdr" ? "SDR" : "?"}{note && <Hint text={note} />}</span>}
                      {d.originalId && !onCopy && <span>Drive</span>}
                      {/* The copy of the take: the same words as under the preview. */}
                      {copyStatusEl(true)}
                    </>)}
                  menu={settings.videoName && ((close) => (<>
                    {/* Two ways to the file: another take for this video (Replace), or, on the Drive copy or without the
                        file here, the same camera file found again on this computer (Link: the sync and settings kept). */}
                    <button onClick={() => { close(); document.getElementById("video-file")?.click(); }}>{t("Replace from this computer")}</button>
                    {(!videoBlob || onCopy) && <button onClick={() => { close(); document.getElementById("video-original")?.click(); }}>{t("Link the original file")}</button>}
                    {driveJob && <button onClick={() => { close(); driveAc.current?.abort(); }}>{t("Stop the transfer")}</button>}
                    {copyJob && <button onClick={() => { close(); copyAc.current?.abort(); }}>{t("Stop the Drive copy")}</button>}
                    {videoBlob && <><div className="sep" /><button className="danger" style={{ color: "var(--danger)" }} onClick={() => { close(); void removeVideo(); }}>{t("Remove video")}</button></>}
                  </>))}>
                  {!settings.videoName && (
                    <div className="row"><button className="btn sm" onClick={() => document.getElementById("video-file")?.click()}>{t("From this computer")}</button></div>
                  )}
                  {missing && (
                    <div className="row">
                      {d.originalId && <button className="btn sm primary" disabled={!!driveJob} onClick={() => void fetchOriginal()}>{t("Get it on this device")}</button>}
                      <button className="btn sm" onClick={() => document.getElementById("video-file")?.click()}>{t("Pick it again")}</button>
                    </div>
                  )}
                </MediaTile>
              );
            })()}
            {driveErr && <p className="notice bad xs">{driveErr}</p>}
            {/* On the copy: it holds the passage it was made for (+2 s). Moved past it, the pictures are not on this device. */}
            {onCopy && settings.drive?.copy && (() => {
              const cp = settings.drive.copy, segS = settings.crop.start - settings.offset, segE = segS + settings.crop.duration;
              // Only where the copy is shorter than the take: past the take's own end, the take itself stops (notice below).
              const take = settings.source?.duration ?? Infinity;
              return (segS < cp.from - 0.05 && cp.from > 0.05) || (segE > cp.to + 0.05 && cp.to < take - 0.05)
                ? <p className="notice warn xs">{t("The Drive copy holds {from} to {to} of the take: past it, there are no pictures on this device. Make the passage longer on the device that has the camera file (its copy follows), or pick the camera file here.", { from: fmtTime(cp.from), to: fmtTime(cp.to) })}</p>
                : null;
            })()}
            {/* Really past the take's end: more than 0.1 s (a few frames; the length read at import and the player's can
                differ by a few hundredths, and a segment stuck to the video's end is not past it). On the copy, the take's own. */}
            {settings.videoName && videoDur > 0 && settings.crop.start + settings.crop.duration > settings.offset + (onCopy && settings.source?.duration ? settings.source.duration : Math.max(videoDur, settings.source?.duration ?? 0)) + 0.1 && (
              <p className="notice warn xs">{t("Video stops before the segment ends: extend it or change the offset.")}</p>
            )}
            </div>
            </div>
            {takesEl("rest")}
            </div>
          </div>
          <div className="lib-desk">{library}</div>
          <div className="lib-phone">{libraryPhone}</div>
        </aside>
        {/* Middle: the board, like the carousel's: the clip controls, the preview and the timeline. */}
        <main className="col center video-center" ref={centerRef}>
      <div className="video-head studio-head">
        <div className="row nowrap video-title">{releaseTitle}</div>
        <div className="row nowrap video-tools">
          <label className="field h-pick" style={{ margin: 0 }}>{t("Project")}
            <Select className="input" style={{ width: 150 }} value={clip.id}
              onChange={(e) => { onProject((p) => ({ ...p, videoId: e.target.value })); onSaveNow(); }}>
              {clipGroups(projects).map((g) => g.label
                ? <optgroup key={g.label} label={g.label}>{g.items.map((c) => <option key={c.id} value={c.id}>{clipName(c)}</option>)}</optgroup>
                : g.items.map((c) => <option key={c.id} value={c.id}>{clipName(c)}</option>))}
            </Select>
          </label>
          <button className="btn icon h-new" aria-label={t("New video")} title={t("New video from scratch: the same song and lyrics, no video nor hook yet")} onClick={() => void addVideo()}><Icon name="plus" /></button>
          <div className="slot h-new"><Menu trigger={(_, toggle) => <button className="btn icon quiet" aria-label={t("Video menu")} onClick={toggle}><Icon name="more" /></button>}>
            {(closeMenu) => (<>
              <button onClick={() => { closeMenu(); setClipDialog("rename"); }}>{t("Rename")}</button>
              <button onClick={() => { closeMenu(); duplicateClip(); }} title={t("Same camera file, sync and versions: to change anything on a copy")}>{t("Duplicate")}</button>
              <div className="sep" />
              <button className="danger" style={{ color: "var(--danger)" }} disabled={projects.length < 2}
                onClick={() => { closeMenu(); setClipDialog("delete"); }}>{t("Delete this video")}</button>
            </>)}
          </Menu></div>
          {/* Same history as the carousel (Cmd+Z / Cmd+Shift+Z): every change of the release can be undone. */}
          <button className="btn icon quiet hist" aria-label={t("Undo")} title={`${t("Undo")} (⌘Z)`} onClick={onUndo} disabled={!canUndo}><Icon name="undo" /></button>
          <button className="btn icon quiet hist" aria-label={t("Redo")} title={`${t("Redo")} (⇧⌘Z)`} onClick={onRedo} disabled={!canRedo}><Icon name="redo" /></button>
          <div className="row nowrap head-actions">
          {/* Phone: in place of "More", the video picker (as the versions are picked: show one, rename, delete, add). */}
          <div className="slot h-more clip-pick"><Menu float left trigger={(open, toggle) => (
            <button className={"btn ver-pick clip-pick-btn" + (open ? " on" : "")} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
              <span className="clip-name">{clipName(clip)}</span><Icon name="chevron" size={12} />
            </button>
          )}>
            {(close) => (<div className="ver-list">
              {clipGroups(projects).map((g) => [g.label && <div key={"g" + g.label} className="dd-group">{g.label}</div>, ...g.items.map((c) => {
                const on = c.id === clip.id;
                const show = () => { if (!on) { onProject((p) => ({ ...p, videoId: c.id })); onSaveNow(); } };
                return (
                  <div key={c.id} className={"ver-line" + (on ? " on" : "")}>
                    <button className="ver-main" role="menuitemradio" aria-checked={on} onClick={() => { close(); show(); }}>
                      <Icon name="check" size={12} />{clipName(c)}
                    </button>
                    <button className="btn icon sm quiet" aria-label={t("Rename")} title={t("Rename")} onClick={() => { close(); show(); setClipDialog("rename"); }}><Icon name="pencil" size={12} /></button>
                    {projects.length > 1 && <button className="btn icon sm quiet ver-del" aria-label={t("Delete")} title={t("Delete")} onClick={() => { close(); show(); setClipDialog("delete"); }}><Icon name="trash" size={12} /></button>}
                  </div>
                );
              })])}
              <div className="sep" />
              <button className="ver-new" title={t("New video from scratch: the same song and lyrics, no video nor hook yet")} onClick={() => { close(); void addVideo(); }}>
                <Icon name="plus" size={12} />{t("New video")}
              </button>
              <button className="ver-new" title={t("Same camera file, sync and versions: to change anything on a copy")} onClick={() => { close(); duplicateClip(); }}>
                <Icon name="copy" size={12} />{t("Duplicate this video")}
              </button>
            </div>)}
          </Menu></div>

          {/* Where the release stands (sync, lyrics…), titled like the carousel's Slides, right after the video picker. */}
          <div className="field h-status"><span className="field-k">{t("Sync status")}</span>
            {statusBadge}
          </div>
          {(clips.length > 1 || versions.length > 1) && !exporting && !batch ? (
            <div className="slot h-dl"><Menu trigger={(_, toggle) => (
              <button className="btn primary" aria-label={t("Export")} onClick={toggle} disabled={!audioBuf}><Icon name="download" /><span className="lbl">{t("Export")}</span><Icon name="chevron" size={14} /></button>
            )}>
              {(closeMenu) => (<>
                <button disabled={!videoBlob} onClick={() => { closeMenu(); void exportVideo(); }}>{t("This video (MP4)")}</button>
                {versions.length > 1 && <button disabled={!videoBlob} onClick={() => { closeMenu(); void exportVersions(); }}>{t("Every version of this video ({n})", { n: versions.length })}</button>}
                {clips.length > 1 && <button onClick={() => { closeMenu(); exportAll(); }}>{t("All the videos ({n})", { n: clips.length })}</button>}
              </>)}
            </Menu></div>
          ) : (
          <button className={"btn primary h-dl" + (exporting ? " shine-box" : "")} aria-label={t("Export video (MP4)")} onClick={() => void exportVideo()} disabled={!audioBuf || !videoBlob || exporting}
            title={!audioBuf ? t("Import the release audio") : !videoBlob ? t("Import the video recorded with the camera") : t("Ready to export")}>
            <Icon name="download" /><span className="lbl">{exporting ? t("Exporting…") : t("Export video (MP4)")}</span>
          </button>
          )}
          </div>
        </div>
      </div>
      <div className={"video-grid" + (settings.format === "16:9" ? " wide" : "") + (videoBlob ? "" : " no-take")}>
        <div className="stack video-stage">
          <div className={"cv-wrap" + (settings.format === "16:9" ? " landscape" : "") + (videoUrl && !playerReady ? " shine-box" : "") + (controlsOn ? " controls-on" : "")} style={{ position: "relative" }}>
              <video ref={videoRef} src={videoUrl ?? undefined} className="video-src" muted playsInline preload="auto"
                onError={() => setPlayerReady(true)}
                onCanPlay={() => setPlayerReady(true)}
                onLoadedMetadata={(e) => {
                  setVideoDur(e.currentTarget.duration);
                  // Safari may load nothing more before a click: the file is open, a click on Play will start it.
                  window.setTimeout(() => setPlayerReady(true), 4000);
                  console.debug(`[load] video opened (duration known) after ${Math.round(performance.now() - loadT0.current)} ms`);
                }}
                onSeeked={(e) => { if (!playing) drawWhenShown(e.currentTarget); }}
                onLoadedData={(e) => {
                  console.debug(`[load] first picture decoded after ${Math.round(performance.now() - loadT0.current)} ms`);
              setPlayerReady(true);
                  if (!playing) drawWhenShown(e.currentTarget);
                }} />
            <canvas ref={canvasRef} className="cv" width={outW} height={outH}
              title={t("On the preview: drag the video to reframe it, scroll to zoom, double-click to reset. Drag the lyrics to move them, scroll on them to resize.")}
              onPointerDown={cvDown} onPointerMove={cvMove} onPointerUp={cvUp} onPointerCancel={cvUp} onDoubleClick={cvDouble}
              onContextMenu={(e) => {
                e.preventDefault();
                if (matchMedia("(hover: none)").matches) return;
                // On the lyrics or the hook: that text's quick settings; elsewhere, the preview's menu.
                const c = toCv(e);
                setVctx({ x: e.clientX, y: e.clientY, text: textAt(c.x, c.y) ?? undefined });
              }} />
            {vctx?.text && (() => {
              const which = vctx.text === "hook" ? "hook" : "caption";
              // The lyrics: the caption shown alone when it has its own look (or "this word" is chosen), else all.
              const here = which === "caption" ? cueHere() : null;
              const one = !!here?.one;
              const st = which === "hook" ? hookStyle : one ? cueStyleRef.current(here!.cue) : captionStyle;
              const own = !!here && !!looks[here.key];
              return (
                <ContextMenu x={vctx.x} y={vctx.y} onClose={() => { setVctx(null); setFontPreview(null); }}>
                  <TextQuickMenu style={st} fonts={fonts} onFonts={onFonts}
                    onPreview={(patch) => setFontPreview(patch ? (one ? { which: "cue", key: here!.key, patch } : { which, patch }) : null)}
                    onChange={(patch) => {
                      if (which === "hook") setV({ hookStyle: { ...hookStyle, ...patch } });
                      else if (one) setCueLook(here!.key, { ...st, ...patch });
                      else setV({ captionStyle: { ...captionStyle, ...patch } });
                    }}>
                    {here && (own
                      ? <button onClick={() => { relinkCue(here.key); setVctx(null); }}><Icon name="refresh" size={14} />{t("Link to the lyrics style")}</button>
                      : <button onClick={() => { setCueLook(here.key, cueStyleRef.current(here.cue)); setVctx(null); }}><Icon name="type" size={14} />{mode === "word" ? t("Own style for this word") : t("Own style for this phrase")}</button>)}
                  </TextQuickMenu>
                </ContextMenu>
              );
            })()}
            {clipMenu && (() => {
              const x = partsOf(clipMenu.which);
              if (!x) return null;
              const ft = clipMenu.t - x.offset, pc = pieceAt(x.p, ft, x.ci, x.co), off = pc ? isOff(x.p, (pc[0] + pc[1]) / 2) : false;
              const near = ((viewRef.current ?? twRef.current).d / 100) * 1.5; // (a cut within a few pixels)
              const hasCut = (x.p.splits ?? []).some((c) => Math.abs(c - ft) <= near);
              const inClip = headRef.current - x.offset > x.ci && headRef.current - x.offset < x.co;
              const close = () => setClipMenu(null);
              return (
                <ContextMenu x={clipMenu.x} y={clipMenu.y} onClose={close}>
                  <div className="label cap">{t("Video")}</div>
                  <button disabled={!inClip} onClick={() => { cutVideoAt(clipMenu.which, headRef.current); close(); }}><Icon name="scissors" size={14} />{t("Cut at the playhead")}<kbd>C</kbd></button>
                  {pc && <button onClick={() => { togglePart(clipMenu.which, clipMenu.t); close(); }}><Icon name={off ? "eye" : "eye-off"} size={14} />{off ? t("Turn this part back on") : t("Turn this part off")}<kbd>⇧E</kbd></button>}
                  {hasCut && <button onClick={() => { x.set(joinAt(x.p, ft, near, x.ci, x.co)); close(); }}><Icon name="minus" size={14} />{t("Remove this cut")}</button>}
                  {(x.p.splits?.length || x.p.offParts?.length) ? <button onClick={() => { x.set(wholeAgain(x.p)); close(); requestAnimationFrame(() => drawAt(headRef.current)); }}><Icon name="refresh" size={14} />{t("Remove every cut")}</button> : null}
                </ContextMenu>
              );
            })()}
            {/* The preview's own right-click menu: play, the segment at the playhead, full screen, zones, export. */}
            {vctx && !vctx.text && (
              <ContextMenu x={vctx.x} y={vctx.y} onClose={() => setVctx(null)}>
                <div className="label cap truncate">{clipName(clip)}</div>
                <div className="label cap">{t("Playback")}</div>
                <button disabled={!audioBuf || (!!videoUrl && !playerReady && !playing)} onClick={() => (playing ? pause() : void play())}>
                  <Icon name={playing ? "pause" : "play"} size={14} />{playing ? t("Pause") : t("Play")}<kbd>{t("Space")}</kbd></button>
                <button disabled={!audioBuf} onClick={markIn}><Icon name="arrowLeft" size={14} />{t("Start of the segment here")}<kbd>I</kbd></button>
                <button disabled={!audioBuf} onClick={markOut}><Icon name="arrowRight" size={14} />{t("End of the segment here")}<kbd>O</kbd></button>
                <div className="label cap">{t("View")}</div>
                <button disabled={!videoBlob} onClick={() => toggleFull(true)}><Icon name="expand" size={14} />{t("Full screen")}<kbd>F</kbd></button>
                {settings.format !== "16:9" && <button disabled={!videoBlob} onClick={() => setAids({ zones: !aids.zones })}><Icon name={aids.zones ? "zones-off" : "zones"} size={14} />{t("TikTok zones")}<kbd>G</kbd></button>}
                <div className="label cap">{t("Video")}</div>
                {videoBlob && <button disabled={syncBusy} onClick={() => void autoSync()}><Icon name="film" size={14} />{settings.score === undefined ? t("Sync the video") : t("Resync the video")}</button>}
                <button disabled={!audioBuf || !videoBlob || exporting} onClick={() => void exportVideo()}><Icon name="download" size={14} />{t("Export video (MP4)")}</button>
              </ContextMenu>
            )}
            {/* Phone: the preview full screen, and back. */}
            {/* Over the picture: TikTok's zones (bottom left) and the full screen (bottom right); on a computer they show on hover. */}
            {videoBlob && !full && settings.format !== "16:9" && (
              <button className={"pv-zones" + (aids.zones ? " on" : "")} aria-pressed={aids.zones} aria-label={t("Zones")} title={t("TikTok's interface zones on the video")}
                {...shownPress(() => { setAids({ zones: !aids.zones }); revealControls(); })}><Icon name={aids.zones ? "zones" : "zones-off"} size={18} /></button>
            )}
            {videoBlob && !full && <button className="pv-expand" aria-label={t("Full screen")} title={t("Full screen")} {...shownPress(() => toggleFull(true))}><Icon name="expand" size={18} /></button>}
            {/* The full screen (the same as the carousel's): the preview's picture as it is drawn, over the app. */}
            {full && <FullView source={() => canvasRef.current} onClose={() => toggleFull(false)} onLeave={() => setFullLeaving(true)} onTap={fullTap} player label={clipName(clip)}
              bar={<><span className="mono xs truncate">{clipName(clip)}</span><span className="muted xs grow preview-hint">{t("F or Esc to close")}</span></>} />}
          </div>
          {/* Phone: the TikTok zones on / off, the carousel's own button, at the same place (under the picture, right). */}
          {videoBlob && (
            <div className="deck-bar video-bar">
              {/* Phone, Style page: before / after the grade in one tap. */}
              {gradesColour(grade) ? <Switch off={t("Before")} on={t("After")} checked={!rawView} onChange={(v) => setRawView(!v)} title={t("Before: the picture as recorded, to compare")} /> : <span className="bar-noswitch" />}
              {/* Phone, Create page: the picture's size on the left (its line above the take's goes), so the row is
                  full; what the video shows (lyrics, hook) on the right, under the thumb. */}
              <span className="bar-format"><span className="bar-k">{t("Format")}</span><span className="bar-v mono">{outW}×{outH}<Hint text={t("Drag the picture to reframe it, the lyrics to move them. Double-click resets.")} /></span></span>
              <span className="bar-show">{shownToggles("bar-chip")}</span>
            </div>
          )}
          {/* What the video shows (not what is edited: that is the tabs beside): lyrics and hook, on or off. */}
          <div className="row shown-on">
            <span className="label">{t("Shown")}</span>
            {shownToggles("btn sm")}
          </div>
          {/* What the picture is: its size, then the take it comes from (the original, or the Drive copy and where
              it stands: the library says the same), each under its title. */}
          <div className="stage-meta">
            <div className="meta-row meta-format"><span className="meta-k">{t("Format")}</span>
              <span className="meta-v">{!videoBlob && <span>{t("Nothing to preview yet.")} </span>}<span className="mono">{outW}×{outH}</span>
                {videoBlob && <Hint text={t("Drag the picture to reframe it, the lyrics to move them. Double-click resets.")} />}</span>
            </div>
            {copyState && <div className="meta-row"><span className="meta-k">{t("Video")}</span><span className="meta-v">{copyStatusEl()}</span></div>}
          </div>
          {lookErr && grade?.lut && (
            <p className="notice warn xs">
              {t("The LUT “{name}” is not in this browser: the picture is shown without it.", { name: grade.lut.name })}{" "}
              <button className="btn sm quiet" onClick={() => document.getElementById("video-color")?.scrollIntoView({ behavior: "smooth", block: "start" })}>{t("Import it again")}</button>
            </p>
          )}
          {(() => {
            // One line for the work done in the background on the video, one step after the other.
            const job = driveJob
              ? { p: driveJob.p, text: t("Getting the camera file from your Drive") }
              : null;
            if (job) return (
              <div className="job" title={t("Keep this tab open until it is done. The export always uses the original file.")}>
                <div className="row"><span className="xs shine">{job.text}</span><span className="xs mono muted">{Math.round(job.p * 100)} %</span></div>
                <div className="job-bar"><i className="shine-bar" style={{ width: `${Math.max(2, job.p * 100)}%` }} /></div>
              </div>
            );
            return videoBlob && !videoDur ? <p className="muted xs shine">{t("Opening the camera video…")}</p> : null;
          })()}

        </div>

        <div className={"video-side" + (studioLoading ? " is-loading" : "")}>
          <div className="timeline" ref={timelineRef} {...timelineTouch} onPointerDownCapture={(e) => { wheelDrag(e); if (!e.isPropagationStopped()) timelineTouch.onPointerDownCapture(e); }}
            onMouseDownCapture={(e) => { if (e.button === 1) e.preventDefault(); /* no autoscroll */ }}>
            {!audioBuf ? (
              audioBlob ? (
                <div className="studio-loading" aria-busy="true">
                  <span className="muted xs shine">{t("Reading the audio…")}</span>
                  <div className="skel-wave shine-box" />
                </div>
              ) : (
                <div className="timeline-empty">
                  {/* One place to import it: the official audio's tile, in the library. */}
                  <p>{t("The timeline shows once the official audio is in the library.")}</p>
                </div>
              )
            ) : (
              <>
                {/* Phone: the block is the segment's (play and time are on the dock): its title, and where the sync stands. */}
                <div className="row seg-top">
                  <span className="label">{t("Segment")}</span>
                  <span className="grow" />
                  {statusBadge}
                </div>
                <div className="row transport">
                  <button className="btn icon tr-play" aria-label={playing ? t("Pause") : t("Play")} title={(playing ? t("Pause") : t("Play")) + " (Espace)"}
                    disabled={!playing && !!videoUrl && !playerReady}
                    onClick={() => (playing ? pause() : void play())}>
                    {videoUrl && !playerReady && !playing ? <span className="spin-dot" aria-hidden /> : <Icon name={playing ? "pause" : "play"} />}
                  </button>
                  <span className="mono xs tr-time">{fmtTime(head)} <span className="muted">/ {fmtTime(end)}</span></span>
                  <span className="sep tr-time" />
                  <span className="mono xs tr-range">{mmss(settings.crop.start)} → {mmss(end)}</span>
                  {/* Length of the segment: the usual ones, or the one set on the waveform. */}
                  <Select className="input sm seg-len" aria-label={t("Length of the segment")} title={t("Length of the segment")}
                    value={PRESETS.find((d) => Math.abs(settings.crop.duration - d) < 0.01) ?? "custom"}
                    onChange={(e) => { if (e.target.value !== "custom") setCropDuration(Number(e.target.value)); }}>
                    {PRESETS.map((d) => <option key={d} value={d}>{d} s</option>)}
                    {!PRESETS.some((d) => Math.abs(settings.crop.duration - d) < 0.01) && (
                      <option value="custom">{settings.crop.duration.toFixed(1).replace(".", lang === "fr" ? "," : ".")} s</option>
                    )}
                  </Select>
                  {!phone && lockEl()}{!phone && loopEl()}
                  <span className="grow" />
                  <span className="tr-sync">
                  {!syncBusy && !genBusy && firstSync ? (
                    <button className="btn sm primary" onClick={() => void syncAll()}>
                      <Icon name="refresh" size={14} />{t("Sync lyrics and video")}
                    </button>
                  ) : !syncBusy && !genBusy ? (
                    // One button: the video and the lyrics are synced apart (changing the video never moves the lyrics).
                    <Menu trigger={(_, toggle) => (
                      <button className={"btn sm" + ((videoBlob && settings.score === undefined) || (hasLyrics && !placed) ? " primary" : "")} onClick={toggle}
                        aria-haspopup="menu">
                        <Icon name="refresh" size={14} /><span className="tr-sync-lbl">{
                          // Everything there is synced already: doing it again.
                          !((videoBlob && settings.score === undefined) || (hasLyrics && !placed)) && (settings.score !== undefined || placed) ? t("Resync") : t("Sync")}</span> <Icon name="chevron" size={12} />
                      </button>
                    )}>
                      {(closeMenu) => (<>
                        {videoBlob && (
                          <button onClick={() => { closeMenu(); void autoSync(); }} title={t("Find where the camera video sits in the official audio. The lyrics do not move.")}>
                            <Icon name="film" size={14} />{settings.score === undefined ? t("Sync the video") : t("Resync the video")}{settings.score === undefined && <span className="tab-dot" />}
                          </button>
                        )}
                        <button disabled={!hasLyrics} onClick={() => { closeMenu(); if (hasManual(project.lyricWords) || lockedLines(project.lyricWords).size) setAskReplace(true); else void syncLyrics(); }}
                          title={!hasLyrics ? t("Import the video or paste the lyrics first.") : placed ? t("Listen to the whole song again and place the lyrics from scratch (the lines retimed by hand too).") : undefined}>
                          {/* One action, always from scratch (it was two, the second shown only once the first was done). */}
                          <Icon name="type" size={14} />{placed ? t("Re-place every line") : t("Sync the lyrics")}{hasLyrics && !placed && <span className="tab-dot" />}
                        </button>
                        {placed && (
                          <button onClick={() => { closeMenu(); void refitWords(); }} title={t("Each line stays where it is; its words are placed again on the voice inside it.")}>
                            <Icon name="sparkle" size={14} />{t("Fit the words in their lines")}
                          </button>
                        )}
                      </>)}
                    </Menu>
                  ) : (
                    <>
                      <span className="badge"><span className="shine">
                        {syncBusy ? t("Syncing the video… {n}%", { n: Math.round(syncPct * 100) })
                          : genStep === "model" && genPct > 0 && genPct < 1 ? t("Downloading the speech model… {n}%", { n: Math.round(genPct * 100) })
                          : genStep === "listen" || genDone > 0 ? t("Placing the lyrics… {n}%", { n: Math.round(genDone * 100) })
                          : t("Loading the speech engine…")}
                      </span></span>
                      {genBusy && <button className="btn sm quiet" onClick={cancelLyrics}>{t("Cancel")}</button>}
                    </>
                  )}
                  </span>
                  {!phone && zoomEl("tr-zoom")}
                </div>
                {/* Phone: the lock and the zoom above the tracks they act on (on a computer: in the segment's row). */}
                {phone && (
                  <div className="row seg-tools">
                    {lockEl()}{loopEl()}
                    <span className="grow" />
                    {zoomEl()}
                  </div>
                )}
                {/* One frame for every line of the timeline (waveform, hook, lyrics, videos), each with its kind's icon on
                    the left, and one playhead across them all (desktop; the phone keeps one per line). */}
                <div className="tl-stack" ref={stackRef}>
                <div className="tl-row"><div className="tl-hd" onPointerDown={(e) => e.stopPropagation()}>{muteEl}</div><div className="wave-wrap">
                  <canvas ref={waveRef} className="wave"
                    onPointerDown={waveDown} onPointerMove={waveMove} onPointerUp={waveUp}
                    onPointerCancel={(e) => { pointers.current.delete(e.pointerId); dragWave.current = null; }} />
                </div></div>
                {hooks.length > 0 && (<>
                  <div className="tl-row"><div className="tl-hd" onPointerDown={(e) => e.stopPropagation()}>{textEye(settings.showHooks !== false, () => setV({ showHooks: settings.showHooks === false }), "hooks")}</div><div className={"lyric-track hook-track" + (settings.showHooks === false ? " off" : "")} role="group" aria-label={t("Hooks")} {...scrub(() => setTab("hook"))}>
                    <div className="track-content">
                    <span className="track-seg" style={{ ...place(settings.crop.start), width: wFull(settings.crop.start, end) }} />
                    {hooks.map((h, i) => onTrack(settings.crop.start + h.from, settings.crop.start + (h.to ?? segLen)) && (
                      <button key={h.id} className={"cue" + (hookAt(settings, head)?.id === h.id ? " on" : "") + (pick === "hook:" + h.id ? " sel" : "")} data-pick={"hook:" + h.id}
                        data-text={h.text.replace(/\n/g, " ") || t("Hook {n}", { n: i + 1 })}
                        style={{
                          ...place(settings.crop.start + h.from), width: wFull(settings.crop.start + h.from, settings.crop.start + (h.to ?? segLen)),
                          ...(hookAt(settings, head)?.id === h.id ? { ["--hx" as string]: hxIn(settings.crop.start + h.from, settings.crop.start + (h.to ?? segLen)) } : null),
                        }}
                        data-a={settings.crop.start + h.from} data-b={settings.crop.start + (h.to ?? segLen)}
                        title={h.text || t("Hook {n}", { n: i + 1 })} data-at={settings.crop.start + h.from}
                        onClick={(e) => { if (e.detail === 0) { stop(); setTab("hook"); setHead(round2(settings.crop.start + h.from)); } }}>
                        <span className="cue-ico" aria-hidden><Icon name="sparkle" size={11} /></span>{h.text.replace(/\n/g, " ") || t("Hook {n}", { n: i + 1 })}
                        {grips(moveHook(h.id), moveHookEnd(h.id))}
                      </button>
                    ))}
                    {(() => { const h = hookAt(settings, head); const a0 = h ? settings.crop.start + h.from : 0, b0 = h ? settings.crop.start + (h.to ?? segLen) : 0; const at = h ? barAt(a0, b0) : null; return at !== null ? <span className="cue-bar-glow" data-a={a0} data-b={b0} style={place(at)} /> : null; })()}
                    <span className="lyric-head" style={{ ...place(clamp(head, tw.s, tw.s + tw.d)) }} />
                    </div>
                  </div></div>
                </>)}
                <div className="tl-row"><div className="tl-hd" onPointerDown={(e) => e.stopPropagation()}>{textEye(!!settings.captions, () => setV({ captions: !settings.captions }), "lyrics")}
                  {(project.lyricWords?.length ?? 0) > 0 && mode !== "word" && (() => {
                    const ws = project.lyricWords!, n = ws.filter((x) => x.lock).length, all = n === ws.length;
                    return (
                        <button className={"btn icon sm quiet track-lock" + (all ? " on" : n ? " some" : "")} aria-pressed={all}
                          aria-label={all ? t("Unlock every line") : t("Lock every line")}
                          title={all ? t("Every line is locked: kept as it is when the lyrics are placed again. Click to unlock them all.") : n ? t("Some lines are locked. Click to lock them all.") : t("Lock every line: kept as they are when the lyrics are placed again")}
                          onClick={() => toggleAllLocks(!all)}>
                          <Icon name={all ? "lock" : "unlock"} size={14} />
                        </button>
                    );
                  })()}</div><div ref={trackRef} className={"lyric-track lyrics-track" + (settings.captions ? "" : " off")} role="group" aria-label={t("Lyrics of the segment")} {...scrub(() => setTab("lyrics"))}>
                  {/* At the track's end: every line locked or unlocked at once (all: closed; some: open with a dot). */}
                  {(project.lyricWords?.length ?? 0) > 0 && mode !== "word" && (() => {
                    const ws = project.lyricWords!, n = ws.filter((x) => x.lock).length, all = n === ws.length;
                    return (
                      <div className="track-tools" onPointerDown={(e) => e.stopPropagation()}>
                        <button className={"btn icon sm quiet track-lock" + (all ? " on" : n ? " some" : "")} aria-pressed={all}
                          aria-label={all ? t("Unlock every line") : t("Lock every line")}
                          title={all ? t("Every line is locked: kept as it is when the lyrics are placed again. Click to unlock them all.") : n ? t("Some lines are locked. Click to lock them all.") : t("Lock every line: kept as they are when the lyrics are placed again")}
                          onClick={() => toggleAllLocks(!all)}>
                          <Icon name={all ? "lock" : "unlock"} size={14} />
                        </button>
                      </div>
                    );
                  })()}
                  <div className="track-content">
                  <span className="track-seg" style={{ ...place(settings.crop.start), width: wFull(settings.crop.start, end) }} />
                  {/* The song's lines outside the segment: dimmed, not edited here (move the segment onto them to work on them). */}
                  {songCues.map((c, i) => (c.end <= settings.crop.start || c.start >= end) && onTrack(c.start, c.end) && (
                    <span key={"o" + i} className={"cue song-line" + (loopSeg ? " outside" : head >= c.start && head < c.end ? " on" : "") + (pick === "text:" + (keyOf(c) ?? "o" + i) ? " sel" : "")} data-text={c.text.replace(/\n/g, " ")} data-a={c.start} data-b={c.end} data-mv={lockedCue(c) ? undefined : "song:" + i} data-at={c.start} data-pick={"text:" + (keyOf(c) ?? "o" + i)} title={`${fmtTime(c.start)} · ${c.text.replace(/\n/g, " ")} · ${t("outside the segment: not in the post")}`}
                      style={{ ...place(c.start), width: wFull(c.start, c.end) }}>{cueIcon(c)}{c.text.replace(/\n/g, " ")}{mode !== "word" && !lockedCue(c) && grips(moveSongLine(i), moveSongLineEnd(i))}</span>
                  ))}
                  {/* Only the clips with a part in view (one wholly past the left edge was drawn there, 3 px wide, and they piled up). */}
                  {cues.map((c, i) => onTrack(c.start, c.end) && (
                    <button key={i} className={"cue" + (c === current ? " on" : "") + (pick === "text:" + (keyOf(c) ?? i) ? " sel" : "") + (looks[keyOf(c) ?? ""] ? " own-look" : "")} data-pick={"text:" + (keyOf(c) ?? i)} data-mv={lockedCue(c) ? undefined : "seg:" + i} title={`${fmtTime(c.start)} · ${c.text.replace(/\n/g, " ")}${looks[keyOf(c) ?? ""] ? ` · ${t("own style")}` : ""}`}
                      data-text={c.text.replace(/\n/g, " ")}
                      // (a line across the segment's edge drawn whole, one clip: its end handle where it really ends)
                      style={{
                        ...place(c.start),
                        width: wFull(c.start, c.end),
                        ...(c === current ? { ["--hx" as string]: hxIn(clamp(c.start, settings.crop.start, end), clamp(c.end, settings.crop.start, end)) } : null),
                      }}
                      data-a={c.start} data-b={c.end}
                      data-at={Math.max(settings.crop.start, c.start)}
                      onClick={(e) => { if (e.detail === 0) { stop(); setTab("lyrics"); setHead(round2(Math.max(settings.crop.start, c.start))); } }}>
                      {cueIcon(c)}{c.text.replace(/\n/g, " ")}
                      {mode !== "word" && !lockedCue(c) && grips(moveLine(i), moveLineEnd(i))}
                    </button>
                  ))}
                  {!songCues.length && <span className={"muted xs lyric-track-empty" + (genBusy ? " shine" : "")}>{genBusy ? t("Placing the lyrics…") : t("No lyrics on this segment yet: paste them in Lyrics, then Sync.")}</span>}
                  {/* Loop off: the whole song plays as the segment does, its lines outside lit under the playhead too (loop on: dimmed). */}
                  {!loopSeg && (() => { const o = songCues.find((c) => (c.end <= settings.crop.start || c.start >= end) && head >= c.start && head < c.end); const at = o ? barAt(o.start, o.end) : null; return o && at !== null ? <span className="cue-bar-glow" data-a={o.start} data-b={o.end} style={place(at)} /> : null; })()}
                  {current && barAt(Math.max(current.start, settings.crop.start), Math.min(current.end, end)) !== null && <span className="cue-bar-glow" data-a={Math.max(current.start, settings.crop.start)} data-b={Math.min(current.end, end)} style={place(barAt(Math.max(current.start, settings.crop.start), Math.min(current.end, end))!)} />}
                  <span className="lyric-head" style={{ ...place(clamp(head, tw.s, tw.s + tw.d)) }} />
                  </div>
                </div></div>
                {/* The video part of the timeline: every video track in one block (the one over it on top). */}
                {audioBuf && videoBlob && (
                  <div className={"video-block" + (dragTake || vdrag ? " dragging" : "") + (dropRow ? " drop-" + dropRow : "") + (vdrag?.act ? " va-" + vdrag.act : "")} {...blockDrop}>
                    {/* Dragging a take from the library: the row above the base line to drop it over the video. */}
                    {dragTake && videosIn(settings) < MAX_CAMS && <div className="lyric-track drop-over-row">{t("Drop here: over the video")}</div>}
                    {/* The videos over it, the top one first (2, 3, 4 from the base up), then the base line (1, or the multicam). */}
                    {[...overlaysOf(settings)].reverse().map((o) => <Fragment key={o.clip}>{overlayTrackEl(o)}</Fragment>)}{camsEl("track")}
                    {vdrag?.act === "multicam" && <div className="vz-cut" style={{ left: vdrag.cutX }} title={t("Cut here")} />}
                    {dragTake && <div className="drop-main-hint">{t("Drop on the base line: multicam")}</div>}
                    {dragTake && dropRow === "over" && dropAt && (
                      <div className="drop-ghost" style={{ left: dropAt.x, width: Math.max(8, dropAt.w) }}>
                        <span className="truncate">{clips.find((x) => x.id === dragTake)?.videoName?.replace(/\.[^.]+$/, "")}</span>
                      </div>
                    )}
                  </div>
                )}
                <span className="tl-head" ref={tlHeadRef} aria-hidden />
                </div>
                {camsEl("controls")}
                {/* Versions of this video to compare (A/B): one selector (each line: show it, rename, delete), a new one
                    beside it. Each keeps its segment, hooks and lyrics. */}
                <div className="row seg-versions" role="group" aria-label={t("Versions")}>
                  {/* The version shown, and its list: show one, rename (pencil), delete (bin), and a new one at the end.
                      With no versions yet, the video is "Version A". */}
                  {(() => {
                    const lines: { v: VideoVersion | null; i: number }[] = versions.length ? versions.map((v, i) => ({ v, i })) : [{ v: null, i: 0 }];
                    const at = Math.max(0, versions.findIndex((v) => v.id === settings.activeVersion));
                    const shown = versions[at];
                    return (
                      <Menu float left trigger={(open, toggle) => (
                        <button className={"btn sm ver-pick" + (open ? " on" : "")} aria-haspopup="menu" aria-expanded={open} onClick={() => { setRenaming(null); toggle(); }}>
                          {shown ? versionName(shown, at) : t("Version {x}", { x: "A" })}
                          <span className="mono xs muted">{mmss(settings.crop.start)}–{mmss(settings.crop.start + settings.crop.duration)}</span>
                          <Icon name="chevron" size={12} />
                        </button>
                      )}>
                        {(close) => (<div className="ver-list">
                          {lines.map(({ v, i }) => {
                            const id = v?.id ?? "solo";
                            const on = !v || v.id === settings.activeVersion;
                            const crop = on ? settings.crop : v?.v.crop;
                            const label = v ? versionName(v, i) : t("Version {x}", { x: "A" });
                            return (
                              <div key={id} className={"ver-line" + (on ? " on" : "")}>
                                {renaming === id ? (
                                  <input className="input sm ver-name" autoFocus defaultValue={v?.name ?? ""} placeholder={label} aria-label={t("Rename")}
                                    onBlur={(e) => (v ? (renameVersion(v.id, e.target.value), setRenaming(null)) : nameSolo(e.target.value))}
                                    onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") { if (v) { renameVersion(v.id, e.currentTarget.value); setRenaming(null); } else nameSolo(e.currentTarget.value); } if (e.key === "Escape") setRenaming(null); }} />
                                ) : (
                                  <button className="ver-main" role="menuitemradio" aria-checked={on} onClick={() => { close(); if (v) switchVersion(v.id); }}>
                                    <Icon name="check" size={12} />{label}
                                    {crop && <span className="mono xs">{mmss(crop.start)}–{mmss(crop.start + crop.duration)}</span>}
                                  </button>
                                )}
                                <button className="btn icon sm quiet" aria-label={t("Rename")} title={t("Rename")} onClick={() => setRenaming(renaming === id ? null : id)}><Icon name="pencil" size={12} /></button>
                                {versions.length > 1 && <button className="btn icon sm quiet ver-del" aria-label={t("Delete")} title={t("Delete")} onClick={() => { removeVersion(id); if (versions.length <= 2) close(); }}><Icon name="trash" size={12} /></button>}
                              </div>
                            );
                          })}
                          <div className="sep" />
                          <button className="ver-new" onClick={() => { close(); addVersion(); }}
                            title={t("Another version of this video, to compare: its own segment, texts, styles, framing and colour (the camera file and its sync are shared)")}>
                            <Icon name="plus" size={12} />{t("Duplicate this version")}
                          </button>
                        </div>)}
                      </Menu>
                    );
                  })()}
                  {/* The takes found in the video (it holds the passage more than once): picked like a version. */}
                  {settings.takes && settings.takes.length > 1 && (() => {
                    const takes = settings.takes;
                    const at = takes.findIndex((k) => Math.abs(k.offset - settings.offset) < 0.02);
                    const cur = takes[at];
                    return (
                      <span className="take-slot">
                        <Menu float left trigger={(open, toggle) => (
                          <button className={"btn sm ver-pick take-pick" + (open ? " on" : "")} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
                            {at >= 0 ? t("Take {n}", { n: at + 1 }) : t("Takes")}
                            {cur && <span className="mono xs muted take-range">{mmss(cur.musicStart)}–{mmss(cur.musicEnd)}</span>}
                            <Icon name="chevron" size={12} />
                          </button>
                        )}>
                          {(close) => (<div className="ver-list">
                            {takes.map((k, i) => {
                              const on = i === at;
                              return (
                                <div key={i} className={"ver-line" + (on ? " on" : "")}>
                                  <button className="ver-main" role="menuitemradio" aria-checked={on} onClick={() => { close(); applyTake(k, takes); }}
                                    title={t("In the video {a}–{b} · in the song {c}–{d}", { a: fmtTime(k.musicStart), b: fmtTime(k.musicEnd), c: fmtTime(k.offset + k.musicStart), d: fmtTime(k.offset + k.musicEnd) })}>
                                    <Icon name="check" size={12} />{t("Take {n}", { n: i + 1 })}
                                    <span className="mono xs">{mmss(k.musicStart)}–{mmss(k.musicEnd)}</span>
                                  </button>
                                </div>
                              );
                            })}
                          </div>)}
                        </Menu>
                        <Hint text={t("The song plays more than once in this video (you sang it twice, or started over): each take is one of those passes. The first times are where it sits in the video, the second where it falls in the song. Pick the one to use; if you filmed only one pass, the other is a part of the song that sounds alike (a loop of the beat): keep the right one and ignore it.")} />
                      </span>
                    );
                  })()}
                </div>
                {genBusy && (
                  <div className="bar live" role="progressbar" aria-valuemin={0} aria-valuemax={100}
                    aria-valuenow={Math.round((genStep === "model" && genDone === 0 ? genPct : genDone) * 100)}>
                    <div style={{ width: `${(genStep === "model" && genDone === 0 ? genPct : genDone) * 100}%` }} />
                  </div>
                )}
                {genInfo && <p className="notice xs">{genInfo}</p>}
                {err && <p className="notice bad xs">{err}</p>}
                {note && <p className="notice xs">{note}</p>}
                <details className="fine">
                  <summary>{t("Fine tuning")}</summary>
                  <div className="stack">
                    <p className="muted xs">{linked
                      ? t("Drag the edges to trim, the middle to move the segment. Linked: the sync stays and the segment stays inside the video.")
                      : t("Drag the edges to trim, the middle to move the segment. Drag the top of the blue band to move the sync.")}</p>
                    <div className="cols3">
                      <label className="field">{t("Start (s)")}
                        <input className="input" type="number" min={0} step={0.1} value={round2(settings.crop.start)}
                          onChange={(e) => setCropStart(Number(e.target.value) || 0)} />
                      </label>
                      <label className="field">{t("Length (s)")}
                        <input className="input" type="number" min={1} step={0.1} value={round2(settings.crop.duration)}
                          onChange={(e) => setCropDuration(Number(e.target.value) || 1)} />
                      </label>
                      <label className="field">{t("Offset (s)")}
                        <input className="input" type="number" step={0.05} value={round2(settings.offset)} disabled={linked}
                          onChange={(e) => setV({ offset: round2(Number(e.target.value) || 0) })} />
                      </label>
                    </div>
                    <div className="row">
                      <button className="btn sm" disabled={linked} onClick={() => setV({ offset: round2(settings.offset - 0.1) })}>−0,1</button>
                      <button className="btn sm" disabled={linked} onClick={() => setV({ offset: round2(settings.offset + 0.1) })}>+0,1</button>
                      <button className="btn sm" disabled={linked} onClick={() => setV({ offset: Math.max(0, settings.crop.start) })}>{t("Set here")}</button>
                      {!!settings.anchors && <span className="badge">{t("{n} anchors", { n: settings.anchors })}</span>}
                      {linked && <span className="muted xs">{t("Audio and video are linked: unlink them to change the offset by hand.")}</span>}
                    </div>
                    {settings.musicStart != null && settings.musicEnd != null && (
                      <p className="mono xs">
                        {t("Music detected from {a} to {b} in the video.", { a: fmtTime(settings.musicStart), b: fmtTime(settings.musicEnd) })}
                      </p>
                    )}
                    <div className="cols2">
                      <label className="field">{t("Language")}
                        <Select className="input" value={language} onChange={(e) => setLanguage(e.target.value)} disabled={genBusy}>
                          <option value="auto">{t("Detect")}</option>
                          <option value="french">Français</option><option value="english">English</option>
                          <option value="spanish">Español</option><option value="portuguese">Português</option>
                          <option value="italian">Italiano</option><option value="german">Deutsch</option>
                          <option value="dutch">Nederlands</option><option value="arabic">العربية</option>
                        </Select>
                      </label>
                      <label className="field">{t("Accuracy")}
                        <Select className="input" value={model} onChange={(e) => setModel(e.target.value as AsrModel)} disabled={genBusy}>
                          <option value="tiny">{t("Fast")}</option>
                          <option value="base">{t("Balanced")}</option>
                          <option value="small">{t("Precise (slower)")}</option>
                          <option value="turbo" disabled={!hasGpu()}>{hasGpu() ? t("Very precise (about 560 MB, downloaded once)") : t("Very precise (needs a graphics card)")}</option>
                        </Select>
                      </label>
                    </div>
                    <p className="muted xs">{t("The speech model ({name}) is downloaded once, then kept by the browser. Your audio never leaves this device.", { name: ASR_MODELS[model].split("/")[1].replace("_timestamped", "") })}</p>
                    <p className="muted xs">{t("Shortcuts: Space play · ←/→ previous/next line · I/O start/end of the segment here · Alt+←/→ offset ±0.1 s")}</p>
                  </div>
                </details>
              </>
            )}
            {!audioBuf && err && <p className="notice bad xs">{err}</p>}
            {!audioBuf && note && <p className="notice xs">{note}</p>}
          </div>

          {/* The content of the lyrics, of the hook (their style in the right column), or the post's caption. */}
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === "lyrics"} className={"tab" + (tab === "lyrics" ? " on" : "")} onClick={() => setTab("lyrics")}>{t("Lyrics")}</button>
            <button role="tab" aria-selected={tab === "hook"} className={"tab" + (tab === "hook" ? " on" : "")} onClick={() => setTab("hook")}>{t("Hook")}</button>
            <button role="tab" aria-selected={tab === "caption"} className={"tab" + (tab === "caption" ? " on" : "")} onClick={() => setTab("caption")}>{t("Caption")}</button>
          </div>

          {tab === "lyrics" && (
            <div className="tab-body">
              {songCues.length > 0 && (
                <div className="stack" style={{ gap: 4 }}>
                  <div className="cue-row cue-legend muted xs">
                    <span>{t("Starts")}</span><span className="grow row" style={{ gap: 6 }}>{t("Line")} <Hint text={t("Fine-tune each line by 0.1 s. Your retouches are kept when you edit the lyrics or sync again.")} /></span><span>{t("Ends")}</span>
                  </div>
                  <div className="lyric-timing">
                    {songCues.map((c, i) => (
                      <div key={i} className={"cue-row" + (i === currentIdx ? " on" : "")}>
                        <span className="nudge">
                          <button className="btn sm quiet" aria-label={t("Earlier")} title={t("Show this line earlier (−0.1 s)")} onClick={() => retime(i, "start", -1)}>−</button>
                          <span className="mono xs">{fmtTime(c.start)}</span>
                          <button className="btn sm quiet" aria-label={t("Later")} title={t("Show this line later (+0.1 s)")} onClick={() => retime(i, "start", 1)}>+</button>
                        </span>
                        {editCue?.i === i ? (
                          <span className="cue-edit grow">
                            <input ref={cueInput} className="input sm" autoFocus value={editCue.text} aria-label={t("Text of the line")}
                              onChange={(e) => setEditCue({ i, text: e.target.value })}
                              onKeyDown={(e) => { if (e.key === "Enter") saveCue(); if (e.key === "Escape") setEditCue(null); }} />
                            {mode === "phrase" && c.words.length > 1 && (
                              <button className="btn sm" title={t("Cut the line in two where the cursor is: the rest becomes a line of its own")}
                                onMouseDown={(e) => e.preventDefault()} onClick={() => saveCue(cueInput.current?.selectionStart ?? undefined)}>{t("Cut here")}</button>
                            )}
                            {/* The next line joined to this one (to move a cut: join, then "Cut here" where it should be). */}
                            {mode === "phrase" && songCues[i + 1] && (
                              <button className="btn sm" title={t("Join the next line to this one, its timing kept: then cut it where you want")}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => {
                                  const next = songCues[i + 1];
                                  onProject((p) => ({ ...p, lyricWords: joinCue(p.lyricWords ?? [], c, next) }));
                                  setEditCue({ i, text: `${editCue.text} ${next.text.replace(/\n/g, " ")}`.trim() });
                                  onSaveNow();
                                }}>{t("Join with the next")}</button>
                            )}
                            <button className="btn sm primary" onMouseDown={(e) => e.preventDefault()} onClick={() => saveCue()}>{t("OK")}</button>
                          </span>
                        ) : (<>
                          <button className="cue-text truncate xs" onClick={() => { stop(); const [lo, hi] = headRange(); setHead(round2(clamp(c.start, lo, hi))); }}>
                            {c.text.replace(/\n/g, " ⏎ ")}
                          </button>
                          {c.words.some((x) => x.doubt) && !c.words.some((x) => x.manual) && (
                            <span className="cue-doubt" title={t("To check: the model was unsure where this line is sung")} aria-label={t("To check")} />
                          )}
                          {/* Right after the line's text (not at the far end): close at hand. */}
                          <button className="btn icon sm quiet cue-pen" aria-label={t("Edit the line")} title={t("Edit the line: a missing word, or cut it in two")}
                            onClick={() => { stop(); setEditCue({ i, text: c.words.map((x) => x.w).join(" ") }); }}><Icon name="pencil" size={14} /></button>
                          <span className="grow" />
                        </>)}
                        <span className="nudge">
                          <button className="btn sm quiet" aria-label={t("Shorter")} title={t("Hide this line earlier (−0.1 s)")} onClick={() => retime(i, "end", -1)}>−</button>
                          <span className="mono xs">{fmtTime(c.end)}</span>
                          <button className="btn sm quiet" aria-label={t("Longer")} title={t("Keep this line longer (+0.1 s)")} onClick={() => retime(i, "end", 1)}>+</button>
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="row">
                    <span className="grow" />
                    {hasManual(project.lyricWords) && !genBusy && (
                      <button className="btn sm quiet" onClick={() => resyncLyrics(writtenSrc, project, true)}>{t("Back to the automatic timing")}</button>
                    )}
                  </div>
                </div>
              )}
              {/* Linked: the release's lyrics, edited in the same editor as the carousel's (sections as cards). */}
              {lyricsLinked && (
                <div className={"row paste-fold" + (project.lyrics.length ? "" : " needs-lyrics")}>
                  <span className="xs grow truncate">
                    {project.lyrics.length
                      ? `${t("Lyrics of the release")} · ${t("{n} sections", { n: project.lyrics.length })} · ${t("{n} sung lines", { n: sungLines })}`
                      : t("No lyrics yet: add them in the library (Lyrics).")}
                  </span>
                  <Hint text={t("The same lyrics as the carousel's. When you change them, the video places the changed lines again; your retouches stay.")} />
                  {project.lyrics.length > 0 && <button className="btn sm quiet" onClick={onEditLyrics}>{t("Edit")}</button>}
                  {cues.length > 0 && !genBusy && <button className="btn sm quiet danger" onClick={() => setClearAsk(true)} title={t("Remove the timing of the lyrics on this segment (the text stays)")}>{t("Clear the timing")}</button>}
                </div>
              )}
              {/* Not linked yet (older releases): the song's own text, open while nothing is placed, then folded. */}
              {lyricsLinked ? null : cues.length > 0 && !pasteOpen ? (
                <div className="row paste-fold">
                  <span className="xs grow truncate">{t("Lyrics of the song")}{pasted.lines ? ` · ${t("{n} sung lines", { n: pasted.lines })}` : ""}</span>
                  <Hint text={t("No pasted lyrics, no lyrics on the video. The audio is only used to know when each written word is sung.")} />
                  <button className="btn sm quiet" onClick={() => setPasteOpen(true)}>{t("Edit")}</button>
                  {cues.length > 0 && !genBusy && <button className="btn sm quiet danger" onClick={() => setClearAsk(true)} title={t("Remove the timing of the lyrics on this segment (the text stays)")}>{t("Clear the timing")}</button>}
                </div>
              ) : (
                <>
              {!lyricsLinked && project.lyrics.length > 0 && !!project.songLyrics?.trim() && (
                <div className="notice warn xs stack" style={{ gap: 6 }}>
                  <span>{t("The lyrics pasted here are not the same as the release's (the carousel's sections). Keep one text for both:")}</span>
                  <div className="row">
                    <button className="btn sm" onClick={() => { setWrittenSrc("song"); onProject((p) => ({ ...p, lyricsLinked: true, songLyrics: songOf(p.lyrics) })); setPaste(songOf(project.lyrics)); }}
                      title={t("The video takes the sections' text. Its lines are placed again; the words you retimed by hand keep their timing.")}>{t("Use the release's lyrics")}</button>
                    <button className="btn sm" onClick={() => { setWrittenSrc("song"); onProject((p) => { const lyrics = mergeSong(p.lyrics, p.songLyrics ?? "", (n) => t("Part {n}", { n }), t("Chorus")); return refreshLyricSlides({ ...p, lyrics, lyricsLinked: true, lyricsPlacedFrom: p.lyricWords?.length ? sungOf(lyrics) : p.lyricsPlacedFrom }); }); }}
                      title={t("The sections become the text pasted here. The video's timing does not move.")}>{t("Use these for the release")}</button>
                  </div>
                </div>
              )}
              <label className="field"><span className="row" style={{ gap: 6 }}>{lyricsLinked ? t("Lyrics of the release") : t("Paste the lyrics of the song")} <Hint text={lyricsLinked ? t("The same text as the carousel's sections: editing it here changes them too. The video places the changed lines again; your retouches stay.") : t("No pasted lyrics, no lyrics on the video. The audio is only used to know when each written word is sung.")} />
                {cues.length > 0 && <button type="button" className="btn sm quiet" style={{ marginLeft: "auto" }} onClick={() => setPasteOpen(false)}>{t("Fold")}</button>}</span>
                <textarea ref={pasteRef} className="input" rows={8} value={paste} onChange={(e) => setPaste(e.target.value)}
                  onBlur={() => { if (lyricsLinked && parseLyrics(paste).text === sungOf(project.lyrics)) setPaste(songOf(project.lyrics)); }}
                  placeholder={t("Paste the whole song as found online: titles like [Chorus], Couplet 1 or Refrain x2 are recognised and removed.")} />
              </label>
              {pasted.parts.length > 0 && (
                <p className="muted xs">{t("Parts found: {list}", { list: pasted.parts.join(" · ") })} · {t("{n} sung lines", { n: pasted.lines })}</p>
              )}
              {project.lyrics.length > 0 && !lyricsLinked && (
                <label className="field">{t("Written lyrics")}
                  <Select className="input" value={writtenSrc} disabled={genBusy}
                    onChange={(e) => { setWrittenSrc(e.target.value); if (project.heardWords?.length) resyncLyrics(e.target.value); }}>
                    <option value="song">{t("Lyrics pasted above")}</option>
                    <option value="all">{t("Carousel lyrics (all sections)")}</option>
                    {project.lyrics.map((s) => <option key={s.id} value={s.id}>{t("Section: {name}", { name: s.name })}</option>)}
                  </Select>
                </label>
              )}
                </>
              )}
              {/* The pasted text open (older releases): Clear under it; else it is beside Edit. */}
              {!lyricsLinked && pasteOpen && cues.length > 0 && !genBusy && <div><button className="btn sm quiet danger" onClick={() => setClearAsk(true)}>{t("Clear the timing")}</button></div>}
              {/* Plan B, when the audio could not place the lyrics (speech model unavailable, a very noisy live):
                  a section spread over the segment, then fine-tuned with − / + like the synced lines. */}
              {!cues.length && !genBusy && project.lyrics.length > 0 && (
                <div className="row spread-row">
                  <Select className="input sm grow" aria-label={t("Section")} value={section?.id ?? ""} onChange={(e) => setSectionId(e.target.value)}>
                    {project.lyrics.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </Select>
                  <button className="btn sm" onClick={spreadLyrics} disabled={!section?.text.trim()}>{t("Spread it on the segment")}</button>
                  <Hint text={t("If the audio could not place the lyrics: the lines of this section are spread over the segment, on the attacks of the sound. Then adjust each one with − / +.")} />
                </div>
              )}
            </div>
          )}

          {tab === "hook" && (
            <div className="tab-body">
              {!hookPools.length && <p className="muted xs">{t("Make a hook list in the carousel (Import hooks): the video draws from the same lists.")}</p>}
              {hooks.map((h, i) => {
                const src = srcOf(h);
                const setSrc = (patch: Partial<VideoHook>) => editHook(h.id, { pool: src.poolId, tags: src.ticked, notTags: src.notTicked.length ? src.notTicked : undefined, ...patch });
                const setTags = (next: { tags: string[]; not: string[] }) => setSrc({ tags: next.tags, notTags: next.not.length ? next.not : undefined });
                return (
                <div key={h.id} className="hook-item">
                  {/* As a slide's: its title and its text, then where it is drawn from (with another one drawn), then its timing. */}
                  <span className="label hook-k">{t("Hook {n}", { n: i + 1 })}</span>
                  <textarea className="input" rows={2} value={h.text} placeholder={t("Write the hook…")}
                    onChange={(e) => editHook(h.id, { text: e.target.value, link: undefined })} />
                  <div className="row nowrap hook-head">
                    {/* Where from (its list and tags), then which one (the list, opened on this hook): as on a slide. */}
                    {hookPools.length > 0 && (
                      <Menu float trigger={(open, toggle) => (
                        <SourceButton open={open} onClick={toggle} label={t("List and tags of this hook")} name={src.pool?.name ?? ""} sub={sourceSub(tagSummary(src.ticked, src.notTicked, t), h.text)} />
                      )}>
                        {(close) => (
                          <div className="pick-pane">
                            <div className="pick-sec">
                              <span className="pick-k">{t("List")}</span>
                              <div className="pick-list">
                                {hookPools.map((p) => (
                                  <button key={p.id} className={"pick-line" + (p.id === src.poolId ? " on" : "")} onClick={() => editHook(h.id, { pool: p.id, tags: [] })}>
                                    <span className="dd-check" aria-hidden>{p.id === src.poolId ? "✓" : ""}</span><span>{p.name}</span><span className="pick-n">{textItems(p).length}</span>
                                  </button>
                                ))}
                              </div>
                            </div>
                            <div className="pick-sec">
                              <span className="pick-k">{t("Tags")}</span>
                              {src.groups.length > 1 ? <TagChips groups={src.groups} ticked={src.ticked} not={src.notTicked} count={src.count} onChange={setTags} />
                                : <p className="muted xs">{t("No tags in this list yet.")}</p>}
                            </div>
                            {/* Which one: the list's hooks (the tags' ones), this one ticked (the menu opens on it). */}
                            {src.items.length > 0 && (
                              <TextPickList label={t("Hooks")} items={src.items} all={src.pool ? textItems(src.pool) : src.items} current={h.text}
                                onPick={(x) => { close(); editHook(h.id, fromList(h, x)); }} />
                            )}
                          </div>
                        )}
                      </Menu>
                    )}
                    
                    {src.items.length > 0 && (
                      <button className="btn sm primary hook-gen" onClick={() => drawInto(h.id)} title={t("Another hook from its list and tags")}><Icon name="sparkle" size={13} />{t("Generate")}</button>
                    )}
                  </div>
                  <div className="row">
                    <span className="nudge">
                      <span className="muted xs">{t("From")}</span>
                      <button className="btn sm quiet" aria-label={t("Earlier")} onClick={() => nudgeHook(h, "from", -0.1)}>−</button>
                      <span className="mono xs">{(h.from).toFixed(1)} s</span>
                      <button className="btn sm quiet" aria-label={t("Later")} onClick={() => nudgeHook(h, "from", 0.1)}>+</button>
                    </span>
                    <span className="nudge">
                      <span className="muted xs">{t("To")}</span>
                      <button className="btn sm quiet" aria-label={t("Shorter")} onClick={() => nudgeHook(h, "to", -0.1)}>−</button>
                      <span className="mono xs">{(h.to ?? segLen).toFixed(1)} s</span>
                      <button className="btn sm quiet" aria-label={t("Longer")} onClick={() => nudgeHook(h, "to", 0.1)}>+</button>
                    </span>
                    <label className="check">
                      <input type="checkbox" checked={h.to === undefined}
                        onChange={(e) => editHook(h.id, { to: e.target.checked ? undefined : round2(Math.min(segLen, h.from + 3)) })} />
                      {t("Until the end")}
                    </label>
                    {/* Remove: at the card's bottom right, away from its other buttons. */}
                    <button className="btn sm danger hook-del" onClick={() => setHooks(hooks.filter((x) => x.id !== h.id))}><Icon name="trash" size={13} />{t("Remove")}</button>
                  </div>
                </div>
                );
              })}
              <div className="row">
                <button className="btn sm" onClick={() => addHook(drawFor(hooks[hooks.length - 1], hooks.map((h) => h.text)) ?? "")}><Icon name="plus" size={13} />{t("Add a hook")}</button>
                <Hint text={t("A title over the video, at the top by default. Add several to change it along the video, or keep one all along. Each hook has its own list and tags (the button next to its name).")} />
              </div>
            </div>
          )}

          {/* The text of the post, built like the carousel's (under its slides). */}
          {tab === "caption" && (
            <div className="tab-body">
              <section className="post-box in-tab">
                <h3 className="label">{t("Caption and hashtags")}</h3>
                <PostCaption value={settings.caption ?? ""} poolId={settings.captionPoolId} pools={captionPools}
                  onChange={(caption) => setV({ caption })}
                  onPool={(captionPoolId) => setV({ captionPoolId })}
                  onDraw={() => onDrawCaption(settings.captionPoolId, settings.caption, (caption) => setV({ caption }))}
                  onNewList={onNewCaptionList} />
              </section>
            </div>
          )}

        </div>
      </div>
          {!dockSlot && audioBuf && <div className="board-player">{playerEl}</div>}
        </main>
        {/* Right: the look of what is edited in the middle (lyrics or hook), then the colour of the whole video. */}
        {/* (the clip selected on the timeline decides what the column shows, as in an editor: a text or a hook, its text
            settings; a video clip, the video's — nothing selected, all) */}
        <aside className={"col side r video-col-r" + (studioLoading ? " is-loading" : "") + (pick === "video" ? " focus-video" : pick?.startsWith("text:") || pick?.startsWith("hook:") ? " focus-text" : "")} ref={rightColRef}>
          <StyleTabs parts={vParts} part={vPart} onPart={pickVPart} tone="video" />
          {/* Multicam: whose look the column sets (the camera on the preview). */}
          {((settings.angles ?? []).some(Boolean) || overlaysOf(settings).length > 0) && (() => {
            const k = camTake && !ovTake ? (settings.angles ?? []).indexOf(camTake.id) + 1 : 0;
            const c = camTake ?? clip;
            return (
              <div className={"look-of cam-" + (ovTake ? overNo(settings, ovTake.id) : k)}>
                <span className="xs muted">{t("Settings of")}</span> <b>{ovTake ? overNo(settings, ovTake.id) + 1 : k + 1}</b> <span className="take-name">{c.videoName?.replace(/\.[^.]+$/, "") ?? clipName(c)}</span>
                <Hint text={t("Each video has its own colour, effects, framing, bars and progressive zoom: those of the camera on the preview, or of the video over it once clicked (on the preview or its track). Click a take in the library or a shot in the timeline to set another one. Kept in the take.")} />
              </div>
            );
          })()}
          {/* How the camera picture fits the post: the first part of the video's style. */}
          <Section id="video-render" title={t("Framing")}>
          {/* Phone's Style page: its title, like the other parts' (the panel's own is hidden there). */}
          <div className="row col-head style-only"><span className="label">{t("Format")}</span><Hint text={t("The shape of the post and how the camera picture fills it. On the preview, drag the picture to reframe it and pinch to zoom.")} /></div>
          <div className="row">
            <button className={"btn sm" + (settings.format !== "16:9" ? " on" : "")} aria-pressed={settings.format !== "16:9"}
              onClick={() => setV({ format: "9:16" })}>9:16</button>
            <button className={"btn sm" + (settings.format === "16:9" ? " on" : "")} aria-pressed={settings.format === "16:9"}
              onClick={() => setV({ format: "16:9" })}>16:9</button>
            {!ovTake && <Select className="input sm grow" aria-label={t("Framing")}
              value={(frame.framing ?? "fill") === "fill" ? "fill" : (frame.bars ?? "blur") === "blur" ? "fit-blur" : "fit-black"}
              onChange={(e) => {
                const v = e.target.value;
                setFrame(v === "fill" ? { framing: "fill" } : { framing: "fit", bars: v === "fit-blur" ? "blur" : "black" });
              }}>
              <option value="fill">{t("Fill (crop)")}</option>
              <option value="fit-blur">{t("Fit whole, blurred bars")}</option>
              <option value="fit-black">{t("Fit whole, black bars")}</option>
            </Select>}
          </div>
          {/* The video over it: whole, its size is its zoom (×1: as wide as the post), moved on the preview. */}
          {ovTake && ovSel && (
            <Range label={t("Size")} value={ovSel.w / 100} display={`${(ovSel.w / 100).toFixed(2)}×`} min={0.15} max={4} step={0.01}
              onChange={(z) => patchOverlay(ovSel.clip, { w: Math.round(z * 1000) / 10 })}
              onReset={() => patchOverlay(ovSel.clip, { w: 42 })} />
          )}
          {/* Every video has all its settings: the one over it too (drawn in its frame), not only its size. */}
          {<>
          <div className="row" title={t("An anamorphic lens squeezes the picture across: pick its factor to see it as filmed. It goes with the camera file (all its versions).")}>
            <span className="label">{t("Anamorphic lens")}</span>
            <Select className="input sm grow" aria-label={t("Anamorphic lens")} value={String(desq ?? 1)}
              onChange={(e) => { const k = Number(e.target.value); writeLook({ desqueeze: k === 1 ? undefined : k, frame: fitFrame(frame, k) }); }}>
              <option value="1">{t("None")}</option>
              {DESQUEEZE.map((k) => <option key={k} value={String(k)}>{`×${String(k).replace(".", lang === "fr" ? "," : ".")}`}</option>)}
            </Select>
          </div>
          <div className="row">
            <span className="label">{t("Black bars")}</span>
            <MatteSelect className="input sm grow" value={lookMatte} onChange={(v) => writeLook({ matte: camTake ? v ?? 0 : v })} />
          </div>
          <Range label={t("Zoom")} value={frame.zoom} display={`${frame.zoom.toFixed(2)}×`} min={0.15} max={4} step={0.05}
            onChange={(v) => { const z = zoomPic(picOf(frame), v); setFrame(fitFrame({ ...frame, zoom: z.zoom, ox: z.ox, oy: z.oy })); }}
            onReset={() => setFrame({ zoom: 1, ox: 0, oy: 0 })} />
          {/* Progressive zoom: its factor on one line (like the lens), then, when on, what it zooms. */}
          <div className="row" title={t("Zooms in slowly over the whole segment: ×1 on the first frame, up to the chosen factor on the last.")}>
            <span className="label">{t("Progressive zoom")}</span>
            <Select className="input sm grow" aria-label={t("Progressive zoom")} value={pushIsCustom ? "custom" : String(lookPush ?? 0)}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "custom") { setPushCustom(true); if (!lookPush) setPush(1.15); return; }
                setPushCustom(false);
                setPush(Number(v) || undefined);
              }}>
              {PUSH_PRESETS.map((v) => <option key={v} value={String(v)}>{v ? timesText(v) : t("Off")}</option>)}
              <option value="custom">{t("Custom…")}</option>
            </Select>
          </div>
          {/* Custom: its own factor, on a slider under the menu (up to ×1.3: beyond, it is no longer a slow push). */}
          {pushIsCustom && lookPush && (
            <Range label={t("Strength")} value={lookPush} display={timesText(lookPush)} min={1.01} max={1.3} step={0.01}
              onChange={(v) => setPush(Math.round(v * 100) / 100)} onReset={() => setPush(1.15)} />
          )}
          {lookPush && (
            <div className="row" role="group" aria-label={t("Progressive zoom")}
              title={t("Inside the video: the picture zooms inside its frame, which keeps its place and size (the bars and the texts around do not move).")}>
              <button className={"btn sm grow" + (!lookPushIn ? " on" : "")} aria-pressed={!lookPushIn} onClick={() => writeLook({ pushIn: camTake ? false : undefined })}>{t("The whole frame")}</button>
              <button className={"btn sm grow" + (lookPushIn ? " on" : "")} aria-pressed={!!lookPushIn} onClick={() => writeLook({ pushIn: true })}>{t("Inside the video")}</button>
            </div>
          )}
          </>}
          </Section>
          {tab === "hook" ? (
            <div className="stack sheet-text">
              <div className="row col-head">
                <span className="label">{t("Hook style")}</span>
                <Hint text={settings.hookStyle ? t("Own style for the hooks.") : t("Default hook style: white with a black outline, at the top, until you change something.")} />
                <span className="grow" />
                <button className="btn sm quiet" onClick={() => setV({ hookStyle: undefined })} disabled={!settings.hookStyle}>{t("Reset")}</button>
              </div>
              {hooks.length === 0 ? (
                <div className="stack">
                  <p className="muted xs">{t("No hook on this video yet.")}</p>
                  <div><button className="btn sm" onClick={() => { setTab("hook"); addHook(); }}><Icon name="plus" size={13} />{t("Add a hook")}</button></div>
                </div>
              ) : (
                <>
                  <Section id="hook-style-presets" title={<>{t("Style presets")}{presetOf(presets, hookStyle) && <span className="sec-sub"> · {presetOf(presets, hookStyle)!.name}</span>}</>} open={false}>
                    <StylePresets presets={presets} current={hookStyle} onSave={(name) => onSavePreset(name, hookStyle)}
                      onApply={(p) => setV({ hookStyle: withPreset(hookStyle, p) })} onDelete={onDeletePreset} />
                  </Section>
                    <CaptionStyle
                      sid="hook-style"
                      style={hookStyle}
                      defaults={hookDefault}
                      fonts={fonts}
                      onChange={(patch) => setV({ hookStyle: { ...hookStyle, ...patch } })}
                      onPreview={(patch) => setFontPreview(patch ? { which: "hook", patch } : null)}
                      onFonts={onFonts}
                    />
                    {/* Phone's Style page: the reset at the end (the head that holds it is not shown there). */}
                    <div className="reset-m"><button className="btn sm quiet" onClick={() => setV({ hookStyle: undefined })} disabled={!settings.hookStyle}>{t("Reset")}</button></div>
                </>
              )}
                        </div>
          ) : (
            <div className="stack sheet-text">
              <div className="row col-head">
                <span className="label">{t("Lyrics style")}</span>
                <Hint text={settings.captionStyle ? t("Own style for this video.") : t("Default video style, with the font of the selected carousel slide, until you change something.")} />
                <span className="grow" />
                <button className="btn sm quiet" onClick={() => setV({ captionStyle: undefined })} disabled={!settings.captionStyle}>{t("Reset")}</button>
              </div>
              {/* Custom subtitles: the style of every caption, or of the one under the playhead alone (word or phrase). */}
              <div className="row look-scope">
                <button className={"btn sm" + (lookScope === "all" ? " on" : "")} aria-pressed={lookScope === "all"} onClick={() => setLookScope("all")}>{t("All the lyrics")}</button>
                <button className={"btn sm" + (lookScope === "one" ? " on" : "")} aria-pressed={lookScope === "one"} onClick={() => setLookScope("one")}>{mode === "word" ? t("This word") : t("This phrase")}</button>
                <Hint text={t("This word / phrase: the settings below only change the one under the playhead (font, effect, size, colours, place); drag it on the video to move it alone. “Link to the lyrics style” gives it the lyrics' style back.")} />
              </div>
              {lookScope === "one" && (curKey ? (
                <div className="row look-cue">
                  <span className={"look-cue-text truncate" + (curOwn ? " own" : "")}>« {current!.text.replace(/\n/g, " ")} »</span>
                  <span className="grow" />
                  {curOwn
                    ? <button className="btn sm quiet" onClick={() => relinkCue(curKey)}>{t("Link to the lyrics style")}</button>
                    : <span className="muted xs">{t("Lyrics style")}</span>}
                </div>
              ) : <p className="muted xs">{mode === "word" ? t("Put the playhead on a word to give it its own style.") : t("Put the playhead on a phrase to give it its own style.")}</p>)}
              {Object.keys(looks).length > 0 && lookScope === "all" && (
                <p className="muted xs look-count">{t("{n} with their own style (marked on the lyrics track).", { n: Object.keys(looks).length })}{" "}
                  <button className="btn sm quiet" onClick={() => setV({ captionLooks: undefined })}>{t("Link them all to the lyrics style")}</button></p>
              )}

              <Section id="lyrics-style-presets" title={<>{t("Style presets")}{presetOf(presets, panelStyle) && <span className="sec-sub"> · {presetOf(presets, panelStyle)!.name}</span>}</>} open={false}>
                <StylePresets presets={presets} current={panelStyle} onSave={(name) => onSavePreset(name, panelStyle)}
                  onApply={(p) => setPanelStyle(withPreset(panelStyle, p))} onDelete={onDeletePreset} />
              </Section>
              <Section id="lyrics-style-display" title={t("Display")}>
                <div className="row">
                  <button className={"btn sm" + (settings.captionMode !== "word" && settings.captionMode !== "lit" ? " on" : "")} onClick={() => setV({ captionMode: "phrase" })}>{t("Phrase by phrase")}</button>
                  <button className={"btn sm" + (settings.captionMode === "lit" ? " on" : "")} onClick={() => setV({ captionMode: "lit" })}>{t("Phrase, lit word by word")}</button>
                  <button className={"btn sm" + (mode === "word" ? " on" : "")} onClick={() => setV({ captionMode: "word" })}>{t("Word by word")}</button>
                </div>
                {/* The phrase shown whole, its words lighting as they are sung (TikTok), or filling (Apple Music). */}
                {settings.captionMode === "lit" && (<>
                  <div className="field">{t("Words lighting")}
                    <div className="row" style={{ gap: 6 }}>
                      <button className={"btn sm" + (!settings.litSweep ? " on" : "")} onClick={() => setV({ litSweep: undefined })}>{t("At once")}</button>
                      <button className={"btn sm" + (settings.litSweep ? " on" : "")} onClick={() => setV({ litSweep: true })}>{t("Filling")}</button>
                    </div>
                  </div>
                  <Range label={t("Words not sung yet")} value={settings.litDim ?? 35} display={`${settings.litDim ?? 35} %`} min={0} max={90}
                    onChange={(v) => setV({ litDim: v })} />
                </>)}
                {mode === "phrase" && (
                  <Range label={t("Line length")} value={lineChars} display={t("{n} characters", { n: lineChars })} min={10} max={40}
                    onChange={(v) => setV({ lineChars: v })} />
                )}
                {/* Word by word: where each word comes from. The phrases are well placed; the model's word times less so,
                    "spread" shares each phrase by syllables. Retouches made here stay in this mode only. */}
                {mode === "word" && (
                  <div className="field">{t("Word timing")}
                    <div className="row" style={{ gap: 6 }}>
                      <button className={"btn sm" + ((settings.wordTiming ?? "ai") === "ai" ? " on" : "")} onClick={() => setV({ wordTiming: "ai" })}>{t("As heard (AI)")}</button>
                      <button className={"btn sm" + (settings.wordTiming === "even" ? " on" : "")} onClick={() => setV({ wordTiming: "even" })}>{t("Spread in the phrase")}</button>
                      <Hint text={t("Spread: each word gets its share of its phrase by syllables, between the phrase's real start and end. Your word retouches win either way, and never move the phrases.")} />
                    </div>
                    {hasWordTiming(project.lyricWords) && (
                      <button className="btn sm quiet" style={{ justifySelf: "start" }} onClick={() => onProject((p) => ({ ...p, lyricWords: clearWordTiming(p.lyricWords ?? []) }))}>{t("Undo the word-by-word retouches")}</button>
                    )}
                  </div>
                )}
              </Section>
                {(lookScope === "all" || curKey) && <CaptionStyle
                  sid="lyrics-style"
                  style={panelStyle}
                  defaults={slideStyle}
                  fonts={fonts}
                  onChange={(patch) => setPanelStyle({ ...panelStyle, ...patch })}
                  onPreview={(patch) => setFontPreview(patch ? (panelOne ? { which: "cue", key: curKey!, patch } : { which: "caption", patch }) : null)}
                  onFonts={onFonts}
                />}
                <div className="reset-m"><button className="btn sm quiet" onClick={() => setV({ captionStyle: undefined })} disabled={!settings.captionStyle}>{t("Reset")}</button></div>
                        </div>
          )}
          <div id="video-color" className="stack">
            <div className="row col-head"><span className="label">{t("Colour")}</span><Hint text={t("The look of the whole video: a LUT for log footage, then exposure, contrast and colour, the same on the preview and the export.")} />
              {/* Before / after in one click: the picture as recorded, then the panelGrade again. */}
              {/* The panelGrade on / off in one click (the switch alone: what it does shows on the picture), then Reset
                  (the panelGrade removed), like the other parts' Reset. */}
              {panelGrade && <span className="grow" />}
              {panelGrade && <Switch checked={!panelGrade.off} onChange={(v) => { setRawView(false); writeLook({ grade: { ...panelGrade, off: !v } }); }}
                title={panelGrade.off ? t("Colour turned off: the video is shown and exported as recorded. Click to turn it back on.") : t("Colour on: click to turn it all off (preview and export), your settings kept.")} />}
              {panelGrade && otherCams.length > 0 && <button className="btn sm quiet" onClick={() => copyLookToCams(panelGrade)}
                title={t("The same colour on the project's other cameras of the same kind (log with log, standard with standard).")}>{t("Other cameras")}</button>}
              {panelGrade && <button className="btn sm quiet" onClick={() => { setRawView(false); writeLook({ grade: undefined }); }} title={t("Remove the grade")}>{t("Reset")}</button>}
            </div>
              <ColorGrade grade={panelGrade} onChange={(g) => writeLook({ grade: g })} onRaw={setRawView} lookErr={camTake ? null : lookErr} disabled={!!panelGrade?.off}
                sdr={camTake ? camTake.source?.colour === "sdr" || (camTake.source?.kind === "phone" && camTake.source.colour === "unknown") : sdrSource}
                footage={(() => {
                  const src = camTake ? camTake.source : settings.source;
                  if (camTake ? src?.colour === "sdr" || (src?.kind === "phone" && src.colour === "unknown") : sdrSource) return "sdr";
                  return src?.colour === "log" || src?.colour === "hdr" ? src.colour : undefined;
                })()}
                onLutStored={(id) => { LOOKS.delete(id); setLutReload((n) => n + 1); }}
                presets={gradePresets ?? []} onDeletePreset={(id) => onGradePresets?.((gradePresets ?? []).filter((x) => x.id !== id))}
                onSavePreset={(name) => {
                  if (!panelGrade) return;
                  // The LUT with its Drive copy, so the preset finds it on any device.
                  const lib = panelGrade.lut && lutChoices.find((l) => l.id === panelGrade.lut!.id);
                  const kept = panelGrade.lut && lib?.driveId ? { ...panelGrade, lut: { ...panelGrade.lut, driveId: lib.driveId } } : panelGrade;
                  // The same name: that preset is replaced, in its place (the form said so).
                  const list = gradePresets ?? [], same = presetNamed(list, name);
                  onGradePresets?.(same ? list.map((x) => (x.id === same.id ? { ...x, grade: kept } : x)) : [...list, { id: uid(), name, grade: kept }]);
                  onToast?.(same ? t("Preset replaced") : t("Preset saved"));
                }}
                library={lutChoices} onRemoveLut={onRemoveLut}
                onImported={(l) => { lutSent.current.delete(l.id); onLutLibrary?.((cur) => (cur.some((x) => x.id === l.id) ? cur.map((x) => (x.id === l.id ? l : x)) : [...cur, l])); }} />
                      </div>
          {/* How the video file is made: the settings recommended for TikTok and Instagram (at the take's own rate), shown;
              "Change" unfolds the user's own (for every video of the account). */}
          {(() => {
            const prefs = exportPrefs ?? {};
            const rec = exportSettings(settings.source?.fps);
            const cur = exportSettings(settings.source?.fps, prefs);
            const fpsText = (n: number) => `${+n.toFixed(2)} ${t("fps")}`;
            const set = (patch: VideoExportPrefs) => onExportPrefs?.({ ...prefs, ...patch });
            return (
              <div id="video-export" className="stack">
                <div className="row col-head"><span className="label">{t("Output")}</span>
                  <Hint text={t("Recommended for TikTok and Instagram: the take's own frame rate, a quality above what they keep after their own compression. Customize to choose your own (for all your videos).")} />
                  <span className="grow" />
                  <span className="muted xs">{t("Customize")}</span>
                  <Switch checked={!!prefs.custom} onChange={(v) => set({ custom: v })} title={t("Customize")} />
                </div>
                <div className="exp-rows">
                  <span>{t("Format")}</span><span className="mono">{outW} × {outH}</span>
                  <span>{t("Frame rate")}</span><span className="mono">{fpsText(cur.fps)}{!prefs.custom || !prefs.fps ? <span className="muted"> · {t("the take's")}</span> : null}</span>
                  <span>{t("Picture")}</span><span className="mono">H.264 · {cur.bitrate / 1e6} Mb/s</span>
                  <span>{t("Sound")}</span><span className="mono">AAC · {cur.audioBitrate / 1000} kb/s</span>
                </div>
                {prefs.custom && (
                  <div className="stack exp-custom">
                    <label className="field">{t("Frame rate")}
                      <Select className="input sm" value={prefs.fps ? String(prefs.fps) : ""} onChange={(e) => set({ fps: e.target.value ? Number(e.target.value) : undefined })}>
                        <option value="">{t("The take's ({n})", { n: fpsText(rec.fps) })}</option>
                        {[24, 25, 30, 50, 60].map((n) => <option key={n} value={String(n)}>{fpsText(n)}</option>)}
                      </Select>
                    </label>
                    <label className="field">{t("Picture quality")}
                      <Select className="input sm" value={prefs.mbps ? String(prefs.mbps) : ""} onChange={(e) => set({ mbps: e.target.value ? Number(e.target.value) : undefined })}>
                        <option value="">{t("Recommended ({n} Mb/s)", { n: recommendedRate(cur.fps).bitrate / 1e6 })}</option>
                        {[10, 16, 20, 24].map((n) => <option key={n} value={String(n)}>{`${n} Mb/s`}{n === 10 ? ` · ${t("lighter files")}` : n === 24 ? ` · ${t("Instagram's ceiling")}` : ""}</option>)}
                      </Select>
                    </label>
                    <label className="field">{t("Sound quality")}
                      <Select className="input sm" value={prefs.audioKbps ? String(prefs.audioKbps) : ""} onChange={(e) => set({ audioKbps: e.target.value ? Number(e.target.value) : undefined })}>
                        <option value="">{t("Recommended ({n} kb/s)", { n: AUDIO_KBPS })}</option>
                        {[128, 192, 256, 320].map((n) => <option key={n} value={String(n)}>{`${n} kb/s`}</option>)}
                      </Select>
                    </label>
                    <div className="reset-m"><button className="btn sm quiet" disabled={!prefs.fps && !prefs.mbps && !prefs.audioKbps}
                      onClick={() => onExportPrefs?.({ custom: false })}>{t("Back to the recommended settings")}</button></div>
                  </div>
                )}
              </div>
            );
          })()}
        </aside>
      {/* The player: on the phone's dock; on a computer floating at the bottom of the board (the same one). */}
      {dockSlot && audioBuf && !libraryPage && createPortal(playerEl, dockSlot)}
      {clipDialog === "rename" && (
        <PromptDialog title={t("Rename the video")} label={t("Name")} initial={clipName(clip)} confirmLabel={t("Rename")}
          onSubmit={renameClip} onClose={() => setClipDialog(null)} />
      )}
      {renamingAudio && (
        <PromptDialog title={t("Rename this version")} label={t("Name")} confirmLabel={t("Rename")}
          initial={(() => { const v = audioVersionsOf(release).find((x) => x.id === renamingAudio); return v ? audioLabel(v) : ""; })()}
          onSubmit={(v) => { const id = renamingAudio; setRenamingAudio(null); onRelease((p) => renameAudio(p, id, v)); onSaveNow(); }} onClose={() => setRenamingAudio(null)} />
      )}
      {clipDialog === "delete" && (
        <ConfirmDialog danger title={t("Delete this video")} confirmLabel={t("Delete")}
          message={t("“{name}” and its camera file will be removed from this release. The official audio, the lyrics and the other videos stay as they are.", { name: clipName(clip) })}
          onConfirm={() => void deleteClip()} onClose={() => setClipDialog(null)} />
      )}
      {/* A new audio while there is one: another version of it, kept next to it; which videos go on it. */}
      {askReplace && (() => {
        const n = lockedLines(project.lyricWords).size;
        return (
          <Modal title={t("Re-place every line?")} onClose={() => setAskReplace(false)}>
            <p>{t("You retimed lines by hand. Placing the lyrics again listens to the song and places every line from scratch.")}</p>
            <p className="muted sm">{n === 1 ? t("Your locked line stays as it is.") : n ? t("Your {n} locked lines stay as they are.", { n }) : t("To keep a line as you set it, lock it first with the padlock on its clip (on the timeline).")}</p>
            <div className="modal-foot">
              <button className="btn left quiet" onClick={() => setAskReplace(false)}>{t("Cancel")}</button>
              <button className={"btn" + (n ? "" : " danger")} onClick={() => { setAskReplace(false); dropLocks.current = true; void syncLyrics(); }}>{t("Re-place everything")}</button>
              {n > 0 && <button className="btn primary" onClick={() => { setAskReplace(false); void syncLyrics(); }}>{t("Re-place the others")}</button>}
            </div>
          </Modal>
        );
      })()}
      {audioAsk && (
        <Modal title={t("Another version of the audio")} onClose={() => { if (!audioAsk.busy) setAudioAsk(null); }}>
          {audioAsk.busy ? (
            <p className="shine">{t("Adding “{name}” and finding where its music is…", { name: audioAsk.f.name })}</p>
          ) : (<>
            <p>{t("“{name}” is kept next to the audio already there, as another version (a demo, the master, a sped up…). Which videos play on it?", { name: audioAsk.f.name })}</p>
            <p className="muted sm">{t("A video that goes on it moves to where the same music is in it (its segment, its sync, its takes), even if parts changed length; the lyrics timing follows. Each video can change version later, in the library.")}</p>
            <div className="modal-foot">
              <button className="btn left quiet" onClick={() => void pickAudio(audioAsk.f, audioAsk.driveId, "keep")}>{t("None, keep it in the library")}</button>
              {clips.length > 1 && <button className="btn" onClick={() => void pickAudio(audioAsk.f, audioAsk.driveId, "all")}>{t("All the videos ({n})", { n: clips.length })}</button>}
              <button className="btn primary" onClick={() => void pickAudio(audioAsk.f, audioAsk.driveId, "this")}>{t("This video")}</button>
            </div>
          </>)}
        </Modal>
      )}
      {remapReport && (
        <Modal title={remapReport.to ? t("On “{name}”", { name: remapReport.to }) : t("Another version of the audio")} onClose={() => setRemapReport(null)}>
          {remapReport.notSame ? (
            <p className="notice warn">{t("This audio does not look like a version of the same song: nothing could follow it. The sync of these videos starts over (and the lyrics timing, on this version).")}</p>
          ) : (<>
            <p>{remapReport.shift === 0 ? t("Same timing as before: nothing had to move.")
              : remapReport.shift !== null ? t(remapReport.shift > 0 ? "Same timing, {s} s later: everything moved with it." : "Same timing, {s} s earlier: everything moved with it.", { s: Math.abs(remapReport.shift).toFixed(2) })
                : t("Some parts changed: everything moved to where the same music is.")}</p>
            {remapReport.videos.length > 0 && (
              <div className="remap-list">
                {remapReport.videos.map((v) => (
                  <div key={v.id} className="row nowrap remap-row">
                    <span className="grow truncate">{v.name}</span>
                    <span className={"remap-st " + v.status}>{v.status === "same" ? t("Unchanged") : v.status === "moved" ? t("Moved") : v.status === "check" ? t("To check") : t("Passage gone")}</span>
                    {v.versions.length > 0 && <span className="muted xs">{t(v.versions.length > 1 ? "versions {names}" : "version {names}", { names: v.versions.map((x) => x.name).join(", ") })}</span>}
                  </div>
                ))}
              </div>
            )}
            {remapReport.videos.some((v) => v.status === "check") && <p className="muted sm">{t("To check: its segment covers a part that changed length; it moved with its middle. Play it to see if the take is still on the music (else Resync).")}</p>}
            {remapReport.videos.some((v) => v.status === "gone") && <p className="muted sm">{t("Passage gone: its segment is in a part that is no longer in the audio; it stayed where it was. Pick another segment.")}</p>}
            {remapReport.words.dropped > 0 && <p className="muted sm">{remapReport.words.dropped === 1 ? t("1 word of the lyrics was in a part that is no longer there: removed.") : t("{n} words of the lyrics were in a part that is no longer there: removed.", { n: remapReport.words.dropped })}</p>}
          </>)}
          <div className="modal-foot"><button className="btn primary" onClick={() => setRemapReport(null)}>{t("OK")}</button></div>
        </Modal>
      )}
      {clearAsk && (
        <ConfirmDialog danger title={t("Clear the timing")} confirmLabel={t("Clear")}
          message={t("The {n} words placed on this segment lose their timing (your retouches too), on every video of the release that shows this part of the song: they share it. The lyrics themselves and the carousel's sections stay. Undo (⌘Z) brings it back; Sync places them again.", { n: (project.lyricWords ?? []).filter((x) => x.e > settings.crop.start && x.s < settings.crop.start + settings.crop.duration).length })}
          onConfirm={() => { setClearAsk(false); clearLyrics(); }} onClose={() => setClearAsk(false)} />
      )}
      {(exp || batch) && (
        <Modal title={shareOpen ? (handheld ? t("Share") : t("Send to my phone")) : batch ? (batchDone ? t("Videos ready") : t("Exporting the videos")) : exp?.done ? t("Video ready") : t("Exporting the video")}
          onClose={closeExport}>
          {/* Send to my phone: the same window shows the QR code instead (Back returns to the export). */}
          {shareOpen ? (
          <ShareDialog bare kind="video" onClose={() => setShareOpen(false)}
            place={{ release: project.name, what: lastFiles.current.length > 1 ? t("{n} videos", { n: lastFiles.current.length }) : clipName(clip) }}
            title={lastFiles.current.length > 1 ? `${project.name} · ${t("{n} videos", { n: lastFiles.current.length })}` : `${project.name} · ${clipName(clip)}`}
            // One caption: the video's; several videos: each one's, under its name.
            caption={lastFiles.current.length === 1 ? lastFiles.current[0].caption
              : lastFiles.current.filter((f) => f.caption).map((f) => `${f.name.replace(/ clip\.\w+$/, "")}\n${f.caption}`).join("\n\n———\n\n") || undefined}
            build={async () => lastFiles.current.map((f) => ({ name: f.name, blob: f.blob }))} />
          ) : (<>
          <div className="stack">
            {batch && (
              <ul className="batch-list">
                {batch.ids.map((id, k) => {
                  const c = clips.find((x) => x.id === id);
                  const r = batch.res[id];
                  const now = k === batch.i && !batchDone;
                  return (
                    <li key={id} className={now ? "now" : undefined}>
                      <span className="truncate">{c ? clipName(c) : "?"}</span>
                      {r === "done" ? <span className="ok"><Icon name="check" size={14} />{t("Finished")}</span>
                        : r === "failed" ? <span className="bad">{t("Failed")}</span>
                        : r === "skipped" ? <span className="warn" title={t("Its camera file is not on this device: open it once to import it again.")}>{t("Not on this device")}</span>
                        : now ? <span className="shine">{exp && !exp.done && exporting ? t("In progress {n}%", { n: Math.round(exp.p * 100) }) : t("Opening…")}</span>
                        : <span className="muted">{t("Waiting")}</span>}
                    </li>
                  );
                })}
              </ul>
            )}
            {exp && (!batch || (!batchDone && exporting)) && (<>
            <p className={exp.done ? undefined : "shine"}>
              {exp.done ? t("{name} is in your downloads.", { name: exp.file ?? "" })
                : exp.step === "engine" ? t("Downloading the video converter (once)… {n}%", { n: Math.round(exp.p * 100) })
                : exp.step === "convert" ? t("Converting the camera format… {n}%", { n: Math.round(exp.p * 100) })
                : exp.step === "read" ? t("Reading the camera video…")
                : exp.step === "audio" ? t("Preparing the sound…")
                : exp.step === "video" ? t("Building the frames… {n}%", { n: Math.round(exp.p * 100) })
                : exp.step === "record" ? t("Recording in real time (this browser cannot encode MP4 by itself)… {n}%", { n: Math.round(exp.p * 100) })
                : t("Finishing the MP4…")}
            </p>
            <div className={"bar export-bar" + (exp.done ? "" : " shine-bar")} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(exp.p * 100)}>
              <div style={{ width: `${exp.p * 100}%` }} />
            </div>
            <p className="muted xs">{outW}×{outH} · H.264 + AAC · {+exportSettings(settings.source?.fps, exportPrefs).fps.toFixed(2)} {t("fps")} · {fmtTime(settings.crop.duration)}</p>
            {exp.step === "convert" && gpuWhy && <p className="muted xs">{t("Colour grade on the graphics card not possible here: {why}", { why: gpuWhy })}</p>}
            {expMode && (expMode.direct
              ? <p className="muted xs">{t("Camera frames decoded from the file ({codec}): you can switch tabs.", { codec: expMode.detail })}</p>
              : <p className="notice warn xs">{t("Camera frames read by the browser's player ({why}): the export plays the clip in real time. Keep this tab visible, it pauses while hidden.", { why: expMode.detail || "?" })}</p>)}
            {expPaused && <p className="notice warn xs">{t("Paused: come back to this tab to continue.")}</p>}
            {!exp.done && expMode?.direct !== false && (notifyBlocked()
              ? <p className="notice warn xs">{t("Notifications are blocked for this site: allow them in the browser to be told when the video is ready. The tab title will show it anyway.")}</p>
              : <p className="muted xs">{t("You can switch tabs: you will be notified when the video is ready.")}</p>)}
            </>)}
            {batch && err && <p className="notice bad xs">{err}</p>}
          </div>
          <div className="modal-foot">
            {(batch ? batchDone : exp?.done) && lastFiles.current.length > 0 && (
              <button className="btn left" onClick={() => setShareOpen(true)}><Icon name="share" size={14} />{handheld ? t("Share") : t("Send to my phone")}</button>
            )}
            {(batch ? batchDone : exp?.done)
              ? <button className="btn primary" onClick={closeExport}>{t("Close")}</button>
              : <button className="btn quiet" onClick={closeExport}>{t("Cancel")}</button>}
          </div>
          </>)}
        </Modal>
      )}
    </div>
  );
}

/** One file of the clip (the audio, the camera video): the same tile for both, empty or filled. */
function MediaTile({ icon, label, name, meta, menu, warn, loading, children }: {
  icon: string; label: ReactNode; name: string | null; warn?: boolean;
  /** Still opening (or on its way to / from the Drive): the tile shines. */
  loading?: boolean;
  meta?: ReactNode; menu?: false | null | "" | ((close: () => void) => ReactNode); children?: ReactNode;
}) {
  const { t } = useT();
  return (
    <div className={"media m-" + icon + (name ? "" : " empty") + (warn ? " warn" : "") + (loading ? " shine-box" : "")} aria-busy={loading || undefined}>
      <div className="media-head">
        <span className="media-ic"><Icon name={icon} size={16} /></span>
        <div className="media-txt">
          <span className="label">{label}</span>
          {name ? <span className="media-name" title={name}>{name}</span> : <span className="muted xs">{t("Drop it here, or:")}</span>}
        </div>
        {menu && <Menu float trigger={(_, toggle) => <button className="btn icon sm quiet" aria-label={t("Options")} onClick={toggle}><Icon name="more" /></button>}>{menu}</Menu>}
      </div>
      {meta && <div className="media-meta">{meta}</div>}
      {children}
    </div>
  );
}

