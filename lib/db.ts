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
