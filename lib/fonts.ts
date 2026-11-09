import { DRIVE_PATHS, canWriteDrive, downloadDriveFile, listAppFiles, uploadToDrive } from "./drive";
import { type FaceInfo, faceOf, sameFace } from "./fontInfo";
import { delMedia, getMedia, listMedia, putMedia } from "./idb";

/**
 * Fonts loaded by the user (.ttf, .otf, .woff, .woff2), grouped by family: the bold, light, italic or
 * condensed files of one font are the styles of that family. The files are kept on this device (IndexedDB)
 * and in the user's Google Drive (Rollout folder), so every browser and device gets them.
 */
const PREFIX = "font:";
const keyOf = (f: FaceInfo) => `${PREFIX}${f.family}|${f.weight}|${f.italic ? 1 : 0}|${f.stretch}`;
function infoOfKey(key: string): FaceInfo | null {
  const [family, w, i, stretch] = key.slice(PREFIX.length).split("|");
  return stretch ? { family, weight: Number(w), italic: i === "1", stretch } : null;
}

/** Faces registered on this page, by family. */
const faces = new Map<string, FaceInfo[]>();

/** The styles a loaded family has (for the style buttons). */
export const facesOf = (family: string): FaceInfo[] => faces.get(family) ?? [];
const has = (f: FaceInfo) => facesOf(f.family).some((x) => sameFace(x, f));

/**
 * Name the browser knows a face under. Condensed / expanded files get a family of their own: the canvas
 * cannot ask for a width in every browser (Safari ignores the whole font then), a family name always works.
 */
export const canvasFamily = (family: string, stretch?: string) => (stretch && stretch !== "normal" ? `${family} ~${stretch}` : family);

async function register(f: FaceInfo, blob: Blob) {
  if (has(f)) return;
  const face = new FontFace(canvasFamily(f.family, f.stretch), await blob.arrayBuffer(), {
    weight: String(f.weight), style: f.italic ? "italic" : "normal",
  });
  await face.load();
  document.fonts.add(face);
  faces.set(f.family, [...facesOf(f.family), f].sort((a, b) => a.weight - b.weight || Number(a.italic) - Number(b.italic)));
}

/** This exact style of this family is already loaded. */
export class DuplicateFont extends Error {
  constructor(readonly face: FaceInfo) { super("already loaded"); }
}

const families = () => [...faces.keys()].sort((a, b) => a.localeCompare(b));

/**
 * Register every saved font; returns the families, and the old names of fonts saved before the styles
 * were read from the files ("Helvetica-Bold" → Helvetica 700), so the texts using them can be updated.
 */
export async function loadSavedFonts(): Promise<{ families: string[]; renamed: Record<string, FaceInfo> }> {
  const renamed: Record<string, FaceInfo> = {};
  for (const key of await listMedia(PREFIX)) {
    const blob = await getMedia(key);
    if (!blob) continue;
    let info = infoOfKey(key);
    try {
      if (!info) {
        // Saved by an older version under its file name: read its real family and style once.
        const legacy = key.slice(PREFIX.length);
        info = faceOf(legacy, await blob.arrayBuffer());
        renamed[legacy] = info;
        await putMedia(keyOf(info), blob);
        await delMedia(key);
      }
      await register(info, blob);
    } catch { /* corrupted file: skipped */ }
  }
  return { families: families(), renamed };
}

const nameOnDrive = (f: FaceInfo, file: string) => `font - ${f.family} ${f.weight}${f.italic ? " italic" : ""}${f.stretch !== "normal" ? ` ${f.stretch}` : ""} - ${file}`;
const labels = (f: FaceInfo): Record<string, string> => ({ tktgen: "font", family: f.family, weight: String(f.weight), italic: f.italic ? "1" : "0", stretch: f.stretch });

async function sendToDrive(f: FaceInfo, blob: Blob, file: string) {
  try {
    if (await canWriteDrive()) await uploadToDrive(blob, nameOnDrive(f, file), () => {}, new AbortController().signal, "application/octet-stream", labels(f), DRIVE_PATHS.fonts);
  } catch (e) { console.warn("[fonts] could not be saved in Drive", e); }
}

/**
 * Load a font file. Throws DuplicateFont when this style of this family is already there, or an error
 * when the file is not a usable font. The file also goes to the user's Drive.
 */
export async function addFont(file: File): Promise<FaceInfo> {
  const info = faceOf(file.name, await file.arrayBuffer());
  if (has(info)) throw new DuplicateFont(info);
  await register(info, file); // throws when the file is not a usable font
  try { await putMedia(keyOf(info), file); } catch { /* private mode: usable until reload */ }
  void sendToDrive(info, file, file.name);
  return info;
}

/** Remove a whole family (every style) from this device. Its copies in Drive stay. */
export async function removeFont(family: string): Promise<void> {
  for (const f of facesOf(family)) await delMedia(keyOf(f));
  faces.delete(family);
  for (const face of [...document.fonts]) {
    const name = face.family.replace(/"/g, "");
    if (name === family || name.startsWith(`${family} ~`)) document.fonts.delete(face);
  }
}

/**
 * The fonts in the user's Drive that this device does not have: downloaded and registered; the ones this
 * device has and Drive does not: sent. Returns the families when something changed, else null.
 */
export async function syncFontsWithDrive(): Promise<string[] | null> {
  let changed = false;
  try {
    const remote = await listAppFiles("font");
    const seen: FaceInfo[] = [];
    for (const r of remote) {
      const p = r.appProperties;
      const info: FaceInfo = { family: p.family, weight: Number(p.weight) || 400, italic: p.italic === "1", stretch: p.stretch || "normal" };
      if (!info.family) continue;
      seen.push(info);
      if (has(info)) continue;
      const blob = await downloadDriveFile(r.id);
      await register(info, blob);
      await putMedia(keyOf(info), blob).catch(() => {});
      changed = true;
    }
    if (await canWriteDrive()) {
      for (const fam of families()) for (const f of facesOf(fam)) {
        if (seen.some((x) => sameFace(x, f))) continue;
        const blob = await getMedia(keyOf(f));
        if (blob) await sendToDrive(f, blob, `${f.family}.font`);
      }
    }
  } catch (e) {
    console.warn("[fonts] Drive sync failed", e);
  }
  return changed ? families() : null;
}
