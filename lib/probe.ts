/**
 * What a video file is, read from its metadata at import: which device made it (camera or phone),
 * how it recorded the colours (log, HDR or standard SDR), its codec, and whether the browser can read it.
 * Only the file's index (the "moov" box) and a few small boxes are read, never the whole file.
 */

import type { VideoGrade, VideoSourceInfo } from "./types";

const fourcc = (b: Uint8Array, i: number) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
const u16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u32 = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];

function find(b: Uint8Array, tag: string, from = 0): number {
  const c = [...tag].map((ch) => ch.charCodeAt(0));
  outer: for (let i = from; i <= b.length - c.length; i++) {
    for (let k = 0; k < c.length; k++) if (b[i + k] !== c[k]) continue outer;
    return i;
  }
  return -1;
}

/** Top-level boxes worth reading: the index and the metadata (Sony writes its XML in a uuid / meta box). */
async function metadataBytes(file: Blob): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let at = 0;
  for (let n = 0; n < 64 && at + 8 <= file.size; n++) {
    const head = new Uint8Array(await file.slice(at, at + 16).arrayBuffer());
    let size = u32(head, 0);
    const type = fourcc(head, 4);
    if (size === 1) size = u32(head, 8) * 2 ** 32 + u32(head, 12);
    else if (size === 0) size = file.size - at;
    if (size < 8) break;
    if ((type === "moov" && size <= 64 * 2 ** 20) || ((type === "uuid" || type === "meta" || type === "udta" || type === "XMP_") && size <= 4 * 2 ** 20))
      parts.push(new Uint8Array(await file.slice(at, at + size).arrayBuffer()));
    at += size;
  }
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  return all;
}

export interface Probe extends VideoSourceInfo {}

/** Read the metadata bytes of a file (see metadataBytes) and describe it. Exported for the tests. */
export function describeBytes(b: Uint8Array): Probe {
  const text = new TextDecoder("latin1").decode(b);
  // Sony: <Item name="CaptureGammaEquation" value="s-log3-cine"/>
  const attr = (name: string) => new RegExp(`${name}"?\\s+value="([^"]+)"`, "i").exec(text)?.[1];

  // Device: Sony's XML, else QuickTime / Android metadata.
  const sonyModel = /<Device[^>]*modelName="([^"]+)"/i.exec(text)?.[1];
  const sonyMaker = /<Device[^>]*manufacturer="([^"]+)"/i.exec(text)?.[1];
  const apple = /iPhone[ \w]*|iPad[ \w]*/.exec(text)?.[0]?.trim();
  const android = /com\.android\.(?:manufacturer|model)/.test(text);
  let device = sonyModel ? `${sonyMaker ?? "Sony"} ${sonyModel}` : apple ?? undefined;
  if (!device) {
    const maker = /(Canon|Panasonic|FUJIFILM|Nikon|Blackmagic|DJI|GoPro|samsung|Google|Xiaomi|OnePlus)/i.exec(text)?.[1];
    if (maker) device = maker;
  }
  const phone = !!apple || android || /^(samsung|Google|Xiaomi|OnePlus)$/i.test(device ?? "");
  const kind: Probe["kind"] = sonyModel || (device && !phone) ? "camera" : phone ? "phone" : "unknown";

  // Codec of the video track.
  let codec = "";
  const entry = /(avc1|avc3|hvc1|hev1|apch|apcn|apcs|apco|ap4h|ap4x|vp09|av01)/.exec(text);
  if (entry) codec = entry[1];
  let bitDepth = 8, chroma = "4:2:0";
  const avcC = find(b, "avcC");
  if (avcC >= 0) {
    const profile = b[avcC + 5];
    if (profile === 122) { bitDepth = 10; chroma = "4:2:2"; }
    else if (profile === 110) bitDepth = 10;
    else if (profile === 244) { bitDepth = 10; chroma = "4:4:4"; }
  }
  const hvcC = find(b, "hvcC");
  if (hvcC >= 0) {
    chroma = ["4:0:0", "4:2:0", "4:2:2", "4:4:4"][b[hvcC + 21] & 3];
    bitDepth = (b[hvcC + 22] & 7) + 8;
  }
  if (codec.startsWith("ap")) { bitDepth = 10; chroma = codec === "ap4h" || codec === "ap4x" ? "4:4:4" : "4:2:2"; }

  // How the colours were recorded: Sony's XML says it plainly, else the colour box of the track.
  let primaries = 0, transfer = 0;
  const colr = find(b, "colr");
  if (colr >= 0 && (fourcc(b, colr + 4) === "nclx" || fourcc(b, colr + 4) === "nclc")) {
    primaries = u16(b, colr + 8);
    transfer = u16(b, colr + 10);
  }
  const gamma = (attr("CaptureGammaEquation") ?? "").toLowerCase();
  const gamut = (attr("CaptureColorPrimaries") ?? "").toLowerCase();
  let profile: VideoGrade["profile"] | null = null;
  let curve = "";
  if (gamma.includes("log3")) {
    const cine = gamma.includes("cine") || gamut.includes("cine");
    profile = cine ? "slog3-cine" : "slog3";
    curve = cine ? "S-Log3 / S-Gamut3.Cine" : "S-Log3 / S-Gamut3";
  } else if (gamma.includes("log2")) {
    curve = "S-Log2";
  } else if (gamma.includes("hlg") || transfer === 18) {
    profile = "hlg"; curve = "HDR HLG";
  } else if (transfer === 16) {
    profile = "pq"; curve = "HDR PQ (HDR10)";
  } else if (/apple ?log/i.test(text) || (apple && primaries === 9 && transfer !== 1 && transfer !== 14)) {
    profile = "applelog"; curve = "Apple Log";
  } else if (gamma.includes("cinetone")) {
    curve = "S-Cinetone";
  } else if (gamma || transfer) {
    curve = "SDR Rec.709";
  }
  const colour: Probe["colour"] = profile === "hlg" || profile === "pq" ? "hdr" : profile ? "log" : curve === "S-Log2" ? "log" : curve ? "sdr" : "unknown";

  const codecName = codec.startsWith("avc") ? "H.264" : codec.startsWith("h") ? "HEVC" : codec.startsWith("ap") ? "ProRes" : codec === "vp09" ? "VP9" : codec === "av01" ? "AV1" : codec;
  // What browsers decode: 8-bit 4:2:0 H.264, HEVC 4:2:0 (8 or 10-bit, on recent Macs and PCs), VP9, AV1.
  const convert = codec.startsWith("ap") || chroma !== "4:2:0" || (codec.startsWith("avc") && bitDepth > 8);
  // Duration from the movie header (mvhd): version 0 has 32-bit fields, version 1 64-bit ones.
  let duration: number | undefined;
  const mvhd = find(b, "mvhd");
  if (mvhd >= 0) {
    const v1 = b[mvhd + 4] === 1;
    const scale = u32(b, mvhd + (v1 ? 24 : 16));
    const len = v1 ? u32(b, mvhd + 28) * 2 ** 32 + u32(b, mvhd + 32) : u32(b, mvhd + 20);
    if (scale > 0 && len > 0) duration = len / scale;
  }
  return {
    kind, device, colour, duration, profile: profile ?? undefined, curve: curve || undefined,
    codec: codecName ? `${codecName} ${chroma} ${bitDepth}-bit` : undefined, convert,
  };
}

/** Describe a video file from its metadata. Never throws: unknown parts are left out. */
export async function probeVideo(file: Blob): Promise<Probe> {
  try {
    return describeBytes(await metadataBytes(file));
  } catch (e) {
    console.warn("[probe] could not read the metadata", e);
    return { kind: "unknown", colour: "unknown", convert: false };
  }
}
