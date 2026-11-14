/**
 * Concert-like pictures drawn in the browser (no photo to download): a dark stage, light beams from above, haze, a few
 * blurred lights and film grain, in a palette. For the home page's demos only.
 */
export const PALETTES: [string, string, string][] = [
  ["#ff7b3a", "#ffd27a", "#1a0d08"], // warm stage
  ["#6a55ff", "#dcc4ff", "#0c0a1c"], // violet club
  ["#2bb3ff", "#c9f1ff", "#06111c"], // blue night
  ["#ff3d6e", "#ffc2d1", "#1c0710"], // red room
  ["#1ccb86", "#c9ffe5", "#06160f"], // green haze
  ["#ffb020", "#fff1c2", "#1a1206"], // golden hour
];

const rng = (seed: number) => { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); };

export function drawStage(c: HTMLCanvasElement, palette: [string, string, string], seed: number) {
  const W = c.width, H = c.height, g = c.getContext("2d")!;
  const r = rng(seed);
  const [main, light, dark] = palette;
  // The room: dark, a glow low in the middle.
  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#050506"); bg.addColorStop(0.55, dark); bg.addColorStop(1, "#020203");
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  const glow = g.createRadialGradient(W * (0.35 + r() * 0.3), H * 0.62, 10, W * 0.5, H * 0.62, W * 0.9);
  glow.addColorStop(0, main + "aa"); glow.addColorStop(1, "transparent");
  g.fillStyle = glow; g.fillRect(0, 0, W, H);
  // Beams from the rig.
  g.globalCompositeOperation = "lighter";
  for (let i = 0; i < 4; i++) {
    const x = W * (0.1 + r() * 0.8), spread = W * (0.18 + r() * 0.25), angle = (r() - 0.5) * W * 0.6;
    const beam = g.createLinearGradient(x, 0, x + angle, H * 0.85);
    beam.addColorStop(0, light + "55"); beam.addColorStop(1, "transparent");
    g.fillStyle = beam;
    g.beginPath(); g.moveTo(x - 6, -10); g.lineTo(x + 6, -10); g.lineTo(x + angle + spread, H * 0.9); g.lineTo(x + angle - spread, H * 0.9); g.closePath(); g.fill();
  }
  // Out-of-focus lights.
  for (let i = 0; i < 14; i++) {
    const x = r() * W, y = H * (0.2 + r() * 0.6), rad = W * (0.015 + r() * 0.05);
    const b = g.createRadialGradient(x, y, 0, x, y, rad);
    b.addColorStop(0, (r() > 0.5 ? light : main) + "88"); b.addColorStop(1, "transparent");
    g.fillStyle = b; g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
  }
  g.globalCompositeOperation = "source-over";
  // A crowd's silhouette at the bottom.
  g.fillStyle = "#030304";
  g.beginPath(); g.moveTo(0, H);
  for (let x = 0; x <= W; x += W / 18) g.lineTo(x, H * (0.86 + r() * 0.06) - (Math.sin(x / W * 9 + seed) > 0.6 ? H * 0.04 : 0));
  g.lineTo(W, H); g.closePath(); g.fill();
  // Grain.
  const img = g.getImageData(0, 0, W, H), d = img.data;
  for (let i = 0; i < d.length; i += 4) { const n = (r() - 0.5) * 26; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  g.putImageData(img, 0, 0);
}

/** A stage picture as an image the slide renderer takes. */
export async function stagePhoto(palette: [string, string, string], seed: number): Promise<ImageBitmap> {
  const c = document.createElement("canvas");
  c.width = 540; c.height = 960;
  drawStage(c, palette, seed);
  return createImageBitmap(c);
}
