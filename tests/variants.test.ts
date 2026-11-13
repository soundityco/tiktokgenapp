import { describe, expect, it } from "vitest";
import { hookKey, textItems } from "../lib/generate";
import type { Project, TextPool } from "../lib/types";
import { addVariants, asLine, carouselVariants, videoVariants } from "../lib/variants";

const hooks = { id: "h", name: "Hooks", scope: "shared", kind: "hooks", text: "Ce son va te hanter\nNouveau son vendredi",
  tags: { [hookKey("Ce son va te hanter")]: ["teaser"] } } as TextPool;
const captions = { id: "c", name: "Captions", scope: "shared", kind: "captions", text: "Out now" } as TextPool;

describe("variants of retouched texts", () => {
  it("a slide's retouched text that its list does not have is a variant, with the line it came from", () => {
    const p = {
      slides: [{ textSource: { kind: "pool", poolId: "h" } }, { textSource: { kind: "pool", poolId: "h" } }, { textSource: { kind: "lyrics" } }],
      generated: [{ text: "Ce son va\nte hanter ce soir", edited: true, from: "Ce son va te hanter" }, { text: "nouveau son, vendredi", edited: true }, { text: "x", edited: true }],
    } as unknown as Project;
    // The second one is only a retouch of case and punctuation: the list already has it.
    expect(carouselVariants(p, [hooks])).toEqual([{ pool: "h", text: "Ce son va | te hanter ce soir", from: "Ce son va te hanter" }]);
  });
  it("a video hook retouched from its list line; not a hook typed by hand, nor a captions list", () => {
    const hs = [
      { id: "1", text: "Ce son va vraiment te hanter", from: 0, link: { pool: "h", line: 0, text: "Ce son va te hanter", count: 2 } },
      { id: "2", text: "Typed by hand", from: 1 },
      { id: "3", text: "Out now!!", from: 2, link: { pool: "c", line: 0, text: "Out now", count: 1 } },
    ];
    expect(videoVariants(hs, [hooks, captions]).map((v) => v.text)).toEqual(["Ce son va vraiment te hanter"]);
  });
  it("kept: added at the end of the list, with the tags of the line it came from, once", () => {
    const [p] = addVariants([hooks], [{ pool: "h", text: "Ce son va te hanter ce soir", from: "Ce son va te hanter" }, { pool: "h", text: "Ce son va te hanter ce soir" }]);
    expect(textItems(p)).toEqual(["Ce son va te hanter", "Nouveau son vendredi", "Ce son va te hanter ce soir"]);
    expect(p.tags?.[hookKey("Ce son va te hanter ce soir")]).toEqual(["teaser"]);
    expect(asLine(" a \n\n b ")).toBe("a | b");
  });
});
