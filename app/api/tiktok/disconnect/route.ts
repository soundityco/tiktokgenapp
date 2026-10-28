import { auth } from "@/auth";
import { saveTikTok } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST() {
  const email = (await auth())?.user?.email?.toLowerCase();
  if (!email) return Response.json({ error: "unauthorized" }, { status: 401 });
  await saveTikTok(email, null);
  return Response.json({ ok: true });
}
