import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** The version online (its commit): the page open compares it with its own to offer the new one (UpdatePill). */
export function GET() {
  return NextResponse.json({ build: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev" }, { headers: { "Cache-Control": "no-store" } });
}
