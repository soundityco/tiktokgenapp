import { auth } from "@/auth";
import { saveTikTok } from "@/lib/db";
import { exchangeCode, fetchDisplayName } from "@/lib/tiktok";

export const dynamic = "force-dynamic";

const back = (req: Request, flag: string) =>
  new Response(null, {
    status: 302,
    headers: { Location: new URL(`/studio?tiktok=${flag}`, req.url).toString(), "Set-Cookie": "tt_state=; Path=/; Max-Age=0" },
  });

export async function GET(req: Request) {
  const email = (await auth())?.user?.email?.toLowerCase();
  if (!email) return Response.redirect(new URL("/", req.url));
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookie = /(?:^|;\s*)tt_state=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
  if (url.searchParams.get("error") || !code) return back(req, "denied");
  if (!state || !cookie || state !== cookie) return back(req, "badstate");
  try {
    const tokens = await exchangeCode(req, code);
    const name = await fetchDisplayName(tokens.accessToken);
    await saveTikTok(email, { ...tokens, name });
    return back(req, "connected");
  } catch {
    return back(req, "error");
  }
}
