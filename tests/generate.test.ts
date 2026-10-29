import { describe, expect, it } from "vitest";
import { defaultWorkspace } from "../lib/defaults";
import { generateAll, hookKey, lyricsText, pick, textItems, weightedPick } from "../lib/generate";
import type { TextPool } from "../lib/types";

const pool = (kind: TextPool["kind"], text: string): TextPool => ({ id: "p", name: "p", scope: "shared", kind, text });

describe("textItems", () => {
  it("hooks: one per line, blank lines and duplicates removed", () => {
    expect(textItems(pool("hooks", "a\n\n b \nA!\nc"))).toEqual(["a", "b", "c"]);
  });
  it("hooks: | is kept for the renderer", () => {
    expect(textItems(pool("hooks", "one|two"))).toEqual(["one|two"]);
  });
  it("block: the whole text is one item, empty lines kept", () => {
    expect(textItems(pool("block", "l1\n\nl2\n"))).toEqual(["l1\n\nl2"]);
    expect(textItems(pool("block", "  \n"))).toEqual([]);
  });
});

describe("pick (shuffle bag)", () => {
  it("never repeats before the whole pool was used", () => {
    const items = ["a", "b", "c", "d", "e"];
    const bags: Record<string, string[]> = {};
    for (let round = 0; round < 3; round++) {
      const seen = new Set<string>();
      for (let i = 0; i < items.length; i++) seen.add(pick("x", items, bags, true)!);
      expect(seen.size).toBe(items.length);
    }
  });
  it("respects the exclude set", () => {
    for (let i = 0; i < 50; i++) expect(pick("x", ["a", "b"], {}, true, new Set(["a"]))).toBe("b");
  });
  it("falls back when everything is excluded", () => {
    expect(["a", "b"]).toContain(pick("x", ["a", "b"], {}, true, new Set(["a", "b"])));
  });
  it("empty pool gives null", () => expect(pick("x", [], {}, true)).toBeNull());
});

describe("weightedPick", () => {
  it("favours hooks with more views", () => {
    const items = ["star", "meh"];
    const views = { [hookKey("star")]: 9000, [hookKey("meh")]: 100 };
    let star = 0;
    for (let i = 0; i < 2000; i++) if (weightedPick(items, views) === "star") star++;
    expect(star / 2000).toBeGreaterThan(0.9);
  });
  it("hooks without views still get picked (median weight)", () => {
    const views = { [hookKey("a")]: 1000 };
    const got = new Set<string>();
    for (let i = 0; i < 500; i++) got.add(weightedPick(["a", "b"], views));
    expect(got.has("b")).toBe(true);
  });
});

describe("generateAll", () => {
  it("fills every slide and never uses the same photo twice in one carousel", () => {
    const ws = defaultWorkspace();
    const photos = Array.from({ length: 6 }, (_, i) => ({ id: `ph${i}`, name: `p${i}.jpg` }));
    // same photos in all three slide lists: the guarantee must still hold
    ws.picPools.forEach((p) => (p.pics = photos));
    ws.textPools[0].text = "hook one\nhook two";
    ws.textPools[1].text = "second a\nsecond b";
    const project = ws.projects[0];
    project.lyrics = [{ id: "v", name: "Verse", text: "la la\nla" }, { id: "c", name: "Chorus", text: "oh oh" }];
    project.lyricsSectionId = "c";
    for (let n = 0; n < 30; n++) {
      const { slides } = generateAll(ws, project);
      expect(slides).toHaveLength(3);
      const ids = slides.map((s) => s.picId);
      expect(new Set(ids).size).toBe(3);
      expect(slides[2].text).toBe("oh oh"); // slide 3 = chosen lyrics section
      expect(slides[0].text).toMatch(/hook/);
    }
  });
  it("lyricsText falls back to the first section", () => {
    const ws = defaultWorkspace();
    const p = ws.projects[0];
    p.lyrics = [{ id: "v", name: "Verse", text: "verse text" }];
    p.lyricsSectionId = null;
    expect(lyricsText(p)).toBe("verse text");
  });
});
