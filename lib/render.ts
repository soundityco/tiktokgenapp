import { FORMATS, FontId, PicSettings, SlideCfg, TextStyle } from "./types";

export type Img = ImageBitmap | HTMLImageElement;

const FONTS: Record<FontId, { family: string; weight: number; italic?: boolean }> = {
  classic: { family: '"TikTok Sans Variable", "Segoe UI", Arial, sans-serif', weight: 600 },
  bold: { family: '"TikTok Sans Variable", "Segoe UI", Arial, sans-serif', weight: 800 },
  clean: { family: '"Segoe UI", system-ui, Arial, sans-serif', weight: 500 },
  heavy: { family: '"Arial Black", Arial, sans-serif', weight: 900 },
  condensed: { family: '"Arial Narrow", "Roboto Condensed", Arial, sans-serif', weight: 700 },
  impact: { family: "Impact, Haettenschweiler, sans-serif", weight: 400 },
  serif: { family: 'Georgia, "Times New Roman", serif', weight: 700 },
  serifItalic: { family: 'Georgia, "Times New Roman", serif', weight: 700, italic: true },
  typewriter: { family: '"Courier New", Courier, monospace', weight: 700 },
};

/** A #rrggbb colour with an opacity (0-1). */
export function withAlpha(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m || a >= 1) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, a).toFixed(3)})`;
}

/** "#abc", "abc", "#AABBCC" → "#aabbcc"; null when it is not a hex colour. */
export function parseHex(v: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return `#${h.toLowerCase()}`;
}

/** CSS font of a bundled font, to show its name in it (font picker). */
export const bundledFont = (id: FontId) => FONTS[id];

export const canvasSize = (cfg: SlideCfg, img: Img | null): [number, number] => {
  if (cfg.format !== "orig") return FORMATS[cfg.format];
  if (!img) return FORMATS["9:16"];
  const w = 1080;
  const h = Math.round(Math.min(2400, Math.max(540, (w * img.height) / img.width)));
  return [w, h];
};

export interface Overlay {
  guideV?: boolean; // vertical centre line (text is centred horizontally)
  guideH?: boolean;
  zones?: boolean;
}

export interface TextBox { x: number; y: number; w: number; h: number }
export interface RenderResult { box: TextBox | null; w: number; h: number }

const tmp = (w: number, h: number) => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
};

/**
 * Keep the photo offset in bounds: a photo larger than the canvas always covers it,
 * a smaller one stays inside it. Stored offsets are kept clamped so a drag reacts at once.
 */
export function clampPic(pic: PicSettings, iw: number, ih: number, W: number, H: number): PicSettings {
  const s = (pic.framing === "fill" ? Math.max(W / iw, H / ih) : Math.min(W / iw, H / ih)) * pic.zoom;
  const mx = Math.abs(iw * s - W) / 2 / W, my = Math.abs(ih * s - H) / 2 / H;
  const ox = Math.max(-mx, Math.min(mx, pic.ox)), oy = Math.max(-my, Math.min(my, pic.oy));
  return ox === pic.ox && oy === pic.oy ? pic : { ...pic, ox, oy };
}

/** Change the zoom around the centre of the canvas: the point in the middle stays in the middle. */
export function zoomPic(pic: PicSettings, zoom: number): PicSettings {
  const k = zoom / (pic.zoom || 1);
  return { ...pic, zoom, ox: pic.ox * k, oy: pic.oy * k };
}

/** A rectangle of a picture, in its pixels. */
export interface Region { x: number; y: number; w: number; h: number }

/**
 * The part of a picture (iw×ih) seen on a W×H canvas with these settings. Fit shows it whole.
 * Zooming in further around the centre (see zoomPic) only ever shows a part of this region.
 */
export function visibleRegion(pic: PicSettings, iw: number, ih: number, W: number, H: number): Region {
  if (pic.framing !== "fill") return { x: 0, y: 0, w: iw, h: ih };
  const { zoom, ox, oy } = clampPic(pic, iw, ih, W, H);
  const s = Math.max(W / iw, H / ih) * zoom;
  const dx = (W - iw * s) / 2 + ox * W, dy = (H - ih * s) / 2 + oy * H;
  const x0 = Math.max(0, -dx / s), y0 = Math.max(0, -dy / s);
  const x1 = Math.min(iw, (W - dx) / s), y1 = Math.min(ih, (H - dy) / s);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

let blurCanvas: HTMLCanvasElement | null = null;

/**
 * Draw a picture (photo, video frame) framed like a slide: fill (crop), or fit with blurred or black
 * bars, zoomed around the centre and moved by the offset. Shared by the carousel and the video studio.
 */
export function drawFramed(
  ctx: CanvasRenderingContext2D, src: CanvasImageSource, iw: number, ih: number, pic: PicSettings, W: number, H: number,
  /** `src` holds only this region of the iw×ih picture (a cropped copy, see visibleRegion). */
  part?: Region
) {
  const { framing, bars, zoom, ox, oy, darken } = clampPic(pic, iw, ih, W, H);
  const put = (s: number) => {
    const x = (W - iw * s) / 2 + ox * W, y = (H - ih * s) / 2 + oy * H;
    if (part) ctx.drawImage(src, x + part.x * s, y + part.y * s, part.w * s, part.h * s);
    else ctx.drawImage(src, x, y, iw * s, ih * s);
  };
  if (framing === "fill") {
    put(Math.max(W / iw, H / ih) * zoom);
  } else {
    if (bars === "blur") {
      // Cheap blur that works in every browser (no ctx.filter): shrink, then stretch with smoothing.
      const sw = 24, sh = Math.max(8, Math.round((24 * H) / W));
      const sm = (blurCanvas ??= tmp(sw, sh));
      if (sm.width !== sw || sm.height !== sh) { sm.width = sw; sm.height = sh; }
      const sctx = sm.getContext("2d")!;
      sctx.imageSmoothingQuality = "high";
      const cs = Math.max(sw / iw, sh / ih);
      sctx.drawImage(src, (sw - iw * cs) / 2, (sh - ih * cs) / 2, iw * cs, ih * cs);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(sm, 0, 0, W, H);
      ctx.fillStyle = "rgba(0,0,0,.35)";
      ctx.fillRect(0, 0, W, H);
    } else {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
    }
    put(Math.min(W / iw, H / ih) * zoom);
  }
  if (darken > 0) {
    ctx.fillStyle = `rgba(0,0,0,${Math.min(0.9, darken / 100)})`;
    ctx.fillRect(0, 0, W, H);
  }
}

function drawPicture(ctx: CanvasRenderingContext2D, img: Img, cfg: SlideCfg, W: number, H: number) {
  drawFramed(ctx, img, img.width, img.height, cfg.pic, W, H);
}

// ---- letter spacing: the canvas does it itself where it can, else the letters are placed one by one ----
type Ctx2D = CanvasRenderingContext2D & { letterSpacing?: string };
const nativeTracking = (ctx: CanvasRenderingContext2D) => "letterSpacing" in ctx;
/** Space between the letters in px, for this style at this size (set on the canvas when it can do it). */
let tracking = 0;
function setTracking(ctx: CanvasRenderingContext2D, st: TextStyle, size: number) {
  tracking = (size * (st.tracking ?? 0)) / 100;
  if (nativeTracking(ctx)) (ctx as Ctx2D).letterSpacing = `${tracking}px`;
}
/** Width of a line with the letter spacing (no space after its last letter). */
function textW(ctx: CanvasRenderingContext2D, s: string): number {
  const w = ctx.measureText(s).width;
  if (!tracking) return w;
  const n = Array.from(s).length;
  return nativeTracking(ctx) ? w - tracking : w + tracking * Math.max(0, n - 1);
}
/** Fill or stroke a line with the letter spacing. */
function paintText(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, how: "fill" | "stroke") {
  if (!tracking || nativeTracking(ctx)) { if (how === "fill") ctx.fillText(s, x, y); else ctx.strokeText(s, x, y); return; }
  for (const ch of Array.from(s)) {
    if (how === "fill") ctx.fillText(ch, x, y); else ctx.strokeText(ch, x, y);
    x += ctx.measureText(ch).width + tracking;
  }
}

function setFont(ctx: CanvasRenderingContext2D, st: TextStyle, size: number) {
  setTracking(ctx, st, size);
  if (st.customFont) {
    // A family of loaded files: the browser picks the file of this weight, italic and width.
    const stretch = st.stretch && st.stretch !== "normal" ? `${st.stretch} ` : "";
    ctx.font = `${st.italic ? "italic " : ""}${stretch}${st.weight ?? 400} ${size}px "${st.customFont.replace(/"/g, "")}", ${FONTS.classic.family}`;
    return;
  }
  if (st.googleFont) {
    ctx.font = `${st.italic ? "italic " : ""}${st.weight ?? 400} ${size}px "${st.googleFont.replace(/"/g, "")}", ${FONTS.classic.family}`;
    return;
  }
  const f = FONTS[st.font];
  ctx.font = `${f.italic ? "italic " : ""}${f.weight} ${size}px ${f.family}`;
}

/** Lay out the text: forced breaks ("|" or newlines), word wrap to the width, auto-shrink if it does not fit. */
function layout(ctx: CanvasRenderingContext2D, raw: string, st: TextStyle, W: number, H: number) {
  let text = raw.replace(/\|/g, "\n");
  if (st.case === "upper") text = text.toUpperCase();
  if (st.case === "lower") text = text.toLowerCase();
  if (st.case === "sentence") text = text.toLowerCase().replace(/(^|\n)(\P{L}*)(\p{L})/gu, (_, a, b, c) => a + b + c.toUpperCase());
  const maxW = (st.width / 100) * W;
  const maxH = H * 0.92;
  let size = st.size;
  for (;;) {
    setFont(ctx, st, size);
    const lines: string[] = [];
    let tooWide = false;
    for (const para of text.split("\n")) {
      if (!para.trim()) { lines.push(""); continue; } // empty line = gap
      let cur = "";
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const test = cur ? cur + " " + word : word;
        if (textW(ctx, test) <= maxW || !cur) {
          cur = test;
          if (textW(ctx, cur) > maxW) tooWide = true;
        } else {
          lines.push(cur);
          cur = word;
          if (textW(ctx, cur) > maxW) tooWide = true;
        }
      }
      lines.push(cur);
    }
    const lh = size * st.lineHeight;
    const gap = lh * 0.55;
    const height = lines.reduce((h, l) => h + (l ? lh : gap), 0);
    const overflow = height > maxH || tooWide;
    if ((!overflow) || size <= 18) return { lines, size, lh, gap, height, maxW, overflow };
    size -= 2;
  }
}

/** True when even the smallest font does not fit: the slide will show a cut or overflowing text. */
export function textOverflow(cfg: SlideCfg, text: string): boolean {
  if (!text.trim() || typeof document === "undefined") return false;
  const [W, H] = canvasSize(cfg, null);
  const ctx = tmp(W, H).getContext("2d");
  if (!ctx) return false;
  return layout(ctx, text, cfg.style, W, H).overflow;
}

/** Draw text with a text style on any canvas (slides, but also video captions). */
export function drawStyledText(
  ctx: CanvasRenderingContext2D,
  text: string,
  st: TextStyle,
  W: number,
  H: number
): TextBox | null {
  if (!text.trim()) return null;
  const L = layout(ctx, text, st, W, H);
  setFont(ctx, st, L.size);
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  const widths = L.lines.map((l) => (l ? textW(ctx, l) : 0));
  const bw = Math.max(...widths, 1);
  const cx = (st.x / 100) * W, cy = (st.y / 100) * H;
  const left = cx - bw / 2, top = cy - L.height / 2;
  const box = { x: left, y: top, w: bw, h: L.height };
  let y = top;
  L.lines.forEach((line, i) => {
    if (!line) { y += L.gap; return; }
    const lw = widths[i];
    const lx = st.align === "left" ? left : st.align === "right" ? left + bw - lw : cx - lw / 2;
    const ly = y + L.lh / 2;
    if (st.look === "box") {
      const padX = L.size * (st.padX ?? 30) / 100, inset = L.size * 0.08 - L.size * (st.padY ?? 0) / 100;
      ctx.fillStyle = st.accent;
      ctx.beginPath();
      ctx.roundRect(lx - padX, ly - L.lh / 2 + inset, lw + padX * 2, L.lh - inset * 2, L.size * 0.2);
      ctx.fill();
    }
    ctx.textAlign = "left";
    // The stroke is centred on the edge of the letters and the fill covers its inner half: only the outside shows.
    const stroke = st.stroke ?? 20;
    if (st.look === "outline" && stroke > 0) {
      ctx.strokeStyle = st.accent;
      ctx.lineWidth = Math.max(2, L.size * stroke / 100);
      paintText(ctx, line, lx, ly, "stroke");
    }
    if (st.look === "shadow") {
      ctx.shadowColor = withAlpha(st.accent, (st.shadowOpacity ?? 100) / 100);
      ctx.shadowBlur = L.size * (st.shadowBlur ?? 35) / 100;
      ctx.shadowOffsetX = L.size * (st.shadowX ?? 0) / 100;
      ctx.shadowOffsetY = L.size * (st.shadowY ?? 5) / 100;
    }
    ctx.fillStyle = st.color;
    paintText(ctx, line, lx, ly, "fill");
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    y += L.lh;
  });
  if (nativeTracking(ctx)) (ctx as Ctx2D).letterSpacing = "0px";
  tracking = 0;
  return box;
}

export function renderSlide(
  canvas: HTMLCanvasElement,
  cfg: SlideCfg,
  img: Img | null,
  text: string,
  overlay: Overlay = {}
): RenderResult {
  const [W, H] = canvasSize(cfg, img);
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#16161c";
  ctx.fillRect(0, 0, W, H);
  if (img) drawPicture(ctx, img, cfg, W, H);

  const st = cfg.style;
  const box = drawStyledText(ctx, text, st, W, H);

  drawHelpers(ctx, W, H, overlay);
  return { box, w: W, h: H };
}

/** Editing aids, never exported: TikTok's interface zones (red) and the centre lines a dragged text snaps to (blue). */
export function drawHelpers(ctx: CanvasRenderingContext2D, W: number, H: number, overlay: Overlay) {
  if (overlay.zones) {
    ctx.fillStyle = "rgba(207,31,57,.28)";
    ctx.fillRect(0, 0, W, H * 0.1); // top
    ctx.fillRect(0, H * 0.78, W * 0.8, H * 0.22); // bottom caption
    ctx.fillRect(W * 0.84, H * 0.45, W * 0.16, H * 0.55); // right buttons
  }
  if (overlay.guideV || overlay.guideH) {
    ctx.strokeStyle = "rgba(80,140,255,.9)";
    ctx.lineWidth = Math.max(2, W / 540);
    ctx.beginPath();
    if (overlay.guideV) { ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); }
    if (overlay.guideH) { ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); }
    ctx.stroke();
  }
}

/** Make sure the bundled font is ready before the first render. */
export async function loadFonts() {
  try {
    await Promise.all([
      document.fonts.load('600 40px "TikTok Sans Variable"'),
      document.fonts.load('800 40px "TikTok Sans Variable"'),
    ]);
  } catch {
    /* the fallback font stack is used */
  }
}

export async function slideToBlob(
  cfg: SlideCfg, img: Img | null, text: string, type: "jpg" | "png"
): Promise<Blob> {
  const c = document.createElement("canvas");
  renderSlide(c, cfg, img, text);
  return new Promise((res, rej) =>
    c.toBlob((b) => (b ? res(b) : rej(new Error("Export failed"))), type === "jpg" ? "image/jpeg" : "image/png", 0.95)
  );
}
