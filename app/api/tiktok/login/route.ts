import { randomBytes } from "node:crypto";
import { auth } from "@/auth";
import { authorizeUrl, pkcePair, tiktokConfigured } from "@/lib/tiktok";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!(await auth())?.user?.email) return Response.redirect(new URL("/", req.url));
  if (!tiktokConfigured()) return Response.redirect(new URL("/studio?tiktok=notconfigured", req.url));
  const state = randomBytes(16).toString("hex");
  const { verifier, challenge } = pkcePair();
  const flags = `Path=/; HttpOnly; SameSite=Lax; Max-Age=600${req.url.startsWith("https") ? "; Secure" : ""}`;
  const headers = new Headers({ Location: authorizeUrl(req, state, challenge) });
  headers.append("Set-Cookie", `tt_state=${state}; ${flags}`);
  headers.append("Set-Cookie", `tt_verifier=${verifier}; ${flags}`);
  return new Response(null, { status: 302, headers });
}
