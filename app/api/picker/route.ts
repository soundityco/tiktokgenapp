import { NextResponse } from "next/server";

/**
 * What Google's file picker needs: the Cloud project's number (the start of the OAuth client id: files chosen in
 * the picker are then opened to this app) and, when set, a browser API key (GOOGLE_PICKER_KEY). Both are public.
 */
export async function GET() {
  const appId = (process.env.AUTH_GOOGLE_ID ?? "").split("-")[0];
  return NextResponse.json({ appId, key: process.env.GOOGLE_PICKER_KEY || null });
}
