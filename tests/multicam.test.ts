import { describe, expect, it } from "vitest";
import { camAt, cutTo, moveCut, removeCutAt, setShotCam, shotsOf, splitAt } from "@/lib/multicam";

describe("multicam cuts", () => {
  it("camera 0 before the first cut, then each cut's camera", () => {
    const cuts = cutTo(cutTo([], 12, 2), 5, 1);
    expect(cuts.map((c) => c.at)).toEqual([5, 12]);
    expect([camAt(cuts, 0), camAt(cuts, 5), camAt(cuts, 11.9), camAt(cuts, 20)]).toEqual([0, 1, 1, 2]);
  });
  it("a cut at the same place moves to the new camera (live switching twice)", () => {
    expect(cutTo([{ at: 5, cam: 1 }], 5.02, 3)).toEqual([{ at: 5.02, cam: 3 }]);
  });
  it("split keeps the camera, setting a shot changes only it", () => {
    let cuts = splitAt([{ at: 5, cam: 1 }], 8);
    expect(cuts).toEqual([{ at: 5, cam: 1 }, { at: 8, cam: 1 }]);
    cuts = setShotCam(cuts, 9, 2, 0);
    expect(shotsOf(cuts, 0, 12).map((s) => s.cam)).toEqual([0, 1, 2]);
    // Before the first cut: a cut at the segment's start.
    expect(camAt(setShotCam(cuts, 2, 3, 0), 1)).toBe(3);
  });
  it("removing joins a shot with the one before, moving stays between neighbours", () => {
    const cuts = [{ at: 5, cam: 1 }, { at: 8, cam: 2 }, { at: 12, cam: 3 }];
    expect(removeCutAt(cuts, 9).map((c) => c.at)).toEqual([5, 12]);
    expect(moveCut(cuts, 1, 20)[1].at).toBeCloseTo(11.9);
    expect(moveCut(cuts, 1, 1)[1].at).toBeCloseTo(5.1);
  });
  it("shots of a segment", () => {
    const shots = shotsOf([{ at: 2, cam: 1 }, { at: 5, cam: 2 }, { at: 30, cam: 3 }], 3, 15);
    expect(shots).toEqual([{ from: 3, to: 5, cam: 1, cut: 0 }, { from: 5, to: 15, cam: 2, cut: 1 }]);
  });
});
