
/**
 * MP4 export (H.264 video, AAC audio) with the browser's own encoders (WebCodecs). Frames are drawn
 * and encoded one by one, not recorded while playing: nothing has to play on screen, the result does
 * not depend on the machine keeping up, and it is usually faster than real time.
 */

export type ExportStep = "read" | "audio" | "video" | "finish";

export interface ExportJob {
  width: number;
  height: number;
  fps: number;
  /** Bits per second of the picture (see recommendedRate). */
  bitrate: number;
  /** Bits per second of the sound wanted (less if the browser won't). */
  audioBitrate?: number;
  /** Part of the official track exported (seconds). */
  from: number;
  until: number;
  audio: AudioBuffer;
  /** Draw the picture at official-track time `t` (seeks the camera video first). */
  frame: (ctx: CanvasRenderingContext2D, t: number) => Promise<void>;
  onProgress: (p: number, step: ExportStep) => void;
  signal: AbortSignal;
}

// High then Main then Baseline profile; levels high enough for 1080×1920: 4.0 up to 30 fps, 4.2 above (a player may
// refuse a file whose level says less than it holds).
const AVC = ["avc1.640028", "avc1.4d0028", "avc1.640033", "avc1.42002a"];
const AVC_FAST = ["avc1.64002a", "avc1.4d002a", "avc1.640033", "avc1.42002a"];

/**
 * The recommended export for TikTok and Instagram of a camera file playing at `src` frames per second: at its own rate
 * (24, 25, 30, 50, 60…; unknown: 30), so no frame is doubled or dropped; 16 Mb/s up to 30 fps (a clean source for
 * their own compression, above what they keep), and as many bits per frame above, up to 24 Mb/s (Instagram
 * recompresses harder what passes 25 Mb/s).
 */
export function recommendedRate(src?: number): { fps: number; bitrate: number } {
  const fps = !src || src < 23 ? 30 : Math.min(60, Math.round(src * 1000) / 1000);
  return { fps, bitrate: Math.min(24_000_000, Math.max(16_000_000, Math.round((16_000_000 * fps) / 30 / 1e6) * 1e6)) };
}

/** The sound's recommended bitrate (stereo): as music sold online. */
export const AUDIO_KBPS = 256;

export interface ExportSettings { fps: number; bitrate: number; audioBitrate: number; custom: boolean }
/**
 * What an export uses: the recommended settings for the camera file (`src` fps), or, when the user turned their own
 * on, theirs (a rate chosen keeps the recommended bitrate for that rate unless one is chosen too).
 */
export function exportSettings(src: number | undefined, prefs?: { custom?: boolean; fps?: number; mbps?: number; audioKbps?: number }): ExportSettings {
  const custom = !!prefs?.custom;
  const rate = recommendedRate(custom && prefs?.fps ? prefs.fps : src);
  return {
    fps: rate.fps,
    bitrate: custom && prefs?.mbps ? prefs.mbps * 1e6 : rate.bitrate,
    audioBitrate: (custom && prefs?.audioKbps ? prefs.audioKbps : AUDIO_KBPS) * 1000,
    custom,
  };
}

/** The sound's bitrates, best first: the one wanted (160 at most in mono), then less when the browser won't. */
const AUDIO_BITRATES = (channels: number, wanted = AUDIO_KBPS * 1000) => {
  const top = channels > 1 ? wanted : Math.min(wanted, 160_000);
  return [top, ...[192_000, 128_000].filter((b) => b < top)];
};
/** A sample rate every platform takes (Instagram: 48 kHz at most): 88.2 / 176.4 kHz to 44.1, 96 / 192 to 48. */
export const exportSampleRate = (sr: number) => (sr <= 48000 ? sr : sr % 44100 === 0 ? 44100 : 48000);

/** Codecs this browser can encode for an MP4, or null (then the realtime fallback is used). */
export async function mp4Support(width: number, height: number, sampleRate: number, channels: number, fps = 30, bitrate = 16_000_000, audioBitrate = AUDIO_KBPS * 1000) {
  if (typeof VideoEncoder === "undefined" || typeof AudioEncoder === "undefined" || typeof VideoFrame === "undefined") return null;
  let video: string | null = null;
  for (const codec of fps > 30.5 ? AVC_FAST : AVC) {
    try {
      const r = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate, framerate: fps });
      if (r.supported) { video = codec; break; }
    } catch { /* next */ }
  }
  if (!video) return null;
  // AAC only: Opus inside an MP4 is silent in QuickTime, on iPhones and in some editors. The best bitrate it takes.
  for (const ab of AUDIO_BITRATES(channels, audioBitrate)) {
    try {
      const r = await AudioEncoder.isConfigSupported({ codec: "mp4a.40.2", sampleRate, numberOfChannels: channels, bitrate: ab });
      if (r.supported) return { video, audio: "mp4a.40.2", audioBitrate: ab };
    } catch { /* next */ }
  }
  return null;
}

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
/**
 * AudioSpecificConfig of AAC-LC (2 bytes). Players need it to decode the sound; some browsers do not
 * hand it with the encoded chunks, and an MP4 without it plays silent.
 */
export function aacConfig(sampleRate: number, channels: number): Uint8Array {
  const idx = Math.max(0, AAC_RATES.indexOf(sampleRate));
  const v = (2 << 11) | (idx << 7) | (channels << 3);
  return new Uint8Array([v >> 8, v & 0xff]);
}

const aborted = () => new DOMException("aborted", "AbortError");

/** The part of the sound exported, at a sample rate every platform takes (resampled by the browser if need be). */
async function soundPart(audio: AudioBuffer, from: number, until: number, channels: number): Promise<{ audio: AudioBuffer; from: number; until: number }> {
  const rate = exportSampleRate(audio.sampleRate);
  if (rate === audio.sampleRate) return { audio, from, until };
  const ctx = new OfflineAudioContext(channels, Math.max(1, Math.ceil((until - from) * rate)), rate);
  const src = ctx.createBufferSource();
  src.buffer = audio;
  src.connect(ctx.destination);
  src.start(0, from, until - from);
  return { audio: await ctx.startRendering(), from: 0, until: until - from };
}

export async function exportMp4(job: ExportJob): Promise<Blob> {
  const { width, height, fps, signal } = job;
  const channels = Math.min(2, job.audio.numberOfChannels);
  const { audio, from: a0, until: a1 } = await soundPart(job.audio, job.from, job.until, channels);
  const { from, until } = job;
  const sr = audio.sampleRate;
  const codecs = await mp4Support(width, height, sr, channels, fps, job.bitrate, job.audioBitrate);
  if (!codecs) throw new Error("unsupported");

  const { ArrayBufferTarget, Muxer } = await import("mp4-muxer");
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width, height, frameRate: fps },
    audio: { codec: "aac", sampleRate: sr, numberOfChannels: channels },
    fastStart: "in-memory", // index at the start: plays at once on phones and on TikTok's upload
    firstTimestampBehavior: "offset",
  });
  let failure: unknown = null;

  // ---- audio first: it is quick, and the progress bar then follows the frames
  let audioChunks = 0;
  const asc = aacConfig(sr, channels);
  const aenc = new AudioEncoder({
    output: (c, m) => {
      audioChunks++;
      const desc = m?.decoderConfig?.description;
      const ok = desc && (desc as ArrayBuffer).byteLength > 0;
      muxer.addAudioChunk(c, ok ? m : { decoderConfig: { codec: "mp4a.40.2", sampleRate: sr, numberOfChannels: channels, description: asc } });
    },
    error: (e) => { failure = e; },
  });
  aenc.configure({ codec: codecs.audio, sampleRate: sr, numberOfChannels: channels, bitrate: codecs.audioBitrate, aac: { format: "aac" } } as AudioEncoderConfig);
  const s0 = Math.round(a0 * sr), s1 = Math.min(audio.length, Math.round(a1 * sr));
  const BLOCK = 4096;
  for (let a = s0; a < s1; a += BLOCK) {
    if (signal.aborted) throw aborted();
    const len = Math.min(BLOCK, s1 - a);
    const data = new Float32Array(len * channels);
    for (let c = 0; c < channels; c++) data.set(audio.getChannelData(c).subarray(a, a + len), c * len);
    const ad = new AudioData({ format: "f32-planar", sampleRate: sr, numberOfFrames: len, numberOfChannels: channels, timestamp: Math.round(((a - s0) * 1e6) / sr), data });
    aenc.encode(ad);
    ad.close();
    job.onProgress(((a - s0) / Math.max(1, s1 - s0)) * 0.05, "audio");
  }
  await aenc.flush();
  aenc.close();
  if (failure) throw failure;
  if (!audioChunks) throw new Error("no-audio"); // never deliver a silent video

  // ---- video, frame by frame
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const venc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: (e) => { failure = e; } });
  venc.configure({ codec: codecs.video, width, height, bitrate: job.bitrate, framerate: fps, latencyMode: "quality", avc: { format: "avc" } });
  const gop = Math.max(1, Math.round(fps * 2)); // a key frame every 2 s (29.97 fps too: a whole number of frames)
  const n = Math.max(1, Math.round((until - from) * fps));
  const step = 1e6 / fps;
  try {
    for (let i = 0; i < n; i++) {
      if (signal.aborted) throw aborted();
      if (failure) throw failure;
      await job.frame(ctx, from + i / fps);
      const vf = new VideoFrame(canvas, { timestamp: Math.round(i * step), duration: Math.round(step) });
      venc.encode(vf, { keyFrame: i % gop === 0 });
      vf.close();
      // Do not let frames pile up in the encoder (memory). Wait on the encoder itself, not on a timer:
      // timers are slowed down to once a second in a background tab.
      while (venc.encodeQueueSize > 6) await new Promise((r) => venc.addEventListener("dequeue", r, { once: true }));
      job.onProgress(0.05 + ((i + 1) / n) * 0.9, "video");
    }
    job.onProgress(0.96, "finish");
    await venc.flush();
  } finally {
    if (venc.state !== "closed") venc.close();
  }
  if (failure) throw failure;
  muxer.finalize();
  job.onProgress(1, "finish");
  return new Blob([muxer.target.buffer], { type: "video/mp4" });
}

/** Wait until the video shows the frame at `time` (seconds). */
export function seekVideo(el: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    if (Math.abs(el.currentTime - time) < 1e-3) {
      if (el.readyState >= 2) { resolve(); return; }
      // Already there but no picture decoded yet (first frame): wait for it instead of seeking.
      const ready = () => { el.removeEventListener("loadeddata", ready); clearTimeout(guard); resolve(); };
      const guard = setTimeout(ready, 3000);
      el.addEventListener("loadeddata", ready);
      return;
    }
    const done = () => { el.removeEventListener("seeked", done); clearTimeout(guard); resolve(); };
    const guard = setTimeout(done, 3000);
    el.addEventListener("seeked", done);
    el.currentTime = time;
  });
}
