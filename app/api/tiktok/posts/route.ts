import { sessionEmail } from "@/auth";
import { listPosts, validToken } from "@/lib/tiktok";

export const dynamic = "force-dynamic";

export async function GET() {
  const email = await sessionEmail();
  if (!email) return Response.json({ error: "unauthorized" }, { status: 401 });
  const token = await validToken(email);
  if (!token) return Response.json({ error: "not_connected" }, { status: 409 });
  try {
    return Response.json({ posts: await listPosts(token) });
  } catch (e: any) {
    return Response.json({ error: e?.message ?? "TikTok error", code: e?.code }, { status: 502 });
  }
}
