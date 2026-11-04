import { createFile, DataStream, Endianness, MP4BoxBuffer, type Sample, type Track } from "mp4box";
import type { Region } from "./render";

/**
 * Frames of the camera video for the export, decoded with WebCodecs from the file itself.
 *
 * Seeking a hidden <video> for every frame is not reliable: the browser stops decoding video in a
 * background tab (and sometimes after a while anyway), so the picture froze while the sound and the
 * lyrics went on. Here the MP4 / MOV is read with mp4box, the samples are decoded in order, and each
 * call returns the frame shown at that time, whatever the tab does.
 */

export interface Picture {
  src: CanvasImageSource;
  /** Size of the whole picture. */
  w: number;
  h: number;
  /** `src` is a cropped copy holding only this region of the w×h picture (converted camera files). */
  part?: Region;
}

const CHUNK = 16 * 1024 * 1024;
/** Chunks fed beyond the frames already decoded: covers the reordering of B-frames (at most 16). */
const AHEAD = 20;

/** avcC / hvcC / vpcC / av1C box of the track: the decoder's `description`. */
function describe(file: ReturnType<typeof createFile>, track: Track): Uint8Array | undefined {
  const trak = file.getTrackById(track.id) as any;
  for (const entry of trak?.mdia?.minf?.stbl?.stsd?.entries ?? []) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (box) {
      const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array(stream.buffer, 8); // without the box header
    }
  }
  return undefined;
}

/** Human name of a codec string, for messages ("avc1.7a1033" → "H.264 4:2:2 10-bit"). */
export function codecLabel(codec: string): string {
  const c = codec.toLowerCase();
  if (c.startsWith("avc1") || c.startsWith("avc3")) {
    const profile = parseInt(c.slice(5, 7), 16);
    const name: Record<number, string> = {
      66: "H.264 Baseline", 77: "H.264 Main", 100: "H.264 High", 110: "H.264 High 10 (10-bit)",
      122: "H.264 4:2:2 10-bit (Sony XAVC, pro cameras)", 244: "H.264 4:4:4",
    };
    return `${name[profile] ?? "H.264"} · ${codec}`;
  }
  if (c.startsWith("hvc1") || c.startsWith("hev1")) {
    const profile = Number(c.split(".")[1]);
    return `${profile === 4 ? "HEVC 4:2:2 / RExt (pro cameras)" : profile === 2 ? "HEVC Main 10" : "HEVC"} · ${codec}`;
  }
  if (c.startsWith("apch") || c.startsWith("apcn") || c.startsWith("apcs") || c.startsWith("apco") || c.startsWith("ap4")) return `ProRes · ${codec}`;
  return codec;
}

/** Rotation the phone stored in the track (portrait videos are often landscape frames turned 90°). */
export function rotationOf(m: Track["matrix"]): 0 | 90 | 180 | 270 {
  const a = Number(m?.[0] ?? 65536) / 65536, b = Number(m?.[1] ?? 0) / 65536;
  const deg = Math.round((Math.atan2(b, a) * 180) / Math.PI / 90) * 90;
  return (((deg % 360) + 360) % 360) as 0 | 90 | 180 | 270;
}

export class VideoSource {
  private queue: VideoFrame[] = [];
  private cur: VideoFrame | null = null;
  private fed = 0;
  /** Frames handed back by the decoder so far. */
  private outs = 0;
  private ahead = AHEAD;
  private flushed = false;
  private wake: (() => void) | null = null;
  private failure: unknown = null;
  private turned: HTMLCanvasElement | null = null;
  codec = "";

  private constructor(
    private dec: VideoDecoder,
    private samples: Sample[],
    private timescale: number,
    /** Media time of the first frame shown (edit list), in seconds. */
    private shift: number,
    readonly rotation: 0 | 90 | 180 | 270,
  ) {
    dec.addEventListener("dequeue", () => this.wake?.());
  }

  /**
   * Read the file and keep the samples needed for [from, to] (video seconds).
   * Null when the file or its codec cannot be decoded this way: the caller falls back on the <video>.
   */
  /** Why the last `open` gave up (shown in the export window and the console). */
  static lastReason = "";

  static async open(blob: Blob, from: number, to: number, onProgress?: (p: number) => void, signal?: AbortSignal): Promise<VideoSource | null> {
    const fail = (why: string) => { VideoSource.lastReason = why; console.warn("[export] direct decoding not used:", why); return null; };
    if (typeof VideoDecoder === "undefined") return fail("no WebCodecs");
    // Keep the media data: phone videos put their index (moov) AFTER the data, which would
    // otherwise be thrown away before the samples can be read.
    const file = createFile(true);
    let track: Track | null = null;
    let ready = false;
    const kept: Sample[] = [];
    let scale = 1;
    let shift = 0;
    file.onError = () => { /* handled below: no track */ };
    file.onReady = (info) => {
      track = info.videoTracks?.[0] ?? null;
      if (!track) return;
      ready = true;
      scale = track.timescale;
      // Edit list: an empty first edit delays the video, a media_time skips its first frames.
      const edits = (track.edits ?? []) as { media_time: number; segment_duration: number }[];
      for (const e of edits) {
        if (e.media_time === -1) shift -= e.segment_duration / (info.timescale || 1);
        else { shift += e.media_time / scale; break; }
      }
      file.setExtractionOptions(track.id, null, { nbSamples: 500 });
      file.start();
    };
    file.onSamples = (id, _user, samples) => {
      for (const s of samples) {
        const t = s.cts / s.timescale - shift;
        // Restart from every keyframe until the segment begins: decoding must start on one.
        if (s.is_sync && t <= from + 1e-3) kept.length = 0;
        if (t <= to + 1 && s.data) kept.push({ ...s, data: new Uint8Array(s.data) });
      }
      file.releaseUsedSamples(id, samples[samples.length - 1].number + 1);
    };
    try {
      for (let at = 0; at < blob.size; at += CHUNK) {
        if (signal?.aborted) return fail("cancelled");
        const buf = MP4BoxBuffer.fromArrayBuffer(await blob.slice(at, at + CHUNK).arrayBuffer(), at);
        file.appendBuffer(buf, at + CHUNK >= blob.size);
        onProgress?.(Math.min(1, (at + CHUNK) / blob.size));
      }
      file.flush();
    } catch {
      return fail("not an MP4 / MOV file"); // WebM…
    }
    const tk = track as Track | null;
    if (!ready || !tk) return fail("no video track found");
    if (!kept.length) return fail("no frames read for the segment");
    kept.sort((a, b) => a.dts - b.dts);
    // The samples must really cover the segment, else the picture would freeze: use the <video> instead.
    const lastT = Math.max(...kept.map((x) => x.cts / x.timescale)) - shift;
    const trackEnd = tk.samples_duration / tk.timescale - shift;
    if (lastT < Math.min(to, trackEnd) - 0.5) return fail(`frames read only up to ${lastT.toFixed(1)} s of ${Math.min(to, trackEnd).toFixed(1)} s`);
    const base: VideoDecoderConfig = {
      codec: tk.codec.startsWith("vp08") ? "vp8" : tk.codec,
      codedWidth: tk.video?.width ?? tk.track_width,
      codedHeight: tk.video?.height ?? tk.track_height,
      description: describe(file, tk),
    };
    // Some browsers only take pro formats (4:2:2, 10 bits) on one path: hardware or software.
    let config: VideoDecoderConfig | null = null;
    for (const hardwareAcceleration of ["no-preference", "prefer-hardware", "prefer-software"] as const) {
      try {
        const r = await VideoDecoder.isConfigSupported({ ...base, hardwareAcceleration });
        if (r.supported) { config = { ...base, hardwareAcceleration }; break; }
      } catch { /* next */ }
    }
    if (!config) return fail(`${codecLabel(base.codec)} not decodable by this browser`);
    let src: VideoSource | null = null;
    const dec = new VideoDecoder({
      output: (f) => { if (src) { src.outs++; src.queue.push(f); src.wake?.(); } else f.close(); },
      error: (e) => { if (src) { src.failure = e; src.wake?.(); } },
    });
    dec.configure(config);
    src = new VideoSource(dec, kept, scale, shift, rotationOf(tk.matrix));
    src.codec = config.codec;
    VideoSource.lastReason = "";
    console.info("[export] direct decoding:", config.codec, `${kept.length} frames`, `rotation ${src.rotation}°`);
    return src;
  }

  /** Resolves true when the decoder moved (a frame came out, a chunk was taken), false after `ms`. */
  private wait(ms: number) {
    return new Promise<boolean>((r) => {
      const guard = setTimeout(() => { this.wake = null; r(false); }, ms);
      this.wake = () => { clearTimeout(guard); this.wake = null; r(true); };
    });
  }

  /** Frame shown at video time `t` (seconds). Calls must go forward in time. */
  async frameAt(t: number): Promise<Picture | null> {
    const target = (t + this.shift) * 1e6;
    for (;;) {
      if (this.failure) throw this.failure;
      while (this.queue.length && this.queue[0].timestamp <= target + 500) {
        this.cur?.close();
        this.cur = this.queue.shift()!;
      }
      if (this.queue.length || this.flushed) break; // the next frame is later: the current one is shown now
      if (this.fed < this.samples.length) {
        // Feed only a little ahead of what came back. Feeding the whole clip at once made the
        // (hardware) decoder hold back its frames: the export then froze on the first picture.
        if (this.dec.decodeQueueSize < 4 && this.fed - this.outs < this.ahead) {
          const s = this.samples[this.fed++];
          this.dec.decode(new EncodedVideoChunk({
            type: s.is_sync ? "key" : "delta",
            timestamp: Math.round((s.cts * 1e6) / this.timescale),
            duration: Math.round((s.duration * 1e6) / this.timescale),
            data: s.data!,
          }));
          continue;
        }
        // A decoder that wants more input before giving frames back: let it run further ahead.
        if (!(await this.wait(1500)) && this.dec.decodeQueueSize === 0) this.ahead += 16;
        continue;
      }
      await this.dec.flush(); // last frames held back for reordering
      this.flushed = true;
    }
    return this.cur ? this.picture(this.cur) : null;
  }

  private picture(f: VideoFrame): Picture {
    const w = f.displayWidth, h = f.displayHeight;
    if (!this.rotation) return { src: f, w, h };
    const side = this.rotation === 90 || this.rotation === 270;
    const c = (this.turned ??= document.createElement("canvas"));
    const cw = side ? h : w, ch = side ? w : h;
    if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
    const g = c.getContext("2d")!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    if (this.rotation === 90) { g.translate(cw, 0); g.rotate(Math.PI / 2); }
    else if (this.rotation === 180) { g.translate(cw, ch); g.rotate(Math.PI); }
    else { g.translate(0, ch); g.rotate(-Math.PI / 2); }
    g.drawImage(f, 0, 0);
    return { src: c, w: cw, h: ch };
  }

  close() {
    this.cur?.close();
    this.queue.forEach((f) => f.close());
    this.queue = [];
    this.samples = [];
    if (this.dec.state !== "closed") this.dec.close();
  }
}
