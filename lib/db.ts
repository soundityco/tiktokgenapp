import { neon } from "@neondatabase/serverless";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
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

// ---- Version history: a copy of the workspace at most every 10 minutes, the last 30 kept ----
const HISTORY_EVERY_MIN = 10;
const HISTORY_KEEP = 30;
let readyH: Promise<unknown> | null = null;
const ensureH = () =>
  (readyH ??= sql!`CREATE TABLE IF NOT EXISTS workspace_history (
    id bigserial PRIMARY KEY,
    email text NOT NULL,
    rev int NOT NULL,
    data jsonb NOT NULL,
    saved_at timestamptz NOT NULL DEFAULT now()
  )`.then(() => sql!`CREATE INDEX IF NOT EXISTS workspace_history_email ON workspace_history (email, saved_at DESC)`));

export interface VersionInfo { id: string; rev: number; savedAt: string; projects: number }

const histFile = () => path.join(process.cwd(), ".data", "history.json");
type LocalVersion = { id: string; rev: number; savedAt: string; data: any };
const readHist = async (): Promise<Record<string, LocalVersion[]>> => {
  try { return JSON.parse(await fs.readFile(histFile(), "utf8")); } catch { return {}; }
};

/** Keep a copy of what was just saved, unless the last copy is recent. Never makes the save fail. */
async function snapshot(email: string, data: any) {
  try {
    if (sql) {
      await ensureH();
      const json = JSON.stringify(data);
      await sql`INSERT INTO workspace_history (email, rev, data)
        SELECT ${email}, ${data.rev}, ${json}::jsonb
        WHERE NOT EXISTS (SELECT 1 FROM workspace_history WHERE email = ${email}
          AND saved_at > now() - make_interval(mins => ${HISTORY_EVERY_MIN}))`;
      await sql`DELETE FROM workspace_history WHERE email = ${email} AND id NOT IN (
        SELECT id FROM workspace_history WHERE email = ${email} ORDER BY saved_at DESC LIMIT ${HISTORY_KEEP})`;
      return;
    }
    const all = await readHist();
    const list = all[email] ?? [];
    const last = list[list.length - 1];
    if (last && Date.now() - Date.parse(last.savedAt) < HISTORY_EVERY_MIN * 60_000) return;
    list.push({ id: String(Date.now()), rev: data.rev, savedAt: new Date().toISOString(), data });
    all[email] = list.slice(-HISTORY_KEEP);
    await fs.mkdir(path.dirname(histFile()), { recursive: true });
    await fs.writeFile(histFile(), JSON.stringify(all));
  } catch (e) {
    console.error("workspace snapshot failed", e);
  }
}

/** The kept versions, most recent first. */
export async function listVersions(email: string): Promise<VersionInfo[]> {
  if (sql) {
    await ensureH();
    const rows = await sql`SELECT id, rev, saved_at, jsonb_array_length(data->'projects') AS projects
      FROM workspace_history WHERE email = ${email} ORDER BY saved_at DESC`;
    return rows.map((r: any) => ({ id: String(r.id), rev: Number(r.rev), savedAt: new Date(r.saved_at).toISOString(), projects: Number(r.projects ?? 0) }));
  }
  if (process.env.NODE_ENV === "production") throw new Error("DATABASE_URL is not set (see README)");
  return ((await readHist())[email] ?? []).slice().reverse()
    .map((v) => ({ id: v.id, rev: v.rev, savedAt: v.savedAt, projects: v.data?.projects?.length ?? 0 }));
}

/** One kept version (only the user's own: the email is part of the lookup). */
export async function loadVersion(email: string, id: string): Promise<unknown | null> {
  if (sql) {
    if (!/^\d+$/.test(id)) return null;
    await ensureH();
    const rows = await sql`SELECT data FROM workspace_history WHERE email = ${email} AND id = ${id}`;
    return rows[0]?.data ?? null;
  }
  return ((await readHist())[email] ?? []).find((v) => v.id === id)?.data ?? null;
}

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
    if (upd.length) { await snapshot(email, next); return { ok: true, rev: next.rev }; }
    const ins = await sql`INSERT INTO workspaces (email, data) VALUES (${email}, ${json}::jsonb)
      ON CONFLICT (email) DO NOTHING RETURNING email`;
    if (ins.length) { await snapshot(email, next); return { ok: true, rev: next.rev }; }
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
  await snapshot(email, next);
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

/**
 * TikTok tokens are stored encrypted (AES-256-GCM, key derived from AUTH_SECRET): a leak of the
 * database alone does not give access to anyone's TikTok account. Changing AUTH_SECRET makes them
 * unreadable: the user just connects TikTok again.
 */
const tokenKey = () => {
  const secret = process.env.AUTH_SECRET;
  return secret ? createHash("sha256").update(`tktgen:tiktok-tokens:${secret}`).digest() : null;
};
export function sealTokens(t: TikTokTokens): unknown {
  const key = tokenKey();
  if (!key) {
    if (process.env.NODE_ENV === "production") throw new Error("AUTH_SECRET is not set");
    return t; // local development without a secret
  }
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(JSON.stringify(t), "utf8"), c.final()]);
  return { sealed: Buffer.concat([iv, c.getAuthTag(), body]).toString("base64") };
}
export function openTokens(d: any): { tokens: TikTokTokens | null; legacy: boolean } {
  if (!d) return { tokens: null, legacy: false };
  if (typeof d.sealed !== "string") return { tokens: d as TikTokTokens, legacy: !!tokenKey() }; // saved before encryption
  const key = tokenKey();
  if (!key) return { tokens: null, legacy: false };
  try {
    const buf = Buffer.from(d.sealed, "base64");
    const dc = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
    dc.setAuthTag(buf.subarray(12, 28));
    const json = Buffer.concat([dc.update(buf.subarray(28)), dc.final()]).toString("utf8");
    return { tokens: JSON.parse(json), legacy: false };
  } catch {
    return { tokens: null, legacy: false }; // other secret, or tampered with
  }
}

let readyTT: Promise<unknown> | null = null;
const ensureTT = () =>
  (readyTT ??= sql!`CREATE TABLE IF NOT EXISTS tiktok_tokens (
    email text PRIMARY KEY,
    data jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
const ttPath = () => path.join(process.cwd(), ".data", "tiktok.json");
const readTT = async (): Promise<Record<string, unknown>> => {
  try { return JSON.parse(await fs.readFile(ttPath(), "utf8")); } catch { return {}; }
};

export async function loadTikTok(email: string): Promise<TikTokTokens | null> {
  let raw: unknown;
  if (sql) {
    await ensureTT();
    const rows = await sql`SELECT data FROM tiktok_tokens WHERE email = ${email}`;
    raw = rows[0]?.data ?? null;
  } else {
    if (process.env.NODE_ENV === "production") throw new Error("DATABASE_URL is not set (see README)");
    raw = (await readTT())[email] ?? null;
  }
  const { tokens, legacy } = openTokens(raw);
  if (tokens && legacy) await saveTikTok(email, tokens); // encrypt the ones saved in clear before
  return tokens;
}

export async function saveTikTok(email: string, t: TikTokTokens | null): Promise<void> {
  if (sql) {
    await ensureTT();
    if (!t) await sql`DELETE FROM tiktok_tokens WHERE email = ${email}`;
    else await sql`INSERT INTO tiktok_tokens (email, data, updated_at) VALUES (${email}, ${JSON.stringify(sealTokens(t))}::jsonb, now())
      ON CONFLICT (email) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`;
    return;
  }
  if (process.env.NODE_ENV === "production") throw new Error("DATABASE_URL is not set (see README)");
  const all = await readTT();
  if (!t) delete all[email]; else all[email] = sealTokens(t);
  await fs.mkdir(path.dirname(ttPath()), { recursive: true });
  await fs.writeFile(ttPath(), JSON.stringify(all));
}
