import { sessionEmail } from "@/auth";
import { searchFlickr, searchOpenverse, searchPexels, type ImageSource } from "@/lib/imageSearch";

export const dynamic = "force-dynamic";

/** GET ?q=&page=&source=openverse|pexels → { results, more } */
export async function GET(req: Request) {
  if (!(await sessionEmail())) return Response.json({ error: "unauthorized" }, { status: 401 });
  const u = new URL(req.url);
  const q = (u.searchParams.get("q") ?? "").trim().slice(0, 120);
  const page = Math.max(1, Math.min(20, Number(u.searchParams.get("page")) || 1));
  const source = (u.searchParams.get("source") ?? "flickr") as ImageSource;
  if (!q) return Response.json({ results: [], more: false });
  try {
    if (source === "pexels") {
      const key = process.env.PEXELS_API_KEY;
      if (!key) return Response.json({ error: "pexels_not_configured" }, { status: 503 });
      const results = await searchPexels(q, page, key);
      return Response.json({ results, more: results.length === 30 });
    }
    // Flickr: through its own API when a key is set (bigger pictures), else through Openverse (no key).
    const key = process.env.FLICKR_API_KEY;
    const results = key ? await searchFlickr(q, page, key) : await searchOpenverse(q, page);
    return Response.json({ results, more: results.length >= (key ? 30 : 20) });
  } catch (e) {
    console.error("image search failed", e);
    return Response.json({ error: "search_failed" }, { status: 502 });
  }
}
