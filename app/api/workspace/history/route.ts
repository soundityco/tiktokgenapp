import { auth } from "@/auth";
import { listVersions, loadVersion } from "@/lib/db";

export const dynamic = "force-dynamic";

const email = async () => (await auth())?.user?.email?.toLowerCase() ?? null;

/** GET → the kept versions of the user's workspace; GET ?id=… → one of them (to restore it). */
export async function GET(req: Request) {
  const e = await email();
  if (!e) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return Response.json({ versions: await listVersions(e) });
    const data = await loadVersion(e, id);
    return data ? Response.json({ data }) : Response.json({ error: "not_found" }, { status: 404 });
  } catch (err) {
    console.error("workspace history failed", err);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
