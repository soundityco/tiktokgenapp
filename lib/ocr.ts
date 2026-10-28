import { createScheduler, createWorker } from "tesseract.js";
import { norm } from "./generate";

export interface Crop { top: number; bottom: number; right: number } // percentages to ignore

const UI_WORDS = [
  "following", "for you", "friends", "explore", "live", "inbox", "profile", "home", "shop", "discover",
  "share", "comments", "add comment", "search", "follow", "likes", "views", "original sound", "see translation",
  "more", "creator", "tiktok", "sponsored",
];

function cropToCanvas(img: ImageBitmap, crop: Crop, mode: "threshold" | "gray"): HTMLCanvasElement {
  const W = img.width, H = img.height;
  const top = (crop.top / 100) * H, bottom = H - (crop.bottom / 100) * H;
  const sw = W, sh = Math.max(10, bottom - top);
  const scale = Math.min(2, 1600 / sw);
  const c = document.createElement("canvas");
  c.width = Math.round(sw * scale);
  c.height = Math.round(sh * scale);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, top, sw, sh, 0, 0, c.width, c.height);
  // Mask the right-hand buttons band, only from ~40% of the height down.
  if (crop.right > 0) {
    ctx.fillStyle = "#000";
    const rx = c.width * (1 - crop.right / 100);
    const ry = Math.max(0, (0.4 * H - top) * scale);
    ctx.fillRect(rx, ry, c.width - rx, c.height - ry);
  }
  const data = ctx.getImageData(0, 0, c.width, c.height);
  const d = data.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    // Dark text on white background for tesseract.
    const v = mode === "threshold" ? (lum > 205 ? 0 : 255) : 255 - lum;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(data, 0, 0);
  return c;
}

export interface OcrLine { text: string; conf: number }

export function cleanLines(lines: { text: string; confidence: number }[]): OcrLine[] {
  const kept = lines
    .map((l) => ({ text: l.text.replace(/\s+/g, " ").trim(), conf: l.confidence }))
    .filter((l) => l.text.length >= 2 && l.conf >= 55) // short lines are kept: a hook can end on "me" or "it"
    .filter((l) => !UI_WORDS.some((w) => norm(l.text) === w))
    .filter((l) => /[a-zA-Z]{2,}/.test(l.text));
  // A lone tiny fragment is noise, not a hook.
  return kept.reduce((n, l) => n + l.text.length, 0) >= 6 ? kept : [];
}

export async function createOcr(parallel: number) {
  const scheduler = createScheduler();
  for (let i = 0; i < parallel; i++) scheduler.addWorker(
      await createWorker("eng", 1, { workerPath: "/ocr/worker.min.js", corePath: "/ocr/core", langPath: "/ocr/lang" })
    );
  const run = async (file: File | Blob, crop: Crop) => {
    const bmp = await createImageBitmap(file);
    try {
      let best: OcrLine[] = [];
      for (const mode of ["threshold", "gray"] as const) {
        const canvas = cropToCanvas(bmp, crop, mode);
        const res: any = await scheduler.addJob("recognize", canvas, {}, { blocks: true });
        const lines = (res.data.lines ?? (res.data.blocks ?? []).flatMap((b: any) => b.paragraphs.flatMap((p: any) => p.lines))) as any[];
        best = cleanLines(lines);
        if (best.length) break; // retry in grayscale only if the first pass found nothing usable
      }
      const text = best.map((l) => l.text).join(" ");
      const conf = best.length ? Math.round(best.reduce((s, l) => s + l.conf, 0) / best.length) : 0;
      return { text, conf };
    } finally {
      bmp.close();
    }
  };
  return { run, terminate: () => scheduler.terminate() };
}
