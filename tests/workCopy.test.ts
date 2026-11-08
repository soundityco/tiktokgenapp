import { describe, expect, it } from "vitest";
import { writeFileSync } from "fs";
import { copyArgs, copyPlanFor } from "@/lib/convert";

describe("working copy of a take", () => {
  it("keeps 10-bit 4:2:2 for a log camera (FX30 XAVC S-I)", () => {
    expect(copyPlanFor({ colour: "log", codec: "H.264 4:2:2 10-bit" })).toEqual({ tenBit: true, chroma: "422", crf: 14 });
  });
  it("keeps 10-bit for phone HDR / Apple Log (HEVC 4:2:0 10-bit)", () => {
    expect(copyPlanFor({ colour: "hdr", codec: "HEVC 4:2:0 10-bit" })).toEqual({ tenBit: true, chroma: "420", crf: 14 });
    expect(copyPlanFor({ colour: "log", codec: "HEVC 4:2:0 10-bit" }).tenBit).toBe(true);
  });
  it("keeps 10-bit 4:2:2 for iPhone ProRes", () => {
    expect(copyPlanFor({ colour: "sdr", codec: "ProRes 4:2:2 10-bit" })).toEqual({ tenBit: true, chroma: "422", crf: 14 });
  });
  it("log said in the metadata wins, even with an 8-bit codec", () => {
    expect(copyPlanFor({ colour: "log", codec: "H.264 4:2:0 8-bit" }).tenBit).toBe(true);
  });
  it("8-bit for a standard SDR phone video", () => {
    expect(copyPlanFor({ colour: "sdr", codec: "H.264 4:2:0 8-bit" })).toEqual({ tenBit: false, chroma: "420", crf: 16 });
    expect(copyPlanFor(undefined).tenBit).toBe(false);
  });
  it("keeps the take's clock: the passage's first picture held before it, the camera sound all along", () => {
    const a = copyArgs(copyPlanFor({ colour: "log", codec: "H.264 4:2:2 10-bit" }), 2, 5);
    expect(a.join(" ")).toContain("-ss 2.000 -t 3.000 -i /in/source -t 5.000 -i /in/source");
    expect(a.join(" ")).toContain("tpad=start_duration=2.000:start_mode=clone");
    expect(a.join(" ")).toContain("-pix_fmt yuv422p10le");
    expect(a).toContain("1:a:0?");
    expect(copyArgs(copyPlanFor(undefined), 0, 5).join(" ")).not.toContain("tpad");
    if (process.env.COPY_ARGS_OUT) writeFileSync(process.env.COPY_ARGS_OUT, JSON.stringify({ log: a, sdr: copyArgs(copyPlanFor({ colour: "sdr", codec: "H.264 4:2:0 8-bit" }), 2, 5) }));
  });
});
