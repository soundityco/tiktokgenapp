import { sessionEmail } from "@/auth";
import { RELAY_MAX, isShareCode } from "@/lib/shareLimits";
import { answerShare, createShare, getShare, setShareDrive, type ShareMeta } from "@/lib/shareStore";

export const dynamic = "force-dynamic";

const MAX = 64_000; // an offer / answer with its network candidates is a few kB

/** The computer opens a share: { offer, meta } → { code }. Signed in only. */
export async function POST(req: Request) {
  const e = await sessionEmail();
  if (!e) return Response.json({ error: "unauthorized" }, { status: 401 });
  const raw = await req.text();
  if (raw.length > MAX) return Response.json({ error: "too_large" }, { status: 413 });
  let body: { offer?: unknown; meta?: ShareMeta };
  try { body = JSON.parse(raw); } catch { return Response.json({ error: "invalid json" }, { status: 400 }); }
  if (typeof body.offer !== "string" || !body.meta || !Array.isArray(body.meta.files)) return Response.json({ error: "invalid" }, { status: 400 });
  const meta: ShareMeta = {
    kind: body.meta.kind === "video" ? "video" : "images",
    title: String(body.meta.title ?? "").slice(0, 200),
    caption: body.meta.caption ? String(body.meta.caption).slice(0, 4000) : undefined,
    files: body.meta.files.slice(0, 40).map((f) => ({ name: String(f.name).slice(0, 200), size: Math.max(0, Number(f.size) || 0), type: String(f.type).slice(0, 80) })),
  };
  if (body.meta.relay === true && meta.files.reduce((n, f) => n + f.size, 0) <= RELAY_MAX) meta.relay = true;
  try { return Response.json({ code: await createShare(e, body.offer, meta) }); }
  catch (err) { console.error("share create failed", err); return Response.json({ error: "server_error" }, { status: 500 }); }
}

/** The phone reads the share (offer, what is shared), the computer waits for the answer. Anyone with the code. */
export async function GET(req: Request) {
  const code = new URL(req.url).searchParams.get("code");
  if (!isShareCode(code)) return Response.json({ error: "invalid" }, { status: 400 });
  try {
    const s = await getShare(code);
    return s ? Response.json(s, { headers: { "Cache-Control": "no-store" } }) : Response.json({ error: "expired" }, { status: 404 });
  } catch (err) { console.error("share read failed", err); return Response.json({ error: "server_error" }, { status: 500 }); }
}

/** The phone answers ({ code, answer }); the computer adds its Drive files when the direct link failed ({ code, drive }). */
export async function PUT(req: Request) {
  const raw = await req.text();
  if (raw.length > MAX) return Response.json({ error: "too_large" }, { status: 413 });
  let body: { code?: unknown; answer?: unknown; drive?: unknown };
  try { body = JSON.parse(raw); } catch { return Response.json({ error: "invalid json" }, { status: 400 }); }
  if (!isShareCode(body.code)) return Response.json({ error: "invalid" }, { status: 400 });
  try {
    if (Array.isArray(body.drive)) {
      const e = await sessionEmail();
      if (!e) return Response.json({ error: "unauthorized" }, { status: 401 });
      const drive = body.drive.slice(0, 40).map((d: any) => ({ name: String(d.name).slice(0, 200), id: String(d.id).replace(/[^\w-]/g, "") }));
      return (await setShareDrive(body.code, e, drive)) ? Response.json({ ok: true }) : Response.json({ error: "not_found" }, { status: 404 });
    }
    if (typeof body.answer !== "string") return Response.json({ error: "invalid" }, { status: 400 });
    return (await answerShare(body.code, body.answer)) ? Response.json({ ok: true }) : Response.json({ error: "taken_or_expired" }, { status: 409 });
  } catch (err) { console.error("share answer failed", err); return Response.json({ error: "server_error" }, { status: 500 }); }
}
