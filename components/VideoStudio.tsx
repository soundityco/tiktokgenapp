"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { defaultCaptionStyle, defaultVideo, uid } from "@/lib/defaults";
import { useT } from "@/lib/i18n";
import { safeName, saveBlob, stamp } from "@/lib/files";
import { signIn } from "next-auth/react";
import { askPersistentStorage, delMedia, getMedia, putMedia } from "@/lib/idb";
import { DRIVE_PATHS, canWriteDrive, deleteDriveFile, downloadDriveFile, downloadDriveFileProgress, findInAppFolder, listAppFiles, trashDriveFile, uploadToDrive } from "@/lib/drive";
import { activeCue, alignLyrics, alignSong, buildCues, cleanHeard, clearWordTiming, hasManual, hasWordTiming, keepManual, parseLyrics, repairOrder, retimeCue, retimeWordCue, rewriteCue, splitCue } from "@/lib/lyricsAlign";
import { autoLineTimes, decodeAudio, envelopeOf, fmtTime, monoOf, peaksOf, syncAudio } from "@/lib/media";
import { askNotifyPermission, notify, notifyBlocked } from "@/lib/notify";
import { clamp, clampPic, drawFramed, drawHelpers, drawPictureAt, framedAt, drawStyledText, TextBox, visibleRegion, zoomPic } from "@/lib/render";
import { buildGradeLut, convertsFootage, type CubeLut, drawLook, gradeKey, gradesColour, NEUTRAL_GRADE, parseCube, toCube } from "@/lib/grade";
import { probeVideo } from "@/lib/probe";
import { followLists, hookLink, poolTags, sourceTags, tagGroups, tagStep, textItems } from "@/lib/generate";
import { copyRegion, Grader } from "@/lib/gradeGL";
import ColorGrade, { knownLuts, lastLut, rememberLut } from "./ColorGrade";
import { exportMp4, ExportStep, mp4Support, seekVideo } from "@/lib/exportVideo";
import { DESQUEEZE, desqueeze, type Picture, VideoSource } from "@/lib/videoSource";
import { type Variant, videoVariants } from "@/lib/variants";
import { fastWorkCopy } from "@/lib/fastCopy";
import { gpuGradedSource, gpuGradeReason } from "@/lib/grade10";
import { convertSegment, copyPlanFor, cropFor, ffmpegAlone, grabFrame, makeWorkCopy, type ConvertCrop, type ConvertStep } from "@/lib/convert";
import { ASR_MODELS, AsrModel, AsrStep, prepareAudio, stopTranscribe, transcribe } from "@/lib/transcribe";
import type { LyricWord, PicSettings, Project, StylePreset, TextPool, TextStyle, VideoFrame, VideoHook, VideoSettings, VideoSetup, VideoTake, VideoVersion } from "@/lib/types";
import CaptionStyle from "./CaptionStyle";
import { presetOf, StylePresets, withPreset } from "./TextControls";
import Icon from "./Icon";
import PostCaption from "./PostCaption";
import ShareDialog, { useHandheld } from "./ShareDialog";
import { themeLabel } from "@/lib/themes";
import { mergeSong, refreshLyricSlides, songOf, sungOf } from "@/lib/lyricsSections";
import { ConfirmDialog, ContextMenu, Hint, Menu, Modal, PromptDialog, Range, Section, Select, Switch, TagChip } from "./ui";
import { createPortal } from "react-dom";
import { FullView } from "./FullView";
import { PHONE_QUERY, StyleTabs, usePhone, useStyleParts, type SheetPart } from "./StyleSheet";

const RATE = 25;
const PRESETS = [10, 15, 20, 30];
/** Longest stretch of a video listened to in real time when the browser cannot decode its audio (10 min). */
const MAX_CAPTURE = 600;
/** Above this, the camera file's sound is not decoded by the browser from the whole file in memory (ffmpeg reads it). */
const SYNC_DECODE_MAX = 400 * 1024 * 1024;
/** The lyrics are heard in windows of this length (s), overlapping a little so no word is cut. */
const LYRICS_WIN = 28;
const LYRICS_LAP = 2;

const DEFAULT_VIDEO: VideoSettings = defaultVideo();
/** Look LUTs already read on this page (id → LUT). */
const LOOKS = new Map<string, CubeLut>();

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
const EXPORT_FPS = 30;
/** The video frame settings in the carousel's photo terms, so both are drawn by the same code. */
const picOf = (f: VideoFrame): PicSettings => ({ framing: f.framing ?? "fill", bars: f.bars ?? "blur", zoom: f.zoom, ox: f.ox, oy: f.oy, darken: 0 });
const round2 = (n: number) => Math.round(n * 100) / 100;
/** The hook on screen at official time `time` (the first one when several overlap). */
const hookAt = (cfg: VideoSettings, time: number): VideoHook | undefined => {
  const rel = time - cfg.crop.start;
  return cfg.hooks?.find((h) => h.text.trim() && rel >= h.from - 0.001 && rel < (h.to ?? cfg.crop.duration));
};


/** Fade of the sound when playback starts or stops (seconds): just enough to avoid a click, short enough not to eat
 *  the first or last syllable of a line (a video that starts right on the voice). The export has none. */
const FADE = 0.02;

/** The way the lyrics are placed on the audio: raised when it changes, so lyrics placed before are placed again once. */
const LYRICS_ALIGN_V = 3;

/** What each version of a video keeps for itself: every choice of the post. The rest is the video's: the camera file
 *  and what depends on it (sync, takes, and the grade's camera profile, see `valuesOf`). */
/** The menu's progressive zooms (0: off); any other factor is a custom one. */
const PUSH_PRESETS = [0, 1.05, 1.1];
const VERSION_KEYS = ["crop", "offset", "musicStart", "musicEnd", "linked", "push", "pushIn", "hooks", "hookTheme", "hookTags", "hookPoolId", "showHooks", "hookStyle",
  "captions", "captionMode", "lineChars", "captionStyle", "caption", "captionPoolId", "format", "frame", "grade"] as const satisfies readonly (keyof VideoSettings)[];
/** Kept by a version only since versions hold everything (`VideoVersion.all`): an older one takes the video's. */
const LOOK_KEYS: readonly (keyof VideoSettings)[] = ["format", "frame", "grade"];
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
type VPart = "framing" | "lyrics" | "hook" | "color";

export default function VideoStudio({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  project,
  hookPools,
  onDrawHook,
  onProject,
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
}) {
  const { t, lang } = useT();
  const clips = useMemo(() => clipsOf(project), [project.videos, project.video, project.id]);
  const clip = clips.find((c) => c.id === project.videoId) ?? clips[0];
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
  /** One official audio per release, shared by all its videos. */
  const projectAudioKey = `audio:project:${project.id}`;
  // Another release (the studio stays mounted behind the carousel): its own lyrics, its own source of lyrics,
  // and an export of all the videos of the previous one stops.
  useEffect(() => {
    setPaste(project.songLyrics ?? "");
    setConfirmRemove(false);
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
  const rafRef = useRef(0);
  const originRef = useRef(0);
  const ioRef = useRef(0);
  const syncRef = useRef<AbortController | null>(null);

  const getCtx = useCallback(() => {
    if (!ctxRef.current) ctxRef.current = new AudioContext();
    return ctxRef.current;
  }, []);

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
  const mode = settings.captionMode ?? "phrase";
  const lineChars = settings.lineChars ?? 22;
  const cues = useMemo(
    () => buildCues(project.lyricWords ?? [], mode, { lineChars, from: settings.crop.start, to: settings.crop.start + settings.crop.duration, wordTiming: settings.wordTiming }),
    [project.lyricWords, mode, lineChars, settings.crop.start, settings.crop.duration, settings.wordTiming]
  );

  /** Font under the pointer in a font list (lyrics or hook style): shown on the video until the pointer leaves. */
  const [fontPreview, setFontPreview] = useState<null | { which: "caption" | "hook"; patch: Partial<TextStyle> }>(null);
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
  const activeRef = useRef<(time: number) => string | null>(() => null);
  activeRef.current = (time: number) => {
    return cues.length ? activeCue(cues, time)?.text ?? null : null;
  };

  const end = audioBuf ? Math.min(audioBuf.duration, settings.crop.start + settings.crop.duration) : settings.crop.start + settings.crop.duration;

  // ---- colour grade: one LUT (camera log → look), applied live on the GPU ----
  const grade = settings.grade;
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
      let b = await getMedia(`lut:${lutId}`);
      // Not in this browser under this id: the same LUT under another id here, else its copy in the user's Drive.
      if (!b && want) {
        const twin = knownLuts().find((l) => l.name === want.name && l.id !== lutId);
        if (twin) b = await getMedia(`lut:${twin.id}`);
        if (!b) {
          try {
            const id = want.driveId ?? await findInAppFolder(`${want.name}.cube`);
            if (id) b = await downloadDriveFile(id);
          } catch (e) { console.warn("[grade] LUT download from Drive failed", e); }
        }
        if (b) { void putMedia(`lut:${lutId}`, b).catch(() => {}); rememberLut(lutId, want.name); }
      }
      if (off) return;
      if (!b) { setLookErr(t("This LUT is not on this device: import it again.")); return; }
      try { const l = parseCube(await b.text()); LOOKS.set(lutId, l); if (!off) setLook(l); }
      catch (e) { if (!off) setLookErr(e instanceof Error ? e.message : String(e)); }
    })();
    return () => { off = true; };
  }, [lutId, lutReload]); // eslint-disable-line react-hooks/exhaustive-deps
  const colourKey = gradeKey(grade);
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
    const inVideo = time >= off - 0.001 && (!Number.isFinite(el?.duration) || time <= off + (el?.duration ?? 0) + 0.001);
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
  const drawScene = useCallback((g: CanvasRenderingContext2D, W: number, H: number, pic: Picture | null, time: number, preview?: { raw: boolean; keep: boolean }) => {
    const cfg = settingsRef.current;
    const raw = !!preview?.raw;
    g.fillStyle = "#000";
    g.fillRect(0, 0, W, H);
    // Preview, before the video is ready (a big camera file takes a while to open): its last picture.
    if (preview && !pic && posterRef.current && !(videoRef.current && videoRef.current.readyState >= 2)) g.drawImage(posterRef.current, 0, 0, W, H);
    if (pic && pic.w && pic.h) {
      // Anamorphic lens: the picture drawn wider, as it was meant to be seen (everything below works on that size).
      pic = desqueeze(pic, cfg.desqueeze);
      let f = picOf(cfg.frame ?? DEFAULT_VIDEO.frame);
      // Progressive zoom: ×1 at the start of the segment, `push` on its last frame. The whole framed picture around the
      // centre, or (`pushIn`) only what is inside its frame, around the frame's centre (below).
      const push = cfg.push ?? 1;
      const k = push > 1 ? 1 + (push - 1) * clamp((time - cfg.crop.start) / Math.max(0.1, cfg.crop.duration), 0, 1) : 1;
      const inside = !!cfg.pushIn && k > 1;
      if (k > 1 && !inside) f = zoomPic(f, f.zoom * k);
      const grader = graderRef.current;
      const wantGrade = !raw && !pic.graded && gradesColour(cfg.grade);
      if (wantGrade && !grader?.ready && gradePendingRef.current) { console.debug("[grade] waiting for the grade (LUT loading)"); pic = null; }
      else if (wantGrade && grader?.ready && videoLut.current) {
        grader.setLut(videoLut.current, 33);
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
        if (!raw && cfg.grade) drawLook(g, W, H, cfg.grade, Math.round(time * EXPORT_FPS));
        if (preview?.keep && !raw) keepPoster(g.canvas);
      } else if (preview && posterRef.current) g.drawImage(posterRef.current, 0, 0, W, H);
    }
    // The texts at the very end of the segment (the playhead dragged to the end, or stopped there) are those of its
    // last frame, as in the export: a hook running to the end must not vanish there.
    const at = Math.min(time, cfg.crop.start + cfg.crop.duration - 0.5 / EXPORT_FPS);
    const text = cfg.captions ? activeRef.current(at) : null;
    const caption = text ? drawStyledText(g, text, styleRef.current, W, H) : null;
    const hook = cfg.showHooks === false ? undefined : hookAt(cfg, at);
    return { caption, hook: hook ? drawStyledText(g, hook.text, hookStyleRef.current, W, H) : null };
  }, []);
  const captionBox = useRef<TextBox | null>(null);
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
  const drawAt = useCallback((time: number) => {
    const c = canvasRef.current;
    const g = c?.getContext("2d");
    if (!c || !g) return;
    const el = videoRef.current;
    const keep = !sourceRef.current && !!el && el.readyState >= 2 && fileClip.current === clipIdRef.current && !!videoUrlRef.current;
    const pic = pictureOf(el, time);
    const boxes = drawScene(g, c.width, c.height, pic, time, { raw: rawRef.current, keep });
    captionBox.current = boxes.caption;
    hookBox.current = boxes.hook;
    drawHelpers(g, c.width, c.height, fullRef.current ? { ...aidsRef.current, zones: false } : aidsRef.current);
    // The first picture of the video (or its last picture kept from before) is on screen: the splash can go.
    if (!shownOnce.current && (pic || posterRef.current)) { shownOnce.current = true; window.dispatchEvent(new Event("rollout:video-ready")); }
  }, [drawScene]);
  const shownOnce = useRef(false);
  // The camera file is read from this device: the splash's bar moves on.
  useEffect(() => { if (videoBlob) window.dispatchEvent(new Event("rollout:video-file")); }, [!!videoBlob]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Draw the paused picture now, and again a little later: right after a load or a seek, the frame of the
   * hidden <video> may not be decoded yet (the browser gives black). Timers, not requestVideoFrameCallback:
   * that one waits for the video to be painted on screen, which never happens for the hidden player.
   */
  const headRef = useRef(head);
  headRef.current = head;
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
      window.setTimeout(() => { src.disconnect(); fade?.disconnect(); }, fade ? FADE * 1000 + 60 : 0);
    }
    if (videoRef.current) { videoRef.current.pause(); videoRef.current.playbackRate = 1; }
    setPlaying(false);
  }, []);

  // ---- files ----
  useEffect(() => {
    let off = false;
    const token = ++ioRef.current;
    syncRef.current?.abort();
    stop();
    setAudioBlob(null);
    setAudioBuf(null);
    setPeaks([]);
    setVideoBlob(null);
    setVideoDur(0);
    setLoadedClip(null);
    setErr(null);
    setNote(null);
    setHead(settingsRef.current.crop.start);
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
          try { posterRef.current = await createImageBitmap(p); drawAt(settingsRef.current.crop.start); } catch { /* not a picture */ }
        });
        const [shared, legacy, b] = await Promise.all([getMedia(projectAudioKey), getMedia(`audio:${clip.id}`), getMedia(`video:${mediaId}`)]);
        if (off || token !== ioRef.current) return;
        console.debug(`[load] files read from the device in ${Math.round(performance.now() - t0)} ms (video ${b ? Math.round(b.size / 1e6) + " MB" : "none"})`);
        loadT0.current = t0;
        // The release has one official audio; older workspaces kept a copy per video: it becomes the project's.
        let a = shared ?? legacy;
        // Not on this device (another computer, browser data cleared): back from the Drive file.
        if (!a && project.audioDriveId) {
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
        if (a) {
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
  }, [clip.id, project.id]);

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
  const driveName = (what: string) => safeName(`${project.name || "Rollout"} - ${clip.name} - ${what}.mp4`);
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
  const audioUp = useRef<string | null>(null);
  useEffect(() => {
    if (!audioBlob || project.audioDriveId || !driveWrite) return;
    const key = `${project.id}|${audioBlob.size}`;
    if (audioUp.current === key) return;
    audioUp.current = key;
    const name = safeName(`${project.name || "Rollout"} - ${t("official audio")} - ${project.audioName ?? "audio"}`);
    void uploadToDrive(audioBlob, name, () => {}, new AbortController().signal, audioBlob.type || "application/octet-stream", { tktgen: "audio", project: project.id }, DRIVE_PATHS.audios(project.name || "Release"))
      .then((id) => {
        // Still the same file of the same release: remember where it is.
        onProject((p) => (p.id === project.id && p.audioSize === audioBlob.size && !p.audioDriveId ? { ...p, audioDriveId: id } : p));
        onSaveNow();
      })
      .catch((e) => { console.warn("[drive] audio upload failed", e); audioUp.current = null; });
  }, [audioBlob, project.audioDriveId, driveWrite, project.id]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const makeCopy = async () => {
    const blob = videoBlob;
    if (!blob || onCopy || copyAc.current) return;
    const cur = settingsRef.current;
    const clipId = clip.id;
    let segS = cur.crop.start - cur.offset, segE = segS + cur.crop.duration;
    // The passages of every version, when they sit close enough: switching versions then needs no new copy.
    for (const v of cur.versions ?? []) {
      if (!v.v.crop || v.v.offset === undefined) continue;
      const s0 = v.v.crop.start - v.v.offset, e0 = s0 + v.v.crop.duration;
      if (Math.max(segE, e0) - Math.min(segS, s0) <= 180) { segS = Math.min(segS, s0); segE = Math.max(segE, e0); }
    }
    const from = Math.max(0, segS - 2), to = Math.min(videoDur, segE + 2);
    const key = `${clipId}|${blob.size}|${from.toFixed(1)}|${to.toFixed(1)}`;
    if (to <= from || copyFailed.current === key) return;
    const ac = new AbortController();
    copyAc.current = ac;
    copyClip.current = clipId;
    const job = { clip: clipId, project: project.id, label: `${project.name} · ${clipName(clip)}` };
    setCopyJob({ step: "make", p: 0, ...job });
    try {
      const plan = copyPlanFor(cur.source);
      const name = driveName(t("copy"));
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
    if (!videoBlob || onCopy || !driveWrite || copyJob || settings.score === undefined || !videoDur) return;
    const segS = settings.crop.start - settings.offset, segE = segS + settings.crop.duration;
    if (segE <= 0 || segS >= videoDur) return;
    const cp = settings.drive?.copy;
    if (cp && cp.of === videoBlob.size && cp.from <= Math.max(0, segS - 0.3) + 1e-3 && cp.to >= Math.min(videoDur, segE + 0.3) - 1e-3) return;
    const DELAY = 15_000;
    setCopyDueAt(Date.now() + DELAY);
    dueTimer.current = window.setTimeout(() => { dueTimer.current = null; setCopyDueAt(null); void makeCopy(); }, DELAY);
    return () => { if (dueTimer.current) clearTimeout(dueTimer.current); dueTimer.current = null; setCopyDueAt(null); };
  }, [videoBlob, onCopy, driveWrite, copyJob, settings.score, settings.offset, settings.crop.start, settings.crop.duration, settings.drive?.copy, videoDur]); // eslint-disable-line react-hooks/exhaustive-deps
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
    if (onCopy && cp) return { text: t("You work on the Drive copy ({from} → {to})", { from: fmtTime(cp.from), to: fmtTime(cp.to) }), p: 1,
      action: { label: t("Link the original"), run: () => document.getElementById("video-original")?.click() },
      hint: t("The camera file is not in this browser (imported on another device, in another browser, or at another address of the app: a website never sees your files by itself). You work here on its copy from your Drive ({quality}, the passage used). If the original is on this computer, “Link the original” plugs it back: the sync and the settings are kept.", { quality: q }) };
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
    <span className="copy-status compact on-copy xs">
      <span className="pill-copy">{t("Drive copy")}</span>
      <span className="mono">{fmtTime(settings.drive.copy.from)} → {fmtTime(settings.drive.copy.to)}</span>
      {copyState?.hint && <Hint text={copyState.hint} />}
    </span>
  ) : copyState && (
    <span className={"copy-status xs" + (copyState.busy ? " busy" : "") + (copyState.ok ? " ok" : "") + (copyState.bad ? " bad" : "") + (compact ? " compact" : "")}>
      {copyState.ok ? <Icon name="check" size={12} /> : <span className="bg-ring" style={{ "--p": copyState.p } as CSSProperties} aria-hidden />}
      <span className={copyState.busy ? "shine" : undefined}>{copyState.text}</span>
      {copyState.action && <button type="button" className="btn sm quiet copy-act" onClick={copyState.action.run}>{copyState.action.label}</button>}
      {copyState.hint && <Hint text={copyState.hint} />}
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

  useEffect(() => () => { stop(); syncRef.current?.abort(); genRef.current?.abort(); stopTranscribe(); ctxRef.current?.close().catch(() => {}); }, [stop]);
  // Hidden behind the carousel: the sound stops; a sync or a lyrics placement in progress goes on and ends by itself.
  useEffect(() => { if (!active) stop(); }, [active, stop]);


  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 3500);
    return () => clearTimeout(id);
  }, [note]);

  /** Import the official audio. `driveId`: picked from Google Drive, so it can be fetched again anywhere. */
  const pickAudio = async (f: File, driveId?: string) => {
    const token = ++ioRef.current;
    syncRef.current?.abort();
    stop();
    setErr(null); setNote(null);
    setAudioBlob(f);
    setAudioBuf(null);
    setPeaks([]);
    // Same file again (lost from this device, or another computer): the lyrics timing and the sync stay.
    // Another file: its timings are void; the pasted lyrics stay.
    const same = project.audioSize === f.size && project.audioName === f.name;
    // Another audio replaces this one: the previous file of the release goes to the Drive's bin (if no other
    // release uses it), so its Audios folder never piles up versions.
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
    const patch: Partial<VideoSettings> = { source: info };
    // A phone that says nothing about its colours films standard SDR.
    const colour = info.colour === "unknown" && info.kind === "phone" ? "sdr" : info.colour;
    if (cur.grade && !fresh) { setV(patch); return; } // an older video read again: its grade stays as set
    if (colour === "log" && info.profile) {
      // Log: the camera's conversion, the look LUT and the sliders of the previous video (same camera, most likely).
      const prev = cur.grade?.profile !== "none" && cur.grade?.profile !== "hlg" && cur.grade?.profile !== "pq" ? cur.grade : undefined;
      patch.grade = { ...NEUTRAL_GRADE, ...(prev ?? {}), profile: info.profile, lut: prev?.lut ?? lastLut() };
    } else if (colour === "hdr" && info.profile) {
      // HDR: brought down to SDR, no look LUT (made for log footage) and no log sliders.
      patch.grade = { ...NEUTRAL_GRADE, profile: info.profile };
    } else if (colour === "sdr") {
      // Standard video: no log conversion, no LUT; the simple sliders are there, all at zero (the picture as it is).
      patch.grade = { ...NEUTRAL_GRADE, profile: "rec709" };
    }
    setV(patch);
  };
  // Standard SDR video: no log conversion, no LUT, nothing applied (sliders at zero) unless turned back on by hand.
  // Also puts right a video graded by an older version (LUT, vignette and grain copied from a log video).
  const sdrSource = settings.source?.colour === "sdr" || (settings.source?.kind === "phone" && settings.source.colour === "unknown");
  useEffect(() => {
    const g = settings.grade;
    if (sdrSource && g && !g.sdrOverride && (g.lut || g.profile !== "rec709")) setV({ grade: { ...NEUTRAL_GRADE, profile: "rec709" } });
  }, [sdrSource, settings.grade]); // eslint-disable-line react-hooks/exhaustive-deps

  // Videos imported before the detection existed (or before it read the duration): read them once.
  useEffect(() => {
    if (videoBlob && !onCopy && (!settings.source || settings.source.duration === undefined)) void describeVideo(videoBlob, false);
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
  const nextClipName = () => `Video ${Math.max(clips.length, ...clips.map((c) => Number(/^Video (\d+)$/.exec(c.name)?.[1] ?? 0))) + 1}`;
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
  /** New clip on the same release: same song and segment, fresh camera take. */
  const addVideo = async () => {
    syncRef.current?.abort();
    stop();
    const id = uid();
    const name = nextClipName();
    const copied = !!audioBlob; // the audio is the project's: the new video uses it as is
    const cur = settingsRef.current;
    onProject((p) => ({
      ...p,
      videos: [
        ...clipsOf(p),
        {
          ...cur,
          id,
          name,
          audioName: copied ? cur.audioName : undefined,
          // The camera file is the new video's own: nothing of the previous one (its details, its Drive copy).
          videoName: undefined,
          videoSize: undefined,
          source: undefined,
          drive: undefined,
          offset: 0,
          score: undefined,
          musicStart: undefined,
          musicEnd: undefined,
          anchors: undefined,
          takes: undefined,
          linked: false,
        },
      ],
      videoId: id,
    }));
    onSaveNow();
  };

  const [clipDialog, setClipDialog] = useState<null | "rename" | "delete">(null);
  /** Shown name of a video: the automatic "Video 2" in the interface language. */
  const clipName = (c: VideoSetup) => { const m = /^Video (\d+)$/.exec(c.name); return m ? t("Video {n}", { n: m[1] }) : c.name; };
  const renameClip = (name: string) => {
    const n = name.trim();
    if (!n) return;
    onProject((p) => ({ ...p, videos: clipsOf(p).map((c) => (c.id === clip.id ? { ...c, name: n } : c)) }));
    onSaveNow();
  };
  /** Remove this video from the release: its camera file and its own settings. The audio and the lyrics stay. */
  const deleteClip = async () => {
    if (clips.length < 2) return;
    syncRef.current?.abort();
    stop();
    const id = clip.id;
    const rest = clips.filter((c) => c.id !== id);
    onProject((p) => ({ ...p, videos: clipsOf(p).filter((c) => c.id !== id), videoId: rest[Math.max(0, clips.indexOf(clip) - 1)].id }));
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


  const onDropFile = (f: File | undefined) => {
    if (!f) return;
    if (f.type.startsWith("video/") || /\.(mp4|mov|webm|m4v|avi)$/i.test(f.name)) void pickVideo(f);
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
    if (playReturnRef.current && playStartRef.current !== null) setHead(playStartRef.current);
  };
  const play = async () => {
    // Not before the video can play: a click would otherwise start everything later, by surprise.
    if (!audioBuf || (videoUrl && !playerReady)) return;
    const token = ++playToken.current;
    const ctx = getCtx();
    await ctx.resume();
    if (token !== playToken.current) return;
    stop(); // a start that waited is dropped when another start or a stop came meanwhile
    const mine = ++playToken.current;
    const cfg = settingsRef.current;
    const until = Math.min(audioBuf.duration, cfg.crop.start + cfg.crop.duration);
    let from = head >= until - 0.15 || head < cfg.crop.start ? cfg.crop.start : head;
    playStartRef.current = from;
    const cfgStart = cfg.crop.start;
    const from0 = from;
    // The sound is heard this much after it is played (the phone's output, Bluetooth headphones…): the picture shows
    // what is heard, not what was just sent.
    const ac = ctx as AudioContext & { outputLatency?: number };
    const lat = Math.min(0.5, Math.max(0, (ac.outputLatency ?? 0) + (ac.baseLatency ?? 0)));
    // No camera file: only the sound plays, at once.
    const el = videoUrl && fileClip.current === clip.id ? videoRef.current : null;
    if (el) {
      el.muted = true;
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
      if (!el.paused) from = Math.min(until - 0.05, Math.max(cfg.crop.start, el.currentTime + cfg.offset + lat));
    }
    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    // A short fade in (and out at the stop), as music apps do: no click when it starts or stops.
    const fade = ctx.createGain();
    fade.gain.setValueAtTime(0, ctx.currentTime);
    fade.gain.linearRampToValueAtTime(1, ctx.currentTime + FADE);
    src.connect(fade);
    fade.connect(ctx.destination);
    originRef.current = ctx.currentTime;
    src.start(0, from, until - from);
    sourceRef.current = src;
    fadeRef.current = fade;
    if (el && el.paused) void el.play().catch(() => {});
    setPlaying(true);
    const tick = () => {
      const now = from + (ctx.currentTime - originRef.current);
      if (now >= until) { setHead(playReturnRef.current ? from0 : until); stop(); return; }
      // The playhead and the lyrics follow what is heard (the sound sent, minus the output's delay).
      const heard = Math.max(cfgStart, now - lat);
      setHead(heard);
      if (el) {
        // What is heard right now, in the camera file's time.
        const target = Math.max(0, heard - settingsRef.current.offset);
        const diff = target - el.currentTime; // + : the picture is behind
        // A big gap: jump there. A small one: the picture runs a little faster or slower until it is caught up
        // (no visible jumps).
        if (Math.abs(diff) > 0.4) { el.currentTime = target; el.playbackRate = 1; }
        else el.playbackRate = Math.abs(diff) < 0.02 ? 1 : Math.min(1.1, Math.max(0.9, 1 + diff * 0.8));
      }
      drawAt(heard);
      // Measure of the sync while playing (console, debug level): video behind (+) or ahead (−) of the sound.
      if (el && performance.now() - lastLog > 1000) {
        lastLog = performance.now();
        const target = heard - settingsRef.current.offset;
        console.debug(`[sync] video ${((target - el.currentTime) * 1000).toFixed(0)} ms behind · rate ${el.playbackRate.toFixed(3)} · readyState ${el.readyState} · audio output delay ${Math.round(lat * 1000)} ms`);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    let lastLog = 0;
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
  const autoSync = async () => {
    const official = audioBuf;
    const recording = videoBlob;
    if (!official || !recording) return;
    syncRef.current?.abort();
    stop();
    void askNotifyPermission(); // inside the click: lets the browser tell the user when the analysis is over
    let outcome: { title: string; body: string } | null = null;
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
      let clip: { samples: Float32Array; rate: number } | null = null;
      // 1. The browser's decoder, on the whole file: quick, but only for a file that fits in memory.
      if (recording.size <= SYNC_DECODE_MAX) {
        try {
          const vbuf = await Promise.race([
            decodeAudio(getCtx(), recording),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("decode")), 15000)),
          ]);
          clip = { samples: monoOf(vbuf), rate: vbuf.sampleRate };
        } catch { /* next way */ }
      }
      // 2. ffmpeg reading the sound track only (a camera file of several GB, sound in PCM…): seconds.
      if (!clip && !ac.signal.aborted) {
        try {
          const RATE = 22050;
          const raw = await ffmpegAlone(recording, ["-i", "/in/source", "-map", "0:a:0", "-vn", "-ac", "1", "-ar", String(RATE), "-f", "f32le", "sound.raw"],
            "sound.raw", Math.max(1, videoRef.current?.duration || videoDur || 60), (p) => setSyncPct(p), ac.signal);
          const bytes = raw.byteOffset % 4 ? raw.slice() : raw;
          const samples = new Float32Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
          if (samples.length > RATE) clip = { samples, rate: RATE };
        } catch (e) {
          if (ac.signal.aborted) throw e;
          console.info("[sync] sound not read by ffmpeg", e);
        }
      }
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
        setErr(t("No match found in the official audio. Check it is the right track, or sync by ear."));
        outcome = { title: t("Sync failed"), body: t("No match found in the official audio. Check it is the right track, or sync by ear.") };
      } else {
        const takes = r.takes.map((k) => ({ offset: round2(k.offset), musicStart: round2(k.musicStart), musicEnd: round2(k.musicEnd) }));
        const kept = takes.length > 1 ? takes : undefined;
        setV({ score: round2(r.score), anchors: r.anchors, takes: kept });
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
        const msg = reading ? t("The video has no readable audio track. Sync it manually.") : t("The analysis failed. Sync it by ear.");
        setErr(msg);
        outcome = { title: t("Sync failed"), body: msg };
      }
    }
    if (outcome && !ac.signal.aborted) notify(outcome.title, outcome.body);
    if (syncRef.current === ac) syncRef.current = null;
    setSyncBusy(false);
    setSyncPct(0);
  };

  // ---- audio ↔ video link ----
  /**
   * Where the segment may sit while linked: the whole video, or, when it holds several takes, the
   * part between the neighbouring takes (what was filmed before and after the music of this take stays reachable).
   */
  const linkRangeOf = (v: Pick<VideoSettings, "offset" | "musicStart" | "musicEnd" | "takes">): [number, number] | null => {
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
    return hi - lo >= 1 ? [lo, hi] : null;
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
  const toggleFull = (on: boolean) => { setFullLeaving(false); setFull(on); };
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
  /** The studio's options (draws, preview, export format): in the head on a computer, under the picture on a phone. */
  /** Zoom of the waveform, for precise edges: also a pinch, or ctrl + wheel on a computer. */
  const zoomEl = (where = "") => (
    <div className={"wave-zoom " + where} role="group" aria-label={t("Zoom of the waveform")}>
      <button className="btn icon sm" aria-label={t("Zoom out")} disabled={!view} onClick={() => { const v = viewOf(); zoomTo(v.d * 2, v.s + v.d / 2); }}><Icon name="minus" size={12} /></button>
      <button className="btn icon sm" aria-label={t("Zoom in")} onClick={() => { const v = viewOf(), c = settingsRef.current.crop; const mid = view ? v.s + v.d / 2 : c.start + c.duration / 2; zoomTo(v.d / 2, mid); }}><Icon name="plus" size={12} /></button>
      <button className="btn sm wave-fit" onClick={fitView} title={t("Show the segment large, or the whole track")}><span className="lbl-long">{view ? t("Whole track") : t("Fit segment")}</span><span className="lbl-short">{view ? t("All") : t("Fit")}</span></button>
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

  const toggleLink = () => {
    const cur = settingsRef.current;
    if (cur.linked) { setV({ linked: false }); return; }
    const range = linkRangeOf(cur);
    const crop = range ? fitCrop(cur.crop.start, cur.crop.duration, range) : cur.crop;
    setV({ linked: true, crop });
    setHead(crop.start);
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
  const [view, setView] = useState<{ s: number; d: number } | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const viewOf = () => viewRef.current ?? { s: 0, d: audioBuf?.duration ?? 1 };
  useEffect(() => { setView(null); }, [audioBuf]);
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
  // A segment moved out of sight (another version, a take): the view follows it.
  useEffect(() => {
    const v = viewRef.current, c = settings.crop;
    if (!v || !audioBuf) return;
    if (c.start + c.duration < v.s || c.start > v.s + v.d) setView({ s: clamp(c.start + c.duration / 2 - v.d / 2, 0, audioBuf.duration - v.d), d: v.d });
  }, [settings.crop.start, settings.crop.duration]); // eslint-disable-line react-hooks/exhaustive-deps

  /** "press": down inside the segment, not moved yet: a click places the playhead, a drag moves the segment.
   *  "pan": down outside it, zoomed: a drag slides the view (a click does nothing: the segment never jumps). */
  const dragWave = useRef<null | { mode: "start" | "end" | "move" | "offset" | "head" | "press" | "pan" | "none" | "pinch"; x: number; px: number; start: number; duration: number; vs: number; vd: number; dist?: number; mid?: number }>(null);
  const pointers = useRef(new Map<number, number>());
  const wavePos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1);
  };
  const waveDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!audioBuf) return;
    stop();
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, e.clientX);
    const rect = e.currentTarget.getBoundingClientRect();
    const v = viewOf();
    // Two fingers: pinch to zoom, around the middle of the fingers.
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      dragWave.current = { mode: "pinch", x: 0, px: 0, start: 0, duration: 0, vs: v.s, vd: v.d, dist: Math.max(10, Math.abs(a - b)), mid: v.s + (((a + b) / 2 - rect.left) / rect.width) * v.d };
      return;
    }
    const f = wavePos(e);
    const cfg = settingsRef.current;
    const px = e.clientX;
    const xOf = (t: number) => rect.left + ((t - v.s) / v.d) * rect.width;
    const near = (t: number, r = 6) => Math.abs(e.clientX - xOf(t)) <= r;
    const t = v.s + f * v.d;
    const base = { x: f, px, vs: v.s, vd: v.d };
    // Top strip of the violet "video available" band: slide it to move the sync by hand.
    if (!cfg.linked && videoBlob && videoDur > 0 && (e.clientY - rect.top) / rect.height < 0.2 && t >= cfg.offset && t <= cfg.offset + videoDur) {
      dragWave.current = { mode: "offset", ...base, start: cfg.offset, duration: 0 };
      return;
    }
    const seg = { ...base, start: cfg.crop.start, duration: cfg.crop.duration };
    const end = cfg.crop.start + cfg.crop.duration;
    // The playhead first (a thin line inside the segment), then the edges (each one crops its side), then the segment.
    if (near(head) && head > cfg.crop.start + 0.05 && head < end - 0.05) dragWave.current = { mode: "head", ...seg };
    else if (near(cfg.crop.start, 9) && (!near(end, 9) || Math.abs(e.clientX - xOf(cfg.crop.start)) <= Math.abs(e.clientX - xOf(end)))) dragWave.current = { mode: "start", ...seg };
    else if (near(end, 9)) dragWave.current = { mode: "end", ...seg };
    else if (t > cfg.crop.start && t < end) dragWave.current = { mode: "press", ...seg };
    else dragWave.current = { mode: viewRef.current ? "pan" : "none", ...seg };
  };  /**
   * Lyrics and hook tracks: drag anywhere to move the playhead; a click on a caption goes to its start,
   * a click elsewhere puts the playhead there. `onCue`: also called for a click on a caption.
   */
  const scrubRef = useRef<{ px: number; at: number | null; moved: boolean } | null>(null);
  const scrub = (onCue?: () => void) => {
    const timeOf = (el: HTMLElement, x: number) => {
      const r = el.getBoundingClientRect();
      const cfg = settingsRef.current;
      return round2(cfg.crop.start + clamp((x - r.left) / r.width, 0, 1) * Math.max(0.1, cfg.crop.duration - 0.05));
    };
    return {
      onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
        stop();
        e.currentTarget.setPointerCapture(e.pointerId);
        const cue = (e.target as HTMLElement).closest<HTMLElement>("[data-at]");
        scrubRef.current = { px: e.clientX, at: cue ? Number(cue.dataset.at) : null, moved: false };
      },
      onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
        const d = scrubRef.current;
        if (!d) return;
        if (!d.moved && Math.abs(e.clientX - d.px) < 4) return;
        d.moved = true;
        setHead(timeOf(e.currentTarget, e.clientX));
      },
      onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => {
        const d = scrubRef.current;
        scrubRef.current = null;
        if (!d || d.moved) return;
        if (d.at !== null) { setHead(round2(d.at)); onCue?.(); }
        else setHead(timeOf(e.currentTarget, e.clientX));
      },
      onPointerCancel: () => { scrubRef.current = null; },
    };
  };
  /** Time under the pointer, kept inside the segment (where the playhead lives). */
  const headAt = (f: number) => {
    const cfg = settingsRef.current, v = viewOf();
    return round2(clamp(v.s + f * v.d, cfg.crop.start, cfg.crop.start + cfg.crop.duration - 0.05));
  };
  const waveMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, e.clientX);
    const d = dragWave.current;
    if (!d || !audioBuf) return;
    const dur = audioBuf.duration;
    if (d.mode === "pinch") {
      if (pointers.current.size < 2) return;
      const [a, b] = [...pointers.current.values()];
      const span = clamp(d.vd * (d.dist! / Math.max(10, Math.abs(a - b))), Math.min(2, dur), dur);
      if (span >= dur - 1e-3) { setView(null); return; }
      const k = (d.mid! - d.vs) / d.vd;
      setView({ s: clamp(d.mid! - k * span, 0, dur - span), d: span });
      return;
    }
    const f = wavePos(e);
    if (d.mode === "none") return;
    if (d.mode === "head") { setHead(headAt(f)); return; }
    if (d.mode === "press") {
      if (Math.abs(e.clientX - d.px) < 4) return;
      d.mode = "move"; // it is a drag: the segment moves
    }
    const delta = (f - d.x) * d.vd;
    if (d.mode === "pan") { setView({ s: clamp(d.vs - delta, 0, dur - d.vd), d: d.vd }); return; }
    const bounds = boundsOf(settingsRef.current);
    // The preview follows the edge being dragged: the picture shown is the one under that edge.
    if (d.mode === "offset") {
      // The video may start before the song (negative offset) or end after it.
      setV({ offset: round2(clamp(d.start + delta, 1 - videoDur, Math.max(0, dur - 1))) });
    } else if (d.mode === "start") {
      // The left edge crops the start: the end stays where it is.
      const endT = d.start + d.duration;
      const start = round2(clamp(d.start + delta, bounds[0], endT - 1));
      setV({ crop: { start, duration: round2(endT - start) } });
      setHead(start);
    } else if (d.mode === "end") {
      const duration = clamp(d.duration + delta, 1, Math.max(1, bounds[1] - d.start));
      setV({ crop: { start: d.start, duration: round2(duration) } });
      setHead(round2(Math.max(d.start, d.start + duration - 0.1)));
    } else {
      const crop = fitCrop(d.start + delta, d.duration, bounds);
      setV({ crop });
      setHead(crop.start);
    }
  };
  const waveUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    pointers.current.delete(e.pointerId);
    const d = dragWave.current;
    if (d?.mode === "pinch" && pointers.current.size) return; // one finger still down: the pinch ends with it
    dragWave.current = null;
    if (d?.mode === "press") setHead(headAt(wavePos(e))); // a click inside the segment: the playhead goes there
  };
  // Trackpad: pinch (ctrl + wheel) zooms around the pointer, a sideways swipe slides the view. A plain vertical
  // wheel scrolls the page, as anywhere else.
  useEffect(() => {
    const c = waveRef.current;
    if (!c || !audioBuf) return;
    const h = (e: WheelEvent) => {
      const r = c.getBoundingClientRect();
      const v = viewOf();
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomTo(v.d * Math.exp(e.deltaY * 0.012), v.s + clamp((e.clientX - r.left) / r.width, 0, 1) * v.d);
      } else if (viewRef.current && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        setView({ s: clamp(v.s + (e.deltaX / r.width) * v.d, 0, audioBuf.duration - v.d), d: v.d });
      }
    };
    c.addEventListener("wheel", h, { passive: false });
    return () => c.removeEventListener("wheel", h);
  }, [audioBuf]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The loudest sample of the track: the zoomed waveform is drawn on the same scale as the overview. */
  const peakMax = useMemo(() => {
    if (!audioBuf) return 1;
    const ch = audioBuf.getChannelData(0);
    let m = 1e-9;
    for (let i = 0; i < ch.length; i += 2) { const x = Math.abs(ch[i]); if (x > m) m = x; }
    return m;
  }, [audioBuf]);
  // The waveform is drawn at the size it is shown, in screen pixels (Retina included): never stretched, always sharp.
  const [waveBox, setWaveBox] = useState({ w: 0, dpr: 1 });
  useEffect(() => {
    const c = waveRef.current;
    if (!c) return;
    const ro = new ResizeObserver(() => setWaveBox({ w: Math.round(c.clientWidth), dpr: window.devicePixelRatio || 1 }));
    ro.observe(c);
    return () => ro.disconnect();
  }, [audioBuf]);
  useEffect(() => {
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
    const vid = css.getPropertyValue("--video").trim() || "#a184ff";
    const mus = css.getPropertyValue("--music").trim() || "#4fffb0";
    g.fillStyle = "#16161c";
    g.fillRect(0, 0, W, H);
    const v = view ?? { s: 0, d: dur };
    const X = (t: number) => ((t - v.s) / v.d) * W;
    const x0 = X(settings.crop.start);
    const x1 = X(Math.min(dur, settings.crop.start + settings.crop.duration));
    // Where the camera video exists on the official track.
    if (videoBlob && videoDur > 0) {
      const v0 = clamp(X(settings.offset), 0, W);
      const v1 = clamp(X(settings.offset + videoDur), 0, W);
      g.fillStyle = vid;
      g.globalAlpha = 0.14;
      g.fillRect(v0, 0, Math.max(0, v1 - v0), H);
      g.globalAlpha = 1;
      g.fillRect(v0, 0, Math.max(0, v1 - v0), 15);
      if (settings.musicStart != null && settings.musicEnd != null) {
        const m0 = clamp(X(settings.offset + settings.musicStart), 0, W);
        const m1 = clamp(X(settings.offset + settings.musicEnd), 0, W);
        g.fillStyle = mus;
        g.fillRect(m0, H - 4, Math.max(0, m1 - m0), 4);
      }
    }
    g.fillStyle = accent; // the segment: a faint ground of the accent
    g.globalAlpha = 0.09;
    g.fillRect(x0, 0, Math.max(0, x1 - x0), H);
    g.globalAlpha = 1;
    // One bar per 3 px of screen, snapped to whole pixels: crisp at any width. Zoomed in, read from the samples
    // themselves (the overview's 600 points would only give blocks).
    g.fillStyle = "#6f6e78";
    const step = 3, n = Math.max(1, Math.floor(W / step));
    const fine = !!view && v.d / dur < 0.5;
    const ch = fine ? audioBuf.getChannelData(0) : null;
    const sr = audioBuf.sampleRate;
    for (let i = 0; i < n; i++) {
      let val = 0;
      if (ch) {
        const a = Math.floor((v.s + (i / n) * v.d) * sr), b = Math.min(ch.length, Math.max(a + 1, Math.floor((v.s + ((i + 1) / n) * v.d) * sr)));
        for (let k = a; k < b; k += 4) { const x = Math.abs(ch[k]); if (x > val) val = x; }
        val /= peakMax;
      } else {
        const a = Math.floor(((v.s + (i / n) * v.d) / dur) * peaks.length), b = Math.max(a + 1, Math.floor(((v.s + ((i + 1) / n) * v.d) / dur) * peaks.length));
        for (let k = a; k < b && k < peaks.length; k++) val = Math.max(val, peaks[k]);
      }
      const h = Math.max(1, Math.round(Math.min(1, val) * (H - 18)));
      g.fillRect(i * step, Math.round((H - h) / 2), 2, h);
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
    g.fillStyle = head0;
    g.fillRect(X(head) - 1, 0, 2, H);
    if (videoBlob && videoDur > 0) {
      const v0 = clamp(X(settings.offset), 0, W);
      if (clamp(X(settings.offset + videoDur), 0, W) - v0 > 56) {
        g.fillStyle = "#0c0c0e";
        g.font = "600 10px ui-monospace, 'JetBrains Mono', monospace";
        g.textBaseline = "middle";
        g.fillText("VIDEO", Math.round(v0 + 6), 8);
      }
    }
  }, [peaks, settings.crop, settings.offset, settings.musicStart, settings.musicEnd, settings.linked, settings.takes, head, audioBuf, videoBlob, videoDur, waveBox, view, peakMax]);

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
  const placeWords = (heard: LyricWord[], src: string, p: Project, segFrom: number, segTo: number): { words: LyricWord[]; info: string } => {
    const written = writtenOf(src, p);
    if (!written.trim()) return { words: [], info: t("No lyrics: paste them to show them on the video.") };
    // Never words "as heard": without a match there are no lyrics rather than wrong ones.
    const miss = { words: [], info: t("Your lyrics could not be placed on this audio. Check it is the same song, or set the language.") };
    if (src === "song" || src === "all") {
      const aligned = alignSong(written, heard);
      return aligned
        ? { words: aligned.words, info: t("Your lyrics are synced on the whole song: {n} words, {p}% recognised in the audio", { n: aligned.words.length, p: Math.round(aligned.coverage * 100) }) }
        : miss;
    }
    const inSeg = heard.filter((x) => x.e > segFrom && x.s < segTo);
    const aligned = inSeg.length ? alignLyrics(written, inSeg) : null;
    if (!aligned) return miss;
    return {
      words: [...heard.filter((x) => x.e <= segFrom || x.s >= segTo), ...aligned.words].sort((x, y) => x.s - y.s),
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
    onProject((x) => ({ ...x, lyricWords: fresh ? r.words : keepManual(x.lyricWords ?? [], r.words), lyricsPlacedFrom: writtenOf(src, p), lyricsAlignV: LYRICS_ALIGN_V }));
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

  /** The written lyrics on the official audio only. They do not depend on the video: changing it never moves them. */
  const syncLyrics = async () => {
    let next = project;
    if (writtenSrc === "song" && !lyricsLinked && paste.trim() !== (project.songLyrics ?? "").trim()) {
      const text = paste.trim();
      next = { ...project, songLyrics: text, heardWords: project.heardWords };
      onProject((p) => ({ ...p, songLyrics: text }));
    }
    if (!hasLyrics || !audioBuf) return;
    if (next.heardWords?.length) resyncLyrics(writtenSrc, next);
    else await generateLyrics(audioBuf, next, writtenSrc);
  };


  /**
   * Hear the whole track, window by window (the speech engine reports no progress inside one window):
   * the windows of the post's segment go first, and the words show up as each window is done.
   * Runs by itself when the official audio is imported.
   */
  const generateLyrics = async (buf: AudioBuffer | null = audioBuf, proj: Project = project, src = writtenSrc) => {
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
    const heard: LyricWord[] = [];
    let outcome: { title: string; body: string } | null = null;
    try {
      for (let k = 0; k < order.length; k++) {
        const i = order[k];
        const [a, b] = wins[i];
        const samples = await prepareAudio(buf, a, b);
        const words = cleanHeard(await transcribe(samples, { model, language, base: a, onStep: setGenStep, onProgress: setGenPct, signal: ac.signal }));
        if (ac.signal.aborted) return;
        // The overlap between two windows belongs to the one that hears it whole (its middle).
        const lo = i === 0 ? -Infinity : a + LYRICS_LAP / 2;
        const hi = i === wins.length - 1 ? Infinity : b - LYRICS_LAP / 2;
        heard.push(...words.filter((w) => { const m = (w.s + w.e) / 2; return m >= lo && m < hi; }));
        heard.sort((x, y) => x.s - y.s);
        setGenDone((k + 1) / order.length);
      }
      if (!heard.length) {
        const msg = t("No words were heard in this track. Try a more accurate model or set the language.");
        setErr(msg);
        outcome = { title: t("Lyrics not found"), body: msg };
      } else {
        const { words, info } = placeWords(heard, src, proj, segFrom, segTo);
        // The heard words are kept: editing the written lyrics re-places them without a new analysis.
        onProject((p) => ({ ...p, heardWords: heard, lyricWords: keepManual(p.lyricWords ?? [], words), lyricsPlacedFrom: writtenOf(src, proj) }));
        if (words.length && !settingsRef.current.captions) setV({ captions: true });
        setGenInfo(info);
        outcome = { title: t("Lyrics ready"), body: info };
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

  const cancelLyrics = () => { genRef.current?.abort(); genRef.current = null; setGenBusy(false); setGenStep(null); };

  /** "Clear the timing" asked: what goes is said first (it is shared by the release's videos). */
  const [clearAsk, setClearAsk] = useState(false);
  const clearLyrics = () => {
    const cfg = settingsRef.current;
    const a = cfg.crop.start, b = cfg.crop.start + cfg.crop.duration;
    onProject((p) => ({ ...p, lyricWords: (p.lyricWords ?? []).filter((x) => x.e <= a || x.s >= b) }));
    setGenInfo(null);
    onSaveNow();
  };

  // ---- export ----
  /** Last resort when the browser cannot encode MP4 itself: record a hidden playback in real time. */
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
    const rec = new MediaRecorder(new MediaStream([...canvas.captureStream(EXPORT_FPS).getVideoTracks(), ...dest.stream.getAudioTracks()]),
      mime ? { mimeType: mime, videoBitsPerSecond: 10_000_000 } : undefined);
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
    void askNotifyPermission();
    const ac = new AbortController();
    exportRef.current = ac;
    setErr(null); setNote(null); setExporting(true); setExpMode(null); setExp({ p: 0, step: "audio" });
    const [W, H] = OUT_SIZE(cfg.format);
    // The date and time at the end: two exports of the same video never take each other's name.
    const name = safeName(`${project.name || "Rollout"} ${clip.name}${suffix ? ` ${suffix}` : ""} ${stamp()}`);
    let source: { frameAt: (t: number) => Promise<Picture | null>; close: () => void; codec: string } | null = null;
    let stopPlayer = () => {};
    const el = document.createElement("video");
    el.src = videoUrl;
    el.muted = true;
    el.playsInline = true;
    el.preload = "auto";
    try {
      await whenReady(el);
      let blob: Blob | null = null, ext = "mp4";
      if (await mp4Support(W, H, audioBuf.sampleRate, Math.min(2, audioBuf.numberOfChannels))) {
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
          const crop = cropFor(picOf(cfg.frame ?? DEFAULT_VIDEO.frame), ow, oh, W, H, cfg.push ?? 1, cfg.desqueeze);
          const lut = buildGradeLut(cfg.grade, cfg.grade.lut ? look : null, 65);
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
              const crop = ow && oh ? cropFor(picOf(cfg.frame ?? DEFAULT_VIDEO.frame), ow, oh, W, H, cfg.push ?? 1, cfg.desqueeze) : undefined;
              const key = `${clip.id}|${videoBlob.size}|${vs.toFixed(2)}|${ve.toFixed(2)}|${JSON.stringify(crop ?? null)}|${bake ? gradeKey(cfg.grade) : ""}`;
              let proxy = proxyRef.current?.key === key ? proxyRef.current.blob : null;
              if (!proxy) {
                const lut = bake && cfg.grade ? new TextEncoder().encode(toCube(buildGradeLut(cfg.grade, cfg.grade.lut ? look : null, 65), 65)) : undefined;
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
        blob = await exportMp4({
          width: W, height: H, fps: EXPORT_FPS, from, until, audio: audioBuf, signal: ac.signal,
          onProgress: (p, step) => setExp({ p: 0.05 + p * 0.95, step }),
          frame: async (g, time) => {
            const target = time - cfg.offset;
            const inside = target >= -0.001 && (!Number.isFinite(vdur) || target <= vdur + 0.001);
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
            drawScene(g, W, H, pic, time);
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
    const ids = clips.map((c) => c.id);
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
    batchBusy.current = true;
    void exportVideo(true).then((r) => {
      batchBusy.current = false;
      if (r !== "cancelled") next(r);
    });
  }, [batch, clip.id, loadedClip, videoBlob, audioBlob, audioBuf, videoUrl, videoDur, playerReady, look, lookErr]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const pushIsCustom = pushCustom || (!!settings.push && !PUSH_PRESETS.includes(settings.push));
  const timesText = (v: number) => `×${String(Math.round(v * 100) / 100).replace(".", lang === "fr" ? "," : ".")}`;
  // ---- framing on the preview: drag the video or the lyrics, wheel to zoom / resize, double-click to reset ----
  const frame = settings.frame ?? DEFAULT_VIDEO.frame;
  const setFrame = (patch: Partial<VideoFrame>) => setV({ frame: { ...(settingsRef.current.frame ?? DEFAULT_VIDEO.frame), ...patch } });
  /** Offsets kept in bounds, as for the carousel photos (a drag reacts at once in the other direction). */
  const fitFrame = (f: VideoFrame, squeeze = settingsRef.current.desqueeze ?? 1): VideoFrame => {
    const el = videoRef.current, c = canvasRef.current;
    if (!el?.videoWidth || !c) return f;
    const p = clampPic(picOf(f), el.videoWidth * squeeze, el.videoHeight, c.width, c.height);
    return { ...f, ox: p.ox, oy: p.oy };
  };
  const pdrag = useRef<null | { kind: "text" | "hook" | "pic"; sx: number; sy: number; ox: number; oy: number; k: number }>(null);
  const toCv = (e: { clientX: number; clientY: number }) => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    const k = c.width / r.width;
    return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k, k };
  };
  const inBox = (b: TextBox | null, x: number, y: number) => {
    const pad = 30;
    return !!b && x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad;
  };
  /** Which text is under the pointer: the hook (drawn on top), the lyrics, or none. */
  const textAt = (x: number, y: number): "hook" | "text" | null =>
    inBox(hookBox.current, x, y) ? "hook" : inBox(captionBox.current, x, y) ? "text" : null;
  const cvDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!videoBlob) return;
    const c = toCv(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    const kind = textAt(c.x, c.y);
    const f = fitFrame(settingsRef.current.frame ?? DEFAULT_VIDEO.frame);
    const st = kind === "hook" ? hookStyleRef.current : styleRef.current;
    pdrag.current = { kind: kind ?? "pic", sx: e.clientX, sy: e.clientY, ox: kind ? st.x : f.ox, oy: kind ? st.y : f.oy, k: c.k };
  };
  const cvMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = pdrag.current, c = canvasRef.current;
    if (!d || !c) return;
    const dx = (e.clientX - d.sx) * d.k, dy = (e.clientY - d.sy) * d.k;
    if (d.kind !== "pic") {
      let x = clamp(d.ox + (dx / c.width) * 100, 0, 100), y = clamp(d.oy + (dy / c.height) * 100, 0, 100);
      // Snaps to the centre lines, shown in blue while dragging.
      const sv = Math.abs(x - 50) < 1.5, sh = Math.abs(y - 50) < 1.5;
      if (sv) x = 50;
      if (sh) y = 50;
      if (sv !== snap.v || sh !== snap.h) setSnap({ v: sv, h: sh });
      if (d.kind === "hook") setV({ hookStyle: { ...hookStyleRef.current, x, y } });
      else setV({ captionStyle: { ...styleRef.current, x, y } });
    } else {
      setV({ frame: fitFrame({ ...(settingsRef.current.frame ?? DEFAULT_VIDEO.frame), ox: d.ox + dx / c.width, oy: d.oy + dy / c.height }) });
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
    if (kind) {
      const st = kind === "hook" ? hookStyleRef.current : styleRef.current;
      const next = { ...st, size: clamp(Math.round(st.size + dir * 3), 18, 200) };
      setV(kind === "hook" ? { hookStyle: next } : { captionStyle: next });
      return;
    }
    const f = fitFrame(settingsRef.current.frame ?? DEFAULT_VIDEO.frame);
    const z = zoomPic(picOf(f), clamp(+(f.zoom + dir * 0.05).toFixed(2), 0.5, 4));
    setV({ frame: fitFrame({ ...f, zoom: z.zoom, ox: z.ox, oy: z.oy }) });
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
  ];
  const vStyle = useStyleParts<VPart>({
    column: () => rightColRef.current,
    parts: { framing: '[data-sec="video-render"]', lyrics: ".sheet-text", hook: ".sheet-text", color: "#video-color" },
    all: ':scope > [data-sec="video-render"], :scope > .sheet-text, :scope > #video-color',
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
    const key = base + (gradeNow ? `|${colourKey}` : "");
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
      try {
        await new Promise<void>((ok, ko) => { v.onloadeddata = () => ok(); v.onerror = () => ko(new Error("load")); });
        // Big enough to stay sharp on a computer's wide strip (and on a Retina screen), lightly compressed.
        const N = 9, H = 240;
        const cv = document.createElement("canvas");
        const out: string[] = [];
        for (let i = 0; i < N && !off; i++) {
          // Song time → camera time (the take is that far into the song).
          v.currentTime = clamp(from + ((i + 0.5) / N) * len - offset, 0, Math.max(0, v.duration - 0.05));
          await new Promise<void>((ok) => { v.onseeked = () => ok(); window.setTimeout(ok, 2000); });
          if (!v.videoWidth) break;
          cv.width = Math.round((H * v.videoWidth * squeeze) / v.videoHeight); cv.height = H;
          const g = cv.getContext("2d")!;
          g.drawImage(v, 0, 0, cv.width, cv.height);
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
      finally { v.removeAttribute("src"); v.load(); }
    }, wait);
    return () => { off = true; clearTimeout(timer); };
  }, [active, videoUrl, settings.crop.start, segLen, settings.offset, settings.desqueeze, colourKey, lutRev]); // eslint-disable-line react-hooks/exhaustive-deps
  const placed = (project.lyricWords?.length ?? 0) > 0;
  /** Nothing synced yet: one button does both. Afterwards each has its own, so changing the video never touches the lyrics. */
  const firstSync = hasLyrics && !placed && !!videoBlob && settings.score === undefined;
  const hooks = settings.hooks ?? [];
  const setHooks = (list: VideoHook[]) => setV({ hooks: list });
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

  /** Move one edge of a hook by `d` seconds, inside the segment and never shorter than 0.3 s. */
  const nudgeHook = (h: VideoHook, edge: "from" | "to", d: number) => {
    const to = h.to ?? segLen;
    if (edge === "from") editHook(h.id, { from: round2(clamp(h.from + d, 0, to - 0.3)) });
    else editHook(h.id, { to: round2(clamp(to + d, h.from + 0.3, segLen)) });
    stop();
    setHead(round2(settings.crop.start + (edge === "from" ? clamp(h.from + d, 0, to - 0.3) : Math.max(h.from, clamp(to + d, h.from + 0.3, segLen) - 0.3))));
  };
  const current = activeCue(cues, head);
  // A word picked on the timeline (or the timeline let go) brings its line of the lyrics list to the middle of the
  // part of the list on screen (its bottom near the end), once the finger or the mouse is off, never while playing.
  const followList = useRef(false);
  useEffect(() => {
    // (A line picked in the list itself too: it comes to the middle.)
    const down = (e: PointerEvent) => { if ((e.target as HTMLElement).closest?.(".wave, .lyric-track, .hook-track, .dp-track, .lyric-timing .cue-text")) followList.current = true; };
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, []);
  const currentIdx = current ? cues.indexOf(current) : -1;
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
    const c = ed && cues[ed.i];
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

  const retime = (i: number, what: "start" | "end", dir: 1 | -1) => {
    const c = cues[i];
    // Word by word: that mode's own timing (the phrases never move from it).
    const out = c && (mode === "word" ? retimeWordCue : retimeCue)(project.lyricWords ?? [], cues, i, what, dir * 0.1);
    if (!out) return;
    stop();
    // The preview shows the edge that moved.
    setHead(round2(what === "start" ? Math.max(settings.crop.start, c.start + dir * 0.1) : Math.max(c.start, c.end + dir * 0.1 - 0.3)));
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
  const [vctx, setVctx] = useState<{ x: number; y: number } | null>(null);
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
    <div className="video-shell" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); onDropFile(e.dataTransfer.files[0]); }}>
        {/* Left: the library. The release's files (audio, lyrics, this video's camera take), then the text lists
            shared with the carousel (hooks, captions). */}
        <aside className={"col side l video-col-l" + (studioLoading ? " is-loading" : "")}>
          <h2 className="lib-title">{t("Library")}</h2>
          <div className="stack media-list">
            {/* The two files of the clip, drawn the same way: empty, a drop zone with its buttons; filled, the name, one line of facts and a menu. */}
            <input id="audio-file" type="file" accept="audio/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void pickAudio(f); e.target.value = ""; }} />
            <input id="video-file" type="file" accept="video/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void pickVideo(f); e.target.value = ""; }} />
            <input id="video-original" type="file" accept="video/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void pickOriginal(f); e.target.value = ""; }} />
            {/* The release holds the audio (shared by all its videos); this video holds its camera file and its framing. */}
            <div className="tree-head" title={t("The audio and the lyrics belong to the release: every video of it uses them.")}>
              <span className="label">{t("Release")}</span>
            </div>
            {lyricsRow}
            <MediaTile icon="music" label={t("Official audio")} loading={!!audioBlob && !audioBuf}
              name={audioBlob ? (project.audioName ?? settings.audioName ?? t("Official audio")) : null}
              meta={audioBlob && (<>
                {audioBuf ? <span className="mono">{fmtTime(audioBuf.duration)}</span> : <span className="shine">{t("Reading the audio…")}</span>}
                {clips.length > 1 && <span>{t("For its {n} videos", { n: clips.length })}</span>}
                {project.audioDriveId ? <span>Drive</span>
                  : <span className="row" style={{ gap: 4 }}>{t("This computer only")}<Hint text={t("This audio is only on this computer for now: it goes to your Drive by itself as soon as Google Drive can be written to.")} /></span>}
              </>)}
              menu={audioBlob && ((close) => (<>
                <button onClick={() => { close(); document.getElementById("audio-file")?.click(); }}>{t("Replace the audio")}</button>
                <div className="sep" />
                <button className="danger" style={{ color: "var(--danger)" }} onClick={() => { close(); setConfirmRemove(true); }}>{t("Remove audio")}</button>
              </>))}>
              {!audioBlob && audioPick}
              {audioBlob && confirmRemove && (
                <div className="stack" style={{ gap: 6 }}>
                  <span className="xs">{t("Remove it from every video of this release, with the lyrics timing?")}</span>
                  <div className="row">
                    <button className="btn sm danger" onClick={() => void removeAudio()}>{t("Remove")}</button>
                    <button className="btn sm quiet" onClick={() => setConfirmRemove(false)}>{t("Cancel")}</button>
                  </div>
                </div>
              )}
            </MediaTile>
            <div className="tree-branch">
            <div className="tree-head" title={t("The camera file and the framing belong to this video only.")}>
              <span className="label">{t("Video")}</span><span className="tree-name">{clipName(clip)}</span>
            </div>
            {(() => {
              const d = settings.drive ?? {};
              const gb = (n: number) => `${(n / 1e9).toFixed(1).replace(".", lang === "fr" ? "," : ".")} ${t("GB")}`;
              const src = videoBlob ? settings.source : undefined;
              const note = src && [
                [src.device ?? (src.kind === "camera" ? t("Camera") : src.kind === "phone" ? t("Phone") : null), src.curve, src.codec].filter(Boolean).join(" · "),
                src.colour === "log" ? (src.profile
                  ? t("Log footage: converted like a CST in DaVinci, with your look LUT. Adjust it in the Colour tab.")
                  : t("Log footage this app does not convert yet: pick the closest profile in the Colour tab."))
                  : src.colour === "hdr" ? t("HDR footage: brought down to standard SDR for TikTok, without burnt highlights. Adjust it in the Colour tab.")
                  : src.colour === "unknown" ? t("The file does not say how it recorded the colours: if it looks flat and grey, it is log, pick its profile in the Colour tab.")
                  : t("Standard video, used as it is."),
                src.convert ? t("The browser cannot read this format frame by frame: the export converts it first (slower), without losing quality.") : "",
              ].filter(Boolean).join("\n");
              const missing = !videoBlob && !!settings.videoName;
              return (
                <MediaTile icon="film" label={t("Camera video")} name={settings.videoName ?? null} warn={missing} loading={(!!videoBlob && (!videoDur || !playerReady)) || !!driveJob}
                  meta={settings.videoName && (missing
                    ? <span>{d.originalId ? t("On your Drive, not here.") : t("Not in this browser: pick it again.")}</span>
                    : <>
                      {videoDur > 0 ? <span className="mono">{fmtTime(onCopy && src?.duration ? src.duration : videoDur)}</span> : videoBlob && <span className="shine">{t("Opening the camera video…")}</span>}
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
            {/* Past the take's end (the take itself, not its copy: on the copy, the take's own length). */}
            {settings.videoName && videoDur > 0 && settings.crop.start + settings.crop.duration > settings.offset + (onCopy && settings.source?.duration ? settings.source.duration : videoDur) + 0.02 && (
              <p className="notice warn xs">{t("Video stops before the segment ends: extend it or change the offset.")}</p>
            )}
            </div>
          </div>
          <div className="lib-desk">{library}</div>
          <div className="lib-phone">{libraryPhone}</div>
        </aside>
        {/* Middle: the board, like the carousel's: the clip controls, the preview and the timeline. */}
        <main className="col center video-center">
      <div className="video-head studio-head">
        <div className="row nowrap video-title">{releaseTitle}</div>
        <div className="row nowrap video-tools">
          <label className="field h-pick" style={{ margin: 0 }}>{t("Video")}
            <Select className="input" style={{ width: 150 }} value={clip.id}
              onChange={(e) => { onProject((p) => ({ ...p, videoId: e.target.value })); onSaveNow(); }}>
              {clips.map((c) => <option key={c.id} value={c.id}>{clipName(c)}</option>)}
            </Select>
          </label>
          <button className="btn icon h-new" aria-label={t("New video")} title={t("New video: same audio, lyrics and settings, another camera take")} onClick={() => void addVideo()}><Icon name="plus" /></button>
          <div className="slot h-new"><Menu trigger={(_, toggle) => <button className="btn icon quiet" aria-label={t("Video menu")} onClick={toggle}><Icon name="more" /></button>}>
            {(closeMenu) => (<>
              <button onClick={() => { closeMenu(); setClipDialog("rename"); }}>{t("Rename")}</button>
              <button onClick={() => { closeMenu(); duplicateClip(); }} title={t("Same camera file, sync and versions: to change anything on a copy")}>{t("Duplicate")}</button>
              <div className="sep" />
              <button className="danger" style={{ color: "var(--danger)" }} disabled={clips.length < 2}
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
              {clips.map((c) => {
                const on = c.id === clip.id;
                const show = () => { if (!on) { onProject((p) => ({ ...p, videoId: c.id })); onSaveNow(); } };
                return (
                  <div key={c.id} className={"ver-line" + (on ? " on" : "")}>
                    <button className="ver-main" role="menuitemradio" aria-checked={on} onClick={() => { close(); show(); }}>
                      <Icon name="check" size={12} />{clipName(c)}
                    </button>
                    <button className="btn icon sm quiet" aria-label={t("Rename")} title={t("Rename")} onClick={() => { close(); show(); setClipDialog("rename"); }}><Icon name="pencil" size={12} /></button>
                    {clips.length > 1 && <button className="btn icon sm quiet ver-del" aria-label={t("Delete")} title={t("Delete")} onClick={() => { close(); show(); setClipDialog("delete"); }}><Icon name="trash" size={12} /></button>}
                  </div>
                );
              })}
              <div className="sep" />
              <button className="ver-new" title={t("New video: same audio, lyrics and settings, another camera take")} onClick={() => { close(); void addVideo(); }}>
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
              onContextMenu={(e) => { e.preventDefault(); if (!matchMedia("(hover: none)").matches) setVctx({ x: e.clientX, y: e.clientY }); }} />
            {/* The preview's own right-click menu: play, the segment at the playhead, full screen, zones, export. */}
            {vctx && (
              <ContextMenu x={vctx.x} y={vctx.y} onClose={() => setVctx(null)}>
                <div className="label cap truncate">{clipName(clip)}</div>
                <button disabled={!audioBuf || (!!videoUrl && !playerReady && !playing)} onClick={() => (playing ? pause() : void play())}>
                  <Icon name={playing ? "pause" : "play"} size={14} />{playing ? t("Pause") : t("Play")}<kbd>{t("Space")}</kbd></button>
                <button disabled={!audioBuf} onClick={markIn}><Icon name="arrowLeft" size={14} />{t("Start of the segment here")}<kbd>I</kbd></button>
                <button disabled={!audioBuf} onClick={markOut}><Icon name="arrowRight" size={14} />{t("End of the segment here")}<kbd>O</kbd></button>
                <div className="sep" />
                <button disabled={!videoBlob} onClick={() => toggleFull(true)}><Icon name="expand" size={14} />{t("Full screen")}<kbd>F</kbd></button>
                {settings.format !== "16:9" && <button disabled={!videoBlob} onClick={() => setAids({ zones: !aids.zones })}><Icon name={aids.zones ? "zones-off" : "zones"} size={14} />{t("TikTok zones")}<kbd>G</kbd></button>}
                <div className="sep" />
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
          <div className="timeline">
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
                  {!phone && lockEl()}
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
                        <button disabled={!hasLyrics} onClick={() => { closeMenu(); void syncLyrics(); }}
                          title={!hasLyrics ? t("Import the video or paste the lyrics first.") : placed ? t("Place the lyrics again on the audio. Your retouches are kept.") : undefined}>
                          <Icon name="type" size={14} />{placed ? t("Re-place the lyrics") : t("Sync the lyrics")}{hasLyrics && !placed && <span className="tab-dot" />}
                        </button>
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
                {/* Phone: the lock and the zoom above the tracks they act on (on a computer: in the segment's row). */}
                {phone && (
                  <div className="row seg-tools">
                    {lockEl()}
                    <span className="grow" />
                    {zoomEl()}
                  </div>
                )}
                <div className="wave-wrap">
                  <canvas ref={waveRef} className="wave"
                    onPointerDown={waveDown} onPointerMove={waveMove} onPointerUp={waveUp}
                    onPointerCancel={(e) => { pointers.current.delete(e.pointerId); dragWave.current = null; }} />
                </div>
                {hooks.length > 0 && (
                  <div className={"lyric-track hook-track" + (settings.showHooks === false ? " off" : "")} role="group" aria-label={t("Hooks")} {...scrub(() => setTab("hook"))}>
                    {hooks.map((h, i) => (
                      <button key={h.id} className={"cue" + (hookAt(settings, head)?.id === h.id ? " on" : "")}
                        style={{ left: `${(clamp(h.from, 0, segLen) / segLen) * 100}%`, width: `${((clamp(h.to ?? segLen, 0, segLen) - clamp(h.from, 0, segLen)) / segLen) * 100}%` }}
                        title={h.text || t("Hook {n}", { n: i + 1 })} data-at={settings.crop.start + h.from}
                        onClick={(e) => { if (e.detail === 0) { stop(); setTab("hook"); setHead(round2(settings.crop.start + h.from)); } }}>
                        {h.text.replace(/\n/g, " ") || t("Hook {n}", { n: i + 1 })}
                      </button>
                    ))}
                    <span className="lyric-head" style={{ left: `${(clamp(head - settings.crop.start, 0, segLen) / segLen) * 100}%` }} />
                  </div>
                )}
                <div className={"lyric-track" + (settings.captions ? "" : " off")} role="group" aria-label={t("Lyrics of the segment")} {...scrub()}>
                  {cues.map((c, i) => (
                    <button key={i} className={"cue" + (c === current ? " on" : "")} title={`${fmtTime(c.start)} · ${c.text.replace(/\n/g, " ")}`}
                      style={{
                        left: `${(clamp(c.start - settings.crop.start, 0, segLen) / segLen) * 100}%`,
                        width: `${((clamp(c.end, settings.crop.start, end) - clamp(c.start, settings.crop.start, end)) / segLen) * 100}%`,
                      }}
                      data-at={Math.max(settings.crop.start, c.start)}
                      onClick={(e) => { if (e.detail === 0) { stop(); setHead(round2(Math.max(settings.crop.start, c.start))); } }}>
                      {c.text.replace(/\n/g, " ")}
                    </button>
                  ))}
                  {!cues.length && <span className={"muted xs lyric-track-empty" + (genBusy ? " shine" : "")}>{genBusy ? t("Placing the lyrics…") : t("No lyrics on this segment yet: paste them in Lyrics, then Sync.")}</span>}
                  <span className="lyric-head" style={{ left: `${(clamp(head - settings.crop.start, 0, segLen) / segLen) * 100}%` }} />
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
              {cues.length > 0 && (
                <div className="stack" style={{ gap: 4 }}>
                  <div className="cue-row cue-legend muted xs">
                    <span>{t("Starts")}</span><span className="grow row" style={{ gap: 6 }}>{t("Line")} <Hint text={t("Fine-tune each line by 0.1 s. Your retouches are kept when you edit the lyrics or sync again.")} /></span><span>{t("Ends")}</span>
                  </div>
                  <div className="lyric-timing">
                    {cues.map((c, i) => (
                      <div key={i} className={"cue-row" + (c === current ? " on" : "")}>
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
                            <button className="btn sm primary" onMouseDown={(e) => e.preventDefault()} onClick={() => saveCue()}>{t("OK")}</button>
                          </span>
                        ) : (<>
                          <button className="cue-text truncate xs" onClick={() => { stop(); setHead(round2(Math.max(settings.crop.start, c.start))); }}>
                            {c.text.replace(/\n/g, " ⏎ ")}
                          </button>
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
                  {/* Its name, where it is drawn from (list · tags), then its actions as icons: another one, one picked in the list, remove. */}
                  <div className="row nowrap hook-head">
                    <span className="hook-num" title={t("Hook {n}", { n: i + 1 })}>#{i + 1}</span>
                    {hookPools.length > 0 && (
                      <Menu float trigger={(open, toggle) => (
                        <button type="button" className={"input sm pick-btn hook-src-btn" + (open ? " on" : "")} onClick={toggle}
                          aria-label={t("List and tags of this hook")} title={t("List and tags of this hook")}>
                          <span className="truncate">{src.pool?.name ?? ""}{src.ticked.length ? " · " + (src.ticked.length === 1 ? themeLabel(src.ticked[0], t) : t("{n} tags", { n: src.ticked.length })) : ""}</span>
                          <Icon name="chevron" size={13} />
                        </button>
                      )}>
                        {() => (
                          <div className="pick-pane">
                            {/* Two parts: the list, then its tags. */}
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
                              {src.groups.length > 1 ? (
                                <div className="pick-chips" role="group" aria-label={t("Tags")}>
                                  <button className={"pick-chip" + (!src.ticked.length && !src.notTicked.length ? " on" : "")} onClick={() => setTags({ tags: [], not: [] })}>{t("All ({n})", { n: src.count })}</button>
                                  {src.groups.map((g) => (
                                    <TagChip key={g.id || "other"} label={themeLabel(g.id, t)} count={g.items.length}
                                      state={src.ticked.includes(g.id) ? "on" : src.notTicked.includes(g.id) ? "not" : undefined}
                                      onTick={() => setTags(tagStep(src.ticked, src.notTicked, g.id, "tick"))} onNot={() => setTags(tagStep(src.ticked, src.notTicked, g.id, "not"))} />
                                  ))}
                                </div>
                              ) : <p className="muted xs">{t("No tags in this list yet.")}</p>}
                            </div>
                          </div>
                        )}
                      </Menu>
                    )}
                    <span className="grow" />
                    {src.items.length > 0 && (
                      <Menu float trigger={(open, toggle) => (
                        <button className={"btn sm icon quiet" + (open ? " on" : "")} onClick={toggle} aria-label={t("Pick from the list")} title={t("Pick from the list")}><Icon name="list" size={14} /></button>
                      )}>
                        {(close) => (
                          <div className="pick-pane">
                            <div className="pick-list">
                              {src.items.map((x, k) => (
                                <button key={k} className={"pick-line" + (x === h.text ? " on" : "")} onClick={() => { close(); editHook(h.id, fromList(h, x)); }}>
                                  <span className="dd-check" aria-hidden>{x === h.text ? "✓" : ""}</span><span>{x.replace(/\|/g, " ")}</span>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </Menu>
                    )}
                    <button className="btn sm icon quiet hook-del" onClick={() => setHooks(hooks.filter((x) => x.id !== h.id))} aria-label={t("Remove")} title={t("Remove")}><Icon name="trash" size={14} /></button>
                    {src.items.length > 0 && (
                      <button className="btn sm primary hook-gen" onClick={() => drawInto(h.id)} title={t("Another hook from its list and tags")}><Icon name="sparkle" size={13} />{t("Generate")}</button>
                    )}
                  </div>
                  <textarea className="input" rows={2} value={h.text} placeholder={t("Write the hook…")}
                    onChange={(e) => editHook(h.id, { text: e.target.value, link: undefined })} />
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
        <aside className={"col side r video-col-r" + (studioLoading ? " is-loading" : "")} ref={rightColRef}>
          <StyleTabs parts={vParts} part={vPart} onPart={pickVPart} tone="video" />
          {/* How the camera picture fits the post: the first part of the video's style. */}
          <Section id="video-render" title={t("Framing")}>
          {/* Phone's Style page: its title, like the other parts' (the panel's own is hidden there). */}
          <div className="row col-head style-only"><span className="label">{t("Format")}</span><Hint text={t("The shape of the post and how the camera picture fills it. On the preview, drag the picture to reframe it and pinch to zoom.")} /></div>
          <div className="row">
            <button className={"btn sm" + (settings.format !== "16:9" ? " on" : "")} aria-pressed={settings.format !== "16:9"}
              onClick={() => setV({ format: "9:16" })}>9:16</button>
            <button className={"btn sm" + (settings.format === "16:9" ? " on" : "")} aria-pressed={settings.format === "16:9"}
              onClick={() => setV({ format: "16:9" })}>16:9</button>
            <Select className="input sm grow" aria-label={t("Framing")}
              value={(frame.framing ?? "fill") === "fill" ? "fill" : (frame.bars ?? "blur") === "blur" ? "fit-blur" : "fit-black"}
              onChange={(e) => {
                const v = e.target.value;
                setFrame(v === "fill" ? { framing: "fill" } : { framing: "fit", bars: v === "fit-blur" ? "blur" : "black" });
              }}>
              <option value="fill">{t("Fill (crop)")}</option>
              <option value="fit-blur">{t("Fit whole, blurred bars")}</option>
              <option value="fit-black">{t("Fit whole, black bars")}</option>
            </Select>
          </div>
          <div className="row" title={t("An anamorphic lens squeezes the picture across: pick its factor to see it as filmed. It goes with the camera file (all its versions).")}>
            <span className="label">{t("Anamorphic lens")}</span>
            <Select className="input sm grow" aria-label={t("Anamorphic lens")} value={String(settings.desqueeze ?? 1)}
              onChange={(e) => { const k = Number(e.target.value); setV({ desqueeze: k === 1 ? undefined : k, frame: fitFrame(frame, k) }); }}>
              <option value="1">{t("None")}</option>
              {DESQUEEZE.map((k) => <option key={k} value={String(k)}>{`×${String(k).replace(".", lang === "fr" ? "," : ".")}`}</option>)}
            </Select>
          </div>
          <Range label={t("Zoom")} value={frame.zoom} display={`${frame.zoom.toFixed(2)}×`} min={0.5} max={4} step={0.05}
            onChange={(v) => { const z = zoomPic(picOf(frame), v); setFrame(fitFrame({ ...frame, zoom: z.zoom, ox: z.ox, oy: z.oy })); }}
            onReset={() => setFrame({ zoom: 1, ox: 0, oy: 0 })} />
          {/* Progressive zoom: its factor on one line (like the lens), then, when on, what it zooms. */}
          <div className="row" title={t("Zooms in slowly over the whole segment: ×1 on the first frame, up to the chosen factor on the last.")}>
            <span className="label">{t("Progressive zoom")}</span>
            <Select className="input sm grow" aria-label={t("Progressive zoom")} value={pushIsCustom ? "custom" : String(settings.push ?? 0)}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "custom") { setPushCustom(true); if (!settings.push) setV({ push: 1.15 }); return; }
                setPushCustom(false);
                setV({ push: Number(v) || undefined });
              }}>
              {PUSH_PRESETS.map((v) => <option key={v} value={String(v)}>{v ? timesText(v) : t("Off")}</option>)}
              <option value="custom">{t("Custom…")}</option>
            </Select>
          </div>
          {/* Custom: its own factor, on a slider under the menu (up to ×1.3: beyond, it is no longer a slow push). */}
          {pushIsCustom && settings.push && (
            <Range label={t("Strength")} value={settings.push} display={timesText(settings.push)} min={1.01} max={1.3} step={0.01}
              onChange={(v) => setV({ push: Math.round(v * 100) / 100 })} onReset={() => setV({ push: 1.15 })} />
          )}
          {settings.push && (
            <div className="row" role="group" aria-label={t("Progressive zoom")}
              title={t("Inside the video: the picture zooms inside its frame, which keeps its place and size (the bars and the texts around do not move).")}>
              <button className={"btn sm grow" + (!settings.pushIn ? " on" : "")} aria-pressed={!settings.pushIn} onClick={() => setV({ pushIn: undefined })}>{t("The whole frame")}</button>
              <button className={"btn sm grow" + (settings.pushIn ? " on" : "")} aria-pressed={!!settings.pushIn} onClick={() => setV({ pushIn: true })}>{t("Inside the video")}</button>
            </div>
          )}
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

              <Section id="lyrics-style-presets" title={<>{t("Style presets")}{presetOf(presets, captionStyle) && <span className="sec-sub"> · {presetOf(presets, captionStyle)!.name}</span>}</>} open={false}>
                <StylePresets presets={presets} current={captionStyle} onSave={(name) => onSavePreset(name, captionStyle)}
                  onApply={(p) => setV({ captionStyle: withPreset(captionStyle, p) })} onDelete={onDeletePreset} />
              </Section>
              <Section id="lyrics-style-display" title={t("Display")}>
                <div className="row">
                  <button className={"btn sm" + (mode === "phrase" ? " on" : "")} onClick={() => setV({ captionMode: "phrase" })}>{t("Phrase by phrase")}</button>
                  <button className={"btn sm" + (mode === "word" ? " on" : "")} onClick={() => setV({ captionMode: "word" })}>{t("Word by word")}</button>
                </div>
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
                <CaptionStyle
                  sid="lyrics-style"
                  style={captionStyle}
                  defaults={slideStyle}
                  fonts={fonts}
                  onChange={(patch) => setV({ captionStyle: { ...captionStyle, ...patch } })}
                  onPreview={(patch) => setFontPreview(patch ? { which: "caption", patch } : null)}
                  onFonts={onFonts}
                />
                <div className="reset-m"><button className="btn sm quiet" onClick={() => setV({ captionStyle: undefined })} disabled={!settings.captionStyle}>{t("Reset")}</button></div>
                        </div>
          )}
          <div id="video-color" className="stack">
            <div className="row col-head"><span className="label">{t("Colour")}</span><Hint text={t("The look of the whole video: a LUT for log footage, then exposure, contrast and colour, the same on the preview and the export.")} />
              {/* Before / after in one click: the picture as recorded, then the grade again. */}
              {/* The grade on / off in one click (the switch alone: what it does shows on the picture), then Reset
                  (the grade removed), like the other parts' Reset. */}
              {grade && <span className="grow" />}
              {gradesColour(grade) && <Switch checked={!rawView} onChange={(v) => setRawView(!v)} title={t("Grade on / off: the picture as recorded, to compare")} />}
              {grade && <button className="btn sm quiet" onClick={() => { setRawView(false); setV({ grade: undefined }); }} title={t("Remove the grade")}>{t("Reset")}</button>}
            </div>
              <ColorGrade grade={grade} onChange={(g) => setV({ grade: g })} raw={rawView} onRaw={setRawView} lookErr={lookErr}
                sdr={sdrSource}
                onLutStored={(id) => { LOOKS.delete(id); setLutReload((n) => n + 1); }}
                others={clips.filter((c) => c.id !== clip.id).map((c) => ({ id: c.id, name: clipName(c) }))}
                onApplyTo={(ids) => onProject((p) => ({ ...p, videos: clipsOf(p).map((c) => (ids.includes(c.id) ? { ...c, grade } : c)) }))} />
                      </div>
        </aside>
      {/* The player: on the phone's dock; on a computer floating at the bottom of the board (the same one). */}
      {dockSlot && audioBuf && !libraryPage && createPortal(playerEl, dockSlot)}
      {clipDialog === "rename" && (
        <PromptDialog title={t("Rename the video")} label={t("Name")} initial={clipName(clip)} confirmLabel={t("Rename")}
          onSubmit={renameClip} onClose={() => setClipDialog(null)} />
      )}
      {clipDialog === "delete" && (
        <ConfirmDialog danger title={t("Delete this video")} confirmLabel={t("Delete")}
          message={t("“{name}” and its camera file will be removed from this release. The official audio, the lyrics and the other videos stay as they are.", { name: clipName(clip) })}
          onConfirm={() => void deleteClip()} onClose={() => setClipDialog(null)} />
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
            <p className="muted xs">{outW}×{outH} · H.264 + AAC · {EXPORT_FPS} {t("fps")} · {fmtTime(settings.crop.duration)}</p>
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
  icon: string; label: string; name: string | null; warn?: boolean;
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

