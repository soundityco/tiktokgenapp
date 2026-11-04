import { createHash, randomBytes } from "node:crypto";
import { loadTikTok, saveTikTok, TikTokTokens } from "./db";

// Base URLs can be overridden to run against a local mock in development.
const AUTH_URL = process.env.TIKTOK_AUTH_URL ?? "https://www.tiktok.com/v2/auth/authorize/";
const API = process.env.TIKTOK_API_BASE ?? "https://open.tiktokapis.com";
// Only what we need. Override with TIKTOK_SCOPES if your app lists different scopes.
export const SCOPES = process.env.TIKTOK_SCOPES ?? "user.info.basic,video.list";

export const tiktokConfigured = () => !!process.env.TIKTOK_CLIENT_KEY && !!process.env.TIKTOK_CLIENT_SECRET;

export const redirectUri = (req: Request) =>
  process.env.TIKTOK_REDIRECT_URI ?? `${new URL(req.url).origin}/api/tiktok/callback`;

/**
 * PKCE, required by TikTok's login ("code_challenge" error without it): a random secret kept in a
 * cookie, its SHA-256 sent with the login, the secret itself with the token exchange.
 * TikTok's documentation encodes the hash in hex (not base64url as in RFC 7636): TIKTOK_PKCE_ENCODING
 * can switch to "base64url" if their side changes.
 */
export function pkcePair() {
  const verifier = randomBytes(48).toString("base64url"); // 64 characters, all allowed by RFC 7636
  const hash = createHash("sha256").update(verifier);
  const challenge = process.env.TIKTOK_PKCE_ENCODING === "base64url" ? hash.digest("base64url") : hash.digest("hex");
  return { verifier, challenge };
}

export function authorizeUrl(req: Request, state: string, challenge: string) {
  const p = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY!,
    scope: SCOPES,
    response_type: "code",
    redirect_uri: redirectUri(req),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${AUTH_URL}?${p}`;
}

async function tokenCall(body: Record<string, string>) {
  const res = await fetch(`${API}/v2/oauth/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
    body: new URLSearchParams({ client_key: process.env.TIKTOK_CLIENT_KEY!, client_secret: process.env.TIKTOK_CLIENT_SECRET!, ...body }),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || j.error || !j.access_token) throw new Error(j.error_description || j.error || `TikTok token error ${res.status}`);
  const now = Math.floor(Date.now() / 1000);
  return {
    accessToken: j.access_token as string,
    refreshToken: j.refresh_token as string,
    expiresAt: now + (j.expires_in ?? 86400),
    refreshExpiresAt: now + (j.refresh_expires_in ?? 31536000),
    openId: j.open_id as string | undefined,
  };
}

export const exchangeCode = (req: Request, code: string, verifier: string) =>
  tokenCall({ grant_type: "authorization_code", code, redirect_uri: redirectUri(req), code_verifier: verifier });

/** Return a valid access token for this user, refreshing it when needed. Null if not connected. */
export async function validToken(email: string): Promise<string | null> {
  const t = await loadTikTok(email);
  if (!t) return null;
  const now = Math.floor(Date.now() / 1000);
  if (now < t.expiresAt - 300) return t.accessToken;
  if (now >= t.refreshExpiresAt) { await saveTikTok(email, null); return null; }
  try {
    const r = await tokenCall({ grant_type: "refresh_token", refresh_token: t.refreshToken });
    const next: TikTokTokens = { ...t, ...r, openId: r.openId ?? t.openId };
    await saveTikTok(email, next);
    return next.accessToken;
  } catch {
    await saveTikTok(email, null);
    return null;
  }
}

export async function fetchDisplayName(token: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${API}/v2/user/info/?fields=open_id,display_name`, { headers: { Authorization: `Bearer ${token}` } });
    const j: any = await res.json();
    return j?.data?.user?.display_name;
  } catch { return undefined; }
}

export interface TikTokPost {
  id: string;
  title: string;
  cover: string;
  views: number;
  likes: number;
  created: number;
  url: string;
}

const FIELDS = "id,title,video_description,cover_image_url,view_count,like_count,create_time,share_url";

/** All posts of the connected account (up to `limit`), most recent first, as returned by TikTok. */
export async function listPosts(token: string, limit = 200): Promise<TikTokPost[]> {
  const out: TikTokPost[] = [];
  let cursor: number | undefined;
  while (out.length < limit) {
    const res = await fetch(`${API}/v2/video/list/?fields=${FIELDS}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ max_count: 20, ...(cursor !== undefined ? { cursor } : {}) }),
    });
    const j: any = await res.json().catch(() => ({}));
    const code = j?.error?.code;
    if (!res.ok || (code && code !== "ok")) {
      const e: any = new Error(j?.error?.message || `TikTok error ${res.status}`);
      e.code = code;
      throw e;
    }
    for (const v of j.data?.videos ?? []) {
      out.push({
        id: String(v.id),
        title: v.title || v.video_description || "",
        cover: v.cover_image_url || "",
        views: Number(v.view_count ?? 0),
        likes: Number(v.like_count ?? 0),
        created: Number(v.create_time ?? 0),
        url: v.share_url || "",
      });
    }
    if (!j.data?.has_more) break;
    cursor = j.data.cursor;
  }
  return out;
}

/** Only fetch covers from TikTok's own CDNs (this endpoint is a proxy: never let it reach arbitrary hosts). */
export function coverAllowed(u: URL) {
  if (process.env.NODE_ENV !== "production" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) return true;
  return u.protocol === "https:" && /(^|\.)(tiktokcdn(-[a-z]+)?\.com|tiktok\.com|tiktokv\.com|byteimg\.com|ibyteimg\.com)$/.test(u.hostname);
}
