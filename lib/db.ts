import { neon } from "@neondatabase/serverless";
import { promises as fs } from "fs";
import path from "path";

/**
 * One JSON document per user (their whole workspace: projects, pools, settings).
 * Pictures are NOT stored here: only Google Drive file ids.
 * Without DATABASE_URL (local dev only) a JSON file in .data/ is used instead.
 */
const url = process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL;
const sql = url ? neon(url) : null;
let ready: Promise<unknown> | null = null;

const ensure = () =>
  (ready ??= sql!`CREATE TABLE IF NOT EXISTS workspaces (
    email text PRIMARY KEY,
    data jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);

// Resolved lazily so tests (and tools) can change the working directory.
const dataFile = () => path.join(process.cwd(), ".data", "workspaces.json");
const readAll = async (): Promise<Record<string, unknown>> => {
  try { return JSON.parse(await fs.readFile(dataFile(), "utf8")); } catch { return {}; }
};

export async function loadWorkspace(email: string): Promise<unknown | null> {
  if (sql) {
    await ensure();
    const rows = await sql`SELECT data FROM workspaces WHERE email = ${email}`;
    return rows[0]?.data ?? null;
  }
  if (process.env.NODE_ENV === "production") throw new Error("DATABASE_URL is not set (see README)");
  return (await readAll())[email] ?? null;
}

export type SaveResult = { ok: true; rev: number } | { ok: false; rev: number };

/**
 * Save only if nobody else saved since the client last loaded (compare-and-swap on a revision number).
 * Protects against two tabs/devices silently overwriting each other.
 */
export async function saveWorkspaceCas(email: string, data: any, expectedRev: number): Promise<SaveResult> {
  const next = { ...data, rev: expectedRev + 1 };
  if (sql) {
    await ensure();
    const json = JSON.stringify(next);
    const upd = await sql`UPDATE workspaces SET data = ${json}::jsonb, updated_at = now()
      WHERE email = ${email} AND COALESCE((data->>'rev')::int, 0) = ${expectedRev} RETURNING email`;
    if (upd.length) return { ok: true, rev: next.rev };
    const ins = await sql`INSERT INTO workspaces (email, data) VALUES (${email}, ${json}::jsonb)
      ON CONFLICT (email) DO NOTHING RETURNING email`;
    if (ins.length) return { ok: true, rev: next.rev };
    const cur = await sql`SELECT COALESCE((data->>'rev')::int, 0) AS rev FROM workspaces WHERE email = ${email}`;
    return { ok: false, rev: Number(cur[0]?.rev ?? 0) };
  }
  if (process.env.NODE_ENV === "production") throw new Error("DATABASE_URL is not set (see README)");
  const all: any = await readAll();
  const cur = Number(all[email]?.rev ?? 0);
  if (all[email] && cur !== expectedRev) return { ok: false, rev: cur };
  all[email] = next;
  await fs.mkdir(path.dirname(dataFile()), { recursive: true });
  await fs.writeFile(dataFile(), JSON.stringify(all));
  return { ok: true, rev: next.rev };
}

// ---- TikTok tokens (server side only: the client secret never reaches the browser) ----
export interface TikTokTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch seconds
  refreshExpiresAt: number;
  openId?: string;
  name?: string;
}

let readyTT: Promise<unknown> | null = null;
const ensureTT = () =>
  (readyTT ??= sql!`CREATE TABLE IF NOT EXISTS tiktok_tokens (
    email text PRIMARY KEY,
    data jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
const ttPath = () => path.join(process.cwd(), ".data", "tiktok.json");
const readTT = async (): Promise<Record<string, TikTokTokens>> => {
  try { return JSON.parse(await fs.readFile(ttPath(), "utf8")); } catch { return {}; }
};

export async function loadTikTok(email: string): Promise<TikTokTokens | null> {
  if (sql) {
    await ensureTT();
    const rows = await sql`SELECT data FROM tiktok_tokens WHERE email = ${email}`;
    return (rows[0]?.data as TikTokTokens) ?? null;
  }
  if (process.env.NODE_ENV === "production") throw new Error("DATABASE_URL is not set (see README)");
  return (await readTT())[email] ?? null;
}

export async function saveTikTok(email: string, t: TikTokTokens | null): Promise<void> {
  if (sql) {
    await ensureTT();
    if (!t) await sql`DELETE FROM tiktok_tokens WHERE email = ${email}`;
    else await sql`INSERT INTO tiktok_tokens (email, data, updated_at) VALUES (${email}, ${JSON.stringify(t)}::jsonb, now())
      ON CONFLICT (email) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`;
    return;
  }
  if (process.env.NODE_ENV === "production") throw new Error("DATABASE_URL is not set (see README)");
  const all = await readTT();
  if (!t) delete all[email]; else all[email] = t;
  await fs.mkdir(path.dirname(ttPath()), { recursive: true });
  await fs.writeFile(ttPath(), JSON.stringify(all));
}
