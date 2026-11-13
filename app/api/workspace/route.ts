import { sessionEmail } from "@/auth";
import { loadWorkspace, saveWorkspaceCas } from "@/lib/db";

export const dynamic = "force-dynamic";

// Netlify functions take up to 6 MB per request; the timed lyrics of many releases need room.
const MAX_BODY = 5_000_000;

export async function GET() {
  const e = await sessionEmail();
  if (!e) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    return Response.json({ data: await loadWorkspace(e) });
  } catch (err) {
    console.error("workspace load failed", err);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}

/** Body: { data: Workspace, baseRev: number }. 409 + current revision if someone else saved in between. */
export async function PUT(req: Request) {
  const e = await sessionEmail();
  if (!e) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY) return Response.json({ error: "too_large" }, { status: 413 });
    let body: any;
    try { body = JSON.parse(raw); } catch { return Response.json({ error: "invalid json" }, { status: 400 }); }
    const data = body?.data;
    if (!data || data.v !== 1 || !Array.isArray(data.projects)) {
      return Response.json({ error: "invalid workspace" }, { status: 400 });
    }
    const baseRev = Number.isInteger(body.baseRev) ? body.baseRev : 0;
    const r = await saveWorkspaceCas(e, data, baseRev);
    return r.ok ? Response.json({ ok: true, rev: r.rev }) : Response.json({ error: "conflict", rev: r.rev }, { status: 409 });
  } catch (err) {
    console.error("workspace save failed", err);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
