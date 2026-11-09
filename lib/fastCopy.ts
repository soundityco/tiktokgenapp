import { createFile, DataStream, Endianness, MP4BoxBuffer, type Sample, type Track } from "mp4box";
import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import { ffmpegAlone, type CopyPlan } from "./convert";
import { aacConfig } from "./exportVideo";
import { rotationOf } from "./videoSource";

/**
 * The working copy of a take made by the device's own video chip (WebCodecs): the pictures are decoded and
 * encoded in hardware, often faster than real time, where ffmpeg in WebAssembly takes minutes on one core.
 *
 * Same copy as `copyArgs` (lib/convert): the take's own clock from 0 to `to`, the first picture of the passage held
 * before `from`, the camera's sound all along. 8-bit footage is scaled to at most 1920 px on its short side and
 * encoded in H.264 (every browser plays it); 10-bit footage (log, HDR) keeps its 10 bits, at its own size, in HEVC
 * Main 10 where the chip encodes it (Safari), else VP9 profile 2 (Chrome). The sound is read by ffmpeg (sound only: a few seconds) and encoded in AAC here.
 *
 * Null when this device cannot do it (codec, browser): the caller then uses ffmpeg. Throws when it started and
 * failed: the caller uses ffmpeg too.
 */

export interface FastCopyReport { codec: string; width: number; height: number; frames: number; sound: number; picture: number }

const aborted = () => new DOMException("aborted", "AbortError");
const AVC = ["avc1.640033", "avc1.640034", "avc1.4d0033", "avc1.640028"];
/** 10 bits: HEVC Main 10 (Safari, the video chip), else VP9 profile 2 (Chrome, its own fast encoder). */
const TEN = ["hvc1.2.4.L153.B0", "hvc1.2.4.L156.B0", "hvc1.2.4.L150.B0", "hvc1.2.4.L123.B0", "vp09.02.51.10", "vp09.02.41.10"];

/** Where the top-level boxes of the file are (ftyp, moov…): the index is read alone, the pictures one by one. */
async function topBoxes(blob: Blob) {
  const boxes: { type: string; start: number; size: number }[] = [];
  let at = 0;
  while (at + 8 <= blob.size && boxes.length < 64) {
    const h = new DataView(await blob.slice(at, at + 16).arrayBuffer());
    let size = h.getUint32(0);
    const type = String.fromCharCode(h.getUint8(4), h.getUint8(5), h.getUint8(6), h.getUint8(7));
    if (size === 1) size = Number(h.getBigUint64(8));
    else if (size === 0) size = blob.size - at;
    if (size < 8) break;
    boxes.push({ type, start: at, size });
    at += size;
  }
  return boxes;
}

/** avcC / hvcC box of the track: the decoder's `description`. */
function describe(file: ReturnType<typeof createFile>, track: Track): Uint8Array | undefined {
  const trak = file.getTrackById(track.id) as any;
  for (const entry of trak?.mdia?.minf?.stbl?.stsd?.entries ?? []) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (box) {
      const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array(stream.buffer, 8);
    }
  }
  return undefined;
}

async function firstSupported<C extends VideoEncoderConfig | VideoDecoderConfig>(
  check: (c: C) => Promise<{ supported?: boolean }>, configs: C[]): Promise<C | null> {
  for (const c of configs) {
    try { if ((await check(c)).supported) return c; } catch { /* next */ }
  }
  return null;
}

export async function fastWorkCopy(file: Blob, plan: CopyPlan, from: number, to: number,
  onProgress: (p: number) => void, signal: AbortSignal): Promise<{ blob: Blob; report: FastCopyReport } | null> {
  if (typeof VideoDecoder === "undefined" || typeof VideoEncoder === "undefined" || typeof AudioEncoder === "undefined") return null;

  // ---- the index (moov) only, wherever it is in the file
  const boxes = await topBoxes(file);
  const moov = boxes.find((b) => b.type === "moov");
  if (!moov || moov.size > 400 * 1024 * 1024) return null;
  const mp4 = createFile();
  let info: Parameters<NonNullable<typeof mp4.onReady>>[0] | null = null;
  mp4.onReady = (i) => { info = i; };
  // Read one after the other as if they were side by side (the pictures' places are written in the index itself).
  const head = await new Blob(boxes.filter((x) => x.type === "ftyp" || x.type === "moov").map((b) => file.slice(b.start, b.start + b.size))).arrayBuffer();
  mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(head, 0), true);
  mp4.flush();
  const ready = info as Parameters<NonNullable<typeof mp4.onReady>>[0] | null;
  const track = ready?.videoTracks?.[0];
  if (!ready || !track) return null;
  const samples = (mp4.getTrackById(track.id) as unknown as { samples?: Sample[] }).samples ?? [];
  if (!samples.length || samples.some((s) => !(s.size > 0))) return null;
  const scale = track.timescale;
  let shift = 0; // edit list, as in lib/videoSource
  for (const e of (track.edits ?? []) as { media_time: number; segment_duration: number }[]) {
    if (e.media_time === -1) shift -= e.segment_duration / (ready.timescale || 1);
    else { shift += e.media_time / scale; break; }
  }
  const timeOf = (s: Sample) => s.cts / scale - shift;

  // ---- the decoder
  const dconf = await firstSupported((c) => VideoDecoder.isConfigSupported(c),
    (["prefer-hardware", "no-preference", "prefer-software"] as const).map((hardwareAcceleration) => ({
      codec: track.codec, codedWidth: track.video?.width ?? track.track_width, codedHeight: track.video?.height ?? track.track_height,
      description: describe(mp4, track), hardwareAcceleration,
    })));
  if (!dconf) { console.info("[copy] video chip: cannot decode", track.codec); return null; }

  // ---- the size and the encoder
  const rotation = rotationOf(track.matrix);
  const srcW = dconf.codedWidth!, srcH = dconf.codedHeight!;
  const upW = rotation % 180 ? srcH : srcW, upH = rotation % 180 ? srcW : srcH;
  const fps = Math.min(120, Math.max(1, samples.length / Math.max(0.1, track.samples_duration / scale))) || 30;
  const tenBit = plan.tenBit;
  let width: number, height: number;
  if (tenBit) { width = srcW; height = srcH; } // the decoded frames as they are (10 bits kept), turned by the file's matrix
  else {
    const k = Math.min(1, 1920 / Math.min(upW, upH));
    width = Math.round((upW * k) / 2) * 2; height = Math.round((upH * k) / 2) * 2;
  }
  // About what CRF 16 gives on a camera picture, for the post's use; HEVC needs less for the same look.
  const bitrate = Math.round(Math.min(80e6, width * height * Math.min(fps, 60) * (tenBit ? 0.14 : 0.2)));
  const base = { width, height, bitrate, framerate: fps, latencyMode: "quality" as const, bitrateMode: "variable" as const };
  const econf = await firstSupported((c) => VideoEncoder.isConfigSupported(c),
    (tenBit ? TEN : AVC).flatMap((codec) => (["prefer-hardware", "no-preference"] as const).map((hardwareAcceleration) => ({
      ...base, codec, hardwareAcceleration, ...(codec.startsWith("hvc1") ? { hevc: { format: "hevc" } } : codec.startsWith("avc1") ? { avc: { format: "avc" } } : {}),
    } as VideoEncoderConfig))));
  if (!econf) { console.info("[copy] video chip: cannot encode", tenBit ? "10-bit" : "H.264", `${width}×${height}`); return null; }

  // ---- the sound: read by ffmpeg (sound only, quick), then AAC here
  const t0 = performance.now();
  const RATE = 48000;
  let pcm: Float32Array<ArrayBuffer> | null = null;
  try {
    const raw = await ffmpegAlone(file, ["-t", to.toFixed(3), "-i", "/in/source", "-map", "0:a:0", "-vn", "-ac", "2", "-ar", String(RATE), "-f", "f32le", "sound.raw"],
      "sound.raw", Math.max(0.1, to), (p) => onProgress(p * 0.08), signal);
    const bytes = raw.byteOffset % 4 ? raw.slice() : raw;
    pcm = new Float32Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
  } catch (e) {
    if (signal.aborted) throw aborted();
    console.info("[copy] no camera sound read", e); // a take without sound: the copy has none either
  }
  if (signal.aborted) throw aborted();
  const tSound = performance.now();

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: econf.codec.startsWith("hvc1") ? "hevc" : econf.codec.startsWith("vp09") ? "vp9" : "avc", width, height, frameRate: Math.round(fps), ...(tenBit && rotation ? { rotation } : {}) },
    ...(pcm?.length ? { audio: { codec: "aac" as const, sampleRate: RATE, numberOfChannels: 2 } } : {}),
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  });
  let failure: unknown = null;

  if (pcm?.length) {
    const asc = aacConfig(RATE, 2);
    const aenc = new AudioEncoder({
      output: (c, m) => {
        const desc = m?.decoderConfig?.description;
        muxer.addAudioChunk(c, desc && (desc as ArrayBuffer).byteLength > 0 ? m : { decoderConfig: { codec: "mp4a.40.2", sampleRate: RATE, numberOfChannels: 2, description: asc } });
      },
      error: (e) => { failure = e; },
    });
    aenc.configure({ codec: "mp4a.40.2", sampleRate: RATE, numberOfChannels: 2, bitrate: 160_000, aac: { format: "aac" } } as AudioEncoderConfig);
    const frames = pcm.length / 2, BLOCK = 4096;
    for (let a = 0; a < frames; a += BLOCK) {
      const len = Math.min(BLOCK, frames - a);
      const ad = new AudioData({ format: "f32", sampleRate: RATE, numberOfFrames: len, numberOfChannels: 2, timestamp: Math.round((a * 1e6) / RATE), data: pcm.subarray(a * 2, (a + len) * 2) });
      aenc.encode(ad);
      ad.close();
      if (aenc.encodeQueueSize > 32) await new Promise((r) => aenc.addEventListener("dequeue", r, { once: true }));
    }
    await aenc.flush();
    aenc.close();
    if (failure) throw failure;
  }
  onProgress(0.1);

  // ---- the pictures: from the keyframe before `from` to `to`, in decoding order
  const order = samples.slice().sort((a, b) => a.dts - b.dts);
  let first = 0;
  for (let i = 0; i < order.length; i++) if (order[i].is_sync && timeOf(order[i]) <= from + 1e-3) first = i;
  let last = first;
  // The last picture shown at `to` may come later in decoding order (B-frames): a little margin.
  while (last + 1 < order.length && order[last + 1].dts / scale - shift <= to + 0.6) last++;
  const work = order.slice(first, last + 1);
  const expected = Math.max(1, Math.round((to - from) * fps));

  const canvas = tenBit ? null : new OffscreenCanvas(width, height);
  const g = canvas?.getContext("2d", { alpha: false }) ?? null;
  if (g) { g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high"; }

  const pending: VideoFrame[] = [];
  let wake: (() => void) | null = null;
  const poke = () => { const w = wake; wake = null; w?.(); };
  const dec = new VideoDecoder({ output: (f) => { pending.push(f); poke(); }, error: (e) => { failure = e; poke(); } });
  const enc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: (e) => { failure = e; poke(); } });
  dec.addEventListener("dequeue", poke);
  enc.addEventListener("dequeue", poke);
  dec.configure(dconf);
  enc.configure(econf);
  const nap = (ms: number) => new Promise<void>((r) => { const t = setTimeout(() => { wake = null; r(); }, ms); wake = () => { clearTimeout(t); r(); }; });

  // The data of the next pictures, read ahead in batches (the file's pictures are interleaved with its sound).
  const read = (i: number, n: number) => {
    const batch = work.slice(i, i + n);
    const lo = batch[0].offset, hi = Math.max(...batch.map((s) => s.offset + s.size));
    if (hi - lo > 96 * 1024 * 1024) return Promise.all(batch.map((s) => file.slice(s.offset, s.offset + s.size).arrayBuffer().then((b) => new Uint8Array(b))));
    return file.slice(lo, hi).arrayBuffer().then((buf) => batch.map((s) => new Uint8Array(buf, s.offset - lo, s.size)));
  };
  const BATCH = 12;
  let ready_: Uint8Array[] = [], readyAt = 0;
  let next: Promise<Uint8Array[]> | null = read(0, BATCH);

  let fed = 0, flushed = false, made = 0, lastKey = -Infinity, held = false, lastTs = -1;
  const put = (f: VideoFrame, ts: number, duration: number, key: boolean) => {
    let vf: VideoFrame;
    if (g && canvas) {
      g.save();
      if (rotation === 90) { g.translate(width, 0); g.rotate(Math.PI / 2); }
      else if (rotation === 180) { g.translate(width, height); g.rotate(Math.PI); }
      else if (rotation === 270) { g.translate(0, height); g.rotate(-Math.PI / 2); }
      const dw = rotation % 180 ? height : width, dh = rotation % 180 ? width : height;
      g.drawImage(f, 0, 0, dw, dh);
      g.restore();
      vf = new VideoFrame(canvas, { timestamp: ts, duration });
    } else vf = new VideoFrame(f, { timestamp: ts, duration });
    enc.encode(vf, { keyFrame: key });
    vf.close();
    if (key) lastKey = ts;
  };

  try {
    for (;;) {
      if (signal.aborted) throw aborted();
      if (failure) throw failure;
      // Pictures that came out: the ones of the passage are encoded, the others let go.
      while (pending.length && enc.encodeQueueSize < 8) {
        const f = pending.shift()!;
        const t = f.timestamp / 1e6 - shift;
        const dur = Math.round(1e6 / fps);
        if (t < from - 0.5 / fps || t > to + 0.5 / fps) { f.close(); continue; }
        const ts = Math.max(Math.round(t * 1e6), lastTs + 1);
        if (!held) {
          held = true;
          // Before the passage: its first picture, held (one picture lasting until the passage starts).
          if (ts > 1000) { put(f, 0, ts, true); lastTs = 0; }
        }
        const finalTs = Math.max(ts, lastTs + 1);
        put(f, finalTs, dur, finalTs - lastKey >= 2e6);
        lastTs = finalTs;
        f.close();
        made++;
        onProgress(0.1 + 0.88 * Math.min(1, made / expected));
      }
      if (fed < work.length && dec.decodeQueueSize < 6 && pending.length < 8) {
        if (readyAt >= ready_.length) { ready_ = await next!; readyAt = 0; next = fed + ready_.length < work.length ? read(fed + ready_.length, BATCH) : null; }
        const s = work[fed++];
        dec.decode(new EncodedVideoChunk({
          type: s.is_sync ? "key" : "delta",
          timestamp: Math.round((s.cts * 1e6) / scale),
          duration: Math.round((s.duration * 1e6) / scale),
          data: ready_[readyAt++],
        }));
        continue;
      }
      if (fed >= work.length && !flushed) { await dec.flush(); flushed = true; continue; }
      if (flushed && !pending.length) break;
      await nap(pending.length ? 20 : 400);
    }
    await enc.flush();
    if (failure) throw failure;
  } finally {
    pending.forEach((f) => f.close());
    if (dec.state !== "closed") dec.close();
    if (enc.state !== "closed") enc.close();
  }
  if (!made) throw new Error("no picture decoded");
  muxer.finalize();
  onProgress(1);
  const blob = new Blob([muxer.target.buffer], { type: "video/mp4" });
  const report = { codec: econf.codec, width, height, frames: made, sound: (tSound - t0) / 1000, picture: (performance.now() - tSound) / 1000 };
  console.info("[copy] video chip:", report, `${(blob.size / 1e6).toFixed(1)} MB`);
  return { blob, report };
}
