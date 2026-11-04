"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { defaultStyle, defaultVideo, uid } from "@/lib/defaults";
import { useT } from "@/lib/i18n";
import { delMedia, getMedia, putMedia } from "@/lib/idb";
import { activeCue, alignLyrics, buildCues, cleanHeard } from "@/lib/lyricsAlign";
import { autoLineTimes, decodeAudio, envelopeOf, fmtTime, monoOf, peaksOf, syncAudio } from "@/lib/media";
import { askNotifyPermission, notify } from "@/lib/notify";
import { drawStyledText } from "@/lib/render";
import { ASR_MODELS, AsrModel, AsrStep, prepareAudio, stopTranscribe, transcribe } from "@/lib/transcribe";
import type { LyricWord, Project, StylePreset, TextStyle, VideoSettings, VideoSetup, VideoTake } from "@/lib/types";
import CaptionStyle from "./CaptionStyle";
import { StylePresets, withPreset } from "./TextControls";
import Icon from "./Icon";
import { Range, Section } from "./ui";

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
  const [useWritten, setUseWritten] = useState(true);
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

  const drawAt = useCallback((time: number) => {
    const c = canvasRef.current;
    if (!c) return;
    const g = c.getContext("2d");
    if (!g) return;
    const W = c.width, H = c.height;
    const cfg = settingsRef.current;
    const frame = cfg.frame ?? DEFAULT_VIDEO.frame;
    g.fillStyle = "#000";
    g.fillRect(0, 0, W, H);
    const el = videoRef.current;
    // Outside the part of the track the camera recorded, there is no picture: black.
    const inVideo = time >= cfg.offset - 0.001 && (!Number.isFinite(el?.duration) || time <= cfg.offset + (el?.duration ?? 0) + 0.001);
    if (el && el.videoWidth && inVideo) {
      const s = Math.max(W / el.videoWidth, H / el.videoHeight) * frame.zoom;
      const dw = el.videoWidth * s, dh = el.videoHeight * s;
      g.drawImage(el, (W - dw) / 2 + frame.ox * W, (H - dh) / 2 + frame.oy * H, dw, dh);
    }
    if (cfg.captions) {
      const text = activeRef.current(time);
      if (text) drawStyledText(g, text, styleRef.current, W, H);
    }
  }, []);

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
    setV({ audioName: f.name, offset: 0, score: undefined, musicStart: undefined, musicEnd: undefined, anchors: undefined, takes: undefined });
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
      void generateLyrics(buf); // the lyrics come by themselves with the official audio
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
    setV({ videoName: f.name, offset: 0, score: undefined, musicStart: undefined, musicEnd: undefined, anchors: undefined, takes: undefined });
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
    setV({ audioName: undefined, offset: 0, score: undefined, musicStart: undefined, musicEnd: undefined, anchors: undefined, takes: undefined });
    setHead(settingsRef.current.crop.start);
    await delMedia(`audio:${clip.id}`);
    onSaveNow();
  };

  const removeVideo = async () => {
    syncRef.current?.abort();
    stop();
    setVideoBlob(null);
    setVideoDur(0);
    setV({ videoName: undefined, offset: 0, score: undefined, musicStart: undefined, musicEnd: undefined, anchors: undefined, takes: undefined });
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
        setV({ score: round2(r.score), anchors: r.anchors, takes: takes.length > 1 ? takes : undefined });
        const used = takes.find((k) => Math.abs(k.offset - r.offset) < 0.02);
        if (used) applyTake(used);
        else setV({ offset: round2(r.offset), musicStart: r.musicStart === null ? undefined : round2(r.musicStart), musicEnd: r.musicEnd === null ? undefined : round2(r.musicEnd) });
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

  /**
   * Use one take of the video. If the segment of the post is not filmed in it, the segment
   * moves to the start of the take (same length), so the preview shows that take at once.
   */
  const applyTake = (k: VideoTake) => {
    const cur = settingsRef.current;
    const from = k.offset + k.musicStart, to = k.offset + k.musicEnd;
    const covered = Math.min(to, cur.crop.start + cur.crop.duration) - Math.max(from, cur.crop.start);
    const patch: Partial<VideoSettings> = { offset: k.offset, musicStart: k.musicStart, musicEnd: k.musicEnd };
    if (covered < Math.min(2, cur.crop.duration / 2)) {
      const total = audioBuf?.duration ?? Infinity;
      const start = round2(Math.max(0, Math.min(from, total - cur.crop.duration)));
      patch.crop = { ...cur.crop, start };
      setHead(start);
    }
    setV(patch);
    onSaveNow();
  };

  // ---- crop ----
  const setCropStart = (v: number) => {
    const cfg = settingsRef.current;
    const start = clamp(v, 0, Math.max(0, (audioBuf?.duration ?? cfg.crop.start + cfg.crop.duration) - cfg.crop.duration));
    setV({ crop: { ...cfg.crop, start: round2(start) } });
    setHead(round2(start));
  };
  const setCropDuration = (v: number) => {
    const cfg = settingsRef.current;
    const duration = clamp(v, 1, Math.max(1, audioBuf?.duration ?? v));
    const start = clamp(cfg.crop.start, 0, Math.max(0, (audioBuf?.duration ?? duration) - duration));
    setV({ crop: { start: round2(start), duration: round2(duration) } });
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
    if (videoBlob && videoDur > 0 && (e.clientY - rect.top) / rect.height < 0.2) {
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
      const start = clamp(f * audioBuf.duration, 0, Math.max(0, audioBuf.duration - cfg.crop.duration));
      setV({ crop: { start: round2(start), duration: cfg.crop.duration } });
      setHead(round2(start));
      dragWave.current = { mode: "move", x: f, start, duration: cfg.crop.duration };
    }
  };
  const waveMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragWave.current;
    if (!d || !audioBuf) return;
    const f = wavePos(e);
    const delta = (f - d.x) * audioBuf.duration;
    // The preview follows the edge being dragged: the picture shown is the one under that edge.
    if (d.mode === "offset") {
      setV({ offset: round2(clamp(d.start + delta, 0, Math.max(0, audioBuf.duration - 1))) });
    } else if (d.mode === "start") {
      const start = clamp(d.start + delta, 0, Math.max(0, audioBuf.duration - d.duration));
      setV({ crop: { start: round2(start), duration: d.duration } });
      setHead(round2(start));
    } else if (d.mode === "end") {
      const duration = clamp(d.duration + delta, 1, Math.max(1, audioBuf.duration - d.start));
      setV({ crop: { start: d.start, duration: round2(duration) } });
      setHead(round2(Math.max(d.start, d.start + duration - 0.1)));
    } else {
      const start = clamp(d.start + delta, 0, Math.max(0, audioBuf.duration - d.duration));
      setV({ crop: { start: round2(start), duration: d.duration } });
      setHead(round2(start));
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
  }, [peaks, settings.crop, settings.offset, settings.musicStart, settings.musicEnd, head, audioBuf, videoBlob, videoDur]);

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
  /**
   * Hear the whole track, window by window (the speech engine reports no progress inside one window):
   * the windows of the post's segment go first, and the words show up as each window is done.
   * Runs by itself when the official audio is imported.
   */
  const generateLyrics = async (buf: AudioBuffer | null = audioBuf) => {
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
        if (heard.length) {
          const now = [...heard];
          onProject((p) => ({ ...p, lyricWords: now }));
          if (!settingsRef.current.captions) setV({ captions: true });
        }
      }
      if (!heard.length) {
        const msg = t("No words were heard in this track. Try a more accurate model or set the language.");
        setErr(msg);
        outcome = { title: t("Lyrics not found"), body: msg };
      } else {
        let words = heard;
        let info = t("{n} words heard", { n: heard.length });
        const written = useWritten ? section?.text ?? "" : "";
        const inSeg = heard.filter((x) => x.e > segFrom && x.s < segTo);
        if (written.trim() && inSeg.length) {
          // The written lyrics are those of the post's segment: only its words are corrected.
          const aligned = alignLyrics(written, inSeg);
          if (aligned) {
            words = [...heard.filter((x) => x.e <= segFrom || x.s >= segTo), ...aligned.words].sort((x, y) => x.s - y.s);
            info = t("{n} words heard, the segment placed on your written lyrics", { n: heard.length });
          } else {
            info = t("Your written lyrics do not match what was heard: the words are shown as heard.");
          }
        }
        onProject((p) => ({ ...p, lyricWords: words }));
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
  const exportVideo = async () => {
    const canvas = canvasRef.current;
    if (!audioBuf || !canvas || !videoBlob) return;
    if (typeof MediaRecorder === "undefined" || !canvas.captureStream) {
      setErr(t("Video export failed"));
      return;
    }
    stop();
    setErr(null); setNote(null); setExporting(true);
    try {
      const ctx = getCtx();
      await ctx.resume();
      const cfg = settingsRef.current;
      const from = cfg.crop.start;
      const until = Math.min(audioBuf.duration, from + cfg.crop.duration);
      if (until - from < 0.5) throw new Error("short");
      const stream = canvas.captureStream(30);
      const dest = ctx.createMediaStreamDestination();
      const src = ctx.createBufferSource();
      src.buffer = audioBuf;
      src.connect(dest);
      const mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
      const rec = new MediaRecorder(new MediaStream([...stream.getVideoTracks(), ...dest.stream.getAudioTracks()]),
        mime ? { mimeType: mime, videoBitsPerSecond: 6_000_000 } : undefined);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      const finished = new Promise<Blob>((resolve) => { rec.onstop = () => resolve(new Blob(chunks, { type: "video/webm" })); });
      const el = videoRef.current;
      if (el) {
        el.muted = true;
        await whenReady(el);
        el.currentTime = Math.max(0, from - cfg.offset);
      }
      rec.start(250);
      originRef.current = ctx.currentTime;
      src.start(0, from, until - from);
      if (el) void el.play().catch(() => {});
      await new Promise<void>((resolve) => {
        const tick = () => {
          const now = from + (ctx.currentTime - originRef.current);
          if (now >= until) { drawAt(until); resolve(); return; }
          if (el) {
            const target = Math.max(0, now - settingsRef.current.offset);
            if (Math.abs(el.currentTime - target) > 0.25) el.currentTime = target;
          }
          drawAt(now);
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      });
      rec.stop();
      try { src.stop(); } catch { /* already ended */ }
      el?.pause();
      setPlaying(false);
      const blob = await finished;
      const name = `${project.name || "TkTgen"} ${clip.name}`.replace(/[\\/:*?"<>|]+/g, "-");
      saveBlob(blob, `${name} clip.webm`);
      setNote(t("Video exported"));
    } catch {
      setErr(t("Video export failed"));
    }
    setExporting(false);
  };

  return (
    <div className="video-page">
      <div className="video-wrap">
      <div className="video-head">
        <div className="stack" style={{ gap: 2 }}>
          <span className="label">{t("Video studio")}</span>
          <h2 className="display">{project.name}</h2>
        </div>
        <span className="grow" />
        <div className="row nowrap">
          <label className="field" style={{ margin: 0 }}>{t("Video")}
            <select className="input" style={{ width: 150 }} value={clip.id}
              onChange={(e) => { onProject((p) => ({ ...p, videoId: e.target.value })); onSaveNow(); }}>
              {clips.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <button className="btn icon" aria-label={t("New video")} title={t("New video")} onClick={() => void addVideo()}><Icon name="plus" /></button>
        </div>
      </div>
      <div className="video-grid">
        <div className="stack">
          <div className="cv-wrap"><canvas ref={canvasRef} className="cv" width={1080} height={1920} /></div>
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
                <p className="muted xs">{t("Drag the edges to trim, the middle to move the segment. Drag the top of the blue band to move the sync.")}</p>
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

          <Section title={t("Sync with the official audio")}>
            <div className="row">
              <button className="btn sm primary" onClick={() => void autoSync()} disabled={!audioBuf || !videoBlob || syncBusy}>
                <Icon name="refresh" size={14} />{syncBusy ? t("Analysing… {n}%", { n: Math.round(syncPct * 100) }) : t("Auto sync")}
              </button>
              {settings.score !== undefined && <span className="badge">{t("Sync quality {n}%", { n: Math.round(settings.score * 100) })}</span>}
              {!!settings.anchors && <span className="badge">{t("{n} anchors", { n: settings.anchors })}</span>}
            </div>
            <label className="field">{t("Offset (s)")}
              <input className="input" type="number" step={0.05} value={round2(settings.offset)}
                onChange={(e) => setV({ offset: round2(Number(e.target.value) || 0) })} />
            </label>
            <div className="row">
              <button className="btn sm" onClick={() => setV({ offset: round2(settings.offset - 0.1) })}>−0,1</button>
              <button className="btn sm" onClick={() => setV({ offset: round2(settings.offset + 0.1) })}>+0,1</button>
              <button className="btn sm" onClick={() => setV({ offset: Math.max(0, settings.crop.start) })}>{t("Set here")}</button>
            </div>
            {settings.takes && settings.takes.length > 1 && (
              <div className="stack" style={{ gap: 4 }}>
                <span className="muted xs">{t("Takes found in the video (pick the one to use):")}</span>
                <div className="row">
                  {settings.takes.map((k, i) => (
                    <button key={i} className={"btn sm" + (Math.abs(k.offset - settings.offset) < 0.02 ? " primary" : "")}
                      aria-pressed={Math.abs(k.offset - settings.offset) < 0.02} onClick={() => applyTake(k)}>
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

          <Section title={t("Lyrics from the audio")}>
            <label className="check">
              <input type="checkbox" checked={settings.captions} onChange={(e) => setV({ captions: e.target.checked })} />
              {t("Lyrics on the video")}
            </label>
            <p className="muted xs">{t("The words are heard in the official audio (not in the video), as soon as it is imported.")}</p>
            <div className="cols2">
              <label className="field">{t("Accuracy")}
                <select className="input" value={model} onChange={(e) => setModel(e.target.value as AsrModel)} disabled={genBusy}>
                  <option value="tiny">{t("Fast")}</option>
                  <option value="base">{t("Balanced")}</option>
                  <option value="small">{t("Precise (slower)")}</option>
                </select>
              </label>
              <label className="field">{t("Language")}
                <select className="input" value={language} onChange={(e) => setLanguage(e.target.value)} disabled={genBusy}>
                  <option value="auto">{t("Detect")}</option>
                  <option value="french">Français</option><option value="english">English</option>
                  <option value="spanish">Español</option><option value="portuguese">Português</option>
                  <option value="italian">Italiano</option><option value="german">Deutsch</option>
                  <option value="dutch">Nederlands</option><option value="arabic">العربية</option>
                </select>
              </label>
            </div>
            {project.lyrics.length > 0 && (
              <>
                <label className="field">{t("Section")}
                  <select className="input" value={section?.id ?? ""} onChange={(e) => setSectionId(e.target.value)}>
                    {project.lyrics.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </label>
                <label className="check">
                  <input type="checkbox" checked={useWritten} onChange={(e) => setUseWritten(e.target.checked)} />
                  {t("Correct the words with the written lyrics of this section")}
                </label>
              </>
            )}
            <div className="row">
              {!genBusy ? (
                <button className="btn sm primary" onClick={() => void generateLyrics()} disabled={!audioBuf}>
                  <Icon name="refresh" size={14} />{project.lyricWords?.length ? t("Analyse the lyrics again") : t("Generate lyrics from the audio")}
                </button>
              ) : (
                <>
                  <span className="badge">
                    {genStep === "model" && genPct > 0 && genPct < 1
                      ? t("Downloading the speech model… {n}%", { n: Math.round(genPct * 100) })
                      : genStep === "listen" || genDone > 0 ? t("Analysing the lyrics… {n}%", { n: Math.round(genDone * 100) }) : t("Loading the speech engine…")}
                  </span>
                  <button className="btn sm quiet" onClick={cancelLyrics}>{t("Cancel")}</button>
                </>
              )}
              {cues.length > 0 && !genBusy && <button className="btn sm quiet danger" onClick={clearLyrics}>{t("Clear lyrics of this segment")}</button>}
            </div>
            <p className="muted xs">{t("The speech model ({name}) is downloaded once, then kept by the browser. Your audio never leaves this device.", { name: ASR_MODELS[model].split("/")[1].replace("_timestamped", "") })}</p>
            {genBusy && (
              <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100}
                aria-valuenow={Math.round((genStep === "model" && genDone === 0 ? genPct : genDone) * 100)}>
                <div style={{ width: `${(genStep === "model" && genDone === 0 ? genPct : genDone) * 100}%` }} />
              </div>
            )}
            {genInfo && <p className="notice xs">{genInfo}</p>}

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

          <Section title={t("Style presets")} open={false}>
            <StylePresets presets={presets} onSave={(name) => onSavePreset(name, captionStyle)}
              onApply={(p) => setV({ captionStyle: withPreset(captionStyle, p) })} onDelete={onDeletePreset} />
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
        <span className="muted grow xs">{audioBuf && videoBlob ? t("Ready to export") : t("Import the release audio")}</span>
        <button className="btn primary" onClick={() => void exportVideo()} disabled={!audioBuf || !videoBlob || exporting}>
          <Icon name="download" />{exporting ? t("Exporting…") : t("Export video")}
        </button>
        <button className="btn" onClick={close}>{t("Done")}</button>
      </div>
      </div>
    </div>
  );
}
