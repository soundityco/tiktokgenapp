import { describe, expect, it } from "vitest";
import { addTexts, hookKey, removeText, rewriteText, textItems } from "@/lib/generate";
import type { TextPool } from "@/lib/types";

const k = hookKey;
const base = (): TextPool => ({
  id: "p", name: "Hooks", scope: "shared", kind: "hooks", text: "B hook\nA hook",
  tags: { [k("A hook")]: ["pov"] }, only: { [k("A hook")]: "r1" }, views: { [k("A hook")]: 12 },
} as TextPool);

describe("editing a list's texts in place", () => {
  it("rewrites a text and keeps its tags, release and views", () => {
    const p = rewriteText(base(), "A hook", "C hook");
    expect(textItems(p)).toEqual(["B hook", "C hook"]);
    expect(p.tags?.[k("C hook")]).toEqual(["pov"]);
    expect(p.only?.[k("C hook")]).toBe("r1");
    expect(p.views?.[k("C hook")]).toBe(12);
    expect(p.tags?.[k("A hook")]).toBeUndefined();
  });
  it("takes a text out with what was kept for it", () => {
    const p = removeText(base(), "A hook");
    expect(textItems(p)).toEqual(["B hook"]);
    expect(p.only?.[k("A hook")]).toBeUndefined();
  });
  it("adds only the new texts pasted, in order", () => {
    const { pool, added } = addTexts(base(), "D hook\nA hook\n\n  D hook \nC hook");
    expect(added).toEqual(["D hook", "C hook"]);
    expect(textItems(pool)).toEqual(["A hook", "B hook", "C hook", "D hook"]);
  });
  it("an empty rewrite takes the text out", () => {
    expect(textItems(rewriteText(base(), "B hook", "  "))).toEqual(["A hook"]);
  });
});
