import { describe, expect, it } from "vitest";
import { alignSong, buildCues, cleanHeard, dropLoops, moveCueEnd, moveCueStart, retimeCue, spreadOnHeard, tightenLineStarts } from "@/lib/lyricsAlign";

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

describe("cleanHeard: words cut by the model, made-up sentences", () => {
  const h = (text: string) => text.split(" ").map((x, i) => ({ w: x, s: i * 0.3, e: i * 0.3 + 0.25 }));
  it("puts words cut at an apostrophe or a hyphen back together", () => {
    expect(cleanHeard(h("J 'crois que c 'est fini Est -ce que")).map((x) => x.w).join(" ")).toBe("J'crois que c'est fini Est-ce que");
  });
  it("drops Whisper's made-up subtitles", () => {
    expect(cleanHeard(h("tu mens Sous -titrage Société Radio -Canada")).map((x) => x.w).join(" ")).toBe("tu mens");
  });
  it("so a verse full of elisions is placed on its words", () => {
    const heard = cleanHeard(h("J 'crois que j 'ai réuni tes mensonges ni tes appels"));
    const r = alignSong("J'crois que j'ai réuni tes mensonges, ni tes appels", heard)!;
    expect(r.coverage).toBeGreaterThan(0.9);
  });
});

describe("moveCueStart (a caption's start dragged)", () => {
  const words = [
    { w: "un", s: 1, e: 1.4, line: 0 }, { w: "deux", s: 1.4, e: 2, line: 0 },
    { w: "trois", s: 3, e: 3.4, line: 1 }, { w: "quatre", s: 3.4, e: 4, line: 1 },
  ];
  const cues = () => buildCues(words, "phrase");
  it("later: the line comes later, the one before stays until it (no gap), its end kept", () => {
    const out = moveCueStart(words, cues(), 1, 3.3)!;
    const c = buildCues(out, "phrase");
    expect(c[1].start).toBeCloseTo(3.3);
    expect(c[1].end).toBeCloseTo(cues()[1].end);
    expect(c[0].end).toBeCloseTo(3.3);
  });
  it("earlier: the line before leaves then; Alt: it stays (a gap is allowed)", () => {
    const c = buildCues(moveCueStart(words, cues(), 1, 2.5)!, "phrase");
    expect(c[1].start).toBeCloseTo(2.5);
    expect(c[0].end).toBeCloseTo(2.5);
    const free = buildCues(moveCueStart(words, cues(), 1, 3.6, true)!, "phrase");
    expect(free[0].end).toBeCloseTo(cues()[0].end);
  });
});

describe("retimeCue: + on a line glued to the next one", () => {
  it("still makes it come later (its start only)", () => {
    const glued = [
      { w: "un", s: 1, e: 1.5, line: 0 }, { w: "deux", s: 1.5, e: 2, line: 0 },
      { w: "trois", s: 2, e: 2.5, line: 1 }, { w: "quatre", s: 2.5, e: 3, line: 1 },
    ];
    const cues = buildCues(glued, "phrase");
    const out = retimeCue(glued, cues, 0, "start", 0.1);
    expect(out).not.toBeNull();
    expect(buildCues(out!, "phrase")[0].start).toBeCloseTo(1.1);
  });
});

describe("tightenLineStarts", () => {
  it("a line's first word glued to the pause before comes back before its line", () => {
    const out = tightenLineStarts([
      { w: "ouais", s: 14.8, e: 15.1, line: 2 },
      { w: "Je", s: 15.2, e: 15.4, line: 3 }, { w: "ne", s: 17.4, e: 17.6, line: 3 }, { w: "veux", s: 17.7, e: 17.9, line: 3 },
    ]);
    expect(out[1].s).toBeCloseTo(17.1);
    expect(out[0].s).toBe(14.8); // the last word of the line before stays
  });
  it("a line sung in one go is left alone", () => {
    const ws = [{ w: "tout", s: 1, e: 1.3, line: 0 }, { w: "va", s: 1.4, e: 1.7, line: 0 }];
    expect(tightenLineStarts(ws)[0].s).toBe(1);
  });
});

describe("lines not heard between two heard ones", () => {
  it("follow the line before (sung), only the next heard word's own line waits for it", () => {
    const heard = [
      { w: "tout", s: 10, e: 10.3 }, { w: "gâché", s: 10.3, e: 10.8 },
      { w: "mensonge", s: 40.5, e: 41 }, { w: "quand", s: 41.1, e: 41.3 }, { w: "tu", s: 41.3, e: 41.5 }, { w: "appelles", s: 41.5, e: 42 },
    ];
    const r = alignSong("t'as tout gâché\npourquoi ça fait si mal\nyaourt\nj'ai peur du mensonge quand tu appelles", heard)!;
    const at = (w: string) => r.words.find((x) => x.w === w)!.s;
    expect(at("pourquoi")).toBeLessThan(12.5); // right after "tout gâché", not 30 s later
    expect(at("peur")).toBeGreaterThan(39.5); // its line waits for its heard word
  });
});

describe("moveCueEnd (a caption's end dragged)", () => {
  it("stays longer or leaves sooner; reaching the next line makes it come later", () => {
    const words = [
      { w: "un", s: 1, e: 1.5, line: 0 }, { w: "deux", s: 1.5, e: 2, line: 0 },
      { w: "trois", s: 5, e: 5.5, line: 1 }, { w: "quatre", s: 5.5, e: 6, line: 1 },
    ];
    const cues = buildCues(words, "phrase");
    expect(buildCues(moveCueEnd(words, cues, 0, 3.5)!, "phrase")[0].end).toBeCloseTo(3.5);
    expect(buildCues(moveCueEnd(words, cues, 0, 1.6)!, "phrase")[0].end).toBeCloseTo(1.6);
    const past = buildCues(moveCueEnd(words, cues, 0, 5.3)!, "phrase");
    expect(past[0].end).toBeCloseTo(5.3);
    expect(past[1].start).toBeGreaterThanOrEqual(5.3);
  });
});
