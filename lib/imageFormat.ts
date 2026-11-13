/**
 * Detect the REAL format of an image from its first bytes (file names and MIME types lie, especially for
 * iPhone photos) and decode it to an ImageBitmap, converting formats browsers cannot read (HEIC/HEIF, TIFF).
 */
export type ImgKind = "jpeg" | "png" | "gif" | "webp" | "bmp" | "avif" | "heic" | "tiff" | "unknown";

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.slice(from, to));

export function sniff(b: Uint8Array): ImgKind {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b[0] === 0x89 && ascii(b, 1, 4) === "PNG") return "png";
  if (ascii(b, 0, 4) === "GIF8") return "gif";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "webp";
  if (b[0] === 0x42 && b[1] === 0x4d) return "bmp";
  if ((ascii(b, 0, 2) === "II" && b[2] === 42 && b[3] === 0) || (ascii(b, 0, 2) === "MM" && b[2] === 0 && b[3] === 42)) return "tiff";
  if (ascii(b, 4, 8) === "ftyp") {
    const brand = ascii(b, 8, 12);
    if (brand === "avif" || brand === "avis") return "avif";
    if (["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"].includes(brand)) return "heic";
  }
  return "unknown";
}

/** Is this file a picture the app reads? (decided on MIME type and extension, a HEIC often has none; real format is checked on load) */
export function looksLikeImage(name: string, mime: string): boolean {
  if (mime === "image/svg+xml") return false;
  if (mime.startsWith("image/")) return true;
  return /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif|tiff?)$/i.test(name);
}

// HEIC decoding is heavy (WebAssembly): one at a time.
let heicQueue: Promise<unknown> = Promise.resolve();
const serial = <T,>(fn: () => Promise<T>): Promise<T> => {
  const run = heicQueue.then(fn, fn);
  heicQueue = run.catch(() => {});
  return run;
};

async function decodeHeic(blob: Blob): Promise<ImageBitmap> {
  const { heicTo } = await import("heic-to/next");
  return serial(() => heicTo({ blob, type: "bitmap" }));
}

async function decodeTiff(blob: Blob): Promise<ImageBitmap> {
  const UTIF: any = await import("utif2");
  const buf = await blob.arrayBuffer();
  const ifds = UTIF.decode(buf);
  if (!ifds.length) throw new Error("Empty TIFF");
  UTIF.decodeImage(buf, ifds[0]);
  const rgba = UTIF.toRGBA8(ifds[0]);
  const img = new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), ifds[0].width, ifds[0].height);
  return createImageBitmap(img);
}

const MAX = 2400;

async function shrink(bmp: ImageBitmap): Promise<ImageBitmap> {
  const k = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
  if (k >= 1) return bmp;
  const small = await createImageBitmap(bmp, {
    resizeWidth: Math.round(bmp.width * k),
    resizeHeight: Math.round(bmp.height * k),
    resizeQuality: "high",
  });
  bmp.close();
  return small;
}

export async function decodeImage(blob: Blob): Promise<ImageBitmap> {
  const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const kind = sniff(head);
  let bmp: ImageBitmap;
  if (kind === "heic") bmp = await decodeHeic(blob);
  else if (kind === "tiff") bmp = await decodeTiff(blob);
  else {
    try {
      bmp = await createImageBitmap(blob);
    } catch {
      // Unknown signature or a format this browser lacks (e.g. AVIF on old browsers): last resort is HEIC/HEIF.
      bmp = await decodeHeic(blob).catch(() => {
        throw new Error("This picture format is not supported");
      });
    }
  }
  return shrink(bmp);
}
