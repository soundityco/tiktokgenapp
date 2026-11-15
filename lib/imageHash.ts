/**
 * A picture's look in 256 bits (a "difference hash"): the picture in 17 × 16 grey squares, each bit says whether a
 * square is brighter than the one on its right (fine enough to tell apart two poses on the same white wall). The same
 * photo saved twice (re-encoded, resized, its HEIC turned into a JPEG by the phone at each pick) gives the same bits,
 * or nearly; two different photos differ by many. It finds the same photo twice in a list, where the files differ.
 */

export const HASH_W = 17, HASH_H = 16;

/** The bits of 17 × 16 grey values (row by row), as 64 hexadecimal characters. */
export function hashOfGrey(grey: ArrayLike<number>): string {
  let out = "";
  for (let y = 0; y < HASH_H; y++) {
    for (let half = 0; half < 2; half++) {
      let byte = 0;
      for (let x = half * 8; x < half * 8 + 8; x++) byte = (byte << 1) | (grey[y * HASH_W + x] > grey[y * HASH_W + x + 1] ? 1 : 0);
      out += byte.toString(16).padStart(2, "0");
    }
  }
  return out;
}

/** A picture's hash (drawn small: the browser averages it). */
export function pictureHash(img: CanvasImageSource): string {
  const c = new OffscreenCanvas(HASH_W, HASH_H), g = c.getContext("2d", { willReadFrequently: true })!;
  g.imageSmoothingQuality = "high";
  g.drawImage(img, 0, 0, HASH_W, HASH_H);
  const d = g.getImageData(0, 0, HASH_W, HASH_H).data;
  const grey = new Float32Array(HASH_W * HASH_H);
  for (let i = 0; i < grey.length; i++) grey[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  return hashOfGrey(grey);
}

/** How many bits two hashes differ by (0 to 256); hashes of another size never match. */
export function hashDistance(a: string, b: string): number {
  if (a.length !== b.length) return Infinity;
  let n = 0;
  for (let i = 0; i < a.length; i += 2) {
    let x = parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16);
    while (x) { n += x & 1; x >>= 1; }
  }
  return n;
}

/** At most this many bits apart (of 256): the same photo. */
export const SAME_PHOTO = 12;

/** The photos (by index) that repeat an earlier one of the list; null hashes (not read yet) never count. */
export function repeatedPhotos(hashes: (string | null | undefined)[]): number[] {
  const out: number[] = [];
  hashes.forEach((h, i) => {
    if (h && hashes.slice(0, i).some((e, k) => e && !out.includes(k) && hashDistance(e, h) <= SAME_PHOTO)) out.push(i);
  });
  return out;
}
