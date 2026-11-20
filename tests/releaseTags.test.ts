import { describe, expect, it } from "vitest";
import { drawableItems, hookKey, itemTags, taggedItems } from "@/lib/generate";
import { RELEASE_TAG } from "@/lib/themes";
import type { TextPool } from "@/lib/types";

const pool = (only?: Record<string, string>): TextPool => ({
  id: "p", name: "Hooks", scope: "shared", kind: "hooks", text: "Ton futur s'écrira sans moi\nPOV : tu l'écoutes en boucle\nMerci d'avoir été là",
  tags: { [hookKey("POV : tu l'écoutes en boucle")]: ["pov"], [hookKey("Ton futur s'écrira sans moi")]: ["pov"], [hookKey("Merci d'avoir été là")]: ["pov"] },
  only,
} as TextPool);

describe("hooks kept for one release", () => {
  const p = pool({ [hookKey("Ton futur s'écrira sans moi")]: "r1" });
  it("carry their release's tag besides their own", () => {
    expect(itemTags(p)[0]).toEqual(["pov", RELEASE_TAG + "r1"]);
    expect(itemTags(p)[1]).toEqual(["pov"]);
  });
  it("are drawn in their release only", () => {
    expect(drawableItems(p, undefined, "r1")).toHaveLength(3);
    expect(drawableItems(p, undefined, "r2")).toEqual(["POV : tu l'écoutes en boucle", "Merci d'avoir été là"]);
    expect(taggedItems(p, ["pov"], undefined, "r2")).not.toContain("Ton futur s'écrira sans moi");
  });
  it("can be drawn elsewhere when their release's tag is ticked", () => {
    expect(taggedItems(p, [RELEASE_TAG + "r1"], undefined, "r2")).toEqual(["Ton futur s'écrira sans moi"]);
  });
  it("change nothing for a list without any", () => {
    expect(drawableItems(pool(), undefined, "r2")).toHaveLength(3);
  });
});
