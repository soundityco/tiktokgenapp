"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { norm, textItems } from "@/lib/generate";
import { Crop, createOcr } from "@/lib/ocr";
import type { TextPool } from "@/lib/types";
import { useT } from "@/lib/i18n";
import { Modal } from "./ui";

type Status = "New" | "Check spelling" | "Duplicate" | "Already in pool" | "No text found";
interface Item { id: number; url: string; text: string; conf: number; status: Status; checked: boolean; views?: number }
interface Post { id: string; title: string; cover: string; views: number; likes: number; created: number; url: string }
interface TTStatus { configured: boolean; connected: boolean; name: string | null }
export interface NewHook { text: string; views?: number }

const badge = (s: Status) => (s === "New" ? "ok" : s === "Check spelling" ? "warn" : s === "No text found" ? "bad" : "dim");
const fmt = (n: number) => n.toLocaleString("en-US");

export default function HooksExtract({ pools, initialPoolId, initialSource, onAdd, onClose }: {
  pools: TextPool[]; initialPoolId: string | null; initialSource?: "screens" | "tiktok"; onAdd: (poolId: string, hooks: NewHook[]) => void; onClose: () => void;
}) {
  const { t } = useT();
  const hookPools = pools.filter((p) => p.kind === "hooks");
  const [source, setSource] = useState<"screens" | "tiktok">(initialSource ?? "screens");
  const [poolId, setPoolId] = useState(initialPoolId && hookPools.some((p) => p.id === initialPoolId) ? initialPoolId : hookPools[0]?.id ?? "");
  const [files, setFiles] = useState<File[]>([]);
  const [crop, setCrop] = useState<Crop>({ top: 8, bottom: 20, right: 12 });
  const [workers, setWorkers] = useState(2);
  const [items, setItems] = useState<Item[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [big, setBig] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const started = useRef(0);
  const cancel = useRef(false);
  const drop = useRef<HTMLInputElement>(null);
  const seen = useRef(new Set<string>());
  const [eta, setEta] = useState("");

  // TikTok
  const [tt, setTt] = useState<TTStatus | null>(null);
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [loadingPosts, setLoadingPosts] = useState(false);
  const [mode, setMode] = useState<"top" | "min">("top");
  const [topN, setTopN] = useState(25);
  const [minViews, setMinViews] = useState(1000);

  const previewUrl = useMemo(() => (files[0] ? URL.createObjectURL(files[0]) : null), [files]);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);
  useEffect(() => () => items.forEach((i) => URL.revokeObjectURL(i.url)), []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (source !== "tiktok" || tt) return;
    fetch("/api/tiktok/status").then((r) => r.json()).then(setTt).catch(() => setErr(t("Could not check the TikTok connection")));
  }, [source, tt]);

  const pool = hookPools.find((p) => p.id === poolId);
  const selected = useMemo(() => {
    if (!posts) return [];
    const byViews = [...posts].sort((a, b) => b.views - a.views);
    return mode === "top" ? byViews.slice(0, Math.max(1, topN)) : byViews.filter((p) => p.views >= minViews);
  }, [posts, mode, topN, minViews]);

  async function loadPosts() {
    setLoadingPosts(true); setErr(null);
    try {
      const r = await fetch("/api/tiktok/posts");
      const j = await r.json();
      if (r.status === 409) { setTt((t) => (t ? { ...t, connected: false } : t)); throw new Error(t("TikTok connection expired. Connect again.")); }
      if (!r.ok) throw new Error(j.error ?? t("Could not load your posts"));
      setPosts(j.posts);
    } catch (e: any) { setErr(e.message); }
    setLoadingPosts(false);
  }

  async function run(jobs: { get: () => Promise<Blob>; views?: number }[], cropUsed: Crop) {
    if (!jobs.length || !pool) return;
    cancel.current = false; setRunning(true); setErr(null); setItems([]); setDone(0); setTotal(jobs.length); seen.current = new Set(); started.current = Date.now();
    const existing = new Set(textItems(pool).map((t) => norm(t.replace(/\|/g, " "))));
    let ocr: Awaited<ReturnType<typeof createOcr>> | null = null;
    try {
      ocr = await createOcr(workers);
      let next = 0, finished = 0;
      await Promise.all(Array.from({ length: workers }, async () => {
        while (!cancel.current) {
          const i = next++;
          if (i >= jobs.length) return;
          let text = "", conf = 0, blob: Blob | null = null;
          try { blob = await jobs[i].get(); ({ text, conf } = await ocr!.run(blob, cropUsed)); } catch { /* counted as no text */ }
          const key = norm(text);
          let status: Status = "New";
          if (!key) status = "No text found";
          else if (existing.has(key)) status = "Already in pool";
          else if (seen.current.has(key)) status = "Duplicate";
          else if (conf < 75) status = "Check spelling";
          if (key) seen.current.add(key);
          const item: Item = { id: i, url: blob ? URL.createObjectURL(blob) : "", text, conf, status, checked: status === "New", views: jobs[i].views };
          finished++;
          setItems((cur) => [...cur, item]);
          setDone(finished);
          const per = (Date.now() - started.current) / finished;
          const mins = Math.max(1, Math.round((per * (jobs.length - finished)) / 60000));
          setEta(finished < jobs.length ? `about ${mins} min left` : "");
        }
      }));
    } catch (e: any) {
      setErr(e?.message ?? "OCR failed. Check your connection: the OCR engine downloads once, then is cached.");
    } finally {
      await ocr?.terminate();
      setRunning(false);
    }
  }

  const startScreens = () => run(files.map((f) => ({ get: async () => f as Blob })), crop);
  const startTikTok = () =>
    run(selected.map((p) => ({
      views: p.views,
      get: async () => {
        const r = await fetch("/api/tiktok/cover?u=" + encodeURIComponent(p.cover));
        if (!r.ok) throw new Error("cover unavailable");
        return r.blob();
      },
    })), { top: 0, bottom: 0, right: 0 });

  const checked = items.filter((i) => i.checked && i.text.trim());
  const setItem = (id: number, patch: Partial<Item>) => setItems((c) => c.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  const reset = () => { setItems([]); setDone(0); setTotal(0); };

  return (
    <Modal title={t("Import hooks")} onClose={() => { cancel.current = true; onClose(); }} wide>
      <div className="tabs">
        <button className={"tab" + (source === "screens" ? " on" : "")} disabled={running} onClick={() => { setSource("screens"); reset(); }}>{t("Screenshots")}</button>
        <button className={"tab" + (source === "tiktok" ? " on" : "")} disabled={running} onClick={() => { setSource("tiktok"); reset(); }}>{t("My TikTok account")}</button>
      </div>

      {source === "screens" && (
        <>
          <div className="row">
            <input ref={drop} type="file" accept="image/*" multiple hidden onChange={(e) => { setFiles(Array.from(e.target.files ?? [])); reset(); }} />
            <div className="grow drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); setFiles(Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"))); reset(); }}
              onClick={() => drop.current?.click()}>
              {files.length ? t("{n} screenshots selected", { n: files.length }) : t("Drop your TikTok screenshots here, or click to browse")}
            </div>
          </div>
          <div className="cols2">
            <div>
              {previewUrl && (
                <div className="crop-prev">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={previewUrl} alt={t("Screenshot preview")} />
                  <div className="z" style={{ left: 0, right: 0, top: 0, height: crop.top + "%" }} />
                  <div className="z" style={{ left: 0, right: 0, bottom: 0, height: crop.bottom + "%" }} />
                  <div className="z" style={{ right: 0, width: crop.right + "%", top: "40%", bottom: crop.bottom + "%" }} />
                </div>
              )}
            </div>
            <div style={{ display: "grid", gap: 8, alignContent: "start" }}>
              <p className="muted" style={{ margin: 0 }}>{t("Red areas are ignored: they hide TikTok’s own interface.")}</p>
              <label className="field">{t("Top")} ({crop.top}%)<input type="range" min={0} max={40} value={crop.top} onChange={(e) => setCrop({ ...crop, top: +e.target.value })} /></label>
              <label className="field">{t("Bottom")} ({crop.bottom}%)<input type="range" min={0} max={50} value={crop.bottom} onChange={(e) => setCrop({ ...crop, bottom: +e.target.value })} /></label>
              <label className="field">{t("Right-hand buttons")} ({crop.right}%)<input type="range" min={0} max={40} value={crop.right} onChange={(e) => setCrop({ ...crop, right: +e.target.value })} /></label>
            </div>
          </div>
        </>
      )}

      {source === "tiktok" && (
        <div style={{ display: "grid", gap: 10 }}>
          {!tt && <p className="muted" style={{ margin: 0 }}>{t("Checking your TikTok connection…")}</p>}
          {tt && !tt.configured && (
            <p className="notice warn">
              {t("TikTok is not set up on this site yet: add TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET (see the README).")}
            </p>
          )}
          {tt?.configured && !tt.connected && (
            <div className="row">
              <button className="btn primary" onClick={() => { window.location.href = "/api/tiktok/login"; }}>{t("Connect TikTok")}</button>
              <span className="muted">{t("You will be sent to TikTok to allow read-only access to your posts.")}</span>
            </div>
          )}
          {tt?.connected && (
            <>
              <div className="row">
                <span className="badge ok">{tt.name ? t("Connected as {name}", { name: tt.name }) : t("Connected")}</span>
                <button className="btn sm" onClick={async () => { await fetch("/api/tiktok/disconnect", { method: "POST" }); setTt({ ...tt, connected: false, name: null }); setPosts(null); }}>{t("Disconnect")}</button>
                <span className="grow" />
                <button className="btn" onClick={loadPosts} disabled={loadingPosts || running}>{loadingPosts ? t("Loading…") : posts ? t("Reload my posts") : t("Load my posts")}</button>
              </div>
              {posts && (
                <>
                  <p className="muted" style={{ margin: 0 }}>{t("{n} posts found.", { n: posts.length })}</p>
                  <div className="row">
                    <select className="input" style={{ width: 230 }} value={mode} onChange={(e) => setMode(e.target.value as "top" | "min")}>
                      <option value="top">{t("My best posts (by views)")}</option>
                      <option value="min">{t("Posts with at least … views")}</option>
                    </select>
                    {mode === "top"
                      ? <input className="input" style={{ width: 100 }} type="number" min={1} value={topN} onChange={(e) => setTopN(+e.target.value || 1)} aria-label={t("Number of posts")} />
                      : <input className="input" style={{ width: 130 }} type="number" min={0} value={minViews} onChange={(e) => setMinViews(+e.target.value || 0)} aria-label={t("Minimum views")} />}
                    <span className="muted">
                      {t("{n} posts selected", { n: selected.length })}
                      {selected.length ? ` · ${t("{a} to {b} views", { a: fmt(selected[selected.length - 1].views), b: fmt(selected[0].views) })}` : ""}
                    </span>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}

      <div className="cols2">
        <label className="field">{t("Add hooks to")}
          <select className="input" value={poolId} onChange={(e) => setPoolId(e.target.value)}>
            {hookPools.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="field">{t("Parallel workers")}
          <select className="input" value={workers} onChange={(e) => setWorkers(+e.target.value)}>{[1, 2, 3, 4].map((n) => <option key={n}>{n}</option>)}</select>
        </label>
      </div>
      <div className="row">
        {!running
          ? <button className="btn primary" disabled={!pool || (source === "screens" ? !files.length : !selected.length)} onClick={source === "screens" ? startScreens : startTikTok}>{t("Start")}</button>
          : <button className="btn" onClick={() => { cancel.current = true; }}>{t("Cancel")}</button>}
      </div>

      {(running || done > 0) && (
        <div style={{ display: "grid", gap: 4 }}>
          <div className="bar"><div style={{ width: `${(done / Math.max(1, total)) * 100}%` }} /></div>
          <span className="muted">{source === "tiktok" ? t("{done} / {total} posts", { done, total }) : t("{done} / {total} screenshots", { done, total })} {eta && `· ${eta}`}</span>
        </div>
      )}
      {err && <span className="notice bad">{err}</span>}
      {!!items.length && (
        <>
          <div className="row">
            <button className="btn sm" onClick={() => setItems((c) => c.map((i) => ({ ...i, checked: !!i.text.trim() })))}>{t("Select all")}</button>
            <button className="btn sm" onClick={() => setItems((c) => c.map((i) => ({ ...i, checked: false })))}>{t("Select none")}</button>
            <button className="btn sm" onClick={reset}>{t("Clear list")}</button>
          </div>
          <div style={{ display: "grid", gap: 6, maxHeight: "38dvh", overflow: "auto" }}>
            {[...items].sort((a, b) => a.id - b.id).map((i) => (
              <div className="res" key={i.id}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {i.url ? <img src={i.url} alt="" onClick={() => setBig(i.url)} /> : <div />}
                <div style={{ display: "grid", gap: 4 }}>
                  <div className="row">
                    <input type="checkbox" checked={i.checked} disabled={!i.text.trim()} onChange={(e) => setItem(i.id, { checked: e.target.checked })} aria-label={t("Include")} />
                    <span className={"badge " + badge(i.status)}>{t(i.status)}</span>
                    {i.conf > 0 && <span className="muted">{i.conf}%</span>}
                    {i.views !== undefined && <span className="muted">{t("{n} views", { n: fmt(i.views) })}</span>}
                  </div>
                  <input className="input" value={i.text} onChange={(e) => setItem(i.id, { text: e.target.value })} />
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      <div className="modal-foot">
        <button className="btn quiet" onClick={() => { cancel.current = true; onClose(); }}>{t("Close")}</button>
        <button className="btn primary" disabled={!checked.length || !pool} onClick={() => { onAdd(poolId, checked.map((i) => ({ text: i.text.trim(), views: i.views }))); onClose(); }}>
          {t("Add {n} to the list", { n: checked.length })}
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
