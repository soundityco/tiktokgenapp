import { auth } from "@/auth";
import { loadTikTok } from "@/lib/db";
import { tiktokConfigured } from "@/lib/tiktok";

export const dynamic = "force-dynamic";

export async function GET() {
  const email = (await auth())?.user?.email?.toLowerCase();
  if (!email) return Response.json({ error: "unauthorized" }, { status: 401 });
  const t = tiktokConfigured() ? await loadTikTok(email) : null;
  return Response.json({ configured: tiktokConfigured(), connected: !!t, name: t?.name ?? null });
}
