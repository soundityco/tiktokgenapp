import { getSession } from "next-auth/react";
import { decodeImage, looksLikeImage } from "./imageFormat";
import type { Img } from "./render";
import type { PicRef } from "./types";

/** Emitted when Google Drive rejects the session, so the studio can offer a reconnect. */
export const DRIVE_AUTH_EVENT = "tktgen:drive-auth";
const signalAuth = () => {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(DRIVE_AUTH_EVENT));
};

let cached: { token: string; exp: number } | null = null;

export async function getToken(): Promise<string> {
  if (cached && Date.now() / 1000 < cached.exp - 120) return cached.token;
  const s: any = await getSession();
  if (!s?.accessToken || s.error) {
    signalAuth();
    throw new Error("Google session expired. Sign in again.");
  }
  cached = { token: s.accessToken, exp: s.expiresAt ?? Date.now() / 1000 + 600 };
  return cached.token;
}

export interface DriveItem { id: string; name: string; mimeType: string }
export const isFolder = (i: DriveItem) => i.mimeType === "application/vnd.google-apps.folder";
export const isImage = (i: DriveItem) => !isFolder(i) && looksLikeImage(i.name, i.mimeType);

async function api(url: string) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await getToken()}` } });
  if (res.status === 401) signalAuth();
  if (!res.ok) throw new Error(`Google Drive error ${res.status}`);
  return res;
}

/** List a folder ("root", a folder id, or "shared" for "Shared with me"). Folders first, then images. */
export async function listFolder(folder: string): Promise<DriveItem[]> {
  const q =
    folder === "shared"
      ? "sharedWithMe = true and trashed = false"
      : `'${folder}' in parents and trashed = false`;
  const items: DriveItem[] = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      q,
      fields: "nextPageToken, files(id,name,mimeType)",
      pageSize: "1000",
      orderBy: "folder,name_natural",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await (await api(`https://www.googleapis.com/drive/v3/files?${params}`)).json();
    items.push(...(data.files ?? []));
    pageToken = data.nextPageToken ?? "";
  } while (pageToken);
  return items.filter((i) => isFolder(i) || isImage(i));
}

/** Search the whole Drive by name (folders and supported images). */
export async function searchDrive(query: string): Promise<DriveItem[]> {
  const q = `trashed = false and name contains '${query.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  const items: DriveItem[] = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      q,
      fields: "nextPageToken, files(id,name,mimeType)",
      pageSize: "200",
      orderBy: "folder,name_natural",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await (await api(`https://www.googleapis.com/drive/v3/files?${params}`)).json();
    items.push(...(data.files ?? []));
    pageToken = data.nextPageToken ?? "";
  } while (pageToken);
  return items.filter((i) => isFolder(i) || isImage(i));
}

/**
 * Bring a list up to date with one of its linked folders: photos new in the folder are appended,
 * photos that came from it and are gone (deleted, moved) are dropped. Photos added by hand are kept.
 * Returns the same array when nothing changed.
 */
export function mergeFolder(pics: PicRef[], folderId: string, listed: DriveItem[], excluded: string[] = []): PicRef[] {
  const inFolder = new Set(listed.map((i) => i.id));
  const kept = pics.filter((p) => p.folder !== folderId || inFolder.has(p.id));
  const have = new Set(kept.map((p) => p.id));
  const skip = new Set(excluded);
  const added = listed
    .filter((i) => isImage(i) && !have.has(i.id) && !skip.has(i.id))
    .map((i): PicRef => ({ id: i.id, name: i.name, folder: folderId }));
  return kept.length === pics.length && !added.length ? pics : [...kept, ...added];
}

// ---- Image cache (decoded, downscaled to max 2400px) with limited concurrency ----
const MAX_IMAGES = 24;
const cache = new Map<string, Promise<Img>>();
const remember = (id: string, p: Promise<Img>) => {
  cache.set(id, p);
  if (cache.size <= MAX_IMAGES) return;
  for (const key of cache.keys()) {
    if (key !== id) { cache.delete(key); break; }
  }
};
let active = 0;
const queue: (() => void)[] = [];
const slot = () => new Promise<void>((r) => (active < 4 ? (active++, r()) : queue.push(() => (active++, r()))));
const release = () => { active--; queue.shift()?.(); };

export function loadDriveImage(id: string): Promise<Img> {
  let p = cache.get(id);
  if (!p) {
    p = (async () => {
      await slot();
      try {
        const res = await api(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`);
        return await decodeImage(await res.blob());
      } finally {
        release();
      }
    })();
    p.catch(() => cache.delete(id));
    remember(id, p);
  }
  return p;
}
