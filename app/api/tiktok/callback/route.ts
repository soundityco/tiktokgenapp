import { auth } from "@/auth";
import { saveTikTok } from "@/lib/db";
import { exchangeCode, fetchDisplayName } from "@/lib/tiktok";

export const dynamic = "force-dynamic";

const back = (req: Request, flag: string) => {
  const headers = new Headers({ Location: new URL(`/studio?tiktok=${flag}`, req.url).toString() });
  headers.append("Set-Cookie", "tt_state=; Path=/; Max-Age=0");
  headers.append("Set-Cookie", "tt_verifier=; Path=/; Max-Age=0");
  return new Response(null, { status: 302, headers });
};
const cookieOf = (req: Request, name: string) =>
  new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.get("cookie") ?? "")?.[1];

export async function GET(req: Request) {
  const email = (await auth())?.user?.email?.toLowerCase();
  if (!email) return Response.redirect(new URL("/", req.url));
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookie = cookieOf(req, "tt_state");
  const verifier = cookieOf(req, "tt_verifier");
  if (url.searchParams.get("error") || !code) return back(req, "denied");
  if (!state || !cookie || state !== cookie || !verifier) return back(req, "badstate");
  try {
    const tokens = await exchangeCode(req, code, verifier);
    const name = await fetchDisplayName(tokens.accessToken);
    await saveTikTok(email, { ...tokens, name });
    return back(req, "connected");
  } catch {
    return back(req, "error");
  }
}
