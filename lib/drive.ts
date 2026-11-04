import { getSession } from "next-auth/react";
import { decodeImage, looksLikeImage } from "./imageFormat";
import type { Img } from "./render";
import { delMedia, getMedia, listMedia, putMedia } from "./idb";
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

export interface DriveItem { id: string; name: string; mimeType: string; thumbnailLink?: string }
export const isFolder = (i: DriveItem) => i.mimeType === "application/vnd.google-apps.folder";
export const isImage = (i: DriveItem) => !isFolder(i) && looksLikeImage(i.name, i.mimeType);
export const isAudio = (i: DriveItem) =>
  !isFolder(i) && (i.mimeType.startsWith("audio/") || /\.(mp3|wav|m4a|aac|flac|ogg|opus|aiff?)$/i.test(i.name));
/** What a Drive listing keeps besides folders: photos (carousel) or audio files (official audio of a release). */
export type DriveKind = "images" | "audio";
const keep = (kind: DriveKind) => (i: DriveItem) => isFolder(i) || (kind === "audio" ? isAudio(i) : isImage(i));

/** Thumbnail links seen while listing folders: spares one request per thumbnail (see lib/thumb.ts). */
export const thumbLinks = new Map<string, string>();
const keepThumbs = (files: DriveItem[]) => files.forEach((f) => f.thumbnailLink && thumbLinks.set(f.id, f.thumbnailLink));

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Drive request. Rate limits (429, 403 "rate limit") and server errors are retried with exponential backoff. */
async function api(url: string) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${await getToken()}` } });
    if (res.status === 401) signalAuth();
    if (res.ok) return res;
    const limited = res.status === 429 || res.status >= 500 ||
      (res.status === 403 && /rate|quota/i.test(await res.clone().text().catch(() => "")));
    if (!limited || attempt >= 4) throw new Error(`Google Drive error ${res.status}`);
    await wait(2 ** attempt * 1000 + Math.random() * 500);
  }
}

/** List a folder ("root", a folder id, or "shared" for "Shared with me"). Folders first, then images. */
export async function listFolder(folder: string, kind: DriveKind = "images"): Promise<DriveItem[]> {
  const q =
    folder === "shared"
      ? "sharedWithMe = true and trashed = false"
      : `'${folder}' in parents and trashed = false`;
  const items: DriveItem[] = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      q,
      fields: "nextPageToken, files(id,name,mimeType,thumbnailLink)",
      pageSize: "1000",
      orderBy: "folder,name_natural",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await (await api(`https://www.googleapis.com/drive/v3/files?${params}`)).json();
    items.push(...(data.files ?? []));
    keepThumbs(data.files ?? []);
    pageToken = data.nextPageToken ?? "";
  } while (pageToken);
  return items.filter(keep(kind));
}

/** Search the whole Drive by name (folders and supported images). */
export async function searchDrive(query: string, kind: DriveKind = "images"): Promise<DriveItem[]> {
  const q = `trashed = false and name contains '${query.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  const items: DriveItem[] = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      q,
      fields: "nextPageToken, files(id,name,mimeType,thumbnailLink)",
      pageSize: "200",
      orderBy: "folder,name_natural",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await (await api(`https://www.googleapis.com/drive/v3/files?${params}`)).json();
    items.push(...(data.files ?? []));
    keepThumbs(data.files ?? []);
    pageToken = data.nextPageToken ?? "";
  } while (pageToken);
  return items.filter(keep(kind));
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

/** Download a Drive file as it is (the official audio of a release). */
export async function downloadDriveFile(id: string): Promise<Blob> {
  return (await api(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`)).blob();
}

// ---- Device cache: photos already downloaded stay in IndexedDB (downscaled, as JPEG) ----
const DISK = "pic:";
const DISK_MAX = 300;
const LRU_KEY = "tktgen-pic-lru";
let onDisk: Promise<Set<string>> | null = null;
const diskIds = () => (onDisk ??= listMedia(DISK).then((keys) => new Set(keys.map((k) => k.slice(DISK.length)))));

const readLru = (): string[] => {
  try { return JSON.parse(localStorage.getItem(LRU_KEY) ?? "[]"); } catch { return []; }
};
/** Mark a photo as just used; the least recently used ones are dropped beyond DISK_MAX. */
function touch(id: string) {
  const lru = readLru().filter((x) => x !== id);
  lru.push(id);
  for (const old of lru.splice(0, Math.max(0, lru.length - DISK_MAX))) {
    void delMedia(DISK + old);
    void diskIds().then((d) => d.delete(old));
  }
  try { localStorage.setItem(LRU_KEY, JSON.stringify(lru)); } catch { /* private mode */ }
}

async function encode(bmp: ImageBitmap): Promise<Blob> {
  if (typeof OffscreenCanvas !== "undefined") {
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext("2d")!.drawImage(bmp, 0, 0);
    return c.convertToBlob({ type: "image/jpeg", quality: 0.9 });
  }
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext("2d")!.drawImage(bmp, 0, 0);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("encode"))), "image/jpeg", 0.9));
}

async function fromDisk(id: string): Promise<ImageBitmap | null> {
  if (!(await diskIds()).has(id)) return null;
  const blob = await getMedia(DISK + id);
  if (!blob) return null;
  try { touch(id); return await createImageBitmap(blob); } catch { return null; }
}

/** Download and decode a photo, then keep a copy on the device. */
async function download(id: string): Promise<ImageBitmap> {
  const res = await api(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`);
  const bmp = await decodeImage(await res.blob());
  void encode(bmp)
    .then((b) => putMedia(DISK + id, b))
    .then(async () => { (await diskIds()).add(id); touch(id); })
    .catch(() => { /* storage full or unavailable: the photo is just downloaded again next time */ });
  return bmp;
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
      const saved = await fromDisk(id);
      if (saved) return saved;
      await slot();
      try {
        return await download(id);
      } finally {
        release();
      }
    })();
    p.catch(() => cache.delete(id));
    remember(id, p);
  }
  return p;
}

// ---- Background prefetch: photos likely to be drawn next are downloaded ahead of time ----
let wanted: string[] = [];
let workers = 0;
const idle = () => new Promise<void>((r) => setTimeout(r, 300));

/** Replace the wish list of photos to have on the device. Visible photos always load first. */
export function prefetchDriveImages(ids: string[]) {
  if ((navigator as any).connection?.saveData) return;
  wanted = [...ids];
  while (workers < 2) {
    workers++;
    void (async () => {
      try {
        while (wanted.length) {
          if (active > 0) { await idle(); continue; } // a slide is waiting for its photo
          const id = wanted.shift()!;
          if (cache.has(id) || (await diskIds()).has(id)) continue;
          try { (await download(id)).close(); }
          catch (e) { if (/expired|40[13]/.test(String(e))) wanted = []; } // signed out: stop, a missing file: skip
        }
      } finally {
        workers--;
      }
    })();
  }
}
