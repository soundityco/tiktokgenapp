import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fromName, fromTables, groupFamilies, renameFonts, sameFace } from "../lib/fontInfo";

const buf = (p: string) => { const b = readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const SYS = "/System/Library/Fonts/Supplemental/";

describe("font faces", () => {
  it("reads the style from the file name", () => {
    expect(fromName("Helvetica-BoldItalic.woff2")).toEqual({ family: "Helvetica", weight: 700, italic: true, stretch: "normal" });
    expect(fromName("helvetica-light.ttf")).toEqual({ family: "helvetica", weight: 300, italic: false, stretch: "normal" });
    expect(fromName("Inter_SemiBold.otf")).toMatchObject({ family: "Inter", weight: 600 });
    expect(fromName("Futura Condensed ExtraBold.ttf")).toMatchObject({ family: "Futura", weight: 800, stretch: "condensed" });
    expect(fromName("Black.ttf").family).toBe("Black"); // a family named after a style word stays
  });
  it("tells a file already loaded", () => {
    expect(sameFace(fromName("Helvetica-Bold.ttf"), fromName("helvetica_bold.otf"))).toBe(true);
    expect(sameFace(fromName("Helvetica-Bold.ttf"), fromName("Helvetica-Light.ttf"))).toBe(false);
  });
  it.skipIf(!existsSync(SYS + "Arial Bold Italic.ttf"))("reads the style from the font tables", () => {
    expect(fromTables(buf(SYS + "Arial Bold Italic.ttf"))).toEqual({ family: "Arial", weight: 700, italic: true, stretch: "normal" });
    expect(fromTables(buf(SYS + "Arial.ttf"))).toMatchObject({ family: "Arial", weight: 400, italic: false });
    expect(fromTables(buf(SYS + "Arial Narrow Bold.ttf"))).toMatchObject({ weight: 700, stretch: "condensed" });
    expect(fromTables(new Uint8Array([1, 2, 3, 4]).buffer)).toBeNull();
  });
});

describe("renameFonts", () => {
  it("moves texts using an old font name to its family and style", () => {
    const ws = { projects: [{ slides: [{ style: { customFont: "Helvetica-Bold", size: 60 } }, { style: { font: "classic" } }] }] };
    const out = renameFonts(ws, { "Helvetica-Bold": { family: "Helvetica", weight: 700, italic: false, stretch: "normal" } });
    expect(out.projects[0].slides[0].style).toEqual({ customFont: "Helvetica", weight: 700, italic: undefined, stretch: undefined, size: 60 });
    expect(out.projects[0].slides[1]).toBe(ws.projects[0].slides[1]);
    expect(renameFonts(ws, {})).toBe(ws);
  });
});

describe("groupFamilies", () => {
  it("puts the compressed / rounded families of a font under it", () => {
    const g = groupFamilies(["Helvetica", "Helvetica Compressed", "Helvetica Rounded", "Inter", "Inter Display", "Helvetica Now"]);
    expect(g.find((x) => x.family === "Helvetica")?.variants.map((v) => v.label)).toEqual(["", "Rounded", "Compressed"]);
    expect(g.find((x) => x.family === "Inter")?.variants).toHaveLength(2);
    expect(g.some((x) => x.family === "Helvetica Now")).toBe(true); // "Now" is not a variant word: its own font
    expect(groupFamilies(["Helvetica Rounded"])).toEqual([{ family: "Helvetica Rounded", variants: [{ family: "Helvetica Rounded", label: "" }] }]);
  });
});
