import { randomBytes } from "node:crypto";
import { auth } from "@/auth";
import { appUrl, authorizeUrl, pkcePair, publicOrigin, tiktokConfigured } from "@/lib/tiktok";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!(await auth())?.user?.email) return Response.redirect(appUrl(req, "/"));
  if (!tiktokConfigured()) return Response.redirect(appUrl(req, "/studio?tiktok=notconfigured"));
  const state = randomBytes(16).toString("hex");
  const { verifier, challenge } = pkcePair();
  const flags = `Path=/; HttpOnly; SameSite=Lax; Max-Age=600${publicOrigin(req).startsWith("https") ? "; Secure" : ""}`;
  const headers = new Headers({ Location: authorizeUrl(req, state, challenge) });
  headers.append("Set-Cookie", `tt_state=${state}; ${flags}`);
  headers.append("Set-Cookie", `tt_verifier=${verifier}; ${flags}`);
  return new Response(null, { status: 302, headers });
}
