import { describe, expect, it } from "vitest";
import { fileHeaders, isPicture, safeType } from "../lib/safeFile";

describe("passed-on files", () => {
  it("keeps the type of pictures and media only", () => {
    expect(safeType("image/jpeg")).toBe("image/jpeg");
    expect(safeType("image/HEIC")).toBe("image/heic");
    expect(safeType("video/mp4; codecs=avc1")).toBe("video/mp4");
    expect(safeType("text/plain")).toBe("text/plain");
    expect(safeType("text/html")).toBe("application/octet-stream");
    expect(safeType("image/svg+xml")).toBe("application/octet-stream");
    expect(safeType("")).toBe("application/octet-stream");
  });
  it("never takes an SVG for a picture", () => {
    expect(isPicture("image/png")).toBe(true);
    expect(isPicture("image/svg+xml")).toBe(false);
  });
  it("sandboxes the answer", () => {
    const h = fileHeaders("text/html");
    expect(h["Content-Type"]).toBe("application/octet-stream");
    expect(h["Content-Security-Policy"]).toContain("sandbox");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
  });
});
