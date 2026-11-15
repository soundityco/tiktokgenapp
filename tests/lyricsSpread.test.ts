import { describe, expect, it } from "vitest";
import { dropLoops, spreadOnHeard } from "@/lib/lyricsAlign";

describe("spreadOnHeard (last resort)", () => {
  it("spreads the written words over the heard singing, in order, lines kept", () => {
    const heard = Array.from({ length: 10 }, (_, i) => ({ w: "x", s: 10 + i, e: 10.5 + i }));
    const out = spreadOnHeard("un deux trois\nquatre cinq", heard)!;
    expect(out.map((x) => x.w)).toEqual(["un", "deux", "trois", "quatre", "cinq"]);
    expect(out[0].s).toBe(10);
    expect(out.every((x, i) => i === 0 || x.s >= out[i - 1].s)).toBe(true);
    expect(out[3].line).not.toBe(out[0].line);
    expect(out[4].s).toBeLessThan(19.6);
  });
  it("nothing to spread: null", () => {
    expect(spreadOnHeard("", [{ w: "x", s: 1, e: 2 }])).toBeNull();
    expect(spreadOnHeard("un", [])).toBeNull();
  });
});

describe("dropLoops (the speech model repeating itself)", () => {
  const w = (text: string) => text.split(" ").map((x, i) => ({ w: x, s: i, e: i + 0.5 }));
  it("a phrase said again and again keeps its first two times", () => {
    const out = dropLoops(w("je suis comme un thème je suis comme un thème je suis comme un thème je suis comme un thème fin"));
    expect(out.map((x) => x.w).join(" ")).toBe("je suis comme un thème je suis comme un thème fin");
  });
  it("sung repeats (twice) and normal lines stay", () => {
    expect(dropLoops(w("jamais jamais tu es là")).map((x) => x.w).join(" ")).toBe("jamais jamais tu es là");
    expect(dropLoops(w("oh baby oh baby dis moi")).map((x) => x.w).join(" ")).toBe("oh baby oh baby dis moi");
  });
});
