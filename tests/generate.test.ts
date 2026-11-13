import { describe, expect, it } from "vitest";
import { defaultWorkspace } from "../lib/defaults";
import { drawableItems, drawHook, followLists, tagStep, generateAll, hookKey, hookLink, pick, pickText, poolTags, tagGroups, taggedItems, textItems, weightedPick, weightedPickBag } from "../lib/generate";
import type { TextPool, Workspace } from "../lib/types";

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
  it("keeps locked slides and excludes their photos from new picks", () => {
    const ws = defaultWorkspace();
    const photos = Array.from({ length: 4 }, (_, i) => ({ id: `ph${i}`, name: `p${i}.jpg` }));
    ws.picPools.forEach((p) => (p.pics = photos));
    ws.textPools[0].text = "hook one\nhook two";
    ws.textPools[1].text = "second a\nsecond b";
    const project = ws.projects[0];
    const locked = { text: "kept", picId: "ph0" };
    const { slides } = generateAll(ws, project, (i) => (i === 0 ? locked : undefined));
    expect(slides[0]).toBe(locked);
    expect(slides.slice(1).map((s) => s.picId)).not.toContain("ph0");
  });
});

describe("lyrics per slide", () => {
  it("uses the slide's own section, else the project default", () => {
    const ws = defaultWorkspace();
    const p = ws.projects[0];
    p.lyrics = [
      { id: "v", name: "Verse", text: "verse text" },
      { id: "c", name: "Chorus", text: "chorus text" },
    ];
    p.lyricsSectionId = "v";
    p.slides = [0, 1].map(() => ({ ...p.slides[0], textSource: { kind: "lyrics" as const } }));
    expect(pickText(p, ws, 0, {})).toBe("verse text");
    p.slides[1].textSource = { kind: "lyrics", sectionId: "c" };
    expect(pickText(p, ws, 1, {})).toBe("chorus text");
  });

  it("falls back when the chosen section was deleted", () => {
    const ws = defaultWorkspace();
    const p = ws.projects[0];
    p.lyrics = [{ id: "v", name: "Verse", text: "verse text" }];
    p.lyricsSectionId = "v";
    p.slides[0].textSource = { kind: "lyrics", sectionId: "gone" };
    expect(pickText(p, ws, 0, {})).toBe("verse text");
  });
});

describe("favor top hooks + no repeat", () => {
  const setup = () => {
    const ws = defaultWorkspace();
    const pool = ws.textPools[0];
    pool.text = "h0\nh1\nh2\nh3\nh4\nh5";
    pool.views = { h0: 5000, h1: 4000, h2: 3000, h3: 2000, h4: 1000, h5: 500 };
    ws.favorTop = true;
    ws.noRepeat = true;
    return { ws, project: ws.projects[0] };
  };

  it("still never repeats before the whole pool was used", () => {
    const { ws, project } = setup();
    const bags: Record<string, string[]> = {};
    for (let round = 0; round < 5; round++) {
      const got = Array.from({ length: 6 }, () => pickText(project, ws, 0, bags));
      expect(new Set(got).size).toBe(6);
    }
  });

  it("without no repeat, the best hooks come back more often", () => {
    const { ws, project } = setup();
    ws.noRepeat = false;
    const bags: Record<string, string[]> = {};
    const counts: Record<string, number> = {};
    for (let i = 0; i < 800; i++) {
      const h = pickText(project, ws, 0, bags);
      counts[h] = (counts[h] ?? 0) + 1;
    }
    expect(counts.h0).toBeGreaterThan(counts.h5);
  });

  it("with no repeat, the best hooks land earlier in the carousel", () => {
    const { ws, project } = setup();
    const bags: Record<string, string[]> = {};
    let pos0 = 0, pos5 = 0;
    for (let cycle = 0; cycle < 200; cycle++) {
      const got = Array.from({ length: 6 }, () => pickText(project, ws, 0, bags));
      pos0 += got.indexOf("h0");
      pos5 += got.indexOf("h5");
    }
    expect(pos0).toBeLessThan(pos5);
  });

  it("weightedPickBag empties the bag one item at a time", () => {
    const bags: Record<string, string[]> = {};
    const items = ["a", "b", "c"];
    const views = { a: 100, b: 10, c: 10 };
    const got = new Set([
      weightedPickBag("p", items, views, bags, true),
      weightedPickBag("p", items, views, bags, true),
      weightedPickBag("p", items, views, bags, true),
    ]);
    expect(got.size).toBe(3);
    expect(bags.p).toEqual([]);
  });
});

describe("drawHook (video studio)", () => {
  it("draws from the carousel's shuffle bag: no hook comes back before the list is used up", () => {
    const ws = { ...defaultWorkspace(), noRepeat: true, favorTop: false };
    ws.textPools = [{ id: "h", name: "Hooks", scope: "shared", kind: "hooks", text: "un\ndeux\ntrois" }];
    const bags: Record<string, string[]> = {};
    const seen = [drawHook(ws, "h", bags), drawHook(ws, "h", bags), drawHook(ws, "h", bags)];
    expect(new Set(seen).size).toBe(3);
    expect(bags.h).toEqual([]);
    // The hooks already on the video are not drawn again.
    const ex = drawHook(ws, "h", {}, ["un", "deux"]);
    expect(ex).toBe("trois");
    expect(drawHook(ws, "nope", {})).toBeNull();
  });
});

describe("drawHook with favourite hooks", () => {
  it("the hooks left out stay in the bag", () => {
    const ws = { ...defaultWorkspace(), noRepeat: true, favorTop: true };
    ws.textPools = [{ id: "h", name: "Hooks", scope: "shared", kind: "hooks", text: "un\ndeux\ntrois", views: { un: 10 } }];
    const bags: Record<string, string[]> = { h: ["un", "deux", "trois"] };
    const got = drawHook(ws, "h", bags, ["un"]);
    expect(got === "deux" || got === "trois").toBe(true);
    expect(bags.h).toContain("un"); // not drawn, still to come
    expect(bags.h).not.toContain(got);
  });
});

describe("hooks linked to their list (video)", () => {
  const pool = (text: string): TextPool => ({ id: "h", name: "Hooks", scope: "shared", kind: "hooks", text });
  const hook = (p: TextPool, text: string) => ({ text, link: hookLink(p, text) });
  it("an edited line follows; a moved line is found again; a deleted line leaves the hook as it was", () => {
    const v1 = pool("un\ndeux\ntrois");
    const hooks = [hook(v1, "deux")];
    // Edited in place.
    const e = followLists(hooks, [pool("un\nDEUX !\ntrois")]);
    expect(e[0].text).toBe("DEUX !");
    // A line added above: same text, new place, nothing else changes.
    const m = followLists(hooks, [pool("zéro\nun\ndeux\ntrois")]);
    expect(m[0].text).toBe("deux");
    expect(m[0].link?.line).toBe(2);
    // Deleted: the text stays, the link goes (it does not take the next line).
    const d = followLists(hooks, [pool("un\ntrois")]);
    expect(d[0].text).toBe("deux");
    expect(d[0].link).toBeUndefined();
    // Nothing changed: the same array.
    expect(followLists(hooks, [v1])).toBe(hooks);
  });
});

describe("tags of a hooks list", () => {
  const hooks = { id: "h", name: "Hooks", scope: "shared", kind: "hooks", text: "Ce son va te hanter\nNouveau son vendredi\nÉcoute jusqu'au bout" } as TextPool;
  it("a text without tags of its own has its theme as its tag", () => {
    const tags = poolTags(hooks);
    expect(tags).toHaveLength(3);
    expect(tags.every((x) => x.length === 1)).toBe(true);
  });
  it("tags set by hand win, a text can have several, and drawing keeps to the ticked ones", () => {
    const p = { ...hooks, tags: { [hookKey("Ce son va te hanter")]: ["émotion", "teaser"], [hookKey("Nouveau son vendredi")]: ["teaser"] } };
    expect(poolTags(p)[0]).toEqual(["émotion", "teaser"]);
    expect(taggedItems(p, ["teaser"])).toEqual(["Ce son va te hanter", "Nouveau son vendredi"]);
    expect(taggedItems(p, ["émotion"])).toEqual(["Ce son va te hanter"]);
    const g = tagGroups(poolTags(p));
    expect(g.find((x) => x.id === "teaser")!.items).toEqual([0, 1]);
  });
  it("an excluded tag (its −): its texts are never drawn (even under another ticked tag), the rest is", () => {
    const p = { ...hooks, tags: { [hookKey("Ce son va te hanter")]: ["émotion", "pre-release"], [hookKey("Nouveau son vendredi")]: ["pre-release"], [hookKey("Écoute jusqu'au bout")]: ["out-now"] } };
    expect(drawableItems(p, ["pre-release"])).toEqual(["Écoute jusqu'au bout"]);
    expect(taggedItems(p, ["émotion"], ["pre-release"])).toEqual([]);
    const ws = { textPools: [p], noRepeat: true, bags: {} } as unknown as Workspace;
    for (let i = 0; i < 5; i++) expect(drawHook(ws, "h", {}, [], undefined, ["pre-release"])).toBe("Écoute jusqu'au bout");
    // A tag is ticked or excluded, never both; a second − frees it.
    expect(tagStep(["teaser"], [], "teaser", "not")).toEqual({ tags: [], not: ["teaser"] });
    expect(tagStep([], ["teaser"], "teaser", "tick")).toEqual({ tags: ["teaser"], not: [] });
    expect(tagStep([], ["teaser"], "teaser", "not")).toEqual({ tags: [], not: [] });
    // Everything excluded: nothing drawn (never the excluded ones as a fallback).
    expect(drawHook(ws, "h", {}, [], undefined, ["pre-release", "out-now"])).toBeNull();
  });
});
