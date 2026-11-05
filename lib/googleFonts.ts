/**
 * Google Fonts usable for the texts (carousel and video). A chosen list of families that read well on
 * TikTok, with the weights each one has. The font files come from Google's servers when a font is used;
 * the font list itself is in the app (no API key needed).
 */

export interface GoogleFont { family: string; weights: number[]; kind: "sans" | "serif" | "display" | "script" | "mono" }

const S = "sans", D = "display", R = "serif", H = "script", M = "mono";
const f = (family: string, kind: GoogleFont["kind"], ...weights: number[]): GoogleFont => ({ family, kind, weights: weights.length ? weights : [400] });

export const GOOGLE_FONTS: GoogleFont[] = [
  f("Abril Fatface", D), f("Alfa Slab One", D), f("Amatic SC", H, 400, 700), f("Anton", D), f("Antonio", D, 400, 700),
  f("Architects Daughter", H), f("Archivo", S, 400, 600, 700, 900), f("Archivo Black", D), f("Archivo Narrow", S, 400, 700),
  f("Arvo", R, 400, 700), f("Assistant", S, 400, 700, 800), f("Audiowide", D), f("Bagel Fat One", D), f("Baloo 2", D, 400, 600, 800),
  f("Bangers", D), f("Barlow", S, 400, 500, 600, 700, 800, 900), f("Barlow Condensed", S, 400, 600, 700, 800, 900),
  f("Bebas Neue", D), f("Big Shoulders Display", D, 400, 700, 900), f("Bitter", R, 400, 700, 900), f("Black Ops One", D),
  f("Bodoni Moda", R, 400, 700, 900), f("Bricolage Grotesque", S, 400, 600, 700, 800), f("Bungee", D), f("Bungee Shade", D),
  f("Cabin", S, 400, 700), f("Caveat", H, 400, 700), f("Chakra Petch", S, 400, 600, 700), f("Chewy", D), f("Cinzel", R, 400, 700, 900),
  f("Comfortaa", D, 400, 700), f("Cormorant Garamond", R, 400, 600, 700), f("Courier Prime", M, 400, 700),
  f("Covered By Your Grace", H), f("Crimson Text", R, 400, 600, 700), f("Dancing Script", H, 400, 700), f("Dela Gothic One", D),
  f("DM Sans", S, 400, 500, 700, 900), f("DM Serif Display", R), f("EB Garamond", R, 400, 600, 800), f("Exo 2", S, 400, 600, 700, 800, 900),
  f("Figtree", S, 400, 600, 700, 800, 900), f("Fjalla One", D), f("Fraunces", R, 400, 700, 900), f("Fredoka", D, 400, 600, 700),
  f("Gloria Hallelujah", H), f("Gochi Hand", H), f("Gravitas One", D), f("Great Vibes", H), f("Heebo", S, 400, 700, 900),
  f("Homemade Apple", H), f("IBM Plex Mono", M, 400, 700), f("IBM Plex Sans", S, 400, 500, 600, 700), f("Indie Flower", H),
  f("Instrument Serif", R), f("Inter", S, 400, 500, 600, 700, 800, 900), f("JetBrains Mono", M, 400, 700, 800),
  f("Josefin Sans", S, 400, 600, 700), f("Kalam", H, 400, 700), f("Kanit", S, 400, 500, 600, 700, 800, 900), f("Karla", S, 400, 700, 800),
  f("League Spartan", S, 400, 600, 700, 800, 900), f("Lexend", S, 400, 600, 700, 800), f("Libre Baskerville", R, 400, 700),
  f("Lilita One", D), f("Lobster", H), f("Lora", R, 400, 700), f("Luckiest Guy", D), f("Manrope", S, 400, 600, 700, 800),
  f("Merriweather", R, 400, 700, 900), f("Monoton", D), f("Montserrat", S, 400, 500, 600, 700, 800, 900), f("Mulish", S, 400, 700, 900),
  f("Noto Sans", S, 400, 700, 900), f("Nunito", S, 400, 600, 700, 800, 900), f("Old Standard TT", R, 400, 700),
  f("Open Sans", S, 400, 600, 700, 800), f("Orbitron", D, 400, 700, 900), f("Oswald", S, 400, 500, 600, 700), f("Outfit", S, 400, 600, 700, 800, 900),
  f("Overpass", S, 400, 700, 900), f("Pacifico", H), f("Passion One", D, 400, 700, 900), f("Pathway Gothic One", D),
  f("Patrick Hand", H), f("Paytone One", D), f("Permanent Marker", H), f("Pixelify Sans", D, 400, 700),
  f("Playfair Display", R, 400, 700, 900), f("Plus Jakarta Sans", S, 400, 600, 700, 800), f("Poppins", S, 400, 500, 600, 700, 800, 900),
  f("Press Start 2P", D), f("Prompt", S, 400, 600, 700, 800), f("PT Sans", S, 400, 700), f("PT Serif", R, 400, 700),
  f("Quicksand", S, 400, 600, 700), f("Raleway", S, 400, 600, 700, 800, 900), f("Rammetto One", D), f("Reenie Beanie", H),
  f("Righteous", D), f("Roboto", S, 400, 500, 700, 900), f("Roboto Slab", R, 400, 700, 900), f("Rock Salt", H), f("Rubik", S, 400, 500, 700, 900),
  f("Rubik Mono One", D), f("Russo One", D), f("Sacramento", H), f("Satisfy", H), f("Saira Condensed", S, 400, 600, 700, 800, 900),
  f("Shadows Into Light", H), f("Shrikhand", D), f("Silkscreen", D, 400, 700), f("Six Caps", D), f("Sora", S, 400, 600, 700, 800),
  f("Source Sans 3", S, 400, 600, 700, 900), f("Space Grotesk", S, 400, 500, 700), f("Space Mono", M, 400, 700), f("Special Elite", M),
  f("Spectral", R, 400, 600, 700, 800), f("Squada One", D), f("Staatliches", D), f("Syne", S, 400, 600, 700, 800), f("Teko", S, 400, 500, 600, 700),
  f("Tilt Warp", D), f("Titan One", D), f("Ubuntu", S, 400, 500, 700), f("Ultra", D), f("Unbounded", D, 400, 600, 700, 800, 900),
  f("Urbanist", S, 400, 600, 700, 800, 900), f("VT323", M), f("Work Sans", S, 400, 600, 700, 800), f("Yeseva One", D),
  f("Zen Dots", D), f("Zilla Slab", R, 400, 600, 700),
];

const byFamily = new Map(GOOGLE_FONTS.map((g) => [g.family, g]));
export const googleFont = (family: string) => byFamily.get(family);

const css = (q: string) => `https://fonts.googleapis.com/css2?${q}&display=swap`;
const fam = (family: string) => encodeURIComponent(family).replace(/%20/g, "+");
const loading = new Map<string, Promise<boolean>>();

/** Add Google's @font-face rules to the page, with the family renamed when `as` is given. */
async function inject(url: string, as?: { from: string; to: string }): Promise<boolean> {
  const res = await fetch(url);
  if (!res.ok) return false;
  let text = await res.text();
  if (as) text = text.split(`font-family: '${as.from}'`).join(`font-family: '${as.to}'`);
  const el = document.createElement("style");
  el.dataset.gfont = as?.to ?? url;
  el.textContent = text;
  document.head.appendChild(el);
  return true;
}

/**
 * Load a Google font at a weight, ready for the canvas. Resolves false when it cannot be loaded (offline,
 * family gone): the text then shows in the fallback font. Each family and weight is fetched once.
 */
export function loadGoogleFont(family: string, weight = 400, italic = false): Promise<boolean> {
  const key = `${family}|${weight}|${italic ? "i" : ""}`;
  let p = loading.get(key);
  if (!p) {
    p = (async () => {
      try {
        // The weight asked for; the plain family when Google does not have that weight.
        const ok = (await inject(css(`family=${fam(family)}:ital,wght@${italic ? 1 : 0},${weight}`))) || (await inject(css(`family=${fam(family)}`)));
        if (!ok) return false;
        const spec = `${italic ? "italic " : ""}${weight} 40px "${family}"`;
        await document.fonts.load(spec);
        return document.fonts.check(spec);
      } catch {
        return false;
      }
    })();
    loading.set(key, p);
  }
  return p;
}

const italics = new Map<string, Promise<boolean>>();
/** Does Google have a real italic of this family (asked once per family)? */
export function hasItalic(family: string): Promise<boolean> {
  let p = italics.get(family);
  if (!p) {
    p = fetch(css(`family=${fam(family)}:ital@1`)).then((r) => r.ok, () => false);
    italics.set(family, p);
  }
  return p;
}

/** Family name used for the preview of a font in the list (only the letters of its name are downloaded). */
export const previewFamily = (family: string) => `${family} (preview)`;
const previews = new Set<string>();
export async function loadPreview(family: string): Promise<void> {
  if (previews.has(family)) return;
  previews.add(family);
  try {
    await inject(css(`family=${fam(family)}&text=${encodeURIComponent(family)}`), { from: family, to: previewFamily(family) });
  } catch { previews.delete(family); }
}

/** Every Google font used in the saved data (slides, video texts, presets), to load them at start. */
export function googleFontsIn(data: unknown): { family: string; weight: number; italic: boolean }[] {
  const out = new Map<string, { family: string; weight: number; italic: boolean }>();
  const walk = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    const o = v as Record<string, unknown>;
    if (typeof o.googleFont === "string") {
      const weight = typeof o.weight === "number" ? o.weight : 400;
      const italic = o.italic === true;
      out.set(`${o.googleFont}|${weight}|${italic}`, { family: o.googleFont, weight, italic });
    }
    Object.values(o).forEach(walk);
  };
  walk(data);
  return [...out.values()];
}
