import { getToken, thumbLinks } from "./drive";

// Google generates small thumbnails for every Drive picture (HEIC included): much lighter than downloading the file.
const cache = new Map<string, Promise<string | null>>();
let active = 0;
const waiting: (() => void)[] = [];
const slot = () => new Promise<void>((r) => (active < 6 ? (active++, r()) : waiting.push(() => (active++, r()))));
const release = () => { active--; waiting.shift()?.(); };

export function thumbnailLink(id: string): Promise<string | null> {
  let p = cache.get(id);
  if (!p) {
    const known = thumbLinks.get(id);
    p = (async () => {
      if (known) return known.replace(/=s\d+(-c)?$/, "=s240"); // already given by a folder listing
      await slot();
      try {
        const res = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=thumbnailLink&supportsAllDrives=true`, {
          headers: { Authorization: `Bearer ${await getToken()}` },
        });
        if (!res.ok) return null;
        const link: string | undefined = (await res.json()).thumbnailLink;
        return link ? link.replace(/=s\d+(-c)?$/, "=s240") : null;
      } catch {
        return null;
      } finally {
        release();
      }
    })();
    cache.set(id, p);
  }
  return p;
}
