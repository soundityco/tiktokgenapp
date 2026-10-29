import { auth } from "@/auth";
import { loadWorkspace, saveWorkspaceCas } from "@/lib/db";

export const dynamic = "force-dynamic";

const email = async () => (await auth())?.user?.email?.toLowerCase() ?? null;

export async function GET() {
  const e = await email();
  if (!e) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    return Response.json({ data: await loadWorkspace(e) });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

/** Body: { data: Workspace, baseRev: number }. 409 + current revision if someone else saved in between. */
export async function PUT(req: Request) {
  const e = await email();
  if (!e) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    const body = await req.json();
    const data = body?.data;
    if (!data || data.v !== 1 || !Array.isArray(data.projects)) {
      return Response.json({ error: "invalid workspace" }, { status: 400 });
    }
    const baseRev = Number.isInteger(body.baseRev) ? body.baseRev : 0;
    const r = await saveWorkspaceCas(e, data, baseRev);
    return r.ok ? Response.json({ ok: true, rev: r.rev }) : Response.json({ error: "conflict", rev: r.rev }, { status: 409 });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
