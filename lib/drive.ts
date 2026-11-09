import { isDemo } from "./demo";
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
  if (isDemo()) return false; // demo: nothing goes to the Drive
  const s: any = await getSession();
  return typeof s?.scope === "string" && s.scope.includes("auth/drive.file");
}

const FOLDER_KEY = "tktgen-drive-folder";

let folderAsk: Promise<string> | null = null;
/**
 * The "Rollout" folder at the root of the user's Drive, made the first time. One lookup at a time: several
 * uploads starting together (fonts, audio, LUT on a first visit) would otherwise each make their own folder.
 */
function appFolder(): Promise<string> {
  folderAsk ??= findOrMakeFolder().finally(() => { folderAsk = null; });
  return folderAsk;
}
async function findOrMakeFolder(): Promise<string> {
  try {
    const known = localStorage.getItem(FOLDER_KEY);
    if (known) {
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${known}?fields=id,trashed,name`, { headers: { Authorization: `Bearer ${await getToken()}` } });
      const f = res.ok ? await res.json() : null;
      if (f && !f.trashed) {
        // The folder of the TkTgen days: it takes the app's new name.
        if (f.name === "TkTgen") {
          await fetch(`https://www.googleapis.com/drive/v3/files/${known}`, {
            method: "PATCH", headers: { Authorization: `Bearer ${await getToken()}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Rollout" }),
          }).catch(() => { /* keeps its old name: still found by its id */ });
        }
        return known;
      }
    }
  } catch { /* look it up again */ }
  const folder = async (name: string) => {
    const q = `name = '${name}' and mimeType = 'application/vnd.google-apps.folder' and 'root' in parents and trashed = false`;
    const found = await (await api(`https://www.googleapis.com/drive/v3/files?${new URLSearchParams({ q, fields: "files(id)", pageSize: "1" })}`)).json();
    return found.files?.[0]?.id as string | undefined;
  };
  let id = await folder("Rollout");
  if (!id) {
    // Made when the app was called TkTgen: renamed, so its photos, fonts, LUTs and videos stay found.
    id = await folder("TkTgen");
    if (id) {
      await fetch(`https://www.googleapis.com/drive/v3/files/${id}`, {
        method: "PATCH", headers: { Authorization: `Bearer ${await getToken()}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Rollout" }),
      }).catch(() => { /* keeps its old name: still found by its id */ });
    }
  }
  if (!id) {
    const res = await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
      method: "POST",
      headers: { Authorization: `Bearer ${await getToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Rollout", mimeType: "application/vnd.google-apps.folder" }),
    });
    if (res.status === 401) signalAuth();
    if (!res.ok) throw new Error(`Google Drive error ${res.status}`);
    id = (await res.json()).id as string;
  }
  try { localStorage.setItem(FOLDER_KEY, id); } catch { /* private mode */ }
  return id;
}

// ---- The Rollout tree: everything the app puts in the Drive has its place ----
//   Rollout / Photos / <photo list>
//   Rollout / Releases / <release> / Audios, Videos
//   Rollout / Utils / LUTS, Fonts
export const DRIVE_PATHS = {
  photos: ["Photos"],
  photoList: (list: string) => ["Photos", list],
  /** A photo list of one release only: inside its release. */
  releasePhotos: (release: string, list: string) => ["Releases", release, "Photos", list],
  releases: ["Releases"],
  audios: (release: string) => ["Releases", release, "Audios"],
  videos: (release: string) => ["Releases", release, "Videos"],
  luts: ["Utils", "LUTS"],
  fonts: ["Utils", "Fonts"],
};
const TREE_KEY = "tktgen-drive-tree";
/** A folder name as Drive keeps it (no slash; never empty). */
export const folderName = (n: string) => n.replace(/[\\/]+/g, "-").trim() || "Untitled";
const quote = (n: string) => n.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const readTree = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(TREE_KEY) ?? "{}"); } catch { return {}; } };
const writeTree = (t: Record<string, string>) => { try { localStorage.setItem(TREE_KEY, JSON.stringify(t)); } catch { /* private mode */ } };
const checked = new Set<string>();
const treeAsk = new Map<string, Promise<string>>();

/** The folder `name` inside `parent`: found (the oldest one) or made. */
async function childFolder(parent: string, name: string): Promise<string> {
  const q = `name = '${quote(name)}' and mimeType = 'application/vnd.google-apps.folder' and '${parent}' in parents and trashed = false`;
  const found = await (await api(`https://www.googleapis.com/drive/v3/files?${new URLSearchParams({ q, fields: "files(id)", orderBy: "createdTime", pageSize: "1" })}`)).json();
  if (found.files?.[0]?.id) return found.files[0].id as string;
  const res = await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    headers: { Authorization: `Bearer ${await getToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parent] }),
  });
  if (res.status === 401) signalAuth();
  if (!res.ok) throw new Error(`Google Drive error ${res.status}`);
  return (await res.json()).id as string;
}

/** A folder of the Rollout tree (e.g. ["Releases", "Merci", "Audios"]), made on the way when missing. */
export function driveFolder(path: string[]): Promise<string> {
  const names = path.map(folderName);
  const key = names.join("/");
  let ask = treeAsk.get(key);
  if (!ask) {
    ask = (async () => {
      const tree = readTree();
      const known = tree[key];
      if (known && checked.has(key)) return known;
      if (known) {
        // Still there (not trashed, not deleted by hand)? Checked once per visit.
        const r = await fetch(`https://www.googleapis.com/drive/v3/files/${known}?fields=id,trashed`, { headers: { Authorization: `Bearer ${await getToken()}` } }).catch(() => null);
        const f = r?.ok ? await r.json() : null;
        if (f && !f.trashed) { checked.add(key); return known; }
      }
      const parent = names.length > 1 ? await driveFolder(names.slice(0, -1)) : await appFolder();
      const id = await childFolder(parent, names[names.length - 1]);
      writeTree({ ...readTree(), [key]: id });
      checked.add(key);
      return id;
    })().finally(() => treeAsk.delete(key));
    treeAsk.set(key, ask);
  }
  return ask;
}

/** The tree's fixed folders, made when Google is connected (Photos, Releases, Utils / LUTS, Fonts). */
export async function ensureDriveTree(): Promise<void> {
  if (isDemo() || !(await canWriteDrive())) return;
  for (const p of [DRIVE_PATHS.photos, DRIVE_PATHS.releases, DRIVE_PATHS.luts, DRIVE_PATHS.fonts]) await driveFolder(p);
}

/** A list or a release renamed: its folder takes the new name (what is in it stays). Never throws. */
export async function renameDriveFolder(path: string[], newName: string): Promise<void> {
  if (isDemo()) return;
  const names = path.map(folderName);
  const key = names.join("/");
  const id = readTree()[key];
  if (!id || folderName(newName) === names[names.length - 1]) return;
  try {
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}`, {
      method: "PATCH", headers: { Authorization: `Bearer ${await getToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: folderName(newName) }),
    });
    if (!r.ok) return;
    // Its place in the tree (and its sub-folders') under the new name.
    const tree = readTree();
    const to = [...names.slice(0, -1), folderName(newName)].join("/");
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(tree)) next[k === key || k.startsWith(key + "/") ? to + k.slice(key.length) : k] = v;
    writeTree(next);
    checked.clear();
  } catch { /* keeps its old name: found again by its id */ }
}

/**
 * The files the app put loose in the Rollout folder before the tree existed go to their folder: `place` says
 * where each one belongs (null: left where it is). Once per device; never throws.
 */
export async function tidyDriveRoot(place: (f: AppFile) => string[] | null): Promise<number> {
  const KEY = "tktgen-drive-tidy-v1";
  if (isDemo() || !(await canWriteDrive())) return 0;
  try { if (localStorage.getItem(KEY)) return 0; } catch { /* private mode */ }
  let moved = 0;
  try {
    const root = await appFolder();
    let page: string | undefined;
    const loose: AppFile[] = [];
    do {
      const params = new URLSearchParams({ q: `'${root}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`, fields: "nextPageToken, files(id,name,mimeType,size,appProperties)", pageSize: "1000" });
      if (page) params.set("pageToken", page);
      const j = await (await api(`https://www.googleapis.com/drive/v3/files?${params}`)).json();
      for (const f of j.files ?? []) loose.push({ id: f.id, name: f.name ?? "", mimeType: f.mimeType ?? "", size: Number(f.size ?? 0), appProperties: f.appProperties });
      page = j.nextPageToken;
    } while (page);
    for (const f of loose) {
      const path = place(f);
      if (!path) continue;
      try { await moveToDriveFolder(f.id, path, root); moved++; } catch (e) { console.warn("[drive] tidy", f.name, e); }
    }
    try { localStorage.setItem(KEY, "1"); } catch { /* private mode */ }
  } catch (e) { console.warn("[drive] tidy", e); }
  return moved;
}

/**
 * A folder of the tree goes to another place (a photo list made shared or kept to one release) and/or takes another
 * name: moved, what is in it with it. Nothing to do if it was never made. Never throws.
 */
export async function moveDriveFolder(from: string[], to: string[]): Promise<void> {
  if (isDemo()) return;
  const a = from.map(folderName), b = to.map(folderName);
  const ka = a.join("/"), kb = b.join("/");
  if (ka === kb) return;
  const id = readTree()[ka];
  if (!id) return;
  try {
    const oldParent = a.length > 1 ? await driveFolder(a.slice(0, -1)) : await appFolder();
    const newParent = b.length > 1 ? await driveFolder(b.slice(0, -1)) : await appFolder();
    const params = new URLSearchParams({ fields: "id" });
    if (oldParent !== newParent) { params.set("addParents", newParent); params.set("removeParents", oldParent); }
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?${params}`, {
      method: "PATCH", headers: { Authorization: `Bearer ${await getToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: b[b.length - 1] }),
    });
    if (!r.ok) return;
    const tree = readTree();
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(tree)) next[k === ka || k.startsWith(ka + "/") ? kb + k.slice(ka.length) : k] = v;
    writeTree(next);
    checked.clear();
  } catch { /* stays where it was: found again by its id */ }
}

/** Move a file the app made into a folder of the tree (from wherever it is). */
export async function moveToDriveFolder(id: string, path: string[], from: string): Promise<void> {
  const to = await driveFolder(path);
  if (to === from) return;
  await fetch(`https://www.googleapis.com/drive/v3/files/${id}?${new URLSearchParams({ addParents: to, removeParents: from, fields: "id" })}`, {
    method: "PATCH", headers: { Authorization: `Bearer ${await getToken()}`, "Content-Type": "application/json" }, body: "{}",
  });
}

/**
 * Upload a file to the Rollout folder of the user's Drive, in pieces (resumable upload): big camera files
 * go through, a network hiccup retries the piece. Returns the Drive file id.
 */
export async function uploadToDrive(blob: Blob, name: string, onProgress: (p: number) => void, signal: AbortSignal, mime?: string,
  /** Private labels of the app on the file (what it is), to find it again from another browser. */
  appProperties?: Record<string, string>,
  /** Its folder in the Rollout tree (DRIVE_PATHS); the Rollout folder itself without one. */
  folderPath?: string[]): Promise<string> {
  if (isDemo()) throw new Error("Demo mode: nothing is saved to your Drive.");
  const folder = folderPath ? await driveFolder(folderPath) : await appFolder();
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
    body: JSON.stringify({ name, parents: [folder], ...(appProperties ? { appProperties } : {}) }),
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

/** Files the app put in the Rollout folder with this label (see uploadToDrive), with their labels. */
/** The Drive's space: used and limit (no limit: an unlimited plan), in bytes. */
export async function driveQuota(): Promise<{ used: number; limit: number | null }> {
  const r = await fetch("https://www.googleapis.com/drive/v3/about?fields=storageQuota", { headers: { Authorization: `Bearer ${await getToken()}` } });
  if (!r.ok) throw new Error(`about ${r.status}`);
  const q = (await r.json()).storageQuota ?? {};
  return { used: Number(q.usage ?? 0), limit: q.limit ? Number(q.limit) : null };
}

export interface AppFile { id: string; name: string; mimeType: string; size: number; appProperties?: Record<string, string> }
/** Every file in the app's Drive folder (what Rollout put there), with its size. */
export async function listAppFolder(): Promise<AppFile[]> {
  // The whole tree: Rollout and every folder under it (Photos / …, Releases / … / Audios, Videos, Utils / …).
  const out: AppFile[] = [];
  const folders = [await appFolder()];
  for (let i = 0; i < folders.length && i < 400; i++) {
    let page: string | undefined;
    do {
      const params = new URLSearchParams({ q: `'${folders[i]}' in parents and trashed = false`, fields: "nextPageToken, files(id,name,mimeType,size,appProperties)", pageSize: "1000" });
      if (page) params.set("pageToken", page);
      const r = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${await getToken()}` } });
      if (!r.ok) throw new Error(`list ${r.status}`);
      const j = await r.json();
      for (const f of j.files ?? []) {
        if (f.mimeType === "application/vnd.google-apps.folder") folders.push(f.id);
        else out.push({ id: f.id, name: f.name ?? "", mimeType: f.mimeType ?? "", size: Number(f.size ?? 0), appProperties: f.appProperties });
      }
      page = j.nextPageToken;
    } while (page);
  }
  return out;
}

/** Delete a file the app made (a copy replaced or of a video removed). Never throws. */
export async function deleteDriveFile(id: string): Promise<void> {
  if (isDemo()) return;
  try {
    await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true`, { method: "DELETE", headers: { Authorization: `Bearer ${await getToken()}` } });
  } catch (e) { console.warn("[drive] delete failed", e); }
}

export async function listAppFiles(kind: string): Promise<{ id: string; name: string; appProperties: Record<string, string>; md5Checksum?: string; size?: string }[]> {
  // Anywhere in the Rollout tree (the labels are the app's own: only its files have them).
  const q = `appProperties has { key='tktgen' and value='${kind}' } and trashed = false`;
  const out: { id: string; name: string; appProperties: Record<string, string>; md5Checksum?: string; size?: string }[] = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({ q, fields: "nextPageToken, files(id,name,appProperties,md5Checksum,size)", pageSize: "1000" });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await (await api(`https://www.googleapis.com/drive/v3/files?${params}`)).json();
    out.push(...(data.files ?? []));
    pageToken = data.nextPageToken ?? "";
  } while (pageToken);
  return out;
}

/** A file the app put in the Rollout folder, by its name (newest first). */
export async function findInAppFolder(name: string): Promise<string | null> {
  const q = `name = '${quote(name)}' and trashed = false and ('${await appFolder()}' in parents or '${await driveFolder(DRIVE_PATHS.luts)}' in parents)`;
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

/** A photo found on the web (image search): its id holds its address. */
export const webPicId = (url: string) => `web:${url}`;
export const isWebPic = (id: string) => id.startsWith("web:");

/** Download and decode a photo, then keep a copy on the device. */
async function download(id: string): Promise<ImageBitmap> {
  const res = isWebPic(id)
    ? await fetch(`/api/images/file?u=${encodeURIComponent(id.slice(4))}`).then((r) => { if (!r.ok) throw new Error(`picture ${r.status}`); return r; })
    : await api(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`);
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

/** A picture given by the user (dropped, pasted): kept on this device under its id, as if it had been downloaded. */
export async function keepPicture(id: string, blob: Blob): Promise<void> {
  const bmp = await decodeImage(blob);
  remember(id, Promise.resolve(bmp));
  try {
    await putMedia(DISK + id, await encode(bmp));
    (await diskIds()).add(id);
    touch(id);
  } catch { /* storage full: shown for this visit only */ }
}

// ---- the same picture already in the Drive (checksum of its bytes, which Drive keeps for every file) ----
const SUMS_KEY = "tktgen-drive-md5";
const readSums = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(SUMS_KEY) ?? "{}"); } catch { return {}; } };

/**
 * A Drive photo with exactly these bytes: in the Rollout folder, or among `ids` (the photos of the lists).
 * The checksums of the list photos are asked once, then kept on this device. Null when none matches.
 */
export async function findSamePicture(blob: Blob, ids: string[]): Promise<string | null> {
  const { md5 } = await import("./md5");
  const sum = md5(new Uint8Array(await blob.arrayBuffer()));
  try {
    const mine = await listAppFiles("photo");
    const hit = mine.find((f) => f.md5Checksum === sum);
    if (hit) return hit.id;
  } catch { /* no Drive folder yet: only the lists are looked at */ }
  const sums = readSums();
  const known = ids.find((id) => sums[id] === sum);
  if (known) return known;
  const missing = ids.filter((id) => !(id in sums) && !id.includes(":")).slice(0, 400);
  let found: string | null = null;
  for (let i = 0; i < missing.length && !found; i += 6) {
    await Promise.all(missing.slice(i, i + 6).map(async (id) => {
      try {
        const m = await (await api(`https://www.googleapis.com/drive/v3/files/${id}?fields=md5Checksum&supportsAllDrives=true`)).json();
        sums[id] = m.md5Checksum ?? "";
        if (m.md5Checksum === sum) found = id;
      } catch { sums[id] = ""; }
    }));
  }
  try { localStorage.setItem(SUMS_KEY, JSON.stringify(sums)); } catch { /* storage full */ }
  return found;
}

/** Put a picture in the Rollout folder of the user's Drive; returns its Drive id (a photo of any list). */
export async function sendPictureToDrive(blob: Blob, name: string, path?: string[]): Promise<string> {
  return uploadToDrive(blob, name, () => {}, new AbortController().signal, blob.type || "image/jpeg", { tktgen: "photo" }, path ?? DRIVE_PATHS.photos);
}

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
  // (A bounded loop: a worker with nothing to do ends at once, so "while (workers < 2)" never stopped on an empty list.)
  for (let n = 2 - workers; n > 0 && wanted.length; n--) {
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
