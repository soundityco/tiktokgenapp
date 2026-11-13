import { sessionEmail } from "@/auth";
import { coverAllowed } from "@/lib/tiktok";
import { fileHeaders, isPicture } from "@/lib/safeFile";

export const dynamic = "force-dynamic";

// TikTok cover URLs are short-lived and cannot be read from the browser (CORS), so the server relays them.
export async function GET(req: Request) {
  if (!(await sessionEmail())) return Response.json({ error: "unauthorized" }, { status: 401 });
  const raw = new URL(req.url).searchParams.get("u");
  let target: URL;
  try { target = new URL(raw ?? ""); } catch { return Response.json({ error: "bad url" }, { status: 400 }); }
  if (!coverAllowed(target)) return Response.json({ error: "host not allowed" }, { status: 400 });
  const res = await fetch(target, { redirect: "error" }).catch(() => null);
  if (!res?.ok) return Response.json({ error: "cover unavailable" }, { status: 502 });
  const type = res.headers.get("content-type") ?? "";
  if (!isPicture(type)) return Response.json({ error: "not an image" }, { status: 502 });
  return new Response(res.body, { headers: fileHeaders(type, { "Cache-Control": "private, max-age=300" }) });
}
