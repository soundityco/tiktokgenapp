import { describe, expect, it } from "vitest";
import { alignSong, dropLoops, spreadOnHeard } from "@/lib/lyricsAlign";

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

describe("a line after a silence shows when the voice attacks it", () => {
  it("its first words, not heard, come just before its first heard word, not at the start of the gap", () => {
    // Line 1 heard at 10 s; line 2 ("dis moi pourquoi tu mens"): "dis moi" not heard, "pourquoi" heard at 20 s.
    const heard = [
      { w: "je", s: 10, e: 10.3 }, { w: "suis", s: 10.3, e: 10.6 }, { w: "là", s: 10.6, e: 11 },
      { w: "pourquoi", s: 20, e: 20.4 }, { w: "tu", s: 20.4, e: 20.6 }, { w: "mens", s: 20.6, e: 21 },
    ];
    const r = alignSong("je suis là\ndis moi pourquoi tu mens", heard)!;
    const dis = r.words.find((x) => x.w === "dis")!;
    expect(dis.s).toBeGreaterThan(19);
    expect(dis.s).toBeLessThan(20);
  });
});
