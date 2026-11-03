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

function drawPicture(ctx: CanvasRenderingContext2D, img: Img, cfg: SlideCfg, W: number, H: number) {
  const iw = img.width, ih = img.height;
  const { framing, bars, zoom, ox, oy, darken } = clampPic(cfg.pic, iw, ih, W, H);
  if (framing === "fill") {
    const s = Math.max(W / iw, H / ih) * zoom;
    const dw = iw * s, dh = ih * s;
    ctx.drawImage(img, (W - dw) / 2 + ox * W, (H - dh) / 2 + oy * H, dw, dh);
  } else {
    if (bars === "blur") {
      // Cheap blur that works in every browser (no ctx.filter): shrink, then stretch with smoothing.
      const sm = tmp(24, Math.max(8, Math.round((24 * H) / W)));
      const sctx = sm.getContext("2d")!;
      sctx.imageSmoothingQuality = "high";
      const cs = Math.max(sm.width / iw, sm.height / ih);
      sctx.drawImage(img, (sm.width - iw * cs) / 2, (sm.height - ih * cs) / 2, iw * cs, ih * cs);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(sm, 0, 0, W, H);
      ctx.fillStyle = "rgba(0,0,0,.35)";
      ctx.fillRect(0, 0, W, H);
    } else {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
    }
    const s = Math.min(W / iw, H / ih) * zoom;
    const dw = iw * s, dh = ih * s;
    ctx.drawImage(img, (W - dw) / 2 + ox * W, (H - dh) / 2 + oy * H, dw, dh);
  }
  if (darken > 0) {
    ctx.fillStyle = `rgba(0,0,0,${Math.min(0.9, darken / 100)})`;
    ctx.fillRect(0, 0, W, H);
  }
}

function setFont(ctx: CanvasRenderingContext2D, st: TextStyle, size: number) {
  if (st.customFont) {
    ctx.font = `400 ${size}px "${st.customFont.replace(/"/g, "")}", ${FONTS.classic.family}`;
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
        if (ctx.measureText(test).width <= maxW || !cur) {
          cur = test;
          if (ctx.measureText(cur).width > maxW) tooWide = true;
        } else {
          lines.push(cur);
          cur = word;
          if (ctx.measureText(cur).width > maxW) tooWide = true;
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
  const widths = L.lines.map((l) => (l ? ctx.measureText(l).width : 0));
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
      const padX = L.size * 0.3, padY = L.size * 0.08;
      ctx.fillStyle = st.accent;
      ctx.beginPath();
      ctx.roundRect(lx - padX, ly - L.lh / 2 + padY, lw + padX * 2, L.lh - padY * 2, L.size * 0.2);
      ctx.fill();
    }
    ctx.textAlign = "left";
    if (st.look === "outline") {
      ctx.strokeStyle = st.accent;
      ctx.lineWidth = Math.max(3, L.size * 0.2);
      ctx.strokeText(line, lx, ly);
    }
    if (st.look === "shadow") {
      ctx.shadowColor = st.accent;
      ctx.shadowBlur = L.size * 0.35;
      ctx.shadowOffsetY = L.size * 0.05;
    }
    ctx.fillStyle = st.color;
    ctx.fillText(line, lx, ly);
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    y += L.lh;
  });
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

  if (overlay.zones) {
    ctx.fillStyle = "rgba(207,31,57,.28)";
    ctx.fillRect(0, 0, W, H * 0.1); // top
    ctx.fillRect(0, H * 0.78, W * 0.8, H * 0.22); // bottom caption
    ctx.fillRect(W * 0.84, H * 0.45, W * 0.16, H * 0.55); // right buttons
  }
  if (overlay.guideV || overlay.guideH) {
    ctx.strokeStyle = "rgba(80,140,255,.9)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (overlay.guideV) { ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); }
    if (overlay.guideH) { ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); }
    ctx.stroke();
  }
  return { box, w: W, h: H };
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
