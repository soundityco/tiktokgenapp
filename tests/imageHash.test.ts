import { describe, expect, it } from "vitest";
import { HASH_H, HASH_W, hashDistance, hashOfGrey, repeatedPhotos, SAME_PHOTO } from "../lib/imageHash";

/** A grey picture from a function of the square's place. */
const grey = (f: (x: number, y: number) => number) => Float32Array.from({ length: HASH_W * HASH_H }, (_, i) => f(i % HASH_W, Math.floor(i / HASH_W)));
const scene = (x: number, y: number) => 128 + 90 * Math.sin(x * 0.9 + y * 0.4) * Math.cos(y * 0.7);

describe("a photo's look", () => {
  it("the same photo re-encoded (a little noise, a shift of brightness) stays the same photo", () => {
    let k = 3;
    const noisy = grey((x, y) => scene(x, y) * 0.95 + 6 + ((k = (k * 16807) % 2147483647) / 2147483647 - 0.5) * 3);
    expect(hashDistance(hashOfGrey(grey(scene)), hashOfGrey(noisy))).toBeLessThanOrEqual(SAME_PHOTO);
  });
  it("another photo (another pose, other light) is far", () => {
    const other = grey((x, y) => 128 + 90 * Math.cos(x * 0.5 - y * 0.8) * Math.sin(x * 0.3));
    expect(hashDistance(hashOfGrey(grey(scene)), hashOfGrey(other))).toBeGreaterThan(SAME_PHOTO * 3);
  });
  it("in a list: each repeat after its first, unread photos never count", () => {
    const a = hashOfGrey(grey(scene)), b = hashOfGrey(grey((x, y) => x * 9 - y * 5));
    expect(repeatedPhotos([a, b, null, a, undefined, b, a])).toEqual([3, 5, 6]);
  });
});
