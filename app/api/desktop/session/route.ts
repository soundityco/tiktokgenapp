import { NextResponse } from "next/server";
import { decode, encode } from "next-auth/jwt";
import { CODE_SALT, goodState, isSecure, secret, sessionCookie } from "@/lib/desktopAuth";

const YEAR = 365 * 24 * 60 * 60;
const CHUNK = 3936; // (Auth.js's own cookie chunk size)

/** The desktop app's window signed in with the session the code carries (lib/desktopAuth), then the studio. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code"), state = url.searchParams.get("state");
  const back = (to: string) => NextResponse.redirect(new URL(to, req.url));
  if (!code || !goodState(state)) return back("/?desktop=failed");
  let payload: Record<string, unknown> | null = null;
  try { payload = await decode({ token: code, secret: secret(), salt: CODE_SALT }); } catch { payload = null; }
  if (!payload || payload.desktopState !== state || !payload.email) return back("/?desktop=failed");
  const { desktopState: _s, iat: _i, exp: _e, jti: _j, ...token } = payload;
  const secure = isSecure(req), name = sessionCookie(secure);
  const value = await encode({ token, secret: secret(), salt: name, maxAge: YEAR });
  const res = back("/studio");
  const opts = { httpOnly: true, sameSite: "lax" as const, path: "/", secure, maxAge: YEAR };
  if (value.length <= CHUNK) res.cookies.set(name, value, opts);
  else for (let i = 0; i * CHUNK < value.length; i++) res.cookies.set(`${name}.${i}`, value.slice(i * CHUNK, (i + 1) * CHUNK), opts);
  res.headers.set("Cache-Control", "no-store");
  return res;
}
