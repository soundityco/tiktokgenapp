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

const file = path.join(process.cwd(), ".data", "workspaces.json");
const readAll = async (): Promise<Record<string, unknown>> => {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return {}; }
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

export async function saveWorkspace(email: string, data: unknown): Promise<void> {
  if (sql) {
    await ensure();
    await sql`INSERT INTO workspaces (email, data, updated_at) VALUES (${email}, ${JSON.stringify(data)}::jsonb, now())
      ON CONFLICT (email) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`;
    return;
  }
  if (process.env.NODE_ENV === "production") throw new Error("DATABASE_URL is not set (see README)");
  const all = await readAll();
  all[email] = data;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(all));
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
const ttFile = path.join(process.cwd(), ".data", "tiktok.json");
const readTT = async (): Promise<Record<string, TikTokTokens>> => {
  try { return JSON.parse(await fs.readFile(ttFile, "utf8")); } catch { return {}; }
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
  await fs.mkdir(path.dirname(ttFile), { recursive: true });
  await fs.writeFile(ttFile, JSON.stringify(all));
}
