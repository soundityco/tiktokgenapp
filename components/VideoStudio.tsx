"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { defaultStyle, defaultVideo, uid } from "@/lib/defaults";
import { useT } from "@/lib/i18n";
import { delMedia, getMedia, putMedia } from "@/lib/idb";
import { activeCue, alignLyrics, alignSong, buildCues, cleanHeard, parseLyrics } from "@/lib/lyricsAlign";
import { autoLineTimes, decodeAudio, envelopeOf, fmtTime, monoOf, peaksOf, syncAudio } from "@/lib/media";
import { askNotifyPermission, notify, notifyBlocked } from "@/lib/notify";
import { clampPic, drawFramed, drawStyledText, TextBox, zoomPic } from "@/lib/render";
import { exportMp4, ExportStep, mp4Support, seekVideo } from "@/lib/exportVideo";
import { type Picture, VideoSource } from "@/lib/videoSource";
import { convertSegment, type ConvertStep } from "@/lib/convert";
import { ASR_MODELS, AsrModel, AsrStep, prepareAudio, stopTranscribe, transcribe } from "@/lib/transcribe";
import type { LyricWord, PicSettings, Project, StylePreset, TextStyle, VideoFrame, VideoSettings, VideoSetup, VideoTake } from "@/lib/types";
import CaptionStyle from "./CaptionStyle";
import { StylePresets, withPreset } from "./TextControls";
import Icon from "./Icon";
import { Modal, Range, Section } from "./ui";

const RATE = 25;
const PRESETS = [10, 15, 20, 30];
/** Longest stretch of a video listened to in real time when the browser cannot decode its audio (10 min). */
const MAX_CAPTURE = 600;
/** The lyrics are heard in windows of this length (s), overlapping a little so no word is cut. */
const LYRICS_WIN = 28;
const LYRICS_LAP = 2;

const DEFAULT_VIDEO: VideoSettings = defaultVideo();

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
function whenReady(el: HTMLVideoElement): Promise<void> {
  if (el.readyState >= 1) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { el.removeEventListener("loadedmetadata", done); resolve(); };
    el.addEventListener("loadedmetadata", done);
    window.setTimeout(done, 3000);
  });
}

/**
 * Video studio: import the official audio of the release, import the playback video,
 * find where the camera recording sits in the official track, trim the segment, place the
 * lyrics once, then export a vertical clip with the official audio and the lyrics burned in.
 */
export default function VideoStudio({
  project,
  onProject,
  onSaveNow,
  onBack,
  fonts,
  onFonts,
  presets,
  onSavePreset,
  onDeletePreset,
}: {
  project: Project;
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

  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [videoBlob, setVideoBlob] = useState<Blob | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
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

  // By default the captions follow the selected carousel slide; the text studio overrides it per clip.
  const slideStyle: TextStyle = useMemo(() => {
    const base = project.slides[project.selectedSlide]?.style ?? project.slides[0]?.style ?? defaultStyle();
    return { ...base, y: 78, size: Math.min(base.size, 72), width: 84 };
  }, [project.slides, project.selectedSlide]);
  const captionStyle: TextStyle = settings.captionStyle ?? slideStyle;
  const mode = settings.captionMode ?? "phrase";
  const lineChars = settings.lineChars ?? 22;
  const cues = useMemo(
    () => buildCues(project.lyricWords ?? [], mode, { lineChars, from: settings.crop.start, to: settings.crop.start + settings.crop.duration }),
    [project.lyricWords, mode, lineChars, settings.crop.start, settings.crop.duration]
  );

  const styleRef = useRef(captionStyle);
  styleRef.current = captionStyle;
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

  /** The <video> as a picture at official time `time`; none outside the part of the track the camera recorded. */
  const pictureOf = (el: HTMLVideoElement | null, time: number): Picture | null => {
    const off = settingsRef.current.offset;
    const inVideo = time >= off - 0.001 && (!Number.isFinite(el?.duration) || time <= off + (el?.duration ?? 0) + 0.001);
    return el && el.videoWidth && inVideo ? { src: el, w: el.videoWidth, h: el.videoHeight } : null;
  };
  /** The picture of the post at official time `time`: the framed camera video, then the lyrics. Used by the preview and the export. */
  const drawScene = useCallback((g: CanvasRenderingContext2D, W: number, H: number, pic: Picture | null, time: number): TextBox | null => {
    const cfg = settingsRef.current;
    g.fillStyle = "#000";
    g.fillRect(0, 0, W, H);
    if (pic && pic.w && pic.h) drawFramed(g, pic.src, pic.w, pic.h, picOf(cfg.frame ?? DEFAULT_VIDEO.frame), W, H);
    if (!cfg.captions) return null;
    const text = activeRef.current(time);
    return text ? drawStyledText(g, text, styleRef.current, W, H) : null;
  }, []);
  const captionBox = useRef<TextBox | null>(null);
  const drawAt = useCallback((time: number) => {
    const c = canvasRef.current;
    const g = c?.getContext("2d");
    if (!c || !g) return;
    captionBox.current = drawScene(g, c.width, c.height, pictureOf(videoRef.current, time), time);
  }, [drawScene]);

  const stop = useCallback(() => {
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
        const [a, b] = await Promise.all([getMedia(`audio:${clip.id}`), getMedia(`video:${clip.id}`)]);
        if (off || token !== ioRef.current) return;
        if (a) {
          setAudioBlob(a);
          decodeAudio(getCtx(), a)
            .then((buf) => {
              if (off || token !== ioRef.current) return;
              setAudioBuf(buf);
              setPeaks(peaksOf(buf.getChannelData(0)));
            })
            .catch(() => { if (!off && token === ioRef.current) setErr(t("Could not read this audio file.")); });
        }
        if (b) setVideoBlob(b);
      } catch { /* IndexedDB unavailable */ }
    })();
    return () => { off = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip.id]);

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
    setVideoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [videoBlob]);

  useEffect(() => () => { stop(); syncRef.current?.abort(); genRef.current?.abort(); stopTranscribe(); ctxRef.current?.close().catch(() => {}); }, [stop]);


  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 3500);
    return () => clearTimeout(id);
  }, [note]);

  const pickAudio = async (f: File) => {
    const token = ++ioRef.current;
    syncRef.current?.abort();
    stop();
    setErr(null); setNote(null);
    setAudioBlob(f);
    setAudioBuf(null);
    setPeaks([]);
    onProject((p) => ({ ...p, heardWords: undefined, lyricWords: undefined })); // timings of another audio
    setV({ audioName: f.name, offset: 0, score: undefined, musicStart: undefined, musicEnd: undefined, anchors: undefined, takes: undefined, linked: false });
    try { await putMedia(`audio:${clip.id}`, f); } catch { /* private mode: keep it in memory */ }
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
    setVideoBlob(f);
    setVideoDur(0);
    setV({ videoName: f.name, offset: 0, score: undefined, musicStart: undefined, musicEnd: undefined, anchors: undefined, takes: undefined, linked: false });
    setHead(settingsRef.current.crop.start);
    try { await putMedia(`video:${clip.id}`, f); } catch { /* private mode: keep it in memory */ }
    onSaveNow();
  };

  const removeAudio = async () => {
    ioRef.current++;
    syncRef.current?.abort();
    stop();
    setAudioBlob(null);
    setAudioBuf(null);
    setPeaks([]);
    setV({ audioName: undefined, offset: 0, score: undefined, musicStart: undefined, musicEnd: undefined, anchors: undefined, takes: undefined, linked: false });
    setHead(settingsRef.current.crop.start);
    await delMedia(`audio:${clip.id}`);
    onSaveNow();
  };

  const removeVideo = async () => {
    syncRef.current?.abort();
    stop();
    setVideoBlob(null);
    setVideoDur(0);
    setV({ videoName: undefined, offset: 0, score: undefined, musicStart: undefined, musicEnd: undefined, anchors: undefined, takes: undefined, linked: false });
    setHead(settingsRef.current.crop.start);
    await delMedia(`video:${clip.id}`);
    onSaveNow();
  };

  /** New clip on the same release: same song and segment, fresh camera take. */
  const addVideo = async () => {
    syncRef.current?.abort();
    stop();
    const id = uid();
    const name = `Video ${clips.length + 1}`;
    let copied = false;
    if (audioBlob) {
      try { await putMedia(`audio:${id}`, audioBlob); copied = true; } catch { /* private mode: keep it in memory */ }
    }
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
          videoName: undefined,
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

  const close = () => { syncRef.current?.abort(); stop(); onSaveNow(); onBack(); };

  const onDropFile = (f: File | undefined) => {
    if (!f) return;
    if (f.type.startsWith("video/") || /\.(mp4|mov|webm|m4v|avi)$/i.test(f.name)) void pickVideo(f);
    else if (f.type.startsWith("audio/") || /\.(mp3|wav|m4a|aac|ogg|flac|aiff)$/i.test(f.name)) void pickAudio(f);
  };

  // ---- playback ----
  const play = async () => {
    if (!audioBuf) return;
    const ctx = getCtx();
    await ctx.resume();
    stop();
    const cfg = settingsRef.current;
    const until = Math.min(audioBuf.duration, cfg.crop.start + cfg.crop.duration);
    const from = head >= until - 0.15 || head < cfg.crop.start ? cfg.crop.start : head;
    const el = videoRef.current;
    if (el) {
      el.muted = true;
      await whenReady(el);
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
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  useEffect(() => {
    if (!playing) drawAt(head);
  }, [drawAt, head, playing, settings, timed, cues, captionStyle, videoUrl, fonts]);

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
  /** Where the segment may sit while linked: the synced take when the video holds several, else the whole video. */
  const linkRangeOf = (v: Pick<VideoSettings, "offset" | "musicStart" | "musicEnd" | "takes">): [number, number] | null => {
    if (!audioBuf || !videoBlob || videoDur <= 0) return null;
    const multi = (v.takes?.length ?? 0) > 1 && v.musicStart != null && v.musicEnd != null;
    const lo = Math.max(0, v.offset + (multi ? v.musicStart! : 0));
    const hi = Math.min(audioBuf.duration, v.offset + (multi ? v.musicEnd! : videoDur));
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

  const dragWave = useRef<null | { mode: "start" | "end" | "move" | "offset"; x: number; start: number; duration: number }>(null);
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
    if (!cfg.linked && videoBlob && videoDur > 0 && (e.clientY - rect.top) / rect.height < 0.2) {
      const o0 = cfg.offset / audioBuf.duration, o1 = (cfg.offset + videoDur) / audioBuf.duration;
      if (f >= o0 && f <= o1) {
        dragWave.current = { mode: "offset", x: f, start: cfg.offset, duration: 0 };
        return;
      }
    }
    const x0 = cfg.crop.start / audioBuf.duration;
    const x1 = (cfg.crop.start + cfg.crop.duration) / audioBuf.duration;
    if (Math.abs(f - x0) < 0.02) dragWave.current = { mode: "start", x: f, start: cfg.crop.start, duration: cfg.crop.duration };
    else if (Math.abs(f - x1) < 0.02) dragWave.current = { mode: "end", x: f, start: cfg.crop.start, duration: cfg.crop.duration };
    else if (f > x0 && f < x1) dragWave.current = { mode: "move", x: f, start: cfg.crop.start, duration: cfg.crop.duration };
    else {
      const crop = fitCrop(f * audioBuf.duration, cfg.crop.duration, boundsOf(cfg));
      setV({ crop });
      setHead(crop.start);
      dragWave.current = { mode: "move", x: f, start: crop.start, duration: crop.duration };
    }
  };
  const waveMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragWave.current;
    if (!d || !audioBuf) return;
    const f = wavePos(e);
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
  const waveUp = () => { dragWave.current = null; };

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

  /** Place the written lyrics again on the words already heard: instant, no new analysis. */
  const resyncLyrics = (src = writtenSrc, p = project) => {
    const heard = p.heardWords;
    if (!heard?.length) { void generateLyrics(); return; }
    const cfg = settingsRef.current;
    const r = placeWords(heard, src, p, cfg.crop.start - 0.5, cfg.crop.start + cfg.crop.duration + 0.5);
    onProject((x) => ({ ...x, lyricWords: r.words }));
    setGenInfo(r.info);
    if (r.words.length && !cfg.captions) setV({ captions: true });
    onSaveNow();
  };

  /** Lyrics there are to place: the pasted ones (even not saved yet) or the chosen carousel ones. */
  const hasLyrics = !!(writtenSrc === "song" ? parseLyrics(paste).text.trim() : writtenOf(writtenSrc, project).trim());

  /**
   * The one sync button: the video on the official audio (when there is one), then the written
   * lyrics on the audio (when there are some). The words already heard are reused: no new analysis.
   */
  const syncAll = async () => {
    // autoSync starts the audio capture of the video right away: it must run inside the click.
    const video = videoBlob ? autoSync() : Promise.resolve();
    let next = project;
    if (writtenSrc === "song" && paste.trim() !== (project.songLyrics ?? "").trim()) {
      const text = paste.trim();
      next = { ...project, songLyrics: text, heardWords: project.heardWords };
      onProject((p) => ({ ...p, songLyrics: text }));
    }
    await video;
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
        onProject((p) => ({ ...p, heardWords: heard, lyricWords: words }));
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
    const name = `${project.name || "TkTgen"} ${clip.name}`.replace(/[\\/:*?"<>|]+/g, "-");
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
        source = videoBlob ? await VideoSource.open(videoBlob, from - cfg.offset, until - cfg.offset, (p) => setExp({ p: p * 0.05, step: "read" }), ac.signal) : null;
        const vdur = el.duration;
        /** Camera time at the start of the frames `source` gives (not 0 when they come from a converted segment). */
        let base = 0;
        let detail = source?.codec ?? "";
        if (!source && videoBlob && !ac.signal.aborted) {
          // A format the browser cannot decode (4:2:2 10-bit, ProRes…): ffmpeg converts the segment first.
          const why = VideoSource.lastReason;
          const vs = Math.max(0, from - cfg.offset - 0.2);
          const ve = Math.min(Number.isFinite(vdur) ? vdur : Infinity, until - cfg.offset + 0.2);
          if (ve > vs) {
            try {
              const key = `${clip.id}|${videoBlob.size}|${vs.toFixed(2)}|${ve.toFixed(2)}`;
              let proxy = proxyRef.current?.key === key ? proxyRef.current.blob : null;
              if (!proxy) {
                proxy = await convertSegment(videoBlob, vs, ve, (p, step) => setExp({ p, step }), ac.signal);
                proxyRef.current = { key, blob: proxy }; // exporting the same segment again skips the conversion
              }
              source = await VideoSource.open(proxy, 0, ve - vs, (p) => setExp({ p: p * 0.05, step: "read" }), ac.signal);
              if (source) { base = vs; detail = t("converted from {format}", { format: why.replace(/ not decodable.*$/, "") }); }
            } catch (e) {
              if (ac.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) throw e;
              console.warn("[export] conversion failed, using the browser's player", e);
              VideoSource.lastReason = `${why} · ${t("conversion failed")}: ${e instanceof Error ? e.message : String(e)}`;
            }
          }
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
            if (inside && src) pic = await src.frameAt(target - base);
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
  const pdrag = useRef<null | { kind: "text" | "pic"; sx: number; sy: number; ox: number; oy: number; k: number }>(null);
  const toCv = (e: { clientX: number; clientY: number }) => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    const k = c.width / r.width;
    return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k, k };
  };
  const inCaption = (x: number, y: number) => {
    const b = captionBox.current;
    const pad = 30;
    return !!b && x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad;
  };
  const cvDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!videoBlob) return;
    const c = toCv(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    const isText = inCaption(c.x, c.y);
    const f = fitFrame(settingsRef.current.frame ?? DEFAULT_VIDEO.frame);
    const st = styleRef.current;
    pdrag.current = { kind: isText ? "text" : "pic", sx: e.clientX, sy: e.clientY, ox: isText ? st.x : f.ox, oy: isText ? st.y : f.oy, k: c.k };
  };
  const cvMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = pdrag.current, c = canvasRef.current;
    if (!d || !c) return;
    const dx = (e.clientX - d.sx) * d.k, dy = (e.clientY - d.sy) * d.k;
    if (d.kind === "text") {
      let x = clamp(d.ox + (dx / c.width) * 100, 0, 100), y = clamp(d.oy + (dy / c.height) * 100, 0, 100);
      if (Math.abs(x - 50) < 1.5) x = 50; // snaps to the centre
      setV({ captionStyle: { ...styleRef.current, x, y } });
    } else {
      setV({ frame: fitFrame({ ...(settingsRef.current.frame ?? DEFAULT_VIDEO.frame), ox: d.ox + dx / c.width, oy: d.oy + dy / c.height }) });
    }
  };
  const cvUp = () => { pdrag.current = null; };
  const wheelRef = useRef<(e: WheelEvent) => void>(() => {});
  wheelRef.current = (e) => {
    if (!videoBlob) return;
    e.preventDefault();
    const c = toCv(e);
    const dir = e.deltaY < 0 ? 1 : -1;
    if (inCaption(c.x, c.y)) {
      const st = styleRef.current;
      setV({ captionStyle: { ...st, size: clamp(Math.round(st.size + dir * 3), 18, 200) } });
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
    if (!inCaption(c.x, c.y)) setFrame({ zoom: 1, ox: 0, oy: 0 });
  };
  const [outW, outH] = OUT_SIZE(settings.format);

  return (
    <div className="video-page">
      <div className="video-wrap">
      <div className="video-head">
        <div className="stack" style={{ gap: 2 }}>
          <span className="label">{t("Video studio")}</span>
          <h2 className="display">{project.name}</h2>
        </div>
        <span className="grow" />
        <div className="row nowrap" style={{ alignItems: "flex-end" }}>
          <label className="field" style={{ margin: 0 }}>{t("Video")}
            <select className="input" style={{ width: 150 }} value={clip.id}
              onChange={(e) => { onProject((p) => ({ ...p, videoId: e.target.value })); onSaveNow(); }}>
              {clips.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <button className="btn icon" aria-label={t("New video")} title={t("New video")} onClick={() => void addVideo()}><Icon name="plus" /></button>
          <button className="btn primary" onClick={() => void exportVideo()} disabled={!audioBuf || !videoBlob || exporting}
            title={audioBuf && videoBlob ? t("Ready to export") : t("Import the release audio")}>
            <Icon name="download" />{exporting ? t("Exporting…") : t("Export video (MP4)")}
          </button>
        </div>
      </div>
      <div className="video-grid">
        <div className="stack">
          <div className={"cv-wrap" + (settings.format === "16:9" ? " landscape" : "")}>
            <canvas ref={canvasRef} className="cv" width={outW} height={outH}
              onPointerDown={cvDown} onPointerMove={cvMove} onPointerUp={cvUp} onPointerCancel={cvUp} onDoubleClick={cvDouble} />
          </div>
          <div className="row">
            <button className="btn icon" aria-label={playing ? t("Pause") : t("Play")} title={playing ? t("Pause") : t("Play")}
              onClick={() => (playing ? stop() : void play())} disabled={!audioBuf}>
              <Icon name={playing ? "pause" : "play"} />
            </button>
            <span className="mono xs">{fmtTime(head)} / {fmtTime(end)}</span>
            <span className="grow" />
            <span className="muted xs">{t("Files stay on this device.")}</span>
          </div>
          <video ref={videoRef} src={videoUrl ?? undefined} className="video-src" muted playsInline preload="auto"
            onLoadedMetadata={(e) => setVideoDur(e.currentTarget.duration)}
            onSeeked={() => { if (!playing) drawAt(head); }}
            onLoadedData={() => { if (!playing) drawAt(head); }} />
          {!videoBlob && <p className="muted xs">{t("Nothing to preview yet.")}</p>}
        </div>

        <div className="video-side">
          <Section title={t("Official audio")}>
            <div className="row">
              <label className="btn sm">
                <Icon name="folder" size={14} />{t("Import audio")}
                <input type="file" accept="audio/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void pickAudio(f); e.target.value = ""; }} />
              </label>
              {audioBlob ? <span className="badge ok truncate">{settings.audioName ?? t("Official audio")}</span> : <span className="muted xs">{t("No audio imported yet")}</span>}
              {audioBlob && <button className="btn sm quiet danger" onClick={() => void removeAudio()}>{t("Remove audio")}</button>}
            </div>
            {audioBuf && (
              <>
                <canvas ref={waveRef} className="wave" width={900} height={90}
                  onPointerDown={waveDown} onPointerMove={waveMove} onPointerUp={waveUp} onPointerCancel={waveUp} />
                <p className="muted xs">{linked
                  ? t("Drag the edges to trim, the middle to move the segment. Linked: the sync stays and the segment stays inside the video.")
                  : t("Drag the edges to trim, the middle to move the segment. Drag the top of the blue band to move the sync.")}</p>
                {videoBlob && videoDur > 0 && (
                  <div className="row">
                    <button className={"btn sm" + (linked ? " primary" : "")} aria-pressed={linked} onClick={toggleLink}
                      title={linked ? t("Unlink to move the sync by hand") : t("Keep the sync while you move the segment")}>
                      <Icon name={linked ? "lock" : "unlock"} size={13} />{linked ? t("Audio and video linked") : t("Link audio and video")}
                    </button>
                  </div>
                )}
                <div className="row">
                  {PRESETS.map((d) => (
                    <button key={d} className={"btn sm" + (Math.abs(settings.crop.duration - d) < 0.01 ? " primary" : "")}
                      onClick={() => setCropDuration(d)}>{d}s</button>
                  ))}
                </div>
                <div className="cols2">
                  <label className="field">{t("Start (s)")}
                    <input className="input" type="number" min={0} step={0.1} value={round2(settings.crop.start)}
                      onChange={(e) => setCropStart(Number(e.target.value) || 0)} />
                  </label>
                  <label className="field">{t("Length (s)")}
                    <input className="input" type="number" min={1} step={0.1} value={round2(settings.crop.duration)}
                      onChange={(e) => setCropDuration(Number(e.target.value) || 1)} />
                  </label>
                </div>
                <p className="mono xs">{t("Segment")} {fmtTime(settings.crop.start)} → {fmtTime(end)}</p>
              </>
            )}
          </Section>

          <Section title={t("Playback video")}>
            <div className="drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); onDropFile(e.dataTransfer.files[0]); }}
              onClick={() => document.getElementById("video-file")?.click()}>
              {settings.videoName ?? t("Import the video recorded with the camera")}
            </div>
            <input id="video-file" type="file" accept="video/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void pickVideo(f); e.target.value = ""; }} />
            <div className="row">
              {videoBlob && <span className="badge ok truncate">{settings.videoName ?? "video"}</span>}
              {!videoBlob && <span className="muted xs">{t("No video imported yet")}</span>}
              {videoBlob && <button className="btn sm quiet danger" onClick={() => void removeVideo()}>{t("Remove video")}</button>}
              {videoDur > 0 && <span className="muted xs">{fmtTime(videoDur)}</span>}
            </div>
            {settings.videoName && videoDur > 0 && settings.crop.start + settings.crop.duration > settings.offset + videoDur && (
              <p className="notice warn xs">{t("Video stops before the segment ends: extend it or change the offset.")}</p>
            )}
          </Section>

          <Section title={t("Format & framing")}>
            <div className="row">
              <button className={"btn sm" + (settings.format !== "16:9" ? " primary" : "")} aria-pressed={settings.format !== "16:9"}
                onClick={() => setV({ format: "9:16" })}>{t("Vertical 9:16")}</button>
              <button className={"btn sm" + (settings.format === "16:9" ? " primary" : "")} aria-pressed={settings.format === "16:9"}
                onClick={() => setV({ format: "16:9" })}>{t("Horizontal 16:9")}</button>
              <span className="mono xs muted">{outW}×{outH}</span>
            </div>
            <label className="field">{t("Framing")}
              <select className="input" value={(frame.framing ?? "fill") === "fill" ? "fill" : (frame.bars ?? "blur") === "blur" ? "fit-blur" : "fit-black"}
                onChange={(e) => {
                  const v = e.target.value;
                  setFrame(v === "fill" ? { framing: "fill" } : { framing: "fit", bars: v === "fit-blur" ? "blur" : "black" });
                }}>
                <option value="fill">{t("Fill (crop)")}</option>
                <option value="fit-blur">{t("Fit whole, blurred bars")}</option>
                <option value="fit-black">{t("Fit whole, black bars")}</option>
              </select>
            </label>
            <Range label={t("Zoom")} value={frame.zoom} display={`${frame.zoom.toFixed(2)}×`} min={0.5} max={4} step={0.05}
              onChange={(v) => { const z = zoomPic(picOf(frame), v); setFrame(fitFrame({ ...frame, zoom: z.zoom, ox: z.ox, oy: z.oy })); }}
              onReset={() => setFrame({ zoom: 1, ox: 0, oy: 0 })} />
            <div><button className="btn sm" onClick={() => setFrame({ zoom: 1, ox: 0, oy: 0 })}>{t("Reset framing")}</button></div>
            <p className="muted xs">{t("On the preview: drag the video to reframe it, scroll to zoom, double-click to reset. Drag the lyrics to move them, scroll on them to resize.")}</p>
          </Section>

          <Section title={t("Lyrics")}>
            <label className="field">{t("Paste the lyrics of the song")}
              <textarea className="input" rows={6} value={paste} onChange={(e) => setPaste(e.target.value)}
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
            <label className="check">
              <input type="checkbox" checked={settings.captions} onChange={(e) => setV({ captions: e.target.checked })} />
              {t("Lyrics on the video")}
            </label>
            <div className="row">
              <button className={"btn sm" + (mode === "phrase" ? " primary" : "")} onClick={() => setV({ captionMode: "phrase" })}>{t("Phrase by phrase")}</button>
              <button className={"btn sm" + (mode === "word" ? " primary" : "")} onClick={() => setV({ captionMode: "word" })}>{t("Word by word")}</button>
            </div>
            {mode === "phrase" && (
              <Range label={t("Line length")} value={lineChars} display={t("{n} characters", { n: lineChars })} min={10} max={40}
                onChange={(v) => setV({ lineChars: v })} />
            )}
            {cues.length > 0 && (
              <div className="lyric-timing">
                {cues.map((c, i) => (
                  <button key={i} className="btn sm quiet row nowrap" style={{ justifyContent: "flex-start" }}
                    onClick={() => { stop(); setHead(round2(c.start)); }}>
                    <span className="mono xs">{fmtTime(c.start)}</span>
                    <span className="grow truncate xs">{c.text.replace(/\n/g, " ⏎ ")}</span>
                  </button>
                ))}
              </div>
            )}
            {cues.length > 0 && !genBusy && <div><button className="btn sm quiet danger" onClick={clearLyrics}>{t("Clear lyrics of this segment")}</button></div>}
          </Section>

          <Section title={t("Sync with the official audio")}>
            <div className="row">
              {!syncBusy && !genBusy ? (
                <button className="btn sm primary" onClick={() => void syncAll()} disabled={!audioBuf || (!videoBlob && !hasLyrics)}>
                  <Icon name="refresh" size={14} />
                  {hasLyrics ? (videoBlob ? t("Sync lyrics and video") : t("Sync the lyrics")) : t("Sync the video")}
                </button>
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
              {settings.score !== undefined && <span className="badge">{t("Sync quality {n}%", { n: Math.round(settings.score * 100) })}</span>}
              {!!settings.anchors && <span className="badge">{t("{n} anchors", { n: settings.anchors })}</span>}
            </div>
            {!audioBuf && <p className="muted xs">{t("Import the official audio first.")}</p>}
            {genBusy && (
              <div className="bar live" role="progressbar" aria-valuemin={0} aria-valuemax={100}
                aria-valuenow={Math.round((genStep === "model" && genDone === 0 ? genPct : genDone) * 100)}>
                <div style={{ width: `${(genStep === "model" && genDone === 0 ? genPct : genDone) * 100}%` }} />
              </div>
            )}
            {genInfo && <p className="notice xs">{genInfo}</p>}
            {hasLyrics && <p className="muted xs">{t("The speech model ({name}) is downloaded once, then kept by the browser. Your audio never leaves this device.", { name: ASR_MODELS[model].split("/")[1].replace("_timestamped", "") })}</p>}
            <label className="field">{t("Offset (s)")}
              <input className="input" type="number" step={0.05} value={round2(settings.offset)} disabled={linked}
                onChange={(e) => setV({ offset: round2(Number(e.target.value) || 0) })} />
            </label>
            <div className="row">
              <button className="btn sm" disabled={linked} onClick={() => setV({ offset: round2(settings.offset - 0.1) })}>−0,1</button>
              <button className="btn sm" disabled={linked} onClick={() => setV({ offset: round2(settings.offset + 0.1) })}>+0,1</button>
              <button className="btn sm" disabled={linked} onClick={() => setV({ offset: Math.max(0, settings.crop.start) })}>{t("Set here")}</button>
            </div>
            {linked && <p className="muted xs">{t("Audio and video are linked: unlink them to change the offset by hand.")}</p>}
            {settings.takes && settings.takes.length > 1 && (
              <div className="stack" style={{ gap: 4 }}>
                <span className="muted xs">{t("Takes found in the video (pick the one to use):")}</span>
                <div className="row">
                  {settings.takes.map((k, i) => (
                    <button key={i} className={"btn sm" + (Math.abs(k.offset - settings.offset) < 0.02 ? " primary" : "")}
                      aria-pressed={Math.abs(k.offset - settings.offset) < 0.02} onClick={() => applyTake(k, settings.takes)}>
                      {t("Take {n}", { n: i + 1 })} <span className="mono xs">{fmtTime(k.musicStart)}–{fmtTime(k.musicEnd)}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {settings.musicStart != null && settings.musicEnd != null && (
              <p className="mono xs">
                {t("Music detected from {a} to {b} in the video.", { a: fmtTime(settings.musicStart), b: fmtTime(settings.musicEnd) })}
              </p>
            )}
          </Section>

          <Section title={t("Style presets")}>
            <StylePresets presets={presets} onSave={(name) => onSavePreset(name, captionStyle)}
              onApply={(p) => setV({ captionStyle: withPreset(captionStyle, p) })} onDelete={onDeletePreset} />
          </Section>

          <Section title={t("Text style")}>
            <p className="muted xs">{settings.captionStyle ? t("Own style for this video.") : t("Follows the style of the selected carousel slide until you change something.")}</p>
            <CaptionStyle
              style={captionStyle}
              fonts={fonts}
              onChange={(patch) => setV({ captionStyle: { ...captionStyle, ...patch } })}
              onFonts={onFonts}
              onReset={() => setV({ captionStyle: undefined })}
            />
          </Section>


          <Section title={t("Place lines by hand")} open={false}>
            {project.lyrics.length === 0 && <p className="muted xs">{t("No lyrics in this section.")}</p>}
            {project.lyrics.length > 0 && (
              <>
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
              </>
            )}
          </Section>

          {err && <p className="notice bad xs">{err}</p>}
          {note && <p className="notice xs">{note}</p>}
        </div>
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={close}>{t("Done")}</button>
      </div>
      </div>
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
