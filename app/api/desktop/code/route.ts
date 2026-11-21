import { NextResponse } from "next/server";
import { encode, getToken } from "next-auth/jwt";
import { CODE_SALT, CODE_SECONDS, goodState, isSecure, secret } from "@/lib/desktopAuth";

/** The browser's session sealed for the desktop app (lib/desktopAuth): 2 minutes, bound to the app's state. */
export async function GET(req: Request) {
  const state = new URL(req.url).searchParams.get("state");
  if (!goodState(state)) return NextResponse.json({ error: "state" }, { status: 400 });
  const token = await getToken({ req, secret: secret(), secureCookie: isSecure(req) });
  if (!token?.email) return NextResponse.json({ error: "signed out" }, { status: 401 });
  const { iat: _i, exp: _e, jti: _j, ...rest } = token;
  const code = await encode({ token: { ...rest, desktopState: state }, secret: secret(), salt: CODE_SALT, maxAge: CODE_SECONDS });
  return NextResponse.json({ code }, { headers: { "Cache-Control": "no-store" } });
}
