import { auth } from "@/auth";
import { RELAY_CHUNK } from "@/lib/shareLimits";
import { dropChunks, getChunk, putChunk, shareInfo } from "@/lib/shareStore";

export const dynamic = "force-dynamic";

/** Which slice: ?code=…&f=<file>&n=<slice>, checked against what the share holds. */
async function target(req: Request) {
  const q = new URL(req.url).searchParams;
  const code = q.get("code") ?? "";
  const f = Number(q.get("f"));
  const n = Number(q.get("n"));
  if (!/^[A-Za-z0-9_-]{12,40}$/.test(code)) return { error: 400 } as const;
  const s = await shareInfo(code);
  if (!s || !s.meta.relay) return { error: 410 } as const;
  return { code, f, n, s };
}
const sliceOk = (s: { meta: { files: { size: number }[] } }, f: number, n: number) =>
  Number.isInteger(f) && Number.isInteger(n) && f >= 0 && n >= 0 && f < s.meta.files.length
  && n < Math.max(1, Math.ceil(s.meta.files[f].size / RELAY_CHUNK));

/** The computer puts a slice on the bridge (the owner of the share only). */
export async function PUT(req: Request) {
  try {
    const t = await target(req);
    if ("error" in t) return new Response(null, { status: t.error });
    const email = (await auth())?.user?.email?.toLowerCase();
    if (!email || email !== t.s.email) return new Response(null, { status: 401 });
    if (!sliceOk(t.s, t.f, t.n)) return new Response(null, { status: 400 });
    const data = Buffer.from(await req.arrayBuffer());
    if (data.length > RELAY_CHUNK) return new Response(null, { status: 413 });
    await putChunk(t.code, t.f, t.n, data);
    return Response.json({ ok: true });
  } catch (err) { console.error("share chunk put failed", err); return new Response(null, { status: 500 }); }
}

/** The phone takes a slice (404: not there yet, try again; 410: the share is over). */
export async function GET(req: Request) {
  try {
    const t = await target(req);
    if ("error" in t) return new Response(null, { status: t.error });
    if (!sliceOk(t.s, t.f, t.n)) return new Response(null, { status: 400 });
    const data = await getChunk(t.code, t.f, t.n);
    if (!data) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
    return new Response(new Uint8Array(data), { headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" } });
  } catch (err) { console.error("share chunk get failed", err); return new Response(null, { status: 500 }); }
}

/** The phone has everything: the bridge is emptied. */
export async function DELETE(req: Request) {
  try {
    const t = await target(req);
    if ("error" in t) return new Response(null, { status: t.error === 410 ? 204 : t.error });
    await dropChunks(t.code);
    return new Response(null, { status: 204 });
  } catch (err) { console.error("share chunk drop failed", err); return new Response(null, { status: 500 }); }
}
