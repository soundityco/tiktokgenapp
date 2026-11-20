import { describe, expect, it } from "vitest";
import { wavOf } from "@/lib/wav";

describe("wavOf", () => {
  it("writes a 16-bit PCM WAV, channels interleaved", async () => {
    const l = new Float32Array([0, 1, -1]), r = new Float32Array([0.5, -0.5, 2]);
    const b = wavOf([l, r], 48000);
    const v = new DataView(await b.arrayBuffer());
    expect(b.size).toBe(44 + 3 * 2 * 2);
    expect(String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3))).toBe("RIFF");
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint32(24, true)).toBe(48000);
    expect(v.getInt16(44, true)).toBe(0);
    expect(v.getInt16(46, true)).toBe(Math.round(0.5 * 0x7fff - 0.5)); // 16383
    expect(v.getInt16(48, true)).toBe(0x7fff);
    expect(v.getInt16(52, true)).toBe(-0x8000);
    expect(v.getInt16(54, true)).toBe(0x7fff); // (clipped)
  });
});
