import { sessionEmail } from "@/auth";
import { IMAGE_HOSTS } from "@/lib/imageSearch";
import { fileHeaders, isPicture } from "@/lib/safeFile";

export const dynamic = "force-dynamic";

/** Netlify answers at most 6 MB: a bigger picture would not get through. */
const MAX = 5_800_000;

// The pictures found by the search, relayed so the slide canvas may use them (most hosts send no CORS headers).
export async function GET(req: Request) {
  if (!(await sessionEmail())) return Response.json({ error: "unauthorized" }, { status: 401 });
  let target: URL;
  try { target = new URL(new URL(req.url).searchParams.get("u") ?? ""); } catch { return Response.json({ error: "bad url" }, { status: 400 }); }
  if (target.protocol !== "https:" || !IMAGE_HOSTS.test(target.hostname)) return Response.json({ error: "host not allowed" }, { status: 400 });
  const res = await fetch(target, { redirect: "follow", headers: { "User-Agent": "Rollout/0.5" } }).catch(() => null);
  if (!res?.ok) return Response.json({ error: "picture unavailable" }, { status: 502 });
  // After redirects, still one of the photo hosts.
  if (!IMAGE_HOSTS.test(new URL(res.url).hostname)) return Response.json({ error: "host not allowed" }, { status: 400 });
  const type = res.headers.get("content-type") ?? "";
  if (!isPicture(type)) return Response.json({ error: "not an image" }, { status: 502 });
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX) return Response.json({ error: "too_large" }, { status: 413 });
  return new Response(buf, { headers: fileHeaders(type, { "Cache-Control": "private, max-age=86400" }) });
}
