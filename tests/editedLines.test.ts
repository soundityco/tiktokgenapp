import { describe, expect, it } from "vitest";
import { fitBetweenLocked, keepEditedLines, keepManual } from "@/lib/lyricsAlign";
import type { LyricWord } from "@/lib/types";

// WANNA TRY: « OK, OK, AY » placed between two locked lines, then written « OK »; the words heard first had put it 3 s
// early, over the locked line before it.
const prev: LyricWord[] = [
  { w: "Tout", s: 3, e: 3.4, line: 0, lock: true, manual: true }, { w: "mais", s: 3.4, e: 3.8, line: 0, lock: true, manual: true }, { w: "pas", s: 3.8, e: 4.2, line: 0, lock: true, manual: true },
  { w: "OK,", s: 6, e: 6.3, line: 1 }, { w: "OK,", s: 6.3, e: 6.6, line: 1 }, { w: "AY", s: 6.6, e: 7, line: 1 },
  { w: "yeah", s: 7.5, e: 8, line: 2 },
  { w: "Après", s: 10, e: 10.8, line: 3, lock: true, manual: true },
];
// as placed again from the stale heard words: « OK » 3 s early, « yeah » back where the first listening put it
const placedFromHeard: LyricWord[] = [
  { w: "Tout", s: 2.9, e: 3.3, line: 0 }, { w: "mais", s: 3.3, e: 3.7, line: 0 }, { w: "pas", s: 3.7, e: 4.1, line: 0 },
  { w: "OK", s: 3, e: 7, line: 1 },
  { w: "yeah", s: 4.3, e: 4.6, line: 2 },
  { w: "Après", s: 10, e: 10.8, line: 3 },
];
const edit = () => fitBetweenLocked(keepEditedLines(prev, keepManual(prev, placedFromHeard)).words);

describe("keepEditedLines", () => {
  it("an edited line keeps its old time, never over the locked line before it", () => {
    const ok = edit().find((x) => x.w === "OK")!;
    expect(ok.s).toBeCloseTo(6); expect(ok.e).toBeLessThanOrEqual(7.001);
  });
  it("the lines not edited stay exactly where they were", () => {
    const out = edit();
    expect(out.find((x) => x.w === "yeah")).toMatchObject({ s: 7.5, e: 8 });
    expect(out.filter((x) => x.lock).map((x) => x.s)).toEqual([3, 3.4, 3.8, 10]);
  });
  it("gives the edited line's span for the model", () => {
    const { spans } = keepEditedLines(prev, keepManual(prev, placedFromHeard));
    expect(spans).toEqual([{ lines: [1], lo: 6, hi: 7 }]);
  });
  it("a line added keeps the room between the lines around it", () => {
    const next: LyricWord[] = [...placedFromHeard.slice(0, 3), { w: "Hey", s: 1, e: 1.5, line: 1 },
      ...placedFromHeard.slice(3).map((x) => ({ ...x, line: (x.line ?? 0) + 1 }))];
    const out = fitBetweenLocked(keepEditedLines(prev, keepManual(prev, next)).words);
    const hey = out.find((x) => x.w === "Hey")!;
    expect(hey.s).toBeGreaterThanOrEqual(4.2);
  });
});
