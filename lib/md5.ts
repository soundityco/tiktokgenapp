/**
 * MD5 of a file's bytes (hex), the checksum Google Drive gives for every file: a picture dropped twice is
 * recognised whatever its name. Not for security, only to tell two files apart.
 */
const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const K = Array.from({ length: 64 }, (_, i) => (Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0));

/** The checksum fed piece by piece (a big file is read in slices, the page keeps running in between). */
class Md5 {
  private h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  private rest = new Uint8Array(64);
  private restLen = 0;
  private total = 0;
  private M = new Uint32Array(16);

  /** The 64-byte blocks of `b` from `off`. */
  private blocks(b: Uint8Array, off: number, end: number) {
    const M = this.M;
    let [a0, b0, c0, d0] = this.h;
    for (; off + 64 <= end; off += 64) {
      for (let i = 0; i < 16; i++) { const p = off + i * 4; M[i] = (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0; }
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F: number, g: number;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + K[i] + M[g]) >>> 0;
        A = D; D = C; C = B;
        B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    this.h = [a0, b0, c0, d0];
    return off;
  }

  update(b: Uint8Array) {
    this.total += b.length;
    let off = 0;
    if (this.restLen) {
      const take = Math.min(64 - this.restLen, b.length);
      this.rest.set(b.subarray(0, take), this.restLen);
      this.restLen += take; off = take;
      if (this.restLen < 64) return;
      this.blocks(this.rest, 0, 64);
      this.restLen = 0;
    }
    off = this.blocks(b, off, b.length);
    this.rest.set(b.subarray(off), 0);
    this.restLen = b.length - off;
  }

  digest(): string {
    const n = this.total;
    const tail = new Uint8Array(this.restLen < 56 ? 64 : 128);
    tail.set(this.rest.subarray(0, this.restLen));
    tail[this.restLen] = 0x80;
    const dv = new DataView(tail.buffer);
    dv.setUint32(tail.length - 8, (n * 8) >>> 0, true);
    dv.setUint32(tail.length - 4, Math.floor(n / 2 ** 29), true);
    this.blocks(tail, 0, tail.length);
    const hex = (x: number) => [0, 8, 16, 24].map((s) => ((x >>> s) & 255).toString(16).padStart(2, "0")).join("");
    return this.h.map(hex).join("");
  }
}

export function md5(bytes: Uint8Array): string {
  const m = new Md5();
  m.update(bytes);
  return m.digest();
}

/** MD5 of a file read 4 MB at a time: never the whole file in memory, never the page frozen while it counts. */
export async function md5Blob(blob: Blob): Promise<string> {
  const m = new Md5();
  const STEP = 4 * 1024 * 1024;
  for (let at = 0; at < blob.size; at += STEP) {
    m.update(new Uint8Array(await blob.slice(at, at + STEP).arrayBuffer()));
    await new Promise((r) => setTimeout(r, 0)); // let a frame of the video be drawn
  }
  return m.digest();
}
