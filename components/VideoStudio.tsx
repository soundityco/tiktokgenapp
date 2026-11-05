"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { defaultCaptionStyle, defaultVideo, uid } from "@/lib/defaults";
import { useT } from "@/lib/i18n";
import { signIn } from "next-auth/react";
import { askPersistentStorage, delMedia, getMedia, putMedia } from "@/lib/idb";
import { canWriteDrive, downloadDriveFile, downloadDriveFileProgress, type DriveItem, findInAppFolder, uploadToDrive } from "@/lib/drive";
import DriveBrowser from "./DriveBrowser";
import { activeCue, alignLyrics, alignSong, buildCues, cleanHeard, hasManual, keepManual, parseLyrics, repairOrder, retimeCue } from "@/lib/lyricsAlign";
import { autoLineTimes, decodeAudio, envelopeOf, fmtTime, monoOf, peaksOf, syncAudio } from "@/lib/media";
import { askNotifyPermission, notify, notifyBlocked } from "@/lib/notify";
import { clampPic, drawFramed, drawHelpers, drawStyledText, TextBox, visibleRegion, zoomPic } from "@/lib/render";
import { buildGradeLut, convertsFootage, type CubeLut, drawLook, gradeKey, gradesColour, NEUTRAL_GRADE, parseCube, toCube } from "@/lib/grade";
import { probeVideo } from "@/lib/probe";
import { followLists, hookLink, textItems } from "@/lib/generate";
import { copyRegion, Grader } from "@/lib/gradeGL";
import ColorGrade, { knownLuts, lastLut, rememberLut } from "./ColorGrade";
import { exportMp4, ExportStep, mp4Support, seekVideo } from "@/lib/exportVideo";
import { type Picture, VideoSource } from "@/lib/videoSource";
import { convertSegment, cropFor, grabFrame, type ConvertCrop, type ConvertStep } from "@/lib/convert";
import { ASR_MODELS, AsrModel, AsrStep, prepareAudio, stopTranscribe, transcribe } from "@/lib/transcribe";
import type { LyricWord, PicSettings, Project, StylePreset, TextPool, TextStyle, VideoFrame, VideoHook, VideoSettings, VideoSetup, VideoTake } from "@/lib/types";
import CaptionStyle from "./CaptionStyle";
import { presetOf, StylePresets, withPreset } from "./TextControls";
import Icon from "./Icon";
import { ConfirmDialog, Menu, Modal, PromptDialog, Range, Section } from "./ui";

const RATE = 25;
const PRESETS = [10, 15, 20, 30];
/** Longest stretch of a video listened to in real time when the browser cannot decode its audio (10 min). */
const MAX_CAPTURE = 600;
/** The lyrics are heard in windows of this length (s), overlapping a little so no word is cut. */
const LYRICS_WIN = 28;
const LYRICS_LAP = 2;

const DEFAULT_VIDEO: VideoSettings = defaultVideo();
/** Look LUTs already read on this page (id → LUT). */
const LOOKS = new Map<string, CubeLut>();

/** Clips of a release; old workspaces still carry a single `project.video`. */
function clipsOf(p: Project): VideoSetup[] {
  return p.videos?.length
    ? p.videos
    : [{ ...DEFAULT_VIDEO, id: p.id, name: "Video 1", ...(p.video ?? {}) }];
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
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

function saveBlob(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

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
export default function VideoStudio({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  project,
  hookPools,
  onDrawHook,
  onProject,
  onSaveNow,
  onBack,
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
  onDrawHook: (poolId: string, exclude: string[]) => string | null;
  onProject: (fn: (p: Project) => Project) => void;
  onSaveNow: () => void;
  onBack: () => void;
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
  /** The browser opened the camera file (it can play it): until then the timeline shows it is loading. */
  const [playerReady, setPlayerReady] = useState(false);
  /** The user let the app create files in their Drive (null: not known yet). */
  const [driveWrite, setDriveWrite] = useState<boolean | null>(null);
  /** Transfer with Drive in progress. */
  const [driveJob, setDriveJob] = useState<null | { kind: "send" | "fetch"; p: number }>(null);
  const [driveErr, setDriveErr] = useState<string | null>(null);
  const driveAc = useRef<AbortController | null>(null);
  const [audioBuf, setAudioBuf] = useState<AudioBuffer | null>(null);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [videoDur, setVideoDur] = useState(0);
  const [head, setHead] = useState(settings.crop.start);
  const [playing, setPlaying] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncPct, setSyncPct] = useState(0);
  const [exporting, setExporting] = useState(false);
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
  const [writtenSrc, setWrittenSrc] = useState(project.songLyrics?.trim() || !project.lyrics.length ? "song" : "all");
  const [paste, setPaste] = useState(project.songLyrics ?? "");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [driveOpen, setDriveOpen] = useState(false);
  const [driveBusy, setDriveBusy] = useState(false);
  const pickFromDrive = async (f: DriveItem) => {
    setDriveBusy(true); setErr(null);
    try {
      const blob = await downloadDriveFile(f.id);
      await pickAudio(new File([blob], f.name, { type: blob.type || f.mimeType }), f.id);
    } catch {
      setErr(t("The official audio could not be fetched from Google Drive. Check it is still there, or import it again."));
    } finally {
      setDriveBusy(false);
    }
  };
  /** One official audio per release, shared by all its videos. */
  const projectAudioKey = `audio:project:${project.id}`;
  useEffect(() => { setPaste(project.songLyrics ?? ""); setConfirmRemove(false); }, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const rafRef = useRef(0);
  const originRef = useRef(0);
  const ioRef = useRef(0);
  const syncRef = useRef<AbortController | null>(null);

  const getCtx = useCallback(() => {
    if (!ctxRef.current) ctxRef.current = new AudioContext();
    return ctxRef.current;
  }, []);

  const setV = useCallback((patch: Partial<VideoSettings>) => {
    onProject((p) => {
      const list = clipsOf(p);
      const target = list.find((c) => c.id === clip.id) ?? list[0];
      return { ...p, videos: list.map((c) => (c.id === target.id ? { ...c, ...patch } : c)), videoId: target.id };
    });
  }, [onProject, clip.id]);

  const section = project.lyrics.find((s) => s.id === sectionId) ?? project.lyrics[0];
  const lines = useMemo(
    () => (section ? section.text.split(/\r?\n/).map((text, i) => ({ text, i })).filter((l) => l.text.trim()) : []),
    [section]
  );
  const timed = useMemo(() => {
    if (!section) return [] as { text: string; at: number }[];
    return lines
      .map((l) => ({ text: l.text.trim(), at: section.times?.[l.i] }))
      .filter((l): l is { text: string; at: number } => typeof l.at === "number")
      .sort((a, b) => a.at - b.at);
  }, [section, lines]);

  // Default look of the lyrics; only the font follows the selected carousel slide. The text studio overrides it per clip.
  const slideStyle: TextStyle = useMemo(
    () => defaultCaptionStyle(project.slides[project.selectedSlide]?.style ?? project.slides[0]?.style),
    [project.slides, project.selectedSlide]
  );
  const captionStyle: TextStyle = settings.captionStyle ?? slideStyle;
  const mode = settings.captionMode ?? "phrase";
  const lineChars = settings.lineChars ?? 22;
  const cues = useMemo(
    () => buildCues(project.lyricWords ?? [], mode, { lineChars, from: settings.crop.start, to: settings.crop.start + settings.crop.duration }),
    [project.lyricWords, mode, lineChars, settings.crop.start, settings.crop.duration]
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
    // Lyrics generated from the audio win; hand-placed lines are the fallback.
    if (cues.length) return activeCue(cues, time)?.text ?? null;
    let found: string | null = null;
    for (const l of timed) {
      if (l.at <= time + 0.02) found = l.text;
      else break;
    }
    return found;
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

  // ---- poster: the last graded picture of the clip, shown at once while a big camera file opens ----
  const posterRef = useRef<ImageBitmap | HTMLCanvasElement | null>(null);
  const posterTimer = useRef(0);
  const posterKey = `poster:${clip.id}`;
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
    // No picture from the player yet (Safari, before the first play): the frame read from the file.
    const still = stillRef.current;
    // While playing starts, keep it on screen until the player has its first picture (no black flash).
    if (el && inVideo && el.readyState < 2 && still && still.src === el.currentSrc && (!el.paused || Math.abs(still.at - (time - off)) < 0.08)) {
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
      let f = picOf(cfg.frame ?? DEFAULT_VIDEO.frame);
      // Progressive zoom: ×1 at the start of the segment, `push` on its last frame, around the centre.
      const push = cfg.push ?? 1;
      if (push > 1) f = zoomPic(f, f.zoom * (1 + (push - 1) * clamp((time - cfg.crop.start) / Math.max(0.1, cfg.crop.duration), 0, 1)));
      const grader = graderRef.current;
      const wantGrade = !raw && !pic.graded && gradesColour(cfg.grade);
      if (wantGrade && !grader?.ready && gradePendingRef.current) { console.debug("[grade] waiting for the grade (LUT loading)"); pic = null; }
      else if (wantGrade && grader?.ready && videoLut.current) {
        grader.setLut(videoLut.current, 33);
        // Grade only what the post shows, at the size it is drawn.
        const region = visibleRegion(f, pic.w, pic.h, W, H);
        const s = (f.framing === "fill" ? Math.max(W / pic.w, H / pic.h) : Math.min(W / pic.w, H / pic.h)) * f.zoom;
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
        if (!raw && cfg.grade) drawLook(g, W, H, cfg.grade, Math.round(time * EXPORT_FPS));
        if (preview?.keep && !raw) keepPoster(g.canvas);
      } else if (preview && posterRef.current) g.drawImage(posterRef.current, 0, 0, W, H);
    }
    const text = cfg.captions ? activeRef.current(time) : null;
    const caption = text ? drawStyledText(g, text, styleRef.current, W, H) : null;
    const hook = cfg.showHooks === false ? undefined : hookAt(cfg, time);
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
  aidsRef.current = { zones: aids.zones && settings.format !== "16:9", guideV: aids.guides && snap.v, guideH: aids.guides && snap.h };
  const drawAt = useCallback((time: number) => {
    const c = canvasRef.current;
    const g = c?.getContext("2d");
    if (!c || !g) return;
    const el = videoRef.current;
    const keep = !sourceRef.current && !!el && el.readyState >= 2 && fileClip.current === clipIdRef.current && !!videoUrlRef.current;
    const boxes = drawScene(g, c.width, c.height, pictureOf(el, time), time, { raw: rawRef.current, keep });
    captionBox.current = boxes.caption;
    hookBox.current = boxes.hook;
    drawHelpers(g, c.width, c.height, aidsRef.current);
  }, [drawScene]);

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
    if (sourceRef.current) {
      try { sourceRef.current.stop(); } catch { /* already stopped */ }
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    videoRef.current?.pause();
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
        void getMedia(`poster:${clip.id}`).then(async (p) => {
          if (!p || off || token !== ioRef.current) return;
          try { posterRef.current = await createImageBitmap(p); drawAt(settingsRef.current.crop.start); } catch { /* not a picture */ }
        });
        const [shared, legacy, b] = await Promise.all([getMedia(projectAudioKey), getMedia(`audio:${clip.id}`), getMedia(`video:${clip.id}`)]);
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
        if (b) { fileClip.current = clip.id; setVideoBlob(b); }
        // No camera file: a picture kept by mistake for this video (older versions) is dropped.
        else { posterRef.current = null; void delMedia(`poster:${clip.id}`).catch(() => {}); }
      } catch { /* IndexedDB unavailable */ }
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
  const driveName = (what: string) => `${project.name || "Rollout"} - ${clip.name} - ${what}.mp4`.replace(/[\\/:*?"<>|]+/g, "-");
  const setDrive = (patch: Partial<NonNullable<VideoSettings["drive"]>>) => setV({ drive: { ...(settingsRef.current.drive ?? {}), ...patch } });
  const sendToDrive = async (blob: Blob) => {
    if (driveJob) return;
    const ac = new AbortController();
    driveAc.current = ac;
    setDriveErr(null);
    setDriveJob({ kind: "send", p: 0 });
    try {
      const id = await uploadToDrive(blob, driveName(t("original")), (p) => setDriveJob({ kind: "send", p }), ac.signal);
      setDrive({ originalId: id });
      onSaveNow();
    } catch (e) {
      if (!ac.signal.aborted) {
        console.warn("[drive] upload failed", e);
        setDriveErr(t("Sending to Google Drive failed. Check your connection and try again."));
      }
    } finally {
      if (driveAc.current === ac) driveAc.current = null;
      setDriveJob(null);
    }
  };
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
        const driveId = await uploadToDrive(b, `${lut.name}.cube`, () => {}, new AbortController().signal, "application/octet-stream");
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
    const name = `${project.name || "Rollout"} - ${t("official audio")} - ${project.audioName ?? "audio"}`.replace(/[\\/:*?"<>|]+/g, "-");
    void uploadToDrive(audioBlob, name, () => {}, new AbortController().signal, audioBlob.type || "application/octet-stream", { tktgen: "audio", project: project.id })
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
      await putMedia(`video:${clip.id}`, blob).catch(() => {});
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

  useEffect(() => () => { stop(); syncRef.current?.abort(); genRef.current?.abort(); stopTranscribe(); ctxRef.current?.close().catch(() => {}); }, [stop]);


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

  const pickVideo = async (f: File) => {
    syncRef.current?.abort();
    stop();
    setErr(null);
    // The same camera file again (another browser, data cleared): plug it back, keep the sync and every setting.
    const cur = settingsRef.current;
    if (!videoBlob && cur.videoName === f.name) {
      const info = await probeVideo(f);
      const same = cur.videoSize ? cur.videoSize === f.size
        : !!info.duration && !!cur.source?.duration && Math.abs(info.duration - cur.source.duration) < 0.05;
      if (same) {
        fileClip.current = clip.id;
        setVideoBlob(f);
        if (!cur.videoSize) setV({ videoSize: f.size });
        void askPersistentStorage();
        try { await putMedia(`video:${clip.id}`, f); } catch { /* private mode: keep it in memory */ }
        setNote(t("Camera file found again: the sync and the settings are kept."));
        return;
      }
    }
    // The light copy and the picture of the previous file go first, so they are never shown for this one.
    posterRef.current = null;
    stillRef.current = null;
    await delMedia(posterKey).catch(() => {});
    fileClip.current = clip.id;
    setVideoBlob(f);
    setVideoDur(0);
    setV({ videoName: f.name, videoSize: f.size, source: undefined, drive: undefined, offset: 0, score: undefined, musicStart: undefined, musicEnd: undefined, anchors: undefined, takes: undefined, linked: false });
    setHead(settingsRef.current.crop.start);
    void askPersistentStorage();
    void describeVideo(f, true);
    try { await putMedia(`video:${clip.id}`, f); } catch { /* private mode: keep it in memory */ }
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
    if (videoBlob && (!settings.source || settings.source.duration === undefined)) void describeVideo(videoBlob, false);
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
    stop();
    setVideoBlob(null);
    setVideoDur(0);
    setV({ videoName: undefined, source: undefined, drive: undefined, offset: 0, score: undefined, musicStart: undefined, musicEnd: undefined, anchors: undefined, takes: undefined, linked: false });
    setHead(settingsRef.current.crop.start);
    posterRef.current = null;
    await delMedia(`video:${clip.id}`);
    await delMedia(posterKey);
    onSaveNow();
  };

  /** New clip on the same release: same song and segment, fresh camera take. */
  const addVideo = async () => {
    syncRef.current?.abort();
    stop();
    const id = uid();
    // Next free number: after a deletion, clips.length + 1 could repeat a name.
    const name = `Video ${Math.max(clips.length, ...clips.map((c) => Number(/^Video (\d+)$/.exec(c.name)?.[1] ?? 0))) + 1}`;
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
    await delMedia(`video:${id}`).catch(() => {});
    await delMedia(`poster:${id}`).catch(() => {});
    await delMedia(`audio:${id}`).catch(() => {});
  };

  const close = () => { syncRef.current?.abort(); stop(); onSaveNow(); onBack(); };

  const onDropFile = (f: File | undefined) => {
    if (!f) return;
    if (f.type.startsWith("video/") || /\.(mp4|mov|webm|m4v|avi)$/i.test(f.name)) void pickVideo(f);
    else if (f.type.startsWith("audio/") || /\.(mp3|wav|m4a|aac|ogg|flac|aiff)$/i.test(f.name)) void pickAudio(f);
  };

  // ---- playback ----
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
    const from = head >= until - 0.15 || head < cfg.crop.start ? cfg.crop.start : head;
    // No camera file: only the sound plays, at once.
    const el = videoUrl && fileClip.current === clip.id ? videoRef.current : null;
    if (el) {
      el.muted = true;
      await whenReady(el);
      if (mine !== playToken.current) return;
      el.currentTime = Math.max(0, from - cfg.offset);
    }
    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(ctx.destination);
    originRef.current = ctx.currentTime;
    src.start(0, from, until - from);
    sourceRef.current = src;
    if (el) void el.play().catch(() => {});
    setPlaying(true);
    const tick = () => {
      const now = from + (ctx.currentTime - originRef.current);
      if (now >= until) { setHead(until); stop(); return; }
      setHead(now);
      if (el) {
        const target = Math.max(0, now - settingsRef.current.offset);
        if (Math.abs(el.currentTime - target) > 0.25) el.currentTime = target;
      }
      drawAt(now);
      // Measure of the sync while playing (console, debug level): video behind (+) or ahead (−) of the sound.
      if (el && performance.now() - lastLog > 1000) {
        lastLog = performance.now();
        const target = now - settingsRef.current.offset;
        const ac = ctx as AudioContext & { outputLatency?: number };
        console.debug(`[sync] video ${((target - el.currentTime) * 1000).toFixed(0)} ms behind · readyState ${el.readyState} · audio output delay ${Math.round(((ac.outputLatency ?? 0) + ac.baseLatency) * 1000)} ms`);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    let lastLog = 0;
    rafRef.current = requestAnimationFrame(tick);
  };

  useEffect(() => {
    if (!playing) drawAt(head);
  }, [drawAt, head, playing, settings, timed, cues, captionStyle, hookStyle, videoUrl, fonts, aids, snap, lutRev, rawView, fontPreview]);

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
      if (el.readyState >= 2 || !el.paused) return; // the player has pictures: nothing to do
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
    const capture = videoUrl
      ? capturePcm(videoUrl, MAX_CAPTURE, (p) => setSyncPct(p), capAc.signal)
      : null;
    if (capture) void capture.catch(() => {});
    try {
      let clip: { samples: Float32Array; rate: number };
      try {
        const vbuf = await Promise.race([
          decodeAudio(getCtx(), recording),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("decode")), 15000)),
        ]);
        clip = { samples: monoOf(vbuf), rate: vbuf.sampleRate };
        capAc.abort(); // the fast path worked: no need for the real-time capture
      } catch {
        // Phone MOV/MP4 often decode fine in the <video> but not through decodeAudioData.
        if (!capture) throw new Error("no-url");
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

  /** Use one take of the video: audio and video get linked on it, and the segment moves inside it if needed. */
  const applyTake = (k: VideoTake, takes = settingsRef.current.takes) => {
    const cur = settingsRef.current;
    const range = linkRangeOf({ offset: k.offset, musicStart: k.musicStart, musicEnd: k.musicEnd, takes });
    const crop = range ? fitCrop(cur.crop.start, cur.crop.duration, range) : cur.crop;
    setV({ offset: k.offset, musicStart: k.musicStart, musicEnd: k.musicEnd, linked: true, crop });
    if (crop.start !== cur.crop.start) setHead(crop.start);
    onSaveNow();
  };

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

  /** "press": down inside the segment, not moved yet: a click places the playhead, a drag moves the segment. */
  const dragWave = useRef<null | { mode: "start" | "end" | "move" | "offset" | "head" | "press"; x: number; px: number; start: number; duration: number }>(null);
  const wavePos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1);
  };
  const waveDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!audioBuf) return;
    stop();
    e.currentTarget.setPointerCapture(e.pointerId);
    const f = wavePos(e);
    const cfg = settingsRef.current;
    // Top strip of the blue "video available" band: slide it to move the sync by hand.
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX;
    const near = (t: number) => Math.abs(e.clientX - (rect.left + (t / audioBuf.duration) * rect.width)) <= 6;
    if (!cfg.linked && videoBlob && videoDur > 0 && (e.clientY - rect.top) / rect.height < 0.2) {
      const o0 = cfg.offset / audioBuf.duration, o1 = (cfg.offset + videoDur) / audioBuf.duration;
      if (f >= o0 && f <= o1) {
        dragWave.current = { mode: "offset", x: f, px, start: cfg.offset, duration: 0 };
        return;
      }
    }
    const x0 = cfg.crop.start / audioBuf.duration;
    const x1 = (cfg.crop.start + cfg.crop.duration) / audioBuf.duration;
    const seg = { x: f, px, start: cfg.crop.start, duration: cfg.crop.duration };
    // The playhead first (a thin line inside the segment), then the edges, then the segment itself.
    if (near(head) && head > cfg.crop.start + 0.05 && head < cfg.crop.start + cfg.crop.duration - 0.05) dragWave.current = { mode: "head", ...seg };
    else if (Math.abs(f - x0) < 0.02) dragWave.current = { mode: "start", ...seg };
    else if (Math.abs(f - x1) < 0.02) dragWave.current = { mode: "end", ...seg };
    else if (f > x0 && f < x1) dragWave.current = { mode: "press", ...seg };
    else {
      const crop = fitCrop(f * audioBuf.duration, cfg.crop.duration, boundsOf(cfg));
      setV({ crop });
      setHead(crop.start);
      dragWave.current = { mode: "move", x: f, px, start: crop.start, duration: crop.duration };
    }
  };
  /**
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
    const cfg = settingsRef.current;
    return round2(clamp(f * (audioBuf?.duration ?? 0), cfg.crop.start, cfg.crop.start + cfg.crop.duration - 0.05));
  };
  const waveMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragWave.current;
    if (!d || !audioBuf) return;
    const f = wavePos(e);
    if (d.mode === "head") { setHead(headAt(f)); return; }
    if (d.mode === "press") {
      if (Math.abs(e.clientX - d.px) < 4) return;
      d.mode = "move"; // it is a drag: the segment moves
    }
    const delta = (f - d.x) * audioBuf.duration;
    const bounds = boundsOf(settingsRef.current);
    // The preview follows the edge being dragged: the picture shown is the one under that edge.
    if (d.mode === "offset") {
      // The video may start before the song (negative offset) or end after it.
      setV({ offset: round2(clamp(d.start + delta, 1 - videoDur, Math.max(0, audioBuf.duration - 1))) });
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
    const d = dragWave.current;
    dragWave.current = null;
    if (d?.mode === "press") setHead(headAt(wavePos(e))); // a click inside the segment: the playhead goes there
  };

  useEffect(() => {
    const c = waveRef.current;
    if (!c || !peaks.length || !audioBuf) return;
    const W = c.width, H = c.height, dur = audioBuf.duration;
    const g = c.getContext("2d");
    if (!g) return;
    g.fillStyle = "#16161c";
    g.fillRect(0, 0, W, H);
    const x0 = (settings.crop.start / dur) * W;
    const x1 = (Math.min(dur, settings.crop.start + settings.crop.duration) / dur) * W;
    // Where the camera video exists on the official track.
    if (videoBlob && videoDur > 0) {
      const v0 = clamp(settings.offset / dur, 0, 1) * W;
      const v1 = clamp((settings.offset + videoDur) / dur, 0, 1) * W;
      g.fillStyle = "rgba(86,156,255,.16)";
      g.fillRect(v0, 0, Math.max(0, v1 - v0), H);
      g.fillStyle = "rgba(86,156,255,.95)";
      g.fillRect(v0, 0, Math.max(0, v1 - v0), 15);
      if (settings.musicStart != null && settings.musicEnd != null) {
        const m0 = clamp((settings.offset + settings.musicStart) / dur, 0, 1) * W;
        const m1 = clamp((settings.offset + settings.musicEnd) / dur, 0, 1) * W;
        g.fillStyle = "rgba(79,255,176,.9)";
        g.fillRect(m0, H - 4, Math.max(0, m1 - m0), 4);
      }
    }
    g.fillStyle = "rgba(216,33,60,.16)";
    g.fillRect(x0, 0, Math.max(0, x1 - x0), H);
    const bw = W / peaks.length;
    g.fillStyle = "#6f6e78";
    peaks.forEach((v, i) => {
      const h = Math.max(1, v * (H - 14));
      g.fillRect(i * bw, (H - h) / 2, Math.max(1, bw - 0.6), h);
    });
    // Linked: what lies outside the synced video is out of reach for the segment.
    const range = settings.linked ? linkRangeOf(settings) : null;
    if (range) {
      g.fillStyle = "rgba(10,10,14,.62)";
      g.fillRect(0, 0, (range[0] / dur) * W, H);
      g.fillRect((range[1] / dur) * W, 0, W - (range[1] / dur) * W, H);
    }
    g.fillStyle = "#f03a56";
    g.fillRect(x0 - 1, 0, 3, H);
    g.fillRect(x1 - 2, 0, 3, H);
    g.fillStyle = "#f0eee8";
    g.fillRect((head / dur) * W - 1, 0, 2, H);
    if (videoBlob && videoDur > 0) {
      const v0 = clamp(settings.offset / dur, 0, 1) * W;
      if ((clamp((settings.offset + videoDur) / dur, 0, 1) * W) - v0 > 56) {
        g.fillStyle = "#0c0c0e";
        g.font = "700 11px sans-serif";
        g.fillText("VIDEO", v0 + 6, 12);
      }
    }
  }, [peaks, settings.crop, settings.offset, settings.musicStart, settings.musicEnd, settings.linked, settings.takes, head, audioBuf, videoBlob, videoDur]);

  // ---- lyrics timing ----
  const saveTimes = (id: string, times: (number | null)[]) =>
    onProject((p) => ({ ...p, lyrics: p.lyrics.map((s) => (s.id === id ? { ...s, times } : s)) }));

  const setLine = (i: number, value: number | null) => {
    if (!section) return;
    const count = section.text.split(/\r?\n/).length;
    const times = Array.from({ length: count }, (_, k) => section.times?.[k] ?? null);
    times[i] = value;
    saveTimes(section.id, times);
  };

  const autoPlace = () => {
    if (!section) return;
    const raw = section.text.split(/\r?\n/);
    const filled = raw.map((l, i) => ({ l: l.trim(), i })).filter((x) => x.l);
    if (!filled.length) return;
    const cfg = settingsRef.current;
    const from = cfg.crop.start;
    const to = cfg.crop.start + cfg.crop.duration;
    // Lines follow the attacks of the official audio instead of an arbitrary split.
    const placed = audioBuf
      ? autoLineTimes(filled.map((x) => x.l), envelopeOf(audioBuf.getChannelData(0), audioBuf.sampleRate, RATE), RATE, from, to)
      : filled.map((_, k) => from + 0.4 + ((to - from - 0.8) * k) / filled.length);
    const times: (number | null)[] = new Array(raw.length).fill(null);
    filled.forEach((x, k) => { times[x.i] = round2(placed[k]); });
    saveTimes(section.id, times);
    setNote(t("Lyrics placed on the segment"));
  };

  // ---- lyrics from the official audio ----
  const writtenOf = (src: string, p: Project) =>
    parseLyrics(src === "none" ? "" : src === "song" ? p.songLyrics ?? ""
      : src === "all" ? p.lyrics.map((l) => l.text).join("\n") : p.lyrics.find((l) => l.id === src)?.text ?? "").text;

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
    onProject((x) => ({ ...x, lyricWords: fresh ? r.words : keepManual(x.lyricWords ?? [], r.words) }));
    setGenInfo(r.info);
    if (r.words.length && !cfg.captions) setV({ captions: true });
    onSaveNow();
  };

  // Pasted lyrics are saved as you type (nothing lost on a reload), and once the song has been
  // heard, every edit re-places the lyrics at once: the timed lines below follow the text.
  useEffect(() => {
    if (paste === (project.songLyrics ?? "")) return;
    const id = setTimeout(() => {
      onProject((p) => ({ ...p, songLyrics: paste }));
      if (writtenSrc === "song" && project.heardWords?.length && !genBusy) resyncLyrics("song", { ...project, songLyrics: paste });
      else onSaveNow();
    }, 700);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paste]);

  /** Lyrics there are to place: the pasted ones (even not saved yet) or the chosen carousel ones. */
  const hasLyrics = !!(writtenSrc === "song" ? parseLyrics(paste).text.trim() : writtenOf(writtenSrc, project).trim());

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
    if (writtenSrc === "song" && paste.trim() !== (project.songLyrics ?? "").trim()) {
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
        onProject((p) => ({ ...p, heardWords: heard, lyricWords: keepManual(p.lyricWords ?? [], words) }));
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
  const exportVideo = async () => {
    if (!audioBuf || !videoUrl) return;
    stop();
    const cfg = settingsRef.current;
    const from = cfg.crop.start;
    const until = Math.min(audioBuf.duration, from + cfg.crop.duration);
    if (until - from < 0.5) { setErr(t("Video export failed")); return; }
    void askNotifyPermission();
    const ac = new AbortController();
    exportRef.current = ac;
    setErr(null); setNote(null); setExporting(true); setExpMode(null); setExp({ p: 0, step: "audio" });
    const [W, H] = OUT_SIZE(cfg.format);
    const name = `${project.name || "Rollout"} ${clip.name}`.replace(/[\\/:*?"<>|]+/g, "-");
    let source: VideoSource | null = null;
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
        if (!source && videoBlob && !ac.signal.aborted) {
          // A format the browser cannot decode (4:2:2 10-bit, ProRes…): ffmpeg converts the segment first.
          const why = bake ? "" : VideoSource.lastReason;
          const vs = Math.max(0, from - cfg.offset - 0.2);
          const ve = Math.min(Number.isFinite(vdur) ? vdur : Infinity, until - cfg.offset + 0.2);
          if (ve > vs) {
            try {
              // Only what the post shows, at the camera's resolution (unknown size: the whole picture, not scaled).
              const crop = ow && oh ? cropFor(picOf(cfg.frame ?? DEFAULT_VIDEO.frame), ow, oh, W, H, cfg.push ?? 1) : undefined;
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
      setExp({ p: 1, step: "finish", done: true, file });
      notify(t("Video exported"), t("{name} is in your downloads.", { name: file }));
    } catch (e) {
      const cancelled = ac.signal.aborted || (e instanceof DOMException && e.name === "AbortError");
      setExp(null);
      if (e instanceof FrozenVideo) {
        const msg = t("The camera video stopped giving pictures at {s}: this browser cannot read its format frame by frame ({why}). Export it as H.264 or HEVC, 8-bit 4:2:0 (from DaVinci, or use the camera's proxy file), then import that file.", { s: fmtTime(e.at), why: VideoSource.lastReason || "?" });
        setErr(msg);
        notify(t("Video export failed"), msg);
      } else if (!cancelled) {
        console.error("video export failed", e);
        setErr(t("Video export failed"));
        notify(t("Video export failed"), t("The export stopped before the end. Try again."));
      }
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
  };

  // ---- framing on the preview: drag the video or the lyrics, wheel to zoom / resize, double-click to reset ----
  const frame = settings.frame ?? DEFAULT_VIDEO.frame;
  const setFrame = (patch: Partial<VideoFrame>) => setV({ frame: { ...(settingsRef.current.frame ?? DEFAULT_VIDEO.frame), ...patch } });
  /** Offsets kept in bounds, as for the carousel photos (a drag reacts at once in the other direction). */
  const fitFrame = (f: VideoFrame): VideoFrame => {
    const el = videoRef.current, c = canvasRef.current;
    if (!el?.videoWidth || !c) return f;
    const p = clampPic(picOf(f), el.videoWidth, el.videoHeight, c.width, c.height);
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
  const cvUp = () => { pdrag.current = null; if (snap.v || snap.h) setSnap({ v: false, h: false }); };
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
  const [tab, setTab] = useState<"lyrics" | "hook">("lyrics");
  /** Where the release stands, shown next to the export button. */
  const status: { text: string; tone: "" | "ok" | "warn" } =
    !audioBlob ? { text: t("Audio missing"), tone: "warn" }
    : !videoBlob ? (settings.videoName ? { text: t("Video missing"), tone: "warn" } : { text: t("No camera video yet"), tone: "" })
    : syncBusy || genBusy ? { text: t("Syncing…"), tone: "" }
    : settings.score === undefined ? { text: t("Not synced yet"), tone: "warn" }
    : { text: t("Sync quality {n}%", { n: Math.round(settings.score * 100) }), tone: settings.score >= 0.7 ? "ok" : "warn" };
  const segLen = Math.max(0.1, end - settings.crop.start);
  const placed = (project.lyricWords?.length ?? 0) > 0;
  /** Nothing synced yet: one button does both. Afterwards each has its own, so changing the video never touches the lyrics. */
  const firstSync = hasLyrics && !placed && !!videoBlob && settings.score === undefined;
  const hooks = settings.hooks ?? [];
  const setHooks = (list: VideoHook[]) => setV({ hooks: list });
  const editHook = (id: string, patch: Partial<VideoHook>) => setHooks(hooks.map((h) => (h.id === id ? { ...h, ...patch } : h)));
  const addHook = (text = "") => {
    const last = hooks[hooks.length - 1];
    const from = last ? round2(Math.min(segLen - 1, last.to ?? Math.min(3, segLen / 2))) : 0;
    const list = last && last.to === undefined ? hooks.map((h) => (h === last ? { ...h, to: from } : h)) : hooks;
    setHooks([...list, { id: uid(), text, from, to: last ? round2(Math.min(segLen, from + 3)) : undefined, link: text ? hookLink(hookPool, text) : undefined }]);
    if (settings.showHooks === false) setV({ showHooks: true });
  };
  // ---- hook lists: the same as the carousel's; by default the one of the first slide of the release ----
  const slide1Pool = (() => {
    const src = project.slides[0]?.textSource;
    return src?.kind === "pool" && hookPools.some((p) => p.id === src.poolId) ? src.poolId : undefined;
  })();
  const hookPoolId = settings.hookPoolId && hookPools.some((p) => p.id === settings.hookPoolId) ? settings.hookPoolId : slide1Pool ?? hookPools[0]?.id;
  const hookPool = hookPools.find((p) => p.id === hookPoolId);
  const hookItems = useMemo(() => (hookPool ? textItems(hookPool) : []), [hookPool]);
  /** A hook drawn for this video, different from the ones already on it. */
  const drawFor = (taken: string[]) => (hookPoolId ? onDrawHook(hookPoolId, taken) : null);
  /** A text of the list in a hook: linked to its line, so editing it in the list follows here. */
  const fromList = (text: string): Partial<VideoHook> => ({ text, link: hookLink(hookPool, text) });
  const drawInto = (id: string) => {
    const text = drawFor(hooks.filter((h) => h.id !== id).map((h) => h.text));
    if (text !== null) editHook(id, fromList(text));
  };
  const drawAll = () => {
    const taken: string[] = [];
    const list = hooks.map((h) => {
      const text = drawFor(taken);
      if (text === null) return h;
      taken.push(text);
      return { ...h, ...fromList(text) };
    });
    setHooks(list);
  };
  // A hook line edited in the carousel's list: every video of the release that uses it follows.
  // The lists are made again at each render: only their text decides when to look.
  const listsKey = hookPools.map((p) => `${p.id}\u0001${p.text}`).join("\u0002");
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

  /** Retime one caption by 0.1 s: "start" moves the whole line, "end" only when it leaves the screen. Never over its neighbours. */
  // Lyrics saved out of order by an older version of the ± buttons: put back in the order of the text, once.
  useEffect(() => {
    const ws = project.lyricWords;
    if (ws?.length && repairOrder(ws) !== ws) onProject((p) => ({ ...p, lyricWords: repairOrder(p.lyricWords ?? []) }));
  }, [project.lyricWords]); // eslint-disable-line react-hooks/exhaustive-deps

  const retime = (i: number, what: "start" | "end", dir: 1 | -1) => {
    const c = cues[i];
    const out = c && retimeCue(project.lyricWords ?? [], cues, i, what, dir * 0.1);
    if (!out) return;
    stop();
    // The preview shows the edge that moved.
    setHead(round2(what === "start" ? Math.max(settings.crop.start, c.start + dir * 0.1) : Math.max(c.start, c.end + dir * 0.1 - 0.3)));
    onProject((p) => ({ ...p, lyricWords: out }));
  };

  // ---- keyboard: Space play, ←/→ previous/next line, Alt+←/→ offset, I/O segment start/end ----
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
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e) => {
    const el = e.target as HTMLElement;
    if (/INPUT|TEXTAREA|SELECT/.test(el.tagName) || el.isContentEditable || e.metaKey || e.ctrlKey) return;
    if (!audioBuf || document.querySelector(".ov")) return;
    const k = e.key;
    if (k === " ") { e.preventDefault(); if (playing) stop(); else void play(); }
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
      <button className="btn sm primary" onClick={() => setDriveOpen(true)} disabled={driveBusy}>
        <Icon name="folder" size={14} />{driveBusy ? t("Downloading…") : t("From Google Drive")}
      </button>
      <label className="btn sm">
        {t("From this computer")}
        <input type="file" accept="audio/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void pickAudio(f); e.target.value = ""; }} />
      </label>
    </div>
  );

  return (
    <div className="video-shell" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); onDropFile(e.dataTransfer.files[0]); }}>
        {/* Left: the files of the clip, and how the camera picture fits the post. */}
        <aside className={"col side l video-col-l" + (studioLoading ? " is-loading" : "")}>
          <div className="stack">
              <div className="stack">
                <span className="label">{t("Official audio")}</span>
                {audioPick}
                <div className="row">
                  {audioBlob ? <span className="badge ok truncate" title={project.audioName ?? settings.audioName ?? undefined}>{project.audioName ?? settings.audioName ?? t("Official audio")}</span> : <span className="muted xs">{t("No audio imported yet")}</span>}
                  {audioBlob && project.audioDriveId && <span className="badge">{t("Saved in Drive")}</span>}
                  {audioBlob && !confirmRemove && <button className="btn sm quiet danger" onClick={() => setConfirmRemove(true)}>{t("Remove audio")}</button>}
                  {audioBlob && confirmRemove && (
                    <>
                      <span className="xs">{t("Remove it from every video of this release, with the lyrics timing?")}</span>
                      <button className="btn sm danger" onClick={() => void removeAudio()}>{t("Remove")}</button>
                      <button className="btn sm quiet" onClick={() => setConfirmRemove(false)}>{t("Cancel")}</button>
                    </>
                  )}
                </div>
                {audioBlob && !project.audioDriveId && (
                  <p className="muted xs">{t("This audio is only on this computer. Pick it from Google Drive so the release keeps it on any device.")}</p>
                )}
              </div>
              <div className="stack">
                <span className="label">{t("Playback video")}</span>
                <div className="drop" title={settings.videoName ?? undefined} onClick={() => document.getElementById("video-file")?.click()}>
                  {settings.videoName && !videoBlob
                    ? t("Pick {name} again: this browser does not have it. The sync and the settings are kept.", { name: settings.videoName })
                    : settings.videoName ?? t("Import the video recorded with the camera")}
                </div>
                <input id="video-file" type="file" accept="video/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void pickVideo(f); e.target.value = ""; }} />
                <div className="row">
                  {videoBlob && <span className="badge ok truncate" title={settings.videoName ?? undefined}>{settings.videoName ?? "video"}</span>}
                  {!videoBlob && <span className="muted xs">{t("No video imported yet")}</span>}
                  {videoBlob && <button className="btn sm quiet danger" onClick={() => void removeVideo()}>{t("Remove video")}</button>}
                  {videoDur > 0 && <span className="muted xs">{fmtTime(videoDur)}</span>}
                </div>
                {videoBlob && settings.source && (() => {
                  const s = settings.source;
                  const what = [
                    s.device ?? (s.kind === "camera" ? t("Camera") : s.kind === "phone" ? t("Phone") : null),
                    s.curve ?? (s.colour === "unknown" ? t("colours not specified") : null),
                    s.codec,
                  ].filter(Boolean).join(" · ");
                  // One short line; the device, the codec and the long notes unfold.
                  const short = s.colour === "log" ? (s.profile ? t("Converted from log, with your LUT.") : t("Log not converted yet: pick its profile."))
                    : s.colour === "hdr" ? t("HDR brought down to SDR.")
                    : s.colour === "sdr" ? t("Standard video, used as it is.")
                    : t("Colours not specified.");
                  const long = [
                    s.colour === "log" && (s.profile
                      ? t("Log footage: converted like a CST in DaVinci, with your look LUT. Adjust it in the Colour tab.")
                      : t("Log footage this app does not convert yet: pick the closest profile in the Colour tab.")),
                    s.colour === "hdr" && t("HDR footage: brought down to standard SDR for TikTok, without burnt highlights. Adjust it in the Colour tab."),
                    s.colour === "unknown" && t("The file does not say how it recorded the colours: if it looks flat and grey, it is log, pick its profile in the Colour tab."),
                    s.convert && t("The browser cannot read this format frame by frame: the export converts it first (slower), without losing quality."),
                  ].filter(Boolean) as string[];
                  return (
                    <details className="more">
                      <summary>
                        <span className="badge">{s.colour === "log" ? "LOG" : s.colour === "hdr" ? "HDR" : s.colour === "sdr" ? "SDR" : "?"}</span>
                        <span className="xs more-line">{short}</span>
                      </summary>
                      <div className="more-body muted xs">
                        {what && <p>{what}</p>}
                        {long.map((x, i) => <p key={i}>{x}</p>)}
                      </div>
                    </details>
                  );
                })()}
                {(videoBlob || settings.drive?.originalId) && (() => {
                  const d = settings.drive ?? {};
                  const gb = (n: number) => `${(n / 1e9).toFixed(1).replace(".", lang === "fr" ? "," : ".")} ${t("GB")}`;
                  return (
                    <div className="stack">
                      <span className="label">{t("Google Drive")}</span>
                      {driveWrite === false && !d.originalId ? (
                        <div className="row">
                          <span className="muted xs grow" title={t("To open this video on another device, allow the app to save it in your Drive.")}>{t("Not allowed yet.")}</span>
                          <button className="btn sm" onClick={() => void signIn("google", { redirectTo: "/studio" })}>{t("Reconnect Google")}</button>
                        </div>
                      ) : (
                        <div className="row">
                          <span className="muted xs grow" title={d.originalId ? undefined : t("Put the camera file on your Drive to open this video on another device.")}>{d.originalId
                            ? (videoBlob ? t("On your Drive.") : t("On your Drive, not here."))
                            : t("Not on your Drive.")}</span>
                          {driveJob ? <button className="btn sm quiet" onClick={() => driveAc.current?.abort()}>{t("Cancel")}</button>
                            : !videoBlob && d.originalId ? <button className="btn sm primary" onClick={() => void fetchOriginal()}>{t("Get it on this device")}</button>
                            : videoBlob && !d.originalId ? <button className="btn sm" disabled={!driveWrite} onClick={() => void sendToDrive(videoBlob)}>{t("Send ({size})", { size: gb(videoBlob.size) })}</button>
                            : null}
                        </div>
                      )}
                      {driveErr && <p className="notice bad xs">{driveErr}</p>}
                    </div>
                  );
                })()}
                {settings.videoName && videoDur > 0 && settings.crop.start + settings.crop.duration > settings.offset + videoDur && (
                  <p className="notice warn xs">{t("Video stops before the segment ends: extend it or change the offset.")}</p>
                )}
              </div>
              <p className="muted xs" title={t("Files stay on this device.")}>{t("Drop a file anywhere to import it.")}</p>
                      </div>
          <Section id="video-render" title={t("Framing")}>
          <div className="row">
            <button className={"btn sm" + (settings.format !== "16:9" ? " primary" : "")} aria-pressed={settings.format !== "16:9"}
              onClick={() => setV({ format: "9:16" })}>9:16</button>
            <button className={"btn sm" + (settings.format === "16:9" ? " primary" : "")} aria-pressed={settings.format === "16:9"}
              onClick={() => setV({ format: "16:9" })}>16:9</button>
            <select className="input sm grow" aria-label={t("Framing")}
              value={(frame.framing ?? "fill") === "fill" ? "fill" : (frame.bars ?? "blur") === "blur" ? "fit-blur" : "fit-black"}
              onChange={(e) => {
                const v = e.target.value;
                setFrame(v === "fill" ? { framing: "fill" } : { framing: "fit", bars: v === "fit-blur" ? "blur" : "black" });
              }}>
              <option value="fill">{t("Fill (crop)")}</option>
              <option value="fit-blur">{t("Fit whole, blurred bars")}</option>
              <option value="fit-black">{t("Fit whole, black bars")}</option>
            </select>
          </div>
          <div className="row">
            <label className="check xs">
              <input type="checkbox" checked={aids.zones} disabled={settings.format === "16:9"} onChange={(e) => setAids({ zones: e.target.checked })} />
              {t("TikTok zones")}
            </label>
            <label className="check xs">
              <input type="checkbox" checked={aids.guides} onChange={(e) => setAids({ guides: e.target.checked })} />
              {t("Alignment guides")}
            </label>
          </div>
          <Range label={t("Zoom")} value={frame.zoom} display={`${frame.zoom.toFixed(2)}×`} min={0.5} max={4} step={0.05}
            onChange={(v) => { const z = zoomPic(picOf(frame), v); setFrame(fitFrame({ ...frame, zoom: z.zoom, ox: z.ox, oy: z.oy })); }}
            onReset={() => setFrame({ zoom: 1, ox: 0, oy: 0 })} />
          <div className="row" title={t("Zooms in slowly over the whole segment: ×1 on the first frame, up to the chosen factor on the last.")}>
            <span className="label">{t("Progressive zoom")}</span>
            {[undefined, 1.05, 1.1].map((v) => (
              <button key={v ?? 0} className={"btn sm" + ((settings.push ?? undefined) === v ? " primary" : "")} aria-pressed={(settings.push ?? undefined) === v}
                onClick={() => setV({ push: v })}>{v ? `×${String(v).replace(".", lang === "fr" ? "," : ".")}` : t("Off")}</button>
            ))}
          </div>
          </Section>
        </aside>
        {/* Middle: the board, like the carousel's: the clip controls, the preview and the timeline. */}
        <main className="col center video-center">
      <div className="video-head">
        <div className="row nowrap video-title">
          <button className="btn icon quiet" aria-label={t("Back")} title={t("Back")} onClick={close}><Icon name="back" /></button>
          <div className="stack" style={{ gap: 2, minWidth: 0 }}>
            <span className="label">{t("Video studio")}</span>
            <h2 className="display truncate">{project.name}</h2>
          </div>
        </div>
        <div className="row nowrap video-tools">
          <label className="field" style={{ margin: 0 }}>{t("Video")}
            <select className="input" style={{ width: 150 }} value={clip.id}
              onChange={(e) => { onProject((p) => ({ ...p, videoId: e.target.value })); onSaveNow(); }}>
              {clips.map((c) => <option key={c.id} value={c.id}>{clipName(c)}</option>)}
            </select>
          </label>
          <button className="btn icon" aria-label={t("New video")} title={t("New video: same audio, lyrics and settings, another camera take")} onClick={() => void addVideo()}><Icon name="plus" /></button>
          <Menu trigger={(_, toggle) => <button className="btn icon quiet" aria-label={t("Video menu")} onClick={toggle}><Icon name="more" /></button>}>
            {(closeMenu) => (<>
              <button onClick={() => { closeMenu(); setClipDialog("rename"); }}>{t("Rename")}</button>
              <div className="sep" />
              <button className="danger" style={{ color: "var(--danger)" }} disabled={clips.length < 2}
                onClick={() => { closeMenu(); setClipDialog("delete"); }}>{t("Delete this video")}</button>
            </>)}
          </Menu>
          {/* Same history as the carousel (Cmd+Z / Cmd+Shift+Z): every change of the release can be undone. */}
          <button className="btn icon quiet" aria-label={t("Undo")} title={`${t("Undo")} (⌘Z)`} onClick={onUndo} disabled={!canUndo}><Icon name="undo" /></button>
          <button className="btn icon quiet" aria-label={t("Redo")} title={`${t("Redo")} (⇧⌘Z)`} onClick={onRedo} disabled={!canRedo}><Icon name="redo" /></button>
          <span className="grow" />
          <span className={"badge video-status" + (status.tone ? " " + status.tone : "")}>{status.text}</span>
          <button className="btn primary" onClick={() => void exportVideo()} disabled={!audioBuf || !videoBlob || exporting}
            title={!audioBuf ? t("Import the release audio") : !videoBlob ? t("Import the video recorded with the camera") : t("Ready to export")}>
            <Icon name="download" />{exporting ? t("Exporting…") : t("Export video (MP4)")}
          </button>
        </div>
      </div>
      <div className={"video-grid" + (settings.format === "16:9" ? " wide" : "")}>
        <div className="stack video-stage">
          <div className={"cv-wrap" + (settings.format === "16:9" ? " landscape" : "")} style={{ position: "relative" }}>
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
              onPointerDown={cvDown} onPointerMove={cvMove} onPointerUp={cvUp} onPointerCancel={cvUp} onDoubleClick={cvDouble} />
          </div>
          <div className="row">
            <span className="label">{t("On the video")}</span>
            <button className={"btn sm" + (settings.captions ? " primary" : "")} aria-pressed={settings.captions}
              onClick={() => setV({ captions: !settings.captions })}>{t("Lyrics")}</button>
            <button className={"btn sm" + (hooks.length && settings.showHooks !== false ? " primary" : "")} aria-pressed={!!hooks.length && settings.showHooks !== false}
              onClick={() => { if (!hooks.length) { setTab("hook"); addHook(); } else setV({ showHooks: settings.showHooks === false }); }}>{t("Hook")}</button>
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
              ? { p: driveJob.p, text: driveJob.kind === "send" ? t("Sending the camera file to your Drive") : t("Getting the camera file from your Drive") }
              : null;
            if (job) return (
              <div className="job" title={t("Keep this tab open until it is done. The export always uses the original file.")}>
                <div className="row"><span className="xs">{job.text}</span><span className="xs mono muted">{Math.round(job.p * 100)} %</span></div>
                <div className="job-bar"><i style={{ width: `${Math.max(2, job.p * 100)}%` }} /></div>
              </div>
            );
            return videoBlob && !videoDur ? <p className="muted xs">{t("Opening the camera video…")}</p> : null;
          })()}
          <p className="muted xs">{videoBlob
            ? t("Drag the picture to reframe it, the lyrics to move them. Double-click resets.")
            : t("Nothing to preview yet.")} <span className="mono">{outW}×{outH}</span></p>

        </div>

        <div className={"video-side" + (studioLoading ? " is-loading" : "")}>
          <div className="timeline">
            {!audioBuf ? (
              audioBlob ? (
                <div className="studio-loading" aria-busy="true">
                  <span className="muted xs">{t("Reading the audio…")}</span>
                  <div className="skel-wave" />
                </div>
              ) : (
                <div className="timeline-empty">
                  <p>{t("Import the official audio to see the timeline.")}</p>
                  {audioPick}
                </div>
              )
            ) : (
              <>
                <div className="row">
                  <button className="btn icon" aria-label={playing ? t("Pause") : t("Play")} title={(playing ? t("Pause") : t("Play")) + " (Espace)"}
                    disabled={!playing && !!videoUrl && !playerReady}
                    onClick={() => (playing ? stop() : void play())}>
                    {videoUrl && !playerReady && !playing ? <span className="spin-dot" aria-hidden /> : <Icon name={playing ? "pause" : "play"} />}
                  </button>
                  <span className="mono xs">{fmtTime(head)} <span className="muted">/ {fmtTime(end)}</span></span>
                  <span className="sep" />
                  {PRESETS.map((d) => (
                    <button key={d} className={"btn sm" + (Math.abs(settings.crop.duration - d) < 0.01 ? " primary" : "")}
                      onClick={() => setCropDuration(d)}>{d}s</button>
                  ))}
                  {videoBlob && videoDur > 0 && (
                    <button className={"btn sm" + (linked ? " primary" : "")} aria-pressed={linked} onClick={toggleLink}
                      title={linked ? t("Unlink to move the sync by hand") : t("Keep the sync while you move the segment")}>
                      <Icon name={linked ? "lock" : "unlock"} size={13} />{linked ? t("Audio and video linked") : t("Link audio and video")}
                    </button>
                  )}
                  <span className="grow" />
                  {!syncBusy && !genBusy && firstSync ? (
                    <button className="btn sm primary" onClick={() => void syncAll()}>
                      <Icon name="refresh" size={14} />{t("Sync lyrics and video")}
                    </button>
                  ) : !syncBusy && !genBusy ? (
                    <>
                      {videoBlob && (
                        <button className={"btn sm" + (settings.score === undefined ? " primary" : "")} onClick={() => void autoSync()}
                          title={t("Find where the camera video sits in the official audio. The lyrics do not move.")}>
                          <Icon name="refresh" size={14} />{t("Sync the video")}
                        </button>
                      )}
                      {(hasLyrics || !videoBlob) && (
                        <button className={"btn sm" + (!placed ? " primary" : "")} onClick={() => void syncLyrics()} disabled={!hasLyrics}
                          title={!hasLyrics ? t("Import the video or paste the lyrics first.") : placed ? t("Place the lyrics again on the audio. Your retouches are kept.") : undefined}>
                          <Icon name="refresh" size={14} />{placed ? t("Re-place the lyrics") : t("Sync the lyrics")}
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      <span className="badge">
                        {syncBusy ? t("Syncing the video… {n}%", { n: Math.round(syncPct * 100) })
                          : genStep === "model" && genPct > 0 && genPct < 1 ? t("Downloading the speech model… {n}%", { n: Math.round(genPct * 100) })
                          : genStep === "listen" || genDone > 0 ? t("Placing the lyrics… {n}%", { n: Math.round(genDone * 100) })
                          : t("Loading the speech engine…")}
                      </span>
                      {genBusy && <button className="btn sm quiet" onClick={cancelLyrics}>{t("Cancel")}</button>}
                    </>
                  )}
                </div>
                {settings.takes && settings.takes.length > 1 && (
                  <div className="row">
                    <span className="muted xs">{t("Takes found in the video (pick the one to use):")}</span>
                    {settings.takes.map((k, i) => (
                      <button key={i} className={"btn sm" + (Math.abs(k.offset - settings.offset) < 0.02 ? " primary" : "")}
                        aria-pressed={Math.abs(k.offset - settings.offset) < 0.02} onClick={() => applyTake(k, settings.takes)}>
                        {t("Take {n}", { n: i + 1 })} <span className="mono xs">{fmtTime(k.musicStart)}–{fmtTime(k.musicEnd)}</span>
                      </button>
                    ))}
                  </div>
                )}
                <canvas ref={waveRef} className="wave" width={1200} height={90}
                  onPointerDown={waveDown} onPointerMove={waveMove} onPointerUp={waveUp} onPointerCancel={() => { dragWave.current = null; }} />
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
                <div className="lyric-track" role="group" aria-label={t("Lyrics of the segment")} {...scrub()}>
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
                  {!cues.length && <span className="muted xs lyric-track-empty">{genBusy ? t("Placing the lyrics…") : t("No lyrics on this segment yet: paste them in Lyrics, then Sync.")}</span>}
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
                        <select className="input" value={language} onChange={(e) => setLanguage(e.target.value)} disabled={genBusy}>
                          <option value="auto">{t("Detect")}</option>
                          <option value="french">Français</option><option value="english">English</option>
                          <option value="spanish">Español</option><option value="portuguese">Português</option>
                          <option value="italian">Italiano</option><option value="german">Deutsch</option>
                          <option value="dutch">Nederlands</option><option value="arabic">العربية</option>
                        </select>
                      </label>
                      <label className="field">{t("Accuracy")}
                        <select className="input" value={model} onChange={(e) => setModel(e.target.value as AsrModel)} disabled={genBusy}>
                          <option value="tiny">{t("Fast")}</option>
                          <option value="base">{t("Balanced")}</option>
                          <option value="small">{t("Precise (slower)")}</option>
                        </select>
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

          {/* The content of the lyrics or of the hook; its style shows in the right column. */}
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab !== "hook"} className={"tab" + (tab !== "hook" ? " on" : "")} onClick={() => setTab("lyrics")}>{t("Lyrics")}</button>
            <button role="tab" aria-selected={tab === "hook"} className={"tab" + (tab === "hook" ? " on" : "")} onClick={() => setTab("hook")}>{t("Hook")}</button>
          </div>

          {tab === "lyrics" && (
            <div className="tab-body">
              <label className="field">{t("Paste the lyrics of the song")}
                <textarea className="input" rows={8} value={paste} onChange={(e) => setPaste(e.target.value)}
                  placeholder={t("Paste the whole song as found online: titles like [Chorus], Couplet 1 or Refrain x2 are recognised and removed.")} />
              </label>
              {pasted.parts.length > 0 && (
                <p className="muted xs">{t("Parts found: {list}", { list: pasted.parts.join(" · ") })} · {t("{n} sung lines", { n: pasted.lines })}</p>
              )}
              {project.lyrics.length > 0 && (
                <label className="field">{t("Written lyrics")}
                  <select className="input" value={writtenSrc} disabled={genBusy}
                    onChange={(e) => { setWrittenSrc(e.target.value); if (project.heardWords?.length) resyncLyrics(e.target.value); }}>
                    <option value="song">{t("Lyrics pasted above")}</option>
                    <option value="all">{t("Carousel lyrics (all sections)")}</option>
                    {project.lyrics.map((s) => <option key={s.id} value={s.id}>{t("Section: {name}", { name: s.name })}</option>)}
                  </select>
                </label>
              )}
              <p className="muted xs">{t("No pasted lyrics, no lyrics on the video. The audio is only used to know when each written word is sung.")}</p>
              {cues.length > 0 && (
                <div className="stack" style={{ gap: 4 }}>
                  <div className="cue-row cue-legend muted xs">
                    <span>{t("Starts")}</span><span className="grow">{t("Line")}</span><span>{t("Ends")}</span>
                  </div>
                  <div className="lyric-timing">
                    {cues.map((c, i) => (
                      <div key={i} className={"cue-row" + (c === current ? " on" : "")}>
                        <span className="nudge">
                          <button className="btn sm quiet" aria-label={t("Earlier")} title={t("Show this line earlier (−0.1 s)")} onClick={() => retime(i, "start", -1)}>−</button>
                          <span className="mono xs">{fmtTime(c.start)}</span>
                          <button className="btn sm quiet" aria-label={t("Later")} title={t("Show this line later (+0.1 s)")} onClick={() => retime(i, "start", 1)}>+</button>
                        </span>
                        <button className="cue-text grow truncate xs" onClick={() => { stop(); setHead(round2(Math.max(settings.crop.start, c.start))); }}>
                          {c.text.replace(/\n/g, " ⏎ ")}
                        </button>
                        <span className="nudge">
                          <button className="btn sm quiet" aria-label={t("Shorter")} title={t("Hide this line earlier (−0.1 s)")} onClick={() => retime(i, "end", -1)}>−</button>
                          <span className="mono xs">{fmtTime(c.end)}</span>
                          <button className="btn sm quiet" aria-label={t("Longer")} title={t("Keep this line longer (+0.1 s)")} onClick={() => retime(i, "end", 1)}>+</button>
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="row">
                    <span className="muted xs grow">{t("Fine-tune each line by 0.1 s. Your retouches are kept when you edit the lyrics or sync again.")}</span>
                    {hasManual(project.lyricWords) && !genBusy && (
                      <button className="btn sm quiet" onClick={() => resyncLyrics(writtenSrc, project, true)}>{t("Back to the automatic timing")}</button>
                    )}
                  </div>
                </div>
              )}
              {cues.length > 0 && !genBusy && <div><button className="btn sm quiet danger" onClick={clearLyrics}>{t("Clear lyrics of this segment")}</button></div>}
              {project.lyrics.length > 0 && (
                <Section title={t("Place lines by hand")} open={false}>
                  <div className="row">
                    <button className="btn sm" onClick={autoPlace} disabled={!lines.length}>{t("Auto place")}</button>
                    <span className="muted xs">{cues.length ? t("Used only when no lyrics were generated from the audio.") : t("Pick a section to place its lines.")}</span>
                  </div>
                  <div className="lyric-timing">
                    {lines.map((l) => (
                      <div className="row nowrap" key={l.i}>
                        <span className="grow truncate xs">{l.text}</span>
                        <input className="input" style={{ width: 82 }} type="number" step={0.1} placeholder="–"
                          aria-label={t("Line {n}", { n: l.i + 1 })}
                          value={section?.times?.[l.i] ?? ""}
                          onChange={(e) => setLine(l.i, e.target.value === "" ? null : round2(Number(e.target.value)))} />
                        <button className="btn sm" onClick={() => setLine(l.i, round2(head))}>{t("Set here")}</button>
                      </div>
                    ))}
                  </div>
                </Section>
              )}
            </div>
          )}

          {tab === "hook" && (
            <div className="tab-body">
              <p className="muted xs">{t("A title over the video, at the top by default. Add several to change it along the video, or keep one all along.")}</p>
              <div className="row">
                <label className="field grow">
                  <span>{t("Hook list")}</span>
                  <select className="input" value={settings.hookPoolId && hookPools.some((p) => p.id === settings.hookPoolId) ? settings.hookPoolId : ""}
                    onChange={(e) => setV({ hookPoolId: e.target.value || undefined })} disabled={!hookPools.length}>
                    <option value="">{slide1Pool ? t("Same as slide 1 ({name})", { name: hookPools.find((p) => p.id === slide1Pool)?.name ?? "" }) : hookPools.length ? t("First list ({name})", { name: hookPools[0].name }) : t("No hook list yet")}</option>
                    {hookPools.map((p) => <option key={p.id} value={p.id}>{p.name} · {textItems(p).length}</option>)}
                  </select>
                </label>
                {hookItems.length > 0 && (
                  <button className="btn primary" title={t("A different hook from the list for each one")}
                    onClick={() => { if (hooks.length) drawAll(); else addHook(drawFor([]) ?? ""); }}><Icon name="sparkle" />{t("Generate")}</button>
                )}
              </div>
              {!hookPools.length && <p className="muted xs">{t("Make a hook list in the carousel (Import hooks): the video draws from the same lists.")}</p>}
              {hooks.map((h, i) => (
                <div key={h.id} className="hook-item">
                  <div className="row">
                    <span className="label grow">{t("Hook {n}", { n: i + 1 })}</span>
                    <button className="btn sm quiet" onClick={() => { stop(); setHead(round2(settings.crop.start + h.from)); }}>{t("Go to it")}</button>
                    <button className="btn sm quiet danger" onClick={() => setHooks(hooks.filter((x) => x.id !== h.id))}>{t("Remove")}</button>
                  </div>
                  <textarea className="input" rows={2} value={h.text} placeholder={t("Write the hook…")}
                    onChange={(e) => editHook(h.id, { text: e.target.value, link: undefined })} />
                  {hookItems.length > 0 && (
                    <div className="row">
                      <button className="btn sm quiet" onClick={() => drawInto(h.id)} title={t("Pick another text")}><Icon name="refresh" size={13} />{t("Another hook")}</button>
                      <select className="input sm grow" value="" aria-label={t("Pick from the list")}
                        onChange={(e) => { if (e.target.value) editHook(h.id, fromList(e.target.value)); }}>
                        <option value="">{t("Pick from the list…")}</option>
                        {hookItems.map((x, k) => <option key={k} value={x}>{x.replace(/\|/g, " ")}</option>)}
                      </select>
                    </div>
                  )}
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
              ))}
              <div className="row">
                <button className="btn sm" onClick={() => addHook()}><Icon name="plus" size={13} />{t("Add a hook")}</button>
              </div>
            </div>
          )}

        </div>
      </div>
        </main>
        {/* Right: the look of what is edited in the middle (lyrics or hook), then the colour of the whole video. */}
        <aside className={"col side r video-col-r" + (studioLoading ? " is-loading" : "")}>
          {tab === "hook" ? (
            <div className="stack">
              <span className="label">{t("Hook style")}</span>
              {hooks.length === 0 ? (
                <div className="stack">
                  <p className="muted xs">{t("No hook on this video yet.")}</p>
                  <div><button className="btn sm" onClick={() => { setTab("hook"); addHook(); }}><Icon name="plus" size={13} />{t("Add a hook")}</button></div>
                </div>
              ) : (
                <>
                  <p className="muted xs">{settings.hookStyle ? t("Own style for the hooks.") : t("Default hook style: white with a black outline, at the top, until you change something.")}</p>
                  <div className="stack">
                    <CaptionStyle
                      sid="hook-style"
                      style={hookStyle}
                      defaults={hookDefault}
                      fonts={fonts}
                      onChange={(patch) => setV({ hookStyle: { ...hookStyle, ...patch } })}
                      onPreview={(patch) => setFontPreview(patch ? { which: "hook", patch } : null)}
                      onFonts={onFonts}
                      onReset={() => setV({ hookStyle: undefined })}
                    />
                  </div>
                  <Section id="hook-style-presets" title={t("Style presets") + (presetOf(presets, hookStyle) ? ` · ${presetOf(presets, hookStyle)!.name}` : "")} open={false}>
                    <StylePresets presets={presets} current={hookStyle} onSave={(name) => onSavePreset(name, hookStyle)}
                      onApply={(p) => setV({ hookStyle: withPreset(hookStyle, p) })} onDelete={onDeletePreset} />
                  </Section>
                </>
              )}
                        </div>
          ) : (
            <div className="stack">
              <span className="label">{t("Lyrics style")}</span>
              <p className="muted xs">{settings.captionStyle ? t("Own style for this video.") : t("Default video style, with the font of the selected carousel slide, until you change something.")}</p>
              <div className="stack">
              <Section id="lyrics-style-display" title={t("Display")}>
                <div className="row">
                  <button className={"btn sm" + (mode === "phrase" ? " primary" : "")} onClick={() => setV({ captionMode: "phrase" })}>{t("Phrase by phrase")}</button>
                  <button className={"btn sm" + (mode === "word" ? " primary" : "")} onClick={() => setV({ captionMode: "word" })}>{t("Word by word")}</button>
                </div>
                {mode === "phrase" && (
                  <Range label={t("Line length")} value={lineChars} display={t("{n} characters", { n: lineChars })} min={10} max={40}
                    onChange={(v) => setV({ lineChars: v })} />
                )}
              </Section>
                <CaptionStyle
                  sid="lyrics-style"
                  firstOpen={false}
                  style={captionStyle}
                  defaults={slideStyle}
                  fonts={fonts}
                  onChange={(patch) => setV({ captionStyle: { ...captionStyle, ...patch } })}
                  onPreview={(patch) => setFontPreview(patch ? { which: "caption", patch } : null)}
                  onFonts={onFonts}
                  onReset={() => setV({ captionStyle: undefined })}
                />
              <Section id="lyrics-style-presets" title={t("Style presets") + (presetOf(presets, captionStyle) ? ` · ${presetOf(presets, captionStyle)!.name}` : "")} open={false}>
                <StylePresets presets={presets} current={captionStyle} onSave={(name) => onSavePreset(name, captionStyle)}
                  onApply={(p) => setV({ captionStyle: withPreset(captionStyle, p) })} onDelete={onDeletePreset} />
              </Section>
              </div>
                        </div>
          )}
          <div id="video-color">
            <Section id="video-color" title={t("Colour")} open={false}>
              <ColorGrade grade={grade} onChange={(g) => setV({ grade: g })} raw={rawView} onRaw={setRawView} lookErr={lookErr}
                sdr={sdrSource}
                onLutStored={(id) => { LOOKS.delete(id); setLutReload((n) => n + 1); }}
                clips={clips.length}
                onApplyAll={() => onProject((p) => ({ ...p, videos: clipsOf(p).map((c) => ({ ...c, grade })) }))} />
                        </Section>
          </div>
        </aside>
      {clipDialog === "rename" && (
        <PromptDialog title={t("Rename the video")} label={t("Name")} initial={clipName(clip)} confirmLabel={t("Rename")}
          onSubmit={renameClip} onClose={() => setClipDialog(null)} />
      )}
      {clipDialog === "delete" && (
        <ConfirmDialog title={t("Delete this video")} confirmLabel={t("Delete")}
          message={t("“{name}” and its camera file will be removed from this release. The official audio, the lyrics and the other videos stay as they are.", { name: clipName(clip) })}
          onConfirm={() => void deleteClip()} onClose={() => setClipDialog(null)} />
      )}
      {driveOpen && <DriveBrowser onPick={(f) => void pickFromDrive(f)} onClose={() => setDriveOpen(false)} />}
      {exp && (
        <Modal title={exp.done ? t("Video ready") : t("Exporting the video")} onClose={closeExport}>
          <div className="stack">
            <p>
              {exp.done ? t("{name} is in your downloads.", { name: exp.file ?? "" })
                : exp.step === "engine" ? t("Downloading the video converter (once)… {n}%", { n: Math.round(exp.p * 100) })
                : exp.step === "convert" ? t("Converting the camera format… {n}%", { n: Math.round(exp.p * 100) })
                : exp.step === "read" ? t("Reading the camera video…")
                : exp.step === "audio" ? t("Preparing the sound…")
                : exp.step === "video" ? t("Building the frames… {n}%", { n: Math.round(exp.p * 100) })
                : exp.step === "record" ? t("Recording in real time (this browser cannot encode MP4 by itself)… {n}%", { n: Math.round(exp.p * 100) })
                : t("Finishing the MP4…")}
            </p>
            <div className="bar export-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(exp.p * 100)}>
              <div style={{ width: `${exp.p * 100}%` }} />
            </div>
            <p className="muted xs">{outW}×{outH} · H.264 + AAC · {EXPORT_FPS} {t("fps")} · {fmtTime(settings.crop.duration)}</p>
            {expMode && (expMode.direct
              ? <p className="muted xs">{t("Camera frames decoded from the file ({codec}): you can switch tabs.", { codec: expMode.detail })}</p>
              : <p className="notice warn xs">{t("Camera frames read by the browser's player ({why}): the export plays the clip in real time. Keep this tab visible, it pauses while hidden.", { why: expMode.detail || "?" })}</p>)}
            {expPaused && <p className="notice warn xs">{t("Paused: come back to this tab to continue.")}</p>}
            {!exp.done && expMode?.direct !== false && (notifyBlocked()
              ? <p className="notice warn xs">{t("Notifications are blocked for this site: allow them in the browser to be told when the video is ready. The tab title will show it anyway.")}</p>
              : <p className="muted xs">{t("You can switch tabs: you will be notified when the video is ready.")}</p>)}
          </div>
          <div className="modal-foot">
            {exp.done
              ? <button className="btn primary" onClick={closeExport}>{t("Close")}</button>
              : <button className="btn quiet" onClick={closeExport}>{t("Cancel")}</button>}
          </div>
        </Modal>
      )}
    </div>
  );
}
