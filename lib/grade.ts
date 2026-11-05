/**
 * Colour grading of camera log footage, like a DaVinci node tree:
 * camera log → DaVinci Wide Gamut / Intermediate (CST IN) → exposure, white balance (linear light),
 * contrast, saturation → the user's look LUT (made in DaVinci, input DWG / Intermediate).
 *
 * Everything is folded into one 3D LUT whose input is the camera's own code values: the preview applies it
 * on the GPU (lib/gradeGL.ts), the export hands it to ffmpeg, which applies it on the 10-bit source.
 * Vignette and grain depend on the position in the picture: they are drawn on the frame (see drawLook).
 */

import type { PhotoAdjust, VideoGrade } from "./types";

export type CameraProfile = VideoGrade["profile"];

export const PROFILES: { id: CameraProfile; label: string }[] = [
  { id: "slog3-cine", label: "Sony S-Log3 / S-Gamut3.Cine" },
  { id: "slog3", label: "Sony S-Log3 / S-Gamut3" },
  { id: "rec709", label: "Sony S-Cinetone / Rec.709 (standard)" },
  { id: "applelog", label: "Apple Log (iPhone)" },
  { id: "hlg", label: "HDR HLG (phones, Sony HLG)" },
  { id: "pq", label: "HDR PQ / HDR10" },
  { id: "none", label: "No colour processing" },
];

export const NEUTRAL_GRADE: VideoGrade = {
  profile: "slog3-cine", exposure: 0, contrast: 1, temp: 0, tint: 0, sat: 1, vignette: 0, vignetteSize: 50, grain: 0, grainSize: 1,
};

export interface CubeLut { size: number; data: Float32Array; min: [number, number, number]; max: [number, number, number] }

/** Read a .cube 3D LUT (DaVinci, Adobe): red changes fastest. */
export function parseCube(text: string): CubeLut {
  let size = 0;
  let min: [number, number, number] = [0, 0, 0], max: [number, number, number] = [1, 1, 1];
  const vals: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (/^[-+.\d]/.test(line)) {
      const p = line.split(/\s+/);
      if (p.length >= 3) vals.push(+p[0], +p[1], +p[2]);
      continue;
    }
    const [key, ...rest] = line.split(/\s+/);
    if (key === "LUT_3D_SIZE") size = parseInt(rest[0], 10);
    else if (key === "DOMAIN_MIN") min = [+rest[0], +rest[1], +rest[2]];
    else if (key === "DOMAIN_MAX") max = [+rest[0], +rest[1], +rest[2]];
    else if (key === "LUT_1D_SIZE") throw new Error("1D LUTs are not supported: generate a 3D LUT (.cube)");
  }
  if (!size || size < 2 || size > 129) throw new Error("not a 3D .cube LUT");
  if (vals.length !== size * size * size * 3 || vals.some((v) => !Number.isFinite(v))) throw new Error("incomplete .cube LUT");
  return { size, data: Float32Array.from(vals), min, max };
}

/** Trilinear lookup of a .cube LUT, input clamped to its domain. */
export function sampleCube(l: CubeLut, r: number, g: number, b: number, out: number[]) {
  const n = l.size - 1;
  const at = (v: number, i: number) => Math.min(n, Math.max(0, ((v - l.min[i]) / (l.max[i] - l.min[i])) * n));
  const x = at(r, 0), y = at(g, 1), z = at(b, 2);
  const x0 = Math.min(n - 1, Math.floor(x)), y0 = Math.min(n - 1, Math.floor(y)), z0 = Math.min(n - 1, Math.floor(z));
  const fx = x - x0, fy = y - y0, fz = z - z0;
  const N = l.size, d = l.data;
  for (let c = 0; c < 3; c++) {
    const v = (i: number, j: number, k: number) => d[((i + j * N + k * N * N) * 3) + c];
    const c00 = v(x0, y0, z0) * (1 - fx) + v(x0 + 1, y0, z0) * fx;
    const c10 = v(x0, y0 + 1, z0) * (1 - fx) + v(x0 + 1, y0 + 1, z0) * fx;
    const c01 = v(x0, y0, z0 + 1) * (1 - fx) + v(x0 + 1, y0, z0 + 1) * fx;
    const c11 = v(x0, y0 + 1, z0 + 1) * (1 - fx) + v(x0 + 1, y0 + 1, z0 + 1) * fx;
    out[c] = (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
  }
}

// ---- colour spaces ----

type M3 = number[]; // row-major 3×3
type XY = [number, number];
const D65: XY = [0.3127, 0.329];

const mul = (a: M3, b: M3): M3 => {
  const r: M3 = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r.push(a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]);
  return r;
};
const inv = (m: M3): M3 => {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det);
};
/** RGB → XYZ of a gamut given by its primaries (all D65 here: no white point adaptation needed). */
function toXYZ(r: XY, g: XY, b: XY, w: XY = D65): M3 {
  const col = ([x, y]: XY) => [x / y, 1, (1 - x - y) / y];
  const P = [col(r), col(g), col(b)];
  const m: M3 = [P[0][0], P[1][0], P[2][0], P[0][1], P[1][1], P[2][1], P[0][2], P[1][2], P[2][2]];
  const W = col(w);
  const s = inv(m);
  const S = [0, 1, 2].map((i) => s[i * 3] * W[0] + s[i * 3 + 1] * W[1] + s[i * 3 + 2] * W[2]);
  return m.map((v, k) => v * S[k % 3]);
}

const GAMUTS = {
  dwg: toXYZ([0.8, 0.313], [0.1682, 0.9877], [0.079, -0.1155]),
  sgamut3cine: toXYZ([0.766, 0.275], [0.225, 0.8], [0.089, -0.087]),
  sgamut3: toXYZ([0.73, 0.28], [0.14, 0.855], [0.1, -0.05]),
  rec709: toXYZ([0.64, 0.33], [0.3, 0.6], [0.15, 0.06]),
  rec2020: toXYZ([0.708, 0.292], [0.17, 0.797], [0.131, 0.046]),
};
const XYZ_TO_DWG = inv(GAMUTS.dwg);
const DWG_TO_709 = mul(inv(GAMUTS.rec709), GAMUTS.dwg);
/** Luminance weights of DaVinci Wide Gamut (Y row). */
const DWG_Y = GAMUTS.dwg.slice(3, 6);

/** Video levels as the browser and ffmpeg give them (0 = code 64, 1 = code 940) → 10-bit code value. */
const cv = (v: number) => 64 + v * 876;

/** Sony S-Log3 → scene linear (0.18 = middle grey). */
export function slog3ToLin(v: number): number {
  const c = cv(v);
  return c >= 171.2102946929 ? Math.pow(10, (c - 420) / 261.5) * 0.19 - 0.01 : ((c - 95) * 0.01125) / (171.2102946929 - 95);
}
/** Apple Log → scene linear. */
export function appleLogToLin(v: number): number {
  const R0 = -0.05641088, Rt = 0.01, c = 47.28711236, beta = 0.00964052, gamma = 0.08550479, delta = 0.69336945;
  const Pt = c * (Rt - R0) * (Rt - R0);
  if (v >= Pt) return Math.pow(2, (v - delta) / gamma) - beta;
  if (v >= 0) return Math.sqrt(v / c) + R0;
  return R0;
}
/** HLG (BT.2100) → linear, scaled so its reference white (75 % signal) is 1 and middle grey about 0.18. */
export function hlgToLin(v: number): number {
  const a = 0.17883277, b = 0.28466892, c = 0.55991073;
  const e = v <= 0.5 ? (v * v) / 3 : (Math.exp((v - c) / a) + b) / 12;
  return e / 0.26496;
}
/** PQ (SMPTE 2084) → linear, 203 nits (HDR reference white) = 1. */
export function pqToLin(v: number): number {
  const m1 = 0.1593017578125, m2 = 78.84375, c1 = 0.8359375, c2 = 18.8515625, c3 = 18.6875;
  const p = Math.pow(Math.max(0, v), 1 / m2);
  return (Math.pow(Math.max(0, p - c1) / (c2 - c3 * p), 1 / m1) * 10000) / 203;
}
/** Scene linear → DaVinci Intermediate. */
export function linToDI(l: number): number {
  return l <= 0.00262409 ? l * 10.44426855 : (Math.log2(l + 0.0075) + 7) * 0.07329248;
}
export function diToLin(v: number): number {
  return v <= 0.02740668 ? v / 10.44426855 : Math.pow(2, v / 0.07329248 - 7) - 0.0075;
}
/** DaVinci Intermediate of middle grey: the default contrast pivot. */
export const DI_GREY = linToDI(0.18);

const INPUT: Record<Exclude<CameraProfile, "none">, { decode: (v: number) => number; toDWG: M3 }> = {
  "slog3-cine": { decode: slog3ToLin, toDWG: mul(XYZ_TO_DWG, GAMUTS.sgamut3cine) },
  slog3: { decode: slog3ToLin, toDWG: mul(XYZ_TO_DWG, GAMUTS.sgamut3) },
  rec709: { decode: (v) => Math.pow(Math.max(0, v), 2.4), toDWG: mul(XYZ_TO_DWG, GAMUTS.rec709) },
  applelog: { decode: appleLogToLin, toDWG: mul(XYZ_TO_DWG, GAMUTS.rec2020) },
  hlg: { decode: hlgToLin, toDWG: mul(XYZ_TO_DWG, GAMUTS.rec2020) },
  pq: { decode: pqToLin, toDWG: mul(XYZ_TO_DWG, GAMUTS.rec2020) },
};

/** Does this grade change the picture's colours (otherwise no LUT is applied at all)? */
export function gradesColour(g: VideoGrade | undefined): g is VideoGrade {
  if (!g || g.profile === "none") return false;
  // Standard footage with every slider at zero and no LUT: the picture as it is, nothing to compute.
  return !(g.profile === "rec709" && !g.lut && g.exposure === 0 && g.contrast === 1 && g.temp === 0 && g.tint === 0 && g.sat === 1);
}

/** The grade turns log or HDR footage into SDR (the part worth doing on the 10-bit camera file). */
export const convertsFootage = (g: VideoGrade | undefined) => !!g && g.profile !== "none" && g.profile !== "rec709";

/**
 * The whole colour grade as one size³ LUT (RGB, red fastest), input = the camera's code values.
 * `look`: the user's LUT (DWG / Intermediate in). None: a plain conversion to Rec.709 with a soft highlight roll-off.
 */
export function buildGradeLut(g: VideoGrade, look: CubeLut | null, size: number): Float32Array {
  const out = new Float32Array(size * size * size * 3);
  if (g.profile === "none") {
    for (let b = 0, k = 0; b < size; b++) for (let gg = 0; gg < size; gg++) for (let r = 0; r < size; r++, k += 3) {
      out[k] = r / (size - 1); out[k + 1] = gg / (size - 1); out[k + 2] = b / (size - 1);
    }
    return out;
  }
  const inp = INPUT[g.profile];
  const M = inp.toDWG;
  // White balance in linear light (like a node in linear gamma): warm = more red, less blue; tint = less green.
  const kt = g.temp * 0.004, kn = g.tint * 0.004;
  let wr = Math.pow(2, kt), wg = Math.pow(2, -kn), wb = Math.pow(2, -kt);
  const norm = DWG_Y[0] * wr + DWG_Y[1] * wg + DWG_Y[2] * wb;
  const ev = Math.pow(2, g.exposure) / norm;
  wr *= ev; wg *= ev; wb *= ev;
  const pivot = g.pivot ?? DI_GREY;
  const decode = new Float64Array(size);
  for (let i = 0; i < size; i++) decode[i] = inp.decode(i / (size - 1));
  const s = [0, 0, 0];
  const rolloff = (x: number) => (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
  for (let b = 0, k = 0; b < size; b++) for (let gi = 0; gi < size; gi++) for (let r = 0; r < size; r++, k += 3) {
    const lr = decode[r], lg = decode[gi], lb = decode[b];
    // CST IN: camera gamut → DWG (linear), then exposure and white balance.
    const R = (M[0] * lr + M[1] * lg + M[2] * lb) * wr;
    const G = (M[3] * lr + M[4] * lg + M[5] * lb) * wg;
    const B = (M[6] * lr + M[7] * lg + M[8] * lb) * wb;
    // DaVinci Intermediate: contrast around the pivot, then saturation around the luminance.
    let dr = (linToDI(R) - pivot) * g.contrast + pivot;
    let dg = (linToDI(G) - pivot) * g.contrast + pivot;
    let db = (linToDI(B) - pivot) * g.contrast + pivot;
    if (g.sat !== 1) {
      const y = DWG_Y[0] * dr + DWG_Y[1] * dg + DWG_Y[2] * db;
      dr = y + (dr - y) * g.sat; dg = y + (dg - y) * g.sat; db = y + (db - y) * g.sat;
    }
    if (look) {
      sampleCube(look, dr, dg, db, s);
    } else {
      const x = diToLin(dr), y = diToLin(dg), z = diToLin(db);
      const lin = [DWG_TO_709[0] * x + DWG_TO_709[1] * y + DWG_TO_709[2] * z, DWG_TO_709[3] * x + DWG_TO_709[4] * y + DWG_TO_709[5] * z, DWG_TO_709[6] * x + DWG_TO_709[7] * y + DWG_TO_709[8] * z];
      // Standard footage goes back as it came; log footage gets a film-like highlight roll-off.
      for (let c = 0; c < 3; c++) {
        const v = Math.max(0, lin[c]);
        s[c] = Math.pow(Math.min(1, g.profile === "rec709" ? v : rolloff(v)), 1 / 2.4);
      }
    }
    out[k] = Math.min(1, Math.max(0, s[0]));
    out[k + 1] = Math.min(1, Math.max(0, s[1]));
    out[k + 2] = Math.min(1, Math.max(0, s[2]));
  }
  return out;
}

/** The LUT as a .cube file, for ffmpeg's lut3d. */
export function toCube(data: Float32Array, size: number): string {
  const lines = [`LUT_3D_SIZE ${size}`];
  for (let i = 0; i < data.length; i += 3) lines.push(`${data[i].toFixed(6)} ${data[i + 1].toFixed(6)} ${data[i + 2].toFixed(6)}`);
  return lines.join("\n") + "\n";
}

/**
 * The photo edits of a slide (-100 to 100, like a phone photo editor) as a grade of standard footage:
 * the same maths as the video sliders. None when nothing is changed.
 */
export function photoGrade(a: PhotoAdjust | undefined): VideoGrade | null {
  if (!a) return null;
  const v = (k: keyof PhotoAdjust) => Math.max(-100, Math.min(100, a[k] ?? 0));
  const vignette = Math.max(0, v("vignette")), grain = Math.max(0, v("grain")); // these only add
  if (!v("exposure") && !v("contrast") && !v("saturation") && !v("temperature") && !vignette && !grain) return null;
  return {
    ...NEUTRAL_GRADE, profile: "rec709",
    exposure: v("exposure") / 50, contrast: 1 + v("contrast") / 200, sat: 1 + v("saturation") / 100, temp: v("temperature"),
    vignette, vignetteSize: 50, grain, grainSize: 1.5,
  };
}

/** Everything that changes the colours, to know when a converted copy must be made again. */
export function gradeKey(g: VideoGrade | undefined): string {
  if (!gradesColour(g)) return "";
  return [g.profile, g.lut?.id ?? "", g.exposure, g.contrast, g.pivot ?? "", g.temp, g.tint, g.sat].join(",");
}

/** Grain plates: a few different frames of film-like grain, per grain size (made once). */
const GRAIN_FRAMES = 8;
const grainPlates = new Map<number, HTMLCanvasElement[]>();

/**
 * One grain frame: gaussian noise made at a lower resolution for bigger grain, then smoothed when drawn,
 * so it clumps like silver grain instead of square pixels; mostly luminance with a little colour, like film.
 */
function grainPlate(size: number, seed: number): HTMLCanvasElement {
  const T = Math.max(32, Math.round(512 / size));
  const c = document.createElement("canvas");
  c.width = c.height = T;
  const cg = c.getContext("2d")!;
  const img = cg.createImageData(T, T);
  let a = seed >>> 0;
  const rnd = () => { // mulberry32
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  for (let i = 0; i < T * T; i++) {
    const l = gauss() * 34;
    for (let ch = 0; ch < 3; ch++) img.data[i * 4 + ch] = Math.max(0, Math.min(255, Math.round(128 + l + gauss() * 8)));
    img.data[i * 4 + 3] = 255;
  }
  cg.putImageData(img, 0, 0);
  return c;
}

/**
 * Vignette and film grain on the framed picture (before the texts). `frame`: number of the frame, so the
 * grain moves like film and is the same each time a given frame is drawn.
 */
export function drawLook(ctx: CanvasRenderingContext2D, W: number, H: number, g: VideoGrade, frame: number) {
  if (g.vignette > 0) {
    const r = Math.hypot(W, H) / 2;
    const inner = r * (0.2 + 0.6 * (g.vignetteSize / 100));
    const grad = ctx.createRadialGradient(W / 2, H / 2, inner, W / 2, H / 2, r);
    const a = Math.min(1, g.vignette / 100);
    grad.addColorStop(0, "rgba(0,0,0,0)");
    grad.addColorStop(0.5, `rgba(0,0,0,${(a * 0.35).toFixed(3)})`);
    grad.addColorStop(1, `rgba(0,0,0,${(a * 0.9).toFixed(3)})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }
  if (g.grain > 0) {
    const size = Math.max(1, g.grainSize);
    let plates = grainPlates.get(size);
    if (!plates) {
      plates = Array.from({ length: GRAIN_FRAMES }, (_, i) => grainPlate(size, 9001 + i * 7919));
      grainPlates.set(size, plates);
    }
    // Each frame: another plate, moved and flipped at random, so no pattern repeats or slides.
    let h = Math.imul(frame + 1, 2654435761) >>> 0;
    const next = () => (h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0);
    const plate = plates[next() % GRAIN_FRAMES];
    const step = 512 * (W / 1080);
    const ox = (next() % 1000) / 1000 * step, oy = (next() % 1000) / 1000 * step;
    const fx = next() & 1 ? -1 : 1, fy = next() & 1 ? -1 : 1;
    ctx.save();
    ctx.globalCompositeOperation = "overlay";
    ctx.globalAlpha = Math.min(1, g.grain / 100);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.translate(W / 2, H / 2);
    ctx.scale(fx, fy);
    ctx.translate(-W / 2, -H / 2);
    for (let y = -oy; y < H; y += step) for (let x = -ox; x < W; x += step) ctx.drawImage(plate, x, y, step, step);
    ctx.restore();
  }
}
