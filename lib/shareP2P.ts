/**
 * Sharing files from the computer to a phone, like AirDrop: the phone scans a QR code, the two browsers connect
 * to each other (WebRTC) and the files go straight through the local network. Only the connection details go
 * through our server (/api/share), never the files.
 */
import type { ShareMeta } from "./shareStore";
import { RELAY_CHUNK, RELAY_MAX, SHARE_MINUTES } from "./shareLimits";
import { safeType } from "./safeFile";

const ICE: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }];
const CHUNK = 64 * 1024;
/** Without a direct link after this long, the share falls back to the Drive. */
export const CONNECT_MS = 15_000;
/** Files up to this size come to the phone through our server when they went through the Drive (see /api/share/file). */
const PROXY_MAX = 4_000_000;

const gather = (pc: RTCPeerConnection) => new Promise<void>((resolve) => {
  if (pc.iceGatheringState === "complete") return resolve();
  const t = setTimeout(resolve, 3500); // enough candidates by then (the local network ones come first)
  pc.addEventListener("icegatheringstatechange", () => { if (pc.iceGatheringState === "complete") { clearTimeout(t); resolve(); } });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type SendState =
  | { step: "opening" }
  | { step: "waiting"; url: string; code: string; relay?: { pct: number } }
  | { step: "connecting"; url: string; code: string }
  | { step: "sending"; pct: number }
  | { step: "done" }
  | { step: "failed"; code?: string; url?: string }
  | { step: "expired" };

const sliceCount = (size: number) => Math.max(1, Math.ceil(size / RELAY_CHUNK));
/** A few slices at once (a server function per slice). */
async function pool(count: number, width: number, job: (k: number) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, count) }, async () => { while (next < count) await job(next++); }));
}

/**
 * The bridge (the usual way): the files go up to our side in slices while the QR code shows, the phone takes
 * them as they come, then they are deleted (10 minutes at most). Works whatever the networks.
 */
async function sendRelay(files: { name: string; blob: Blob }[], meta: Omit<ShareMeta, "files">, onState: (s: SendState) => void, signal: AbortSignal) {
  const r = await fetch("/api/share", {
    method: "POST", signal, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ offer: "", meta: { ...meta, relay: true, files: files.map((f) => ({ name: f.name, size: f.blob.size, type: f.blob.type })) } }),
  });
  if (!r.ok) throw new Error(`share ${r.status}`);
  const { code } = (await r.json()) as { code: string };
  const url = `${location.origin}/share/${code}`;
  const total = files.reduce((n, f) => n + f.blob.size, 0) || 1;
  let up = 0;
  onState({ step: "waiting", url, code, relay: { pct: 0 } });
  const slices = files.flatMap((f, i) => Array.from({ length: sliceCount(f.blob.size) }, (_, n) => ({ i, n, blob: f.blob.slice(n * RELAY_CHUNK, (n + 1) * RELAY_CHUNK) })));
  // In order (the phone reads them in order), three at a time.
  let received = false;
  const watch = (async () => {
    while (!signal.aborted && !received) {
      await sleep(1500);
      const g = await fetch(`/api/share?code=${code}`, { signal, cache: "no-store" }).catch(() => null);
      if (g?.status === 404) { if (!received) onState({ step: "expired" }); return; }
      const s = g?.ok ? await g.json() : null;
      if (s?.answer === "got") received = true;
    }
  })().catch(() => {});
  await pool(slices.length, 3, async (k) => {
    const s = slices[k];
    for (let tries = 0; ; tries++) {
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      const p = await fetch(`/api/share/chunk?code=${code}&f=${s.i}&n=${s.n}`, { method: "PUT", signal, body: s.blob }).catch((e) => { if (signal.aborted) throw e; return null; });
      if (p?.ok) break;
      if (tries >= 3) throw new Error(`bridge ${p?.status ?? "network"}`);
      await sleep(800 * (tries + 1));
    }
    up += s.blob.size;
    onState({ step: "waiting", url, code, relay: { pct: up / total } });
  });
  await watch;
  if (received) onState({ step: "done" });
}

/** The computer's side: opens the share, waits for the phone, sends the files. */
export async function sendFiles(files: { name: string; blob: Blob }[], meta: Omit<ShareMeta, "files">, onState: (s: SendState) => void, signal: AbortSignal) {
  onState({ step: "opening" });
  if (files.reduce((n, f) => n + f.blob.size, 0) <= RELAY_MAX) return sendRelay(files, meta, onState, signal);
  const pc = new RTCPeerConnection({ iceServers: ICE });
  signal.addEventListener("abort", () => pc.close(), { once: true });
  const dc = pc.createDataChannel("files", { ordered: true });
  dc.binaryType = "arraybuffer";
  dc.bufferedAmountLowThreshold = 1 << 20;
  await pc.setLocalDescription(await pc.createOffer());
  await gather(pc);
  const r = await fetch("/api/share", {
    method: "POST", signal, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ offer: JSON.stringify(pc.localDescription), meta: { ...meta, files: files.map((f) => ({ name: f.name, size: f.blob.size, type: f.blob.type })) } }),
  });
  if (!r.ok) throw new Error(`share ${r.status}`);
  const { code } = (await r.json()) as { code: string };
  const url = `${location.origin}/share/${code}`;
  onState({ step: "waiting", url, code });

  // The phone's answer.
  let answered = false;
  while (!answered && !signal.aborted) {
    await sleep(1200);
    const g = await fetch(`/api/share?code=${code}`, { signal, cache: "no-store" }).catch(() => null);
    if (g?.status === 404) { onState({ step: "failed", code, url }); return; }
    const s = g?.ok ? await g.json() : null;
    if (s?.answer) { await pc.setRemoteDescription(JSON.parse(s.answer)); answered = true; }
  }
  if (signal.aborted) return;
  onState({ step: "connecting", url, code });

  const opened = await Promise.race([
    new Promise<boolean>((res) => { if (dc.readyState === "open") res(true); dc.addEventListener("open", () => res(true), { once: true }); }),
    sleep(CONNECT_MS).then(() => false),
  ]);
  if (!opened) { pc.close(); onState({ step: "failed", code, url }); return; }

  // The files, in slices; the channel's buffer is kept small (a phone receives slower than a computer sends).
  const total = files.reduce((n, f) => n + f.blob.size, 0) || 1;
  let sent = 0;
  const room = () => (dc.bufferedAmount < 8 << 20 ? Promise.resolve() : new Promise<void>((res) => dc.addEventListener("bufferedamountlow", () => res(), { once: true })));
  dc.send(JSON.stringify({ type: "head", files: files.map((f) => ({ name: f.name, size: f.blob.size, type: f.blob.type })) }));
  for (let i = 0; i < files.length; i++) {
    const b = files[i].blob;
    for (let at = 0; at < b.size; at += CHUNK) {
      if (signal.aborted) return;
      await room();
      const buf = await b.slice(at, at + CHUNK).arrayBuffer();
      dc.send(buf);
      sent += buf.byteLength;
      onState({ step: "sending", pct: sent / total });
    }
    dc.send(JSON.stringify({ type: "end", i }));
  }
  dc.send(JSON.stringify({ type: "done" }));
  // The phone says when it has everything.
  await Promise.race([
    new Promise<void>((res) => dc.addEventListener("message", (e) => { if (e.data === "got") res(); })),
    sleep(60_000),
  ]);
  onState({ step: "done" });
  setTimeout(() => pc.close(), 1000);
}

export type ReceiveState =
  | { step: "opening" }
  | { step: "connecting"; meta: ShareMeta }
  | { step: "receiving"; meta: ShareMeta; pct: number }
  | { step: "done"; meta: ShareMeta; files: File[] }
  | { step: "drive"; meta: ShareMeta }
  | { step: "drive-loading"; meta: ShareMeta; pct: number }
  | { step: "waiting-drive"; meta: ShareMeta }
  | { step: "expired" };

/** Plan B on the phone: the files sent through the Drive, fetched through our server when they are small (the
 *  phone then saves them like a direct transfer), else the Drive links. */
async function fromDrive(code: string, meta: ShareMeta, onState: (s: ReceiveState) => void) {
  const drive = meta.drive ?? [];
  const sizes = drive.map((d, i) => (meta.files.find((f) => f.name === d.name) ?? meta.files[i])?.size ?? Infinity);
  if (!drive.length || sizes.some((n) => n > PROXY_MAX)) { onState({ step: "drive", meta }); return; }
  const out: File[] = [];
  try {
    for (let i = 0; i < drive.length; i++) {
      onState({ step: "drive-loading", meta, pct: i / drive.length });
      const r = await fetch(`/api/share/file?code=${code}&i=${i}`, { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      const b = await r.blob();
      out.push(new File([b], drive[i].name, { type: safeType(meta.files.find((x) => x.name === drive[i].name)?.type ?? b.type) }));
    }
    onState({ step: "done", meta, files: out });
  } catch { onState({ step: "drive", meta }); }
}

/** The phone's side of the bridge: the slices as they come up, then "got" for the computer and the bridge emptied. */
async function fromRelay(code: string, meta: ShareMeta, onState: (s: ReceiveState) => void, taken: boolean) {
  if (taken) { onState({ step: "expired" }); return; }
  const total = meta.files.reduce((n, f) => n + f.size, 0) || 1;
  let got = 0;
  onState({ step: "receiving", meta, pct: 0 });
  const take = async (f: number, n: number): Promise<Blob> => {
    for (let tries = 0; ; tries++) {
      const r = await fetch(`/api/share/chunk?code=${code}&f=${f}&n=${n}`, { cache: "no-store" }).catch(() => null);
      if (r?.ok) return r.blob();
      if (r?.status === 410 || r?.status === 400 || tries > 400) throw new Error("expired");
      await sleep(r?.status === 404 ? 700 : 1500); // 404: not up yet
    }
  };
  try {
    const out: File[] = [];
    for (let f = 0; f < meta.files.length; f++) {
      const { name, size, type } = meta.files[f];
      const parts: Blob[] = new Array(sliceCount(size));
      await pool(parts.length, 3, async (n) => {
        parts[n] = await take(f, n);
        got += parts[n].size;
        onState({ step: "receiving", meta, pct: got / total });
      });
      out.push(new File(parts, name, { type: safeType(type) }));
    }
    onState({ step: "done", meta, files: out });
    // The computer shows "done"; the files leave the bridge.
    await fetch("/api/share", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, answer: "got" }) }).catch(() => {});
    await fetch(`/api/share/chunk?code=${code}`, { method: "DELETE" }).catch(() => {});
  } catch { onState({ step: "expired" }); }
}

/** The phone's side: answers the computer and receives the files (or, plan B, the Drive links). */
export async function receiveFiles(code: string, onState: (s: ReceiveState) => void) {
  onState({ step: "opening" });
  const g = await fetch(`/api/share?code=${code}`, { cache: "no-store" });
  if (!g.ok) { onState({ step: "expired" }); return; }
  const share = (await g.json()) as { offer: string; answer: string | null; meta: ShareMeta };
  const meta = share.meta;
  if (meta.relay) { await fromRelay(code, meta, onState, share.answer === "got"); return; }
  if (meta.drive?.length) { await fromDrive(code, meta, onState); return; }
  onState({ step: "connecting", meta });

  const pc = new RTCPeerConnection({ iceServers: ICE });
  let got = false;
  let flowing = false;
  pc.addEventListener("datachannel", (ev) => {
    const dc = ev.channel;
    dc.binaryType = "arraybuffer";
    const total = meta.files.reduce((n, f) => n + f.size, 0) || 1;
    let received = 0;
    let head: { name: string; size: number; type: string }[] = [];
    let parts: ArrayBuffer[] = [];
    const out: File[] = [];
    dc.addEventListener("message", (e) => {
      if (typeof e.data === "string") {
        const m = JSON.parse(e.data);
        if (m.type === "head") head = m.files;
        else if (m.type === "end") { const f = head[m.i]; out.push(new File(parts, f.name, { type: safeType(f.type) })); parts = []; }
        else if (m.type === "done") { got = true; dc.send("got"); onState({ step: "done", meta, files: out }); setTimeout(() => pc.close(), 1500); }
        return;
      }
      flowing = true;
      parts.push(e.data as ArrayBuffer);
      received += (e.data as ArrayBuffer).byteLength;
      onState({ step: "receiving", meta, pct: received / total });
    });
  });
  if (share.answer) { onState({ step: "expired" }); return; } // already taken by another device
  await pc.setRemoteDescription(JSON.parse(share.offer));
  await pc.setLocalDescription(await pc.createAnswer());
  await gather(pc);
  const a = await fetch("/api/share", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, answer: JSON.stringify(pc.localDescription) }) });
  if (!a.ok) { onState({ step: "expired" }); return; }

  // No direct link: the computer sends the files through its Drive by itself; they show up here.
  const since = Date.now();
  let told = false;
  for (let k = 0; k < 300 && !got && !flowing; k++) {
    await sleep(2000);
    if (got || flowing) return;
    if (!told && Date.now() - since > CONNECT_MS && pc.connectionState !== "connected") { told = true; onState({ step: "waiting-drive", meta }); }
    const s = await fetch(`/api/share?code=${code}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (s?.meta?.drive?.length && !flowing && !got) { pc.close(); await fromDrive(code, s.meta, onState); return; }
  }
}

// The files of plan B are readable by link only while the share lasts (and a little more for the last download):
// then the link is closed. Kept on this device, so a tab closed meanwhile closes them at the next start.
const OPEN_LINKS = "rollout-open-links";
const LINK_MS = (SHARE_MINUTES + 5) * 60_000;
const openLinks = (): { id: string; at: number }[] => { try { return JSON.parse(localStorage.getItem(OPEN_LINKS) ?? "[]"); } catch { return []; } };
const keepLinks = (l: { id: string; at: number }[]) => { try { if (l.length) localStorage.setItem(OPEN_LINKS, JSON.stringify(l)); else localStorage.removeItem(OPEN_LINKS); } catch { /* private mode */ } };

/** Closes the links of plan B whose share is over (the files stay private in the Drive). */
export async function closeOpenLinks() {
  const due = openLinks().filter((l) => Date.now() - l.at >= LINK_MS);
  if (!due.length) return;
  const { getToken } = await import("./drive");
  const closed = new Set<string>();
  for (const l of due) {
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${l.id}/permissions/anyoneWithLink`, {
      method: "DELETE", headers: { Authorization: `Bearer ${await getToken()}` },
    }).catch(() => null);
    if (r && (r.ok || r.status === 404)) closed.add(l.id); // closed, or the file is gone
  }
  keepLinks(openLinks().filter((l) => !closed.has(l.id)));
}

/** Plan B, on the computer: the files on the user's Drive, readable by link while the share lasts, the links handed to the phone. */
export async function shareThroughDrive(code: string, files: { name: string; blob: Blob }[], onProgress: (p: number) => void, signal: AbortSignal,
  /** Where it goes in the Drive: Rollout / Exports / <release> / <what · date> (Rollout itself without it). */
  place?: { release: string; what: string }) {
  const { getToken, uploadToDrive, DRIVE_PATHS } = await import("./drive");
  const d = new Date();
  const when = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}h${String(d.getMinutes()).padStart(2, "0")}`;
  const path = place ? DRIVE_PATHS.exports(place.release || "Release", `${place.what} · ${when}`) : undefined;
  const total = files.reduce((n, f) => n + f.blob.size, 0) || 1;
  let before = 0;
  const drive: { name: string; id: string }[] = [];
  for (const f of files) {
    const id = await uploadToDrive(f.blob, f.name, (p) => onProgress((before + p * f.blob.size) / total), signal, f.blob.type || undefined, { tktgen: "export" }, path);
    before += f.blob.size;
    // Readable by whoever has the link (the phone, not signed in) until the share is over; the file stays in the Drive.
    keepLinks([...openLinks().filter((l) => l.id !== id), { id, at: Date.now() }]);
    await fetch(`https://www.googleapis.com/drive/v3/files/${id}/permissions`, {
      method: "POST", signal,
      headers: { Authorization: `Bearer ${await getToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "reader", type: "anyone" }),
    });
    drive.push({ name: f.name, id });
  }
  setTimeout(() => void closeOpenLinks(), LINK_MS + 1000);
  const r = await fetch("/api/share", { method: "PUT", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, drive }) });
  if (!r.ok) throw new Error(`share ${r.status}`);
}
