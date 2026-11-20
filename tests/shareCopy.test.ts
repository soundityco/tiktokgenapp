import { describe, expect, it } from "vitest";
import { shareCopy } from "@/lib/driveCopy";
import type { VideoSetup } from "@/lib/types";

const v = (id: string, media: string, copy?: { id: string; from: number; to: number }) =>
  ({ id, name: id, media, videoSize: 100, drive: copy ? { copy: { ...copy, of: 100, size: 10, tenBit: true } } : undefined } as unknown as VideoSetup);

describe("a Drive copy shared by the videos of one file", () => {
  it("goes to the duplicate that had the same copy, the old one deleted once nobody reads it", () => {
    const r = shareCopy([v("a", "f", { id: "c1", from: 0, to: 30 }), v("b", "f", { id: "c1", from: 0, to: 30 })], "a", { id: "c2", from: 0, to: 40, of: 100, size: 12, tenBit: true });
    expect(r.videos.map((x) => x.drive?.copy?.id)).toEqual(["c2", "c2"]);
    expect(r.gone).toEqual(["c1"]);
  });
  it("leaves a copy another project still needs (the new one does not cover it)", () => {
    const r = shareCopy([v("a", "f", { id: "c1", from: 0, to: 30 }), v("b", "f", { id: "c1", from: 0, to: 30 })], "a", { id: "c2", from: 10, to: 20, of: 100, size: 5, tenBit: true });
    expect(r.videos.map((x) => x.drive?.copy?.id)).toEqual(["c2", "c1"]);
    expect(r.gone).toEqual([]);
  });
  it("gives it to a video of the same file without a copy, never to another file", () => {
    const r = shareCopy([v("a", "f"), v("b", "f"), v("c", "g")], "a", { id: "c2", from: 0, to: 40, of: 100, size: 12, tenBit: true });
    expect(r.videos.map((x) => x.drive?.copy?.id)).toEqual(["c2", "c2", undefined]);
  });
});
