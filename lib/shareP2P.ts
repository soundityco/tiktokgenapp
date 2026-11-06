/**
 * Sharing files from the computer to a phone, like AirDrop: the phone scans a QR code, the two browsers connect
 * to each other (WebRTC) and the files go straight through the local network. Only the connection details go
 * through our server (/api/share), never the files.
 */
import type { ShareMeta } from "./shareStore";

const ICE: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }];
const CHUNK = 64 * 1024;
/** Without a direct link after this long, the share falls back to the Drive. */
export const CONNECT_MS = 25_000;

const gather = (pc: RTCPeerConnection) => new Promise<void>((resolve) => {
  if (pc.iceGatheringState === "complete") return resolve();
  const t = setTimeout(resolve, 3500); // enough candidates by then (the local network ones come first)
  pc.addEventListener("icegatheringstatechange", () => { if (pc.iceGatheringState === "complete") { clearTimeout(t); resolve(); } });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type SendState =
  | { step: "opening" }
  | { step: "waiting"; url: string; code: string }
  | { step: "connecting"; url: string; code: string }
  | { step: "sending"; pct: number }
  | { step: "done" }
  | { step: "failed"; code?: string; url?: string };

/** The computer's side: opens the share, waits for the phone, sends the files. */
export async function sendFiles(files: { name: string; blob: Blob }[], meta: Omit<ShareMeta, "files">, onState: (s: SendState) => void, signal: AbortSignal) {
  onState({ step: "opening" });
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
  | { step: "waiting-drive"; meta: ShareMeta }
  | { step: "expired" };

/** The phone's side: answers the computer and receives the files (or, plan B, the Drive links). */
export async function receiveFiles(code: string, onState: (s: ReceiveState) => void) {
  onState({ step: "opening" });
  const g = await fetch(`/api/share?code=${code}`, { cache: "no-store" });
  if (!g.ok) { onState({ step: "expired" }); return; }
  const share = (await g.json()) as { offer: string; answer: string | null; meta: ShareMeta };
  const meta = share.meta;
  if (meta.drive?.length) { onState({ step: "drive", meta }); return; }
  onState({ step: "connecting", meta });

  const pc = new RTCPeerConnection({ iceServers: ICE });
  let got = false;
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
        else if (m.type === "end") { const f = head[m.i]; out.push(new File(parts, f.name, { type: f.type })); parts = []; }
        else if (m.type === "done") { got = true; dc.send("got"); onState({ step: "done", meta, files: out }); setTimeout(() => pc.close(), 1500); }
        return;
      }
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

  // No direct link: the computer may send the files through its Drive instead; the links show up here.
  await sleep(CONNECT_MS);
  if (got || pc.connectionState === "connected") return;
  onState({ step: "waiting-drive", meta });
  for (let k = 0; k < 150 && !got; k++) {
    await sleep(2000);
    const s = await fetch(`/api/share?code=${code}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (s?.meta?.drive?.length) { pc.close(); onState({ step: "drive", meta: s.meta }); return; }
  }
}

/** Plan B, on the computer: the files on the user's Drive, readable by link, the links handed to the phone. */
export async function shareThroughDrive(code: string, files: { name: string; blob: Blob }[], onProgress: (p: number) => void, signal: AbortSignal) {
  const { getToken, uploadToDrive } = await import("./drive");
  const total = files.reduce((n, f) => n + f.blob.size, 0) || 1;
  let before = 0;
  const drive: { name: string; id: string }[] = [];
  for (const f of files) {
    const id = await uploadToDrive(f.blob, f.name, (p) => onProgress((before + p * f.blob.size) / total), signal, f.blob.type || undefined);
    before += f.blob.size;
    // Readable by whoever has the link (the phone, not signed in); the file stays in the Rollout folder of the Drive.
    await fetch(`https://www.googleapis.com/drive/v3/files/${id}/permissions`, {
      method: "POST", signal,
      headers: { Authorization: `Bearer ${await getToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "reader", type: "anyone" }),
    });
    drive.push({ name: f.name, id });
  }
  const r = await fetch("/api/share", { method: "PUT", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, drive }) });
  if (!r.ok) throw new Error(`share ${r.status}`);
}
