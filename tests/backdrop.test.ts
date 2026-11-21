import { describe, expect, it } from "vitest";
import { colorAt, gradientOf, isGradient, startGradient } from "@/lib/backdrop";

describe("the post's ground", () => {
  it("a colour between two stops is mixed, a stop added there keeps the look", () => {
    const stops = [{ at: 0, color: "#000000" }, { at: 1, color: "#ffffff" }];
    expect(colorAt(stops, 0.5)).toBe("#808080");
    expect(colorAt(stops, -1)).toBe("#000000");
    expect(colorAt(stops, 2)).toBe("#ffffff");
  });
  it("a gradient's points and stops filled in, in order", () => {
    const g = gradientOf({ kind: "radial", stops: [{ at: 0.8, color: "#111111" }, { at: 0.2, color: "#eeeeee" }] });
    expect(g.stops.map((s) => s.at)).toEqual([0.2, 0.8]);
    expect([g.ax, g.ay]).toEqual([0.5, 0.5]);
  });
  it("a gradient started from a colour keeps it as its first stop", () => {
    const b = startGradient("linear", { kind: "color", color: "#ff3399" });
    expect(isGradient(b)).toBe(true);
    expect(b.stops![0].color).toBe("#ff3399");
  });
});
