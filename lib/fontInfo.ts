/**
 * What a font file is: its family, weight, italic and width, read from the file itself (the OpenType
 * "name" and "OS/2" tables of a .ttf / .otf). The file name is only the fallback (.woff / .woff2 are
 * compressed): "Helvetica-BoldItalic.woff2" → Helvetica, 700, italic.
 */

export interface FaceInfo {
  family: string;
  /** 100-900. */
  weight: number;
  italic: boolean;
  /** CSS font-stretch keyword ("normal", "condensed"…). */
  stretch: string;
}

const STRETCH = ["ultra-condensed", "extra-condensed", "condensed", "semi-condensed", "normal", "semi-expanded", "expanded", "extra-expanded", "ultra-expanded"];

const WEIGHT_WORDS: [RegExp, number][] = [
  [/^(thin|hairline)$/, 100], [/^(extra|ultra)light$/, 200], [/^light$/, 300], [/^(regular|book|normal|roman|plain)$/, 400],
  [/^medium$/, 500], [/^(semi|demi)bold$/, 600], [/^bold$/, 700], [/^(extra|ultra)bold$/, 800], [/^(black|heavy)$/, 900],
];
const WIDTH_WORDS: [RegExp, string][] = [
  [/^(ultra|extra)(condensed|compressed|narrow)$/, "extra-condensed"], [/^(condensed|compressed|narrow|cond)$/, "condensed"],
  [/^semi(condensed|narrow)$/, "semi-condensed"], [/^semi(expanded|extended)$/, "semi-expanded"],
  [/^(expanded|extended|wide)$/, "expanded"], [/^(ultra|extra)(expanded|extended|wide)$/, "extra-expanded"],
];

/** Style words of a name ("Bold Condensed Italic") → weight, italic, width; the rest is the family. */
export function fromName(name: string): FaceInfo {
  const base = name.replace(/\.[^.]+$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2") // CamelCase: "BoldItalic" → "Bold Italic"
    .replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim();
  // "Extra Bold", "Semi Condensed": joined so they are one word.
  const words = base.replace(/\b(extra|ultra|semi|demi)\s+(?=\w)/gi, "$1").split(" ");
  let weight = 400, italic = false, stretch = "normal";
  const keep: string[] = [];
  words.forEach((w, i) => {
    const k = w.toLowerCase();
    const wt = WEIGHT_WORDS.find(([r]) => r.test(k));
    const wd = WIDTH_WORDS.find(([r]) => r.test(k));
    if (i > 0 && wt) weight = wt[1];
    else if (i > 0 && wd) stretch = wd[1];
    else if (i > 0 && /^(italic|oblique|it)$/.test(k)) italic = true;
    else keep.push(w);
  });
  const family = keep.join(" ").replace(/["'\\]/g, "").trim().slice(0, 60) || "Custom font";
  return { family, weight, italic, stretch };
}

const u16 = (d: DataView, o: number) => d.getUint16(o);
const u32 = (d: DataView, o: number) => d.getUint32(o);

/** Read the face from a .ttf / .otf (or the first font of a .ttc). Null when the tables cannot be read. */
export function fromTables(buf: ArrayBuffer): FaceInfo | null {
  try {
    const d = new DataView(buf);
    let base = 0;
    if (u32(d, 0) === 0x74746366) base = u32(d, 12); // "ttcf": first font of the collection
    const tag = u32(d, base);
    if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565) return null; // TrueType, "OTTO", "true"
    const n = u16(d, base + 4);
    const tables = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      const r = base + 12 + i * 16;
      tables.set(String.fromCharCode(d.getUint8(r), d.getUint8(r + 1), d.getUint8(r + 2), d.getUint8(r + 3)), u32(d, r + 8));
    }
    const nameAt = tables.get("name");
    if (nameAt === undefined) return null;
    const count = u16(d, nameAt + 2), strings = nameAt + u16(d, nameAt + 4);
    const names = new Map<number, string>();
    for (let i = 0; i < count; i++) {
      const r = nameAt + 6 + i * 12;
      const platform = u16(d, r), lang = u16(d, r + 4), id = u16(d, r + 6), len = u16(d, r + 8), off = u16(d, r + 10);
      if (![1, 2, 16, 17].includes(id)) continue;
      const at = strings + off;
      let s = "";
      if (platform === 3 || platform === 0) {
        if (platform === 3 && lang !== 0x409 && names.has(id)) continue; // English first
        for (let k = 0; k + 1 < len; k += 2) s += String.fromCharCode(u16(d, at + k));
      } else if (platform === 1 && !names.has(id)) {
        for (let k = 0; k < len; k++) s += String.fromCharCode(d.getUint8(at + k));
      } else continue;
      if (s.trim()) names.set(id, s.trim());
    }
    const family = names.get(16) ?? names.get(1);
    if (!family) return null;
    const sub = names.get(17) ?? names.get(2) ?? "";
    const guess = fromName(`${family} ${sub}`);
    let weight = guess.weight, italic = guess.italic, stretch = guess.stretch;
    const os2 = tables.get("OS/2");
    if (os2 !== undefined) {
      const w = u16(d, os2 + 4), width = u16(d, os2 + 6), sel = u16(d, os2 + 62);
      if (w >= 100 && w <= 900) weight = Math.round(w / 100) * 100;
      if (width >= 1 && width <= 9) stretch = STRETCH[width - 1];
      italic = !!(sel & 1) || !!(sel & 0x200) || italic;
    }
    // The family of a "Bold Condensed" face can still carry the width ("Arial Narrow"): keep it as written.
    return { family: family.replace(/["'\\]/g, "").slice(0, 60), weight, italic, stretch };
  } catch {
    return null;
  }
}

/** The face of a font file: from its tables when readable, else from its name. */
export function faceOf(fileName: string, buf: ArrayBuffer): FaceInfo {
  return fromTables(buf) ?? fromName(fileName);
}

/** Same face of the same family (a file already loaded). */
export const sameFace = (a: FaceInfo, b: FaceInfo) =>
  a.family.toLowerCase() === b.family.toLowerCase() && a.weight === b.weight && a.italic === b.italic && a.stretch === b.stretch;

/**
 * Texts that use a font under its old name (the file name, before the styles were read from the files):
 * moved to its family, with the weight, italic and width of that file. Returns the same object when none.
 */
export function renameFonts<T>(data: T, renamed: Record<string, FaceInfo>): T {
  if (!Object.keys(renamed).length) return data;
  let changed = false;
  const walk = (v: unknown): unknown => {
    if (!v || typeof v !== "object") return v;
    if (Array.isArray(v)) { const a = v.map(walk); return a.some((x, i) => x !== v[i]) ? a : v; }
    const o = v as Record<string, unknown>;
    let out: Record<string, unknown> = o;
    for (const [k, x] of Object.entries(o)) {
      const y = walk(x);
      if (y !== x) { if (out === o) out = { ...o }; out[k] = y; }
    }
    const f = typeof o.customFont === "string" ? renamed[o.customFont] : undefined;
    if (f) {
      changed = true;
      if (out === o) out = { ...o };
      Object.assign(out, { customFont: f.family, weight: f.weight, italic: f.italic || undefined, stretch: f.stretch === "normal" ? undefined : f.stretch });
    }
    return out;
  };
  const next = walk(data) as T;
  return changed ? next : data;
}

/** Words that make a sub-family of a font rather than another font: "Helvetica Rounded", "Inter Display". */
const VARIANT_WORDS = /^(compressed|condensed|cond|narrow|extended|expanded|wide|rounded|round|display|text|mono|caption|headline|poster|stencil|outline|inline|slab|serif|sans)$/i;

/**
 * Loaded families grouped as one font: "Helvetica Compressed" and "Helvetica Rounded" are variants of
 * "Helvetica" when it is loaded too. Returns each main family with its variants (its own name first).
 */
export function groupFamilies(families: string[]): { family: string; variants: { family: string; label: string }[] }[] {
  const parent = new Map<string, string>();
  for (const f of families) {
    let best = "";
    for (const b of families) {
      if (b === f || !f.toLowerCase().startsWith(b.toLowerCase() + " ") || b.length <= best.length) continue;
      const rest = f.slice(b.length).trim().split(/\s+/);
      if (rest.every((w) => VARIANT_WORDS.test(w))) best = b;
    }
    if (best) parent.set(f, best);
  }
  const root = (f: string): string => (parent.has(f) ? root(parent.get(f)!) : f);
  const groups = new Map<string, { family: string; label: string }[]>();
  for (const f of [...families].sort((a, b) => a.length - b.length || a.localeCompare(b))) {
    const r = root(f);
    const list = groups.get(r) ?? [];
    list.push({ family: f, label: f === r ? "" : f.slice(r.length).trim() });
    groups.set(r, list);
  }
  return [...groups.entries()].map(([family, variants]) => ({ family, variants })).sort((a, b) => a.family.localeCompare(b.family));
}

/** Short name of a width, for the buttons. */
export const STRETCH_LABEL: Record<string, string> = {
  "ultra-condensed": "Ultra condensed", "extra-condensed": "Extra condensed", condensed: "Condensed", "semi-condensed": "Semi condensed",
  normal: "Normal width", "semi-expanded": "Semi expanded", expanded: "Expanded", "extra-expanded": "Extra expanded", "ultra-expanded": "Ultra expanded",
};
