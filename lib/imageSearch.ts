/**
 * Photos found on the web for a slide (server side: the keys stay on the server). Only pictures that may
 * be posted on TikTok, text added on them included:
 * - Openverse (Flickr and other photo sites): licences CC0, public domain and CC BY (credit the author).
 *   CC BY-SA (the post would have to carry the same licence), non-commercial and no-derivatives licences are left out.
 * - Pexels: free for any use, credit welcome but not required.
 */

export type ImageSource = "flickr" | "pexels";

export interface FoundImage {
  id: string;
  source: ImageSource;
  /** Small picture for the grid. */
  thumb: string;
  /** Picture to put in the slide (large). */
  full: string;
  w: number;
  h: number;
  author: string;
  /** "CC BY 2.0", "CC0", "Pexels licence"… */
  license: string;
  /** Credit to give: required for CC BY. */
  creditRequired: boolean;
  page: string;
}

/** Hosts the file relay may fetch from (the pictures of these sources). */
export const IMAGE_HOSTS = /(^|\.)(staticflickr\.com|flickr\.com|openverse\.org|pexels\.com|wikimedia\.org|nappy\.co|rawpixel\.com|stocksnap\.io|wordpress\.com|pinimg\.com)$/i;

const UA = "Rollout/0.5 (image search for music posts)";

/** A Flickr picture link at 1024 px (Openverse often gives the 500 px one; the same secret serves both). */
const flickrLarge = (u: string) => u.replace(/^(https:\/\/live\.staticflickr\.com\/\d+\/\d+_[0-9a-f]+)(?:_[a-z])?\.jpg$/i, "$1_b.jpg");

export async function searchOpenverse(q: string, page: number): Promise<FoundImage[]> {
  const params = new URLSearchParams({ q, page: String(page), page_size: "20", license: "cc0,pdm,by", mature: "false" });
  let res: Response | null = null;
  // Openverse (no key) answers 500 now and then: a couple of retries.
  for (let i = 0; i < 3; i++) {
    // Openverse can take 10 s and more: the request gives up before the server function does.
    res = await fetch(`https://api.openverse.org/v1/images/?${params}`, { headers: { "User-Agent": UA, Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(7000) }).catch(() => null);
    if (res?.ok) break;
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  if (!res?.ok) throw new Error(`openverse ${res?.status}`);
  const data = await res.json();
  return (data.results ?? []).filter((r: any) => r.url).map((r: any): FoundImage => {
    const lic = String(r.license ?? "").toLowerCase();
    return {
      id: `ov:${r.id}`, source: "flickr",
      thumb: r.thumbnail ?? `https://api.openverse.org/v1/images/${r.id}/thumb/`, full: flickrLarge(r.url),
      w: r.width ?? 0, h: r.height ?? 0,
      author: r.creator ?? r.provider ?? "",
      license: lic === "cc0" ? "CC0" : lic === "pdm" ? "Public domain" : `CC ${lic.toUpperCase()} ${r.license_version ?? ""}`.trim(),
      creditRequired: lic === "by", page: r.foreign_landing_url ?? "",
    };
  });
}

/** Flickr licences that allow a post with text on the picture: CC BY 2.0 / 4.0, CC0, public domain, no known restrictions. */
const FLICKR_OK: Record<string, { name: string; credit: boolean }> = {
  "4": { name: "CC BY 2.0", credit: true }, "11": { name: "CC BY 4.0", credit: true },
  "9": { name: "CC0", credit: false }, "10": { name: "Public domain", credit: false }, "7": { name: "No known copyright restrictions", credit: false },
};

/** Flickr itself (key): up to 2048 px, the amateur photos of real people. */
export async function searchFlickr(q: string, page: number, key: string): Promise<FoundImage[]> {
  const params = new URLSearchParams({
    method: "flickr.photos.search", api_key: key, text: q, page: String(page), per_page: "30", sort: "relevance",
    license: Object.keys(FLICKR_OK).join(","), content_type: "1", media: "photos", safe_search: "1",
    extras: "url_k,url_h,url_b,url_c,url_m,owner_name,license", format: "json", nojsoncallback: "1",
  });
  const res = await fetch(`https://api.flickr.com/services/rest/?${params}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`flickr ${res.status}`);
  const data = await res.json();
  if (data.stat !== "ok") throw new Error(`flickr ${data.message ?? "error"}`);
  return (data.photos?.photo ?? []).flatMap((p: any): FoundImage[] => {
    const lic = FLICKR_OK[String(p.license)];
    const full = p.url_k ?? p.url_h ?? p.url_b ?? p.url_c;
    if (!lic || !full) return [];
    const w = Number(p.width_k ?? p.width_h ?? p.width_b ?? p.width_c) || 0, h = Number(p.height_k ?? p.height_h ?? p.height_b ?? p.height_c) || 0;
    return [{ id: `fl:${p.id}`, source: "flickr", thumb: p.url_m ?? p.url_c ?? full, full, w, h, author: p.ownername ?? "",
      license: lic.name, creditRequired: lic.credit, page: `https://www.flickr.com/photos/${p.owner}/${p.id}` }];
  });
}

export async function searchPexels(q: string, page: number, key: string): Promise<FoundImage[]> {
  const params = new URLSearchParams({ query: q, page: String(page), per_page: "30" });
  const res = await fetch(`https://api.pexels.com/v1/search?${params}`, { headers: { Authorization: key }, cache: "no-store" });
  if (!res.ok) throw new Error(`pexels ${res.status}`);
  const data = await res.json();
  return (data.photos ?? []).map((p: any): FoundImage => ({
    id: `px:${p.id}`, source: "pexels",
    thumb: p.src?.medium ?? p.src?.small, full: `${p.src?.original}?auto=compress&cs=tinysrgb&h=2400`,
    w: p.width ?? 0, h: p.height ?? 0, author: p.photographer ?? "", license: "Pexels licence", creditRequired: false, page: p.url ?? "",
  }));
}
