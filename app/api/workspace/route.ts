import { auth } from "@/auth";
import { loadWorkspace, saveWorkspace } from "@/lib/db";

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

export async function PUT(req: Request) {
  const e = await email();
  if (!e) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    const body = await req.json();
    if (!body || body.v !== 1 || !Array.isArray(body.projects)) {
      return Response.json({ error: "invalid workspace" }, { status: 400 });
    }
    await saveWorkspace(e, body);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
