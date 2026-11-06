import { getShare } from "@/lib/shareStore";

export const dynamic = "force-dynamic";

/** Small enough to go through a server function (bigger files: the phone opens them on the Drive). */
const PROXY_MAX = 4_000_000;

/**
 * Plan B, for the phone: one file of a share sent through the Drive, passed on by the server so the phone gets
 * the file itself (saved like the direct transfer) and not a Drive page. Only the files of that share, only small ones.
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const code = q.get("code");
  const i = Number(q.get("i"));
  if (!code || !/^[A-Za-z0-9_-]{12,40}$/.test(code) || !Number.isInteger(i) || i < 0) return new Response("invalid", { status: 400 });
  const s = await getShare(code).catch(() => null);
  const d = s?.meta.drive?.[i];
  const f = s?.meta.files.find((x) => x.name === d?.name) ?? s?.meta.files[i];
  if (!d || !f) return new Response("not found", { status: 404 });
  if (f.size > PROXY_MAX) return new Response("too large", { status: 413 });
  const r = await fetch(`https://drive.usercontent.google.com/download?id=${encodeURIComponent(d.id)}&export=download&confirm=t`, { cache: "no-store" });
  const type = r.headers.get("content-type") ?? "";
  if (!r.ok || type.startsWith("text/html")) return new Response("drive", { status: 502 });
  const body = await r.arrayBuffer();
  if (body.byteLength > PROXY_MAX) return new Response("too large", { status: 413 });
  return new Response(body, { headers: { "Content-Type": f.type || type || "application/octet-stream", "Cache-Control": "no-store" } });
}
