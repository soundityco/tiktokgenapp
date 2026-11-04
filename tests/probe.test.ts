import { describe, expect, it } from "vitest";
import { describeBytes } from "../lib/probe";
import { hlgToLin, pqToLin } from "../lib/grade";

const bytes = (...parts: (string | ArrayLike<number>)[]) => {
  const out: number[] = [];
  for (const p of parts) out.push(...(typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : Array.from(p)));
  return new Uint8Array(out);
};
/** A colour box: nclx, primaries, transfer, matrix. */
const colr = (prim: number, trc: number) => bytes("colr", "nclx", [0, prim, 0, trc, 0, 1, 0]);

describe("probeVideo (what the imported file is)", () => {
  it("Sony XAVC S-I in S-Log3 / S-Gamut3.Cine", () => {
    const xml = '<Device manufacturer="Sony" modelName="ILME-FX30"/><Item name="CaptureGammaEquation" value="s-log3-cine"/><Item name="CaptureColorPrimaries" value="S-Gamut3Cine"/>';
    const p = describeBytes(bytes("moov", "avc1", "avcC", [1, 122, 0, 0], xml, colr(1, 1)));
    expect(p).toMatchObject({ kind: "camera", device: "Sony ILME-FX30", colour: "log", profile: "slog3-cine", convert: true });
    expect(p.codec).toBe("H.264 4:2:2 10-bit");
  });
  it("iPhone HDR (HLG) and iPhone SDR", () => {
    const hdr = describeBytes(bytes("moov", "hvc1", colr(9, 18), "com.apple.quicktime.model", "iPhone 15 Pro"));
    expect(hdr).toMatchObject({ kind: "phone", colour: "hdr", profile: "hlg", convert: false });
    const sdr = describeBytes(bytes("moov", "avc1", "avcC", [1, 100, 0, 0], colr(1, 1), "iPhone 12"));
    expect(sdr).toMatchObject({ kind: "phone", colour: "sdr", convert: false });
    expect(sdr.profile).toBeUndefined();
  });
  it("HDR10 (PQ) and a file that says nothing", () => {
    expect(describeBytes(bytes("moov", "hvc1", colr(9, 16)))).toMatchObject({ colour: "hdr", profile: "pq" });
    expect(describeBytes(bytes("moov", "avc1"))).toMatchObject({ kind: "unknown", colour: "unknown" });
  });
  it("HDR curves: reference white is 1", () => {
    expect(hlgToLin(0.75)).toBeCloseTo(1, 3);
    expect(pqToLin(0.58069)).toBeCloseTo(1, 1);
  });
});
