import { describe, expect, it } from "vitest";
import { finishOf, finishOn, NEUTRAL_GRADE } from "@/lib/grade";

describe("the post's finish", () => {
  it("is its own when set", () => {
    expect(finishOf({ finish: { vignette: 20 }, grade: { ...NEUTRAL_GRADE, vignette: 80 } }).vignette).toBe(20);
  });
  it("falls back on the video under's grade (older projects look the same)", () => {
    const f = finishOf({ grade: { ...NEUTRAL_GRADE, vignette: 60, grain: 10, mist: 30 } });
    expect([f.vignette, f.grain, f.mist]).toEqual([60, 10, 30]);
    expect(finishOn(f)).toBe(true);
  });
  it("is nothing for a grade turned off, or none", () => {
    expect(finishOn(finishOf({ grade: { ...NEUTRAL_GRADE, vignette: 60, off: true } }))).toBe(false);
    expect(finishOn(finishOf({}))).toBe(false);
  });
  it("keeps its parts' switches", () => {
    expect(finishOn({ vignette: 50, bypass: { finish: true } })).toBe(false);
  });
});
