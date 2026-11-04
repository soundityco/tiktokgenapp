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

// ---- Writing: copies of the camera videos (scope drive.file: only the files the app made) ----

/** Did the user allow the app to create files in their Drive (signed in after drive.file was added)? */
export async function canWriteDrive(): Promise<boolean> {
  const s: any = await getSession();
  return typeof s?.scope === "string" && s.scope.includes("auth/drive.file");
}

const FOLDER_KEY = "tktgen-drive-folder";

/** The "TkTgen" folder at the root of the user's Drive, made the first time. */
async function appFolder(): Promise<string> {
  try {
    const known = localStorage.getItem(FOLDER_KEY);
    if (known) {
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${known}?fields=id,trashed`, { headers: { Authorization: `Bearer ${await getToken()}` } });
      if (res.ok && !(await res.json()).trashed) return known;
    }
  } catch { /* look it up again */ }
  const q = "name = 'TkTgen' and mimeType = 'application/vnd.google-apps.folder' and 'root' in parents and trashed = false";
  const found = await (await api(`https://www.googleapis.com/drive/v3/files?${new URLSearchParams({ q, fields: "files(id)", pageSize: "1" })}`)).json();
  let id: string | undefined = found.files?.[0]?.id;
  if (!id) {
    const res = await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
      method: "POST",
      headers: { Authorization: `Bearer ${await getToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "TkTgen", mimeType: "application/vnd.google-apps.folder" }),
    });
    if (res.status === 401) signalAuth();
    if (!res.ok) throw new Error(`Google Drive error ${res.status}`);
    id = (await res.json()).id as string;
  }
  try { localStorage.setItem(FOLDER_KEY, id); } catch { /* private mode */ }
  return id;
}

/**
 * Upload a file to the TkTgen folder of the user's Drive, in pieces (resumable upload): big camera files
 * go through, a network hiccup retries the piece. Returns the Drive file id.
 */
export async function uploadToDrive(blob: Blob, name: string, onProgress: (p: number) => void, signal: AbortSignal, mime?: string): Promise<string> {
  const folder = await appFolder();
  const type = mime || blob.type || "video/mp4";
  const start = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id", {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${await getToken()}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": type,
      "X-Upload-Content-Length": String(blob.size),
    },
    body: JSON.stringify({ name, parents: [folder] }),
  });
  if (start.status === 401) signalAuth();
  const session = start.headers.get("Location");
  if (!start.ok || !session) throw new Error(`Google Drive error ${start.status}`);
  const PIECE = 32 * 256 * 1024; // 8 MB, a multiple of 256 KB as Drive asks
  for (let at = 0; at < blob.size;) {
    const end = Math.min(blob.size, at + PIECE);
    let res: Response | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        res = await fetch(session, {
          method: "PUT", signal,
          headers: { "Content-Range": `bytes ${at}-${end - 1}/${blob.size}` },
          body: blob.slice(at, end),
        });
        if (res.status < 500) break;
      } catch (e) {
        if (signal.aborted) throw e;
      }
      await wait(2 ** attempt * 1000);
    }
    if (!res) throw new Error("upload interrupted");
    if (res.ok) { onProgress(1); return (await res.json()).id as string; }
    if (res.status !== 308) throw new Error(`Google Drive error ${res.status}`);
    // 308: piece kept. Drive says up to where it has the file, when it lets us read it.
    const range = /bytes=0-(\d+)/.exec(res.headers.get("Range") ?? "");
    at = range ? Number(range[1]) + 1 : end;
    onProgress(at / blob.size);
  }
  throw new Error("upload incomplete");
}

/** A file the app put in the TkTgen folder, by its name (newest first). */
export async function findInAppFolder(name: string): Promise<string | null> {
  const q = `name = '${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' and trashed = false and '${await appFolder()}' in parents`;
  const data = await (await api(`https://www.googleapis.com/drive/v3/files?${new URLSearchParams({ q, fields: "files(id)", orderBy: "modifiedTime desc", pageSize: "1" })}`)).json();
  return data.files?.[0]?.id ?? null;
}

/** Download a Drive file with its progress (big video copies). */
export async function downloadDriveFileProgress(id: string, onProgress: (p: number) => void, signal: AbortSignal): Promise<Blob> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${await getToken()}` }, signal,
  });
  if (res.status === 401) signalAuth();
  if (!res.ok || !res.body) throw new Error(`Google Drive error ${res.status}`);
  const total = Number(res.headers.get("Content-Length")) || 0;
  const reader = res.body.getReader();
  const parts: BlobPart[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value as BlobPart);
    got += value.length;
    if (total) onProgress(got / total);
  }
  return new Blob(parts, { type: res.headers.get("Content-Type") || "video/mp4" });
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
