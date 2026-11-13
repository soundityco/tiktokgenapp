
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
  /** Part of the official track exported (seconds). */
  from: number;
  until: number;
  audio: AudioBuffer;
  /** Draw the picture at official-track time `t` (seeks the camera video first). */
  frame: (ctx: CanvasRenderingContext2D, t: number) => Promise<void>;
  onProgress: (p: number, step: ExportStep) => void;
  signal: AbortSignal;
}

// High then Main then Baseline profile; levels high enough for 1080×1920 at 30 fps.
const AVC = ["avc1.640028", "avc1.4d0028", "avc1.640033", "avc1.42002a"];

/** Codecs this browser can encode for an MP4, or null (then the realtime fallback is used). */
export async function mp4Support(width: number, height: number, sampleRate: number, channels: number) {
  if (typeof VideoEncoder === "undefined" || typeof AudioEncoder === "undefined" || typeof VideoFrame === "undefined") return null;
  let video: string | null = null;
  for (const codec of AVC) {
    try {
      const r = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate: 12_000_000, framerate: 30 });
      if (r.supported) { video = codec; break; }
    } catch { /* next */ }
  }
  if (!video) return null;
  // AAC only: Opus inside an MP4 is silent in QuickTime, on iPhones and in some editors.
  try {
    const r = await AudioEncoder.isConfigSupported({ codec: "mp4a.40.2", sampleRate, numberOfChannels: channels, bitrate: 192_000 });
    if (r.supported) return { video, audio: "mp4a.40.2" };
  } catch { /* not supported */ }
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

export async function exportMp4(job: ExportJob): Promise<Blob> {
  const { width, height, fps, from, until, audio, signal } = job;
  const channels = Math.min(2, audio.numberOfChannels);
  const sr = audio.sampleRate;
  const codecs = await mp4Support(width, height, sr, channels);
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
  aenc.configure({ codec: codecs.audio, sampleRate: sr, numberOfChannels: channels, bitrate: 192_000, aac: { format: "aac" } } as AudioEncoderConfig);
  const s0 = Math.round(from * sr), s1 = Math.min(audio.length, Math.round(until * sr));
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
  venc.configure({ codec: codecs.video, width, height, bitrate: 12_000_000, framerate: fps, latencyMode: "quality", avc: { format: "avc" } });
  const n = Math.max(1, Math.round((until - from) * fps));
  const step = 1e6 / fps;
  try {
    for (let i = 0; i < n; i++) {
      if (signal.aborted) throw aborted();
      if (failure) throw failure;
      await job.frame(ctx, from + i / fps);
      const vf = new VideoFrame(canvas, { timestamp: Math.round(i * step), duration: Math.round(step) });
      venc.encode(vf, { keyFrame: i % (fps * 2) === 0 });
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
