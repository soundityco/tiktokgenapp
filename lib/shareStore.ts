import { neon } from "@neondatabase/serverless";
import { randomBytes } from "node:crypto";

/**
 * The meeting point of a share between the computer and a phone (WebRTC signalling): the computer's offer, the
 * phone's answer, and what is shared (names, sizes, caption). Only these few lines go through here: the files go
 * straight from one browser to the other. A share lasts 10 minutes. Without a database (local dev): in memory.
 */
const url = process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL;
const sql = url ? neon(url) : null;
let ready: Promise<unknown> | null = null;
const ensure = () =>
  (ready ??= sql!`CREATE TABLE IF NOT EXISTS share_sessions (
    code text PRIMARY KEY,
    email text NOT NULL,
    offer text NOT NULL,
    answer text,
    meta jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);

export const SHARE_MINUTES = 10;
export interface ShareMeta { kind: "video" | "images"; title: string; caption?: string; files: { name: string; size: number; type: string }[]; drive?: { name: string; id: string }[] }
export interface ShareRow { offer: string; answer: string | null; meta: ShareMeta }

const mem = ((globalThis as any).__shares ??= new Map<string, ShareRow & { email: string; at: number }>()) as Map<string, ShareRow & { email: string; at: number }>;
const fresh = (at: number) => Date.now() - at < SHARE_MINUTES * 60_000;

export async function createShare(email: string, offer: string, meta: ShareMeta): Promise<string> {
  const code = randomBytes(12).toString("base64url"); // unguessable: the QR code is the only way to it
  if (sql) {
    await ensure();
    await sql`DELETE FROM share_sessions WHERE created_at < now() - make_interval(mins => ${SHARE_MINUTES})`;
    await sql`INSERT INTO share_sessions (code, email, offer, meta) VALUES (${code}, ${email}, ${offer}, ${JSON.stringify(meta)}::jsonb)`;
  } else {
    for (const [k, v] of mem) if (!fresh(v.at)) mem.delete(k);
    mem.set(code, { email, offer, answer: null, meta, at: Date.now() });
  }
  return code;
}

export async function getShare(code: string): Promise<ShareRow | null> {
  if (sql) {
    await ensure();
    const rows = await sql`SELECT offer, answer, meta FROM share_sessions WHERE code = ${code} AND created_at > now() - make_interval(mins => ${SHARE_MINUTES})`;
    return (rows[0] as ShareRow | undefined) ?? null;
  }
  const r = mem.get(code);
  return r && fresh(r.at) ? { offer: r.offer, answer: r.answer, meta: r.meta } : null;
}

/** The phone's answer, once (a second phone cannot take the share over). */
export async function answerShare(code: string, answer: string): Promise<boolean> {
  if (sql) {
    await ensure();
    const rows = await sql`UPDATE share_sessions SET answer = ${answer} WHERE code = ${code} AND answer IS NULL AND created_at > now() - make_interval(mins => ${SHARE_MINUTES}) RETURNING code`;
    return rows.length > 0;
  }
  const r = mem.get(code);
  if (!r || r.answer !== null || !fresh(r.at)) return false;
  r.answer = answer;
  return true;
}

/** The files put on the owner's Drive when the direct link could not be made (plan B). */
export async function setShareDrive(code: string, email: string, drive: { name: string; id: string }[]): Promise<boolean> {
  if (sql) {
    await ensure();
    const rows = await sql`UPDATE share_sessions SET meta = jsonb_set(meta, '{drive}', ${JSON.stringify(drive)}::jsonb) WHERE code = ${code} AND email = ${email} RETURNING code`;
    return rows.length > 0;
  }
  const r = mem.get(code);
  if (!r || r.email !== email) return false;
  r.meta = { ...r.meta, drive };
  return true;
}
