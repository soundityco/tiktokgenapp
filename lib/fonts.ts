import { delMedia, getMedia, listMedia, putMedia } from "./idb";

/**
 * Fonts loaded by the user (.ttf, .otf, .woff, .woff2). The files stay on this device, in
 * IndexedDB like the audio and video, and are registered with the browser so the canvas can use them.
 */
const PREFIX = "font:";
const registered = new Set<string>();

const familyOf = (fileName: string) =>
  fileName.replace(/\.[^.]+$/, "").replace(/["'\\]/g, "").replace(/[_]+/g, " ").trim().slice(0, 60) || "Custom font";

async function register(family: string, blob: Blob) {
  if (registered.has(family)) return;
  const face = new FontFace(family, await blob.arrayBuffer());
  await face.load();
  document.fonts.add(face);
  registered.add(family);
}

/** Register every saved font; returns their family names. */
export async function loadSavedFonts(): Promise<string[]> {
  const names: string[] = [];
  for (const key of await listMedia(PREFIX)) {
    const family = key.slice(PREFIX.length);
    const blob = await getMedia(key);
    if (!blob) continue;
    try { await register(family, blob); names.push(family); } catch { /* corrupted file: skipped */ }
  }
  return names.sort((a, b) => a.localeCompare(b));
}

export async function addFont(file: File): Promise<string> {
  const family = familyOf(file.name);
  registered.delete(family);
  await register(family, file); // throws when the file is not a usable font
  try { await putMedia(PREFIX + family, file); } catch { /* private mode: usable until reload */ }
  return family;
}

export async function removeFont(family: string): Promise<void> {
  registered.delete(family);
  await delMedia(PREFIX + family);
}
