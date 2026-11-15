import { describe, expect, it } from "vitest";
import { videoOnlyMoov } from "@/lib/videoSource";

const box = (type: string, ...kids: Uint8Array[]) => {
  const size = 8 + kids.reduce((n, k) => n + k.length, 0);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  out.set([...type].map((c) => c.charCodeAt(0)), 4);
  let at = 8;
  for (const k of kids) { out.set(k, at); at += k.length; }
  return out;
};
const raw = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
const trak = (handler: string) => box("trak", box("tkhd", raw("xxxx")), box("mdia", box("mdhd", raw("yyyy")), box("hdlr", raw("\0\0\0\0\0\0\0\0" + handler + "rest"))));
const types = (moov: Uint8Array) => {
  const v = new DataView(moov.buffer, moov.byteOffset), out: string[] = [];
  for (let at = 8; at < moov.length; at += v.getUint32(at)) out.push(String.fromCharCode(...moov.subarray(at + 4, at + 8)));
  return out;
};

describe("videoOnlyMoov", () => {
  it("keeps the video tracks only (the camera's PCM sound made millions of samples)", () => {
    const moov = box("moov", box("mvhd", raw("hhhh")), trak("vide"), trak("soun"), trak("tmcd"), box("udta", raw("u")));
    const out = videoOnlyMoov(moov);
    expect(types(out)).toEqual(["mvhd", "trak", "udta"]);
    expect(new DataView(out.buffer).getUint32(0)).toBe(out.length);
    expect(out.subarray(8 + 12, 8 + 12 + trak("vide").length)).toEqual(trak("vide")); // after moov's header and mvhd
  });
  it("leaves the index as it is when it has no video track, nothing to remove, or is broken", () => {
    const sound = box("moov", box("mvhd", raw("hhhh")), trak("soun"));
    expect(videoOnlyMoov(sound)).toBe(sound);
    const video = box("moov", trak("vide"));
    expect(videoOnlyMoov(video)).toBe(video);
    const broken = box("moov", trak("vide"), trak("soun")).slice(0, 30);
    new DataView(broken.buffer).setUint32(0, 30);
    expect(videoOnlyMoov(broken)).toBe(broken);
  });
});
