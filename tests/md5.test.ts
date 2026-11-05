import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { md5 } from "../lib/md5";

describe("md5 (the checksum Drive gives)", () => {
  it("matches the standard MD5", () => {
    expect(md5(new Uint8Array())).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5(new TextEncoder().encode("The quick brown fox jumps over the lazy dog"))).toBe("9e107d9d372bb6826bd81d3542a419d6");
    const big = new Uint8Array(1_000_003).map((_, i) => (i * 31) & 255);
    expect(md5(big)).toBe(createHash("md5").update(big).digest("hex"));
  });
});
