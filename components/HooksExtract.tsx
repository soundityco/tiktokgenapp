"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { norm, textItems } from "@/lib/generate";
import { Crop, createOcr } from "@/lib/ocr";
import type { TextPool } from "@/lib/types";
import { Modal } from "./ui";

type Status = "New" | "Check spelling" | "Duplicate" | "Already in pool" | "No text found";
interface Item { id: number; url: string; text: string; conf: number; status: Status; checked: boolean }

const badge = (s: Status) => (s === "New" ? "ok" : s === "Check spelling" ? "warn" : s === "No text found" ? "bad" : "dim");

export default function HooksExtract({ pools, initialPoolId, onAdd, onClose }: {
  pools: TextPool[]; initialPoolId: string | null; onAdd: (poolId: string, lines: string[]) => void; onClose: () => void;
}) {
  const hookPools = pools.filter((p) => p.kind === "hooks");
  const [poolId, setPoolId] = useState(initialPoolId && hookPools.some((p) => p.id === initialPoolId) ? initialPoolId : hookPools[0]?.id ?? "");
  const [files, setFiles] = useState<File[]>([]);
  const [crop, setCrop] = useState<Crop>({ top: 8, bottom: 20, right: 16 });
  const [workers, setWorkers] = useState(2);
  const [items, setItems] = useState<Item[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [big, setBig] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const started = useRef(0);
  const cancel = useRef(false);
  const drop = useRef<HTMLInputElement>(null);
  const seen = useRef(new Set<string>());
  const [eta, setEta] = useState("");

  const previewUrl = useMemo(() => (files[0] ? URL.createObjectURL(files[0]) : null), [files]);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);
  useEffect(() => () => items.forEach((i) => URL.revokeObjectURL(i.url)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const pool = hookPools.find((p) => p.id === poolId);

  async function start() {
    if (!files.length || !pool) return;
    cancel.current = false; setRunning(true); setErr(null); setItems([]); setDone(0); seen.current = new Set(); started.current = Date.now();
    const existing = new Set(textItems(pool).map((t) => norm(t.replace(/\|/g, " "))));
    let ocr: Awaited<ReturnType<typeof createOcr>> | null = null;
    try {
      ocr = await createOcr(workers);
      let next = 0, finished = 0;
      await Promise.all(Array.from({ length: workers }, async () => {
        while (!cancel.current) {
          const i = next++;
          if (i >= files.length) return;
          let text = "", conf = 0;
          try { ({ text, conf } = await ocr!.run(files[i], crop)); } catch { /* counted as no text */ }
          const key = norm(text);
          let status: Status = "New";
          if (!key) status = "No text found";
          else if (existing.has(key)) status = "Already in pool";
          else if (seen.current.has(key)) status = "Duplicate";
          else if (conf < 75) status = "Check spelling";
          if (key) seen.current.add(key);
          const item: Item = { id: i, url: URL.createObjectURL(files[i]), text, conf, status, checked: status === "New" };
          finished++;
          setItems((cur) => [...cur, item]);
          setDone(finished);
          const per = (Date.now() - started.current) / finished;
          const mins = Math.max(1, Math.round((per * (files.length - finished)) / 60000));
          setEta(finished < files.length ? `about ${mins} min left` : "");
        }
      }));
    } catch (e: any) {
      setErr(e?.message ?? "OCR failed. Check your connection: the OCR engine downloads once, then is cached.");
    } finally {
      await ocr?.terminate();
      setRunning(false);
    }
  }

  const checked = items.filter((i) => i.checked && i.text.trim());
  const setItem = (id: number, patch: Partial<Item>) => setItems((c) => c.map((i) => (i.id === id ? { ...i, ...patch } : i)));

  return (
    <Modal title="Extract hooks from screenshots" onClose={() => { cancel.current = true; onClose(); }} wide>
      <div className="row">
        <input ref={drop} type="file" accept="image/*" multiple hidden onChange={(e) => { setFiles(Array.from(e.target.files ?? [])); setItems([]); setDone(0); }} />
        <div className="grow" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); setFiles(Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"))); setItems([]); setDone(0); }}
          style={{ border: "1px dashed var(--line)", borderRadius: 10, padding: 14, textAlign: "center", cursor: "pointer" }} onClick={() => drop.current?.click()}>
          {files.length ? `${files.length} screenshot${files.length > 1 ? "s" : ""} selected` : "Drop your TikTok screenshots here, or click to browse"}
        </div>
      </div>
      <div className="two">
        <div>
          {previewUrl && (
            <div className="crop-prev">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={previewUrl} alt="Screenshot preview" />
              <div className="z" style={{ left: 0, right: 0, top: 0, height: crop.top + "%" }} />
              <div className="z" style={{ left: 0, right: 0, bottom: 0, height: crop.bottom + "%" }} />
              <div className="z" style={{ right: 0, width: crop.right + "%", top: "40%", bottom: crop.bottom + "%" }} />
            </div>
          )}
        </div>
        <div style={{ display: "grid", gap: 8, alignContent: "start" }}>
          <p className="muted" style={{ margin: 0 }}>Red areas are ignored: they hide TikTok’s own interface.</p>
          <label className="f">Top ({crop.top}%)<input type="range" min={0} max={40} value={crop.top} onChange={(e) => setCrop({ ...crop, top: +e.target.value })} /></label>
          <label className="f">Bottom ({crop.bottom}%)<input type="range" min={0} max={50} value={crop.bottom} onChange={(e) => setCrop({ ...crop, bottom: +e.target.value })} /></label>
          <label className="f">Right buttons ({crop.right}%)<input type="range" min={0} max={40} value={crop.right} onChange={(e) => setCrop({ ...crop, right: +e.target.value })} /></label>
          <div className="two">
            <label className="f">Target pool
              <select className="input" value={poolId} onChange={(e) => setPoolId(e.target.value)}>
                {hookPools.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <label className="f">Parallel workers
              <select className="input" value={workers} onChange={(e) => setWorkers(+e.target.value)}>{[1, 2, 3, 4].map((n) => <option key={n}>{n}</option>)}</select>
            </label>
          </div>
          <div className="row">
            {!running ? <button className="btn red" disabled={!files.length || !pool} onClick={start}>Start</button>
              : <button className="btn" onClick={() => { cancel.current = true; }}>Cancel</button>}
          </div>
        </div>
      </div>
      {(running || done > 0) && (
        <div style={{ display: "grid", gap: 4 }}>
          <div className="bar"><div style={{ width: `${(done / Math.max(1, files.length)) * 100}%` }} /></div>
          <span className="muted">{done} / {files.length} screenshots {eta && `· ${eta}`}</span>
        </div>
      )}
      {err && <span className="badge bad" style={{ whiteSpace: "normal" }}>{err}</span>}
      {!!items.length && (
        <>
          <div className="row">
            <button className="btn sm" onClick={() => setItems((c) => c.map((i) => ({ ...i, checked: !!i.text.trim() })))}>Select all</button>
            <button className="btn sm" onClick={() => setItems((c) => c.map((i) => ({ ...i, checked: false })))}>Select none</button>
            <button className="btn sm" onClick={() => setItems([])}>Clear list</button>
          </div>
          <div style={{ display: "grid", gap: 6, maxHeight: "38dvh", overflow: "auto" }}>
            {[...items].sort((a, b) => a.id - b.id).map((i) => (
              <div className="res" key={i.id}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={i.url} alt="" onClick={() => setBig(i.url)} />
                <div style={{ display: "grid", gap: 4 }}>
                  <div className="row">
                    <input type="checkbox" checked={i.checked} disabled={!i.text.trim()} onChange={(e) => setItem(i.id, { checked: e.target.checked })} aria-label="Include" />
                    <span className={"badge " + badge(i.status)}>{i.status}</span>
                    {i.conf > 0 && <span className="muted">{i.conf}%</span>}
                  </div>
                  <input className="input" value={i.text} onChange={(e) => setItem(i.id, { text: e.target.value })} />
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={() => { cancel.current = true; onClose(); }}>Close</button>
        <button className="btn red" disabled={!checked.length || !pool} onClick={() => { onAdd(poolId, checked.map((i) => i.text.trim())); onClose(); }}>
          Add {checked.length} to pool
        </button>
      </div>
      {big && (
        <div className="ov" onClick={() => setBig(null)} style={{ zIndex: 70 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={big} alt="" style={{ maxHeight: "92dvh", maxWidth: "92vw", borderRadius: 8 }} />
        </div>
      )}
    </Modal>
  );
}
