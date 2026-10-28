"use client";
import JSZip from "jszip";
import { signOut } from "next-auth/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { defaultWorkspace, newProject, newSlide, slidePools, uid } from "@/lib/defaults";
import { loadDriveImage } from "@/lib/drive";
import { generateAll, hookKey, pickPic, pickText, poolsVisible, textItems } from "@/lib/generate";
import { loadFonts, slideToBlob } from "@/lib/render";
import type { GenSlide, PicPool, PicRef, Project, SlideCfg, TextPool, Workspace } from "@/lib/types";
import DriveBrowser from "./DriveBrowser";
import HooksExtract, { NewHook } from "./HooksExtract";
import Inspector from "./Inspector";
import Logo from "./Logo";
import { PicPoolEditor, TextPoolEditor } from "./PoolEditors";
import SlideCard from "./SlideCard";
import { ConfirmDialog, Modal, NewPoolDialog, PromptDialog, Toast } from "./ui";

const VERSION = "v0.1";

type Editor = { k: "text" | "pics"; id: string } | null;
type Overlay =
  | null
  | { k: "drive"; poolId: string }
  | { k: "extract"; poolId: string | null; source?: "tiktok" }
  | { k: "lyrics" }
  | { k: "newPool" }
  | { k: "newProject" }
  | { k: "rename" }
  | { k: "confirm"; title: string; message: string; label: string; run: () => void };

const stamp = () => {
  const d = new Date(), z = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}-${z(d.getMinutes())}`;
};
const safe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "-").trim() || "TkTgen";
const download = (blob: Blob, name: string) => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

export default function Studio({ userName }: { userName: string }) {
  const [ws, setWs] = useState<Workspace | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const [tab, setTab] = useState<"text" | "pics">("text");
  const [editor, setEditor] = useState<Editor>(null);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [menu, setMenu] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [fontsReady, setFontsReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const loaded = useRef(false);
  const restoreInput = useRef<HTMLInputElement>(null);

  const say = useCallback((m: string) => { setToast(m); setTimeout(() => setToast(null), 2600); }, []);

  // ---- load / autosave ----
  useEffect(() => {
    const flag = new URLSearchParams(location.search).get("tiktok");
    if (flag) {
      history.replaceState(null, "", "/studio");
      const msg: Record<string, string> = { connected: "TikTok connected", denied: "TikTok connection was cancelled", badstate: "TikTok connection failed (security check). Try again.", error: "TikTok connection failed. Try again.", notconfigured: "TikTok is not set up on this site yet" };
      setTimeout(() => say(msg[flag] ?? "TikTok"), 300);
      if (flag === "connected") setOverlay({ k: "extract", poolId: null, source: "tiktok" });
    }
    loadFonts().then(() => setFontsReady(true));
    fetch("/api/workspace")
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "Could not load your data");
        setWs(j.data && j.data.v === 1 ? (j.data as Workspace) : defaultWorkspace());
      })
      .catch((e) => setLoadErr(String(e.message ?? e)));
  }, []);

  useEffect(() => {
    if (!ws) return;
    if (!loaded.current) { loaded.current = true; return; }
    setSaveState("saving");
    const t = setTimeout(() => {
      fetch("/api/workspace", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ws) })
        .then((r) => setSaveState(r.ok ? "saved" : "error"))
        .catch(() => setSaveState("error"));
    }, 1000);
    return () => clearTimeout(t);
  }, [ws]);

  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (saveState !== "saved") e.preventDefault(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [saveState]);

  // ---- derived ----
  const project: Project | null = ws ? ws.projects.find((p) => p.id === ws.currentProjectId) ?? ws.projects[0] : null;
  const vText = useMemo(() => (ws && project ? poolsVisible(ws.textPools, project.id) : []), [ws, project]);
  const vPics = useMemo(() => (ws && project ? poolsVisible(ws.picPools, project.id) : []), [ws, project]);

  // ---- updaters ----
  const upd = (fn: (w: Workspace) => Workspace) => setWs((w) => (w ? fn(w) : w));
  const updProject = (fn: (p: Project) => Project) =>
    upd((w) => ({ ...w, projects: w.projects.map((p) => (p.id === w.currentProjectId ? fn(p) : p)) }));
  const updSlide = (i: number, fn: (s: SlideCfg) => SlideCfg) =>
    updProject((p) => ({ ...p, slides: p.slides.map((s, k) => (k === i ? fn(s) : s)) }));
  const setGen = (i: number, patch: Partial<GenSlide>) =>
    updProject((p) => {
      const g = Array.from({ length: p.slides.length }, (_, k) => p.generated?.[k] ?? { text: "", picId: null });
      g[i] = { ...g[i], ...patch };
      return { ...p, generated: g };
    });

  // ---- generate ----
  const generate = useCallback(() => {
    upd((w) => {
      const p = w.projects.find((x) => x.id === w.currentProjectId)!;
      const { slides, bags } = generateAll(w, p);
      return { ...w, bags, projects: w.projects.map((x) => (x.id === p.id ? { ...x, generated: slides } : x)) };
    });
  }, []);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (/INPUT|TEXTAREA|SELECT/.test(t.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() === "g" && !document.querySelector(".ov")) generate();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [generate]);

  const rerollPic = (i: number) =>
    upd((w) => {
      const p = w.projects.find((x) => x.id === w.currentProjectId)!;
      const bags = { ...w.bags };
      const others = new Set((p.generated ?? []).filter((_, k) => k !== i).map((g) => g?.picId).filter(Boolean) as string[]);
      const pic = pickPic(p.slides[i].picPoolId, w, bags, others);
      const g = Array.from({ length: p.slides.length }, (_, k) => p.generated?.[k] ?? { text: "", picId: null });
      g[i] = { ...g[i], picId: pic?.id ?? null, picName: pic?.name };
      return { ...w, bags, projects: w.projects.map((x) => (x.id === p.id ? { ...x, generated: g } : x)) };
    });
  const rerollText = (i: number) =>
    upd((w) => {
      const p = w.projects.find((x) => x.id === w.currentProjectId)!;
      const bags = { ...w.bags };
      const text = pickText(p, w, i, bags);
      const g = Array.from({ length: p.slides.length }, (_, k) => p.generated?.[k] ?? { text: "", picId: null });
      g[i] = { ...g[i], text };
      return { ...w, bags, projects: w.projects.map((x) => (x.id === p.id ? { ...x, generated: g } : x)) };
    });

  // ---- slides count ----
  const addSlide = () =>
    upd((w) => {
      const p = w.projects.find((x) => x.id === w.currentProjectId)!;
      if (p.slides.length >= 10) return w;
      const n = p.slides.length + 1;
      let textPools = w.textPools, picPools = w.picPools;
      let tp = textPools.find((t) => t.scope === "shared" && t.name === `Slide ${n} text`);
      let pp = picPools.find((t) => t.scope === "shared" && t.name === `Slide ${n} pictures`);
      const fresh = slidePools(n);
      if (!tp) { tp = fresh.text; textPools = [...textPools, tp]; }
      if (!pp) { pp = fresh.pics; picPools = [...picPools, pp]; }
      const last = p.slides[p.slides.length - 1];
      const s: SlideCfg = { ...newSlide(n, tp.id, pp.id), format: last.format, pic: { ...last.pic, ox: 0, oy: 0 }, style: { ...last.style } };
      return { ...w, textPools, picPools, projects: w.projects.map((x) => (x.id === p.id ? { ...x, slides: [...x.slides, s], selectedSlide: n - 1 } : x)) };
    });
  const removeSlide = () =>
    updProject((p) => p.slides.length <= 1 ? p : { ...p, slides: p.slides.slice(0, -1), generated: p.generated?.slice(0, p.slides.length - 1) ?? null, selectedSlide: Math.min(p.selectedSlide, p.slides.length - 2) });

  const applyAll = () =>
    updProject((p) => {
      const src = p.slides[p.selectedSlide];
      return { ...p, slides: p.slides.map((s) => ({ ...s, format: src.format, pic: { ...src.pic }, style: { ...src.style } })) };
    });

  // ---- pools ----
  const createPool = (name: string, scope: "shared" | "project", kind: "hooks" | "block") => {
    const projectId = scope === "project" ? project!.id : undefined;
    if (tab === "text") upd((w) => ({ ...w, textPools: [...w.textPools, { id: uid(), name, scope, projectId, kind, text: "" }] }));
    else upd((w) => ({ ...w, picPools: [...w.picPools, { id: uid(), name, scope, projectId, pics: [] }] }));
  };
  const askDeletePool = (kind: "text" | "pics", id: string) => {
    const pool = kind === "text" ? ws!.textPools.find((p) => p.id === id) : ws!.picPools.find((p) => p.id === id);
    if (!pool) return;
    const n = kind === "text" ? textItems(pool as TextPool).length : (pool as PicPool).pics.length;
    setOverlay({
      k: "confirm", title: "Delete pool", label: "Delete",
      message: `Are you sure you want to delete "${pool.name}"? Its ${n} ${kind === "text" ? (n === 1 ? "text" : "texts") : n === 1 ? "picture" : "pictures"} will be deleted too. This can't be undone.`,
      run: () => {
        setEditor(null);
        upd((w) => {
          const bags = { ...w.bags }; delete bags[id];
          return {
            ...w, bags,
            textPools: w.textPools.filter((p) => p.id !== id),
            picPools: w.picPools.filter((p) => p.id !== id),
            projects: w.projects.map((p) => ({
              ...p,
              slides: p.slides.map((s) => ({
                ...s,
                textSource: s.textSource.kind === "pool" && s.textSource.poolId === id ? { kind: "none" as const } : s.textSource,
                picPoolId: s.picPoolId === id ? null : s.picPoolId,
              })),
            })),
          };
        });
      },
    });
  };
  const setTextPool = (id: string, fn: (t: TextPool) => TextPool) => upd((w) => ({ ...w, textPools: w.textPools.map((t) => (t.id === id ? fn(t) : t)) }));
  const setPicPool = (id: string, fn: (t: PicPool) => PicPool) => upd((w) => ({ ...w, picPools: w.picPools.map((t) => (t.id === id ? fn(t) : t)) }));
  const scopeFix = <T extends { scope: string; projectId?: string }>(t: T): T => (t.scope === "project" ? { ...t, projectId: project!.id } : { ...t, projectId: undefined });

  // ---- projects ----
  const sharedPool = <T extends { name: string; scope: string }>(pools: T[], name: string) => pools.find((p) => p.scope === "shared" && p.name === name);
  const createProject = (name: string) =>
    upd((w) => {
      const tp = [1, 2, 3].map((n) => sharedPool(w.textPools, `Slide ${n} text`)).filter(Boolean) as TextPool[];
      const pp = [1, 2, 3].map((n) => sharedPool(w.picPools, `Slide ${n} pictures`)).filter(Boolean) as PicPool[];
      const p = newProject(name, tp, pp);
      return { ...w, projects: [...w.projects, p], currentProjectId: p.id };
    });
  const duplicateProject = () =>
    upd((w) => {
      const src = w.projects.find((x) => x.id === w.currentProjectId)!;
      const id = uid();
      const map = new Map<string, string>();
      const tCopies = w.textPools.filter((p) => p.scope === "project" && p.projectId === src.id).map((p) => { const n = uid(); map.set(p.id, n); return { ...p, id: n, projectId: id }; });
      const pCopies = w.picPools.filter((p) => p.scope === "project" && p.projectId === src.id).map((p) => { const n = uid(); map.set(p.id, n); return { ...p, id: n, projectId: id, pics: [...p.pics] }; });
      const slides = src.slides.map((s) => ({
        ...s, id: uid(), pic: { ...s.pic }, style: { ...s.style },
        textSource: s.textSource.kind === "pool" ? { kind: "pool" as const, poolId: map.get(s.textSource.poolId) ?? s.textSource.poolId } : s.textSource,
        picPoolId: s.picPoolId ? map.get(s.picPoolId) ?? s.picPoolId : null,
      }));
      const copy: Project = { id, name: src.name + " (copy)", slides, lyrics: [], lyricsSectionId: null, generated: null, selectedSlide: 0 };
      return { ...w, textPools: [...w.textPools, ...tCopies], picPools: [...w.picPools, ...pCopies], projects: [...w.projects, copy], currentProjectId: id };
    });
  const deleteProject = () =>
    upd((w) => {
      const id = w.currentProjectId;
      const textPools = w.textPools.filter((p) => !(p.scope === "project" && p.projectId === id));
      const picPools = w.picPools.filter((p) => !(p.scope === "project" && p.projectId === id));
      let projects = w.projects.filter((p) => p.id !== id);
      if (!projects.length) projects = [newProject("New release", textPools.slice(0, 2), picPools.slice(0, 3))];
      return { ...w, textPools, picPools, projects, currentProjectId: projects[0].id };
    });

  // ---- export ----
  async function buildFiles() {
    const p = project!;
    const ext = ws!.exportFormat;
    const out: { name: string; blob: Blob }[] = [];
    for (let i = 0; i < p.slides.length; i++) {
      const g = p.generated?.[i];
      const img = g?.picId ? await loadDriveImage(g.picId) : null;
      out.push({ name: `slide${i + 1}.${ext}`, blob: await slideToBlob(p.slides[i], img, g?.text ?? "", ext) });
    }
    return out;
  }
  async function downloadAll() {
    if (!project?.generated) return say("Generate a carousel first");
    setBusy(true);
    try {
      const files = await buildFiles();
      const folder = `${safe(project.name)} ${stamp()}`;
      const zip = new JSZip();
      const dir = zip.folder(folder)!;
      files.forEach((f) => dir.file(f.name, f.blob));
      download(await zip.generateAsync({ type: "blob" }), `${folder}.zip`);
    } catch (e: any) { say(e?.message ?? "Export failed"); }
    setBusy(false);
  }
  async function shareAll() {
    if (!project?.generated) return say("Generate a carousel first");
    setBusy(true);
    try {
      const files = (await buildFiles()).map((f) => new File([f.blob], f.name, { type: f.blob.type }));
      if (navigator.canShare?.({ files })) await navigator.share({ files });
      else say("Sharing files is not supported on this device");
    } catch (e: any) { if (e?.name !== "AbortError") say(e?.message ?? "Share failed"); }
    setBusy(false);
  }
  async function saveOne(i: number) {
    try {
      const p = project!, g = p.generated?.[i];
      const img = g?.picId ? await loadDriveImage(g.picId) : null;
      const ext = ws!.exportFormat;
      download(await slideToBlob(p.slides[i], img, g?.text ?? "", ext), `${safe(p.name)} slide${i + 1}.${ext}`);
    } catch (e: any) { say(e?.message ?? "Export failed"); }
  }

  // ---- backup / restore ----
  const backup = () => download(new Blob([JSON.stringify(ws)], { type: "application/json" }), `TkTgen backup ${stamp()}.json`);
  const restore = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      if (data?.v !== 1 || !Array.isArray(data.projects) || !data.projects.length) throw new Error("This is not a TkTgen backup");
      setOverlay({ k: "confirm", title: "Restore backup", label: "Replace everything", message: "This replaces all your current projects and pools with the backup. This can't be undone.", run: () => { setWs(data as Workspace); say("Backup restored"); } });
    } catch (e: any) { say(e?.message ?? "Could not read this file"); }
  };

  if (loadErr) return <div className="login"><div className="login-card"><h2>Could not load your data</h2><p className="muted">{loadErr}</p><button className="btn red" onClick={() => location.reload()}>Try again</button></div></div>;
  if (!ws || !project) return <div className="login"><p className="muted">Loading…</p></div>;

  const sel = Math.min(project.selectedSlide, project.slides.length - 1);
  const edText = editor?.k === "text" ? ws.textPools.find((t) => t.id === editor.id) : undefined;
  const edPics = editor?.k === "pics" ? ws.picPools.find((t) => t.id === editor.id) : undefined;
  const pools = tab === "text" ? vText : vPics;

  return (
    <div className="app">
      <header className="top">
        <div className="logo"><Logo /> TkTgen <small>{VERSION}</small></div>
        <select className="input" style={{ width: 200 }} aria-label="Project" value={project.id} onChange={(e) => upd((w) => ({ ...w, currentProjectId: e.target.value }))}>
          {ws.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button className="btn" onClick={() => setOverlay({ k: "newProject" })}>+ New</button>
        <div style={{ position: "relative" }}>
          <button className="btn" aria-label="Project menu" onClick={() => setMenu((m) => !m)}>•••</button>
          {menu && (
            <div className="menu" onMouseLeave={() => setMenu(false)}>
              <button onClick={() => { setMenu(false); setOverlay({ k: "rename" }); }}>Rename</button>
              <button onClick={() => { setMenu(false); duplicateProject(); }}>Duplicate</button>
              <button onClick={() => { setMenu(false); setOverlay({ k: "confirm", title: "Delete project", label: "Delete", message: `Are you sure you want to delete "${project.name}"? Its slide setup and project-only pools will be deleted too. This can't be undone.`, run: deleteProject }); }}>Delete</button>
            </div>
          )}
        </div>
        <span className="grow" />
        <button className="btn" onClick={() => setOverlay({ k: "extract", poolId: null })}>Extract hooks from screenshots</button>
        <button className="btn" onClick={backup}>Backup</button>
        <button className="btn" onClick={() => restoreInput.current?.click()}>Restore</button>
        <input ref={restoreInput} type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) restore(f); e.target.value = ""; }} />
        <span className={"badge " + (saveState === "error" ? "bad" : "dim")}>{saveState === "saved" ? "Saved" : saveState === "saving" ? "Saving…" : "Not saved"}</span>
        <button className="btn ghost sm" title={userName} onClick={() => signOut({ callbackUrl: "/" })}>Sign out</button>
      </header>

      <div className="main">
        <aside className="col left">
          <div className="tabs">
            <button className={"tab" + (tab === "text" ? " on" : "")} onClick={() => setTab("text")}>Text pools</button>
            <button className={"tab" + (tab === "pics" ? " on" : "")} onClick={() => setTab("pics")}>Picture pools</button>
          </div>
          {pools.map((p) => (
            <div key={p.id} className="pool" onClick={() => setEditor({ k: tab, id: p.id })}>
              <div className="grow">
                <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {"pics" in p ? `${p.pics.length} pictures` : p.kind === "block" ? "lyrics block" : `${textItems(p).length} texts`} · {p.scope === "shared" ? "shared" : "this project"}
                </div>
              </div>
              <button className="del" aria-label={`Delete ${p.name}`} onClick={(e) => { e.stopPropagation(); askDeletePool(tab, p.id); }}>🗑</button>
            </div>
          ))}
          <button className="btn" style={{ width: "100%" }} onClick={() => setOverlay({ k: "newPool" })}>+ New pool</button>
        </aside>

        <main className="col center">
          <div className="toolbar">
            <button className="btn red" onClick={generate} title="Shortcut: G">Generate</button>
            <div className="row" style={{ gap: 4 }}>
              <button className="btn sm" aria-label="Fewer slides" onClick={removeSlide} disabled={project.slides.length <= 1}>−</button>
              <span>{project.slides.length} slide{project.slides.length > 1 ? "s" : ""}</span>
              <button className="btn sm" aria-label="More slides" onClick={addSlide} disabled={project.slides.length >= 10}>+</button>
            </div>
            <select className="input" style={{ width: 170 }} aria-label="Lyrics section" value={project.lyricsSectionId ?? ""} onChange={(e) => updProject((p) => ({ ...p, lyricsSectionId: e.target.value || null }))}>
              <option value="">{project.lyrics.length ? "Lyrics: first section" : "Lyrics: none yet"}</option>
              {project.lyrics.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            <button className="btn" onClick={() => setOverlay({ k: "lyrics" })}>Edit lyrics</button>
            <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={ws.noRepeat} onChange={(e) => upd((w) => ({ ...w, noRepeat: e.target.checked }))} /> No repeats</label>
            <label className="row" style={{ gap: 4 }} title="Hooks imported from TikTok are drawn more often the more views they got"><input type="checkbox" checked={!!ws.favorTop} onChange={(e) => upd((w) => ({ ...w, favorTop: e.target.checked }))} /> Favor top hooks</label>
            <span className="grow" />
            <select className="input" style={{ width: 80 }} aria-label="Export format" value={ws.exportFormat} onChange={(e) => upd((w) => ({ ...w, exportFormat: e.target.value as "jpg" | "png" }))}>
              <option value="jpg">JPG</option><option value="png">PNG</option>
            </select>
            <button className="btn" onClick={downloadAll} disabled={busy || !project.generated}>{busy ? "Exporting…" : "Download all"}</button>
            {typeof navigator !== "undefined" && "canShare" in navigator && <button className="btn" onClick={shareAll} disabled={busy || !project.generated}>Share</button>}
          </div>
          {!project.generated && <p className="muted">Pick your pools, add some pictures from Google Drive and hooks, then press <b>Generate</b>.</p>}
          <div className="slides">
            {project.slides.map((cfg, i) => (
              <SlideCard key={cfg.id} index={i} cfg={cfg} gen={project.generated?.[i]} selected={i === sel}
                textPools={vText} picPools={vPics} zones={ws.zones} fontsReady={fontsReady}
                onSelect={() => i !== project.selectedSlide && updProject((p) => ({ ...p, selectedSlide: i }))}
                onCfg={(fn) => updSlide(i, fn)} onText={(t) => setGen(i, { text: t })}
                onRerollPic={() => rerollPic(i)} onRerollText={() => rerollText(i)} onSave={() => saveOne(i)} />
            ))}
          </div>
        </main>

        <aside className="col right">
          <Inspector index={sel} cfg={project.slides[sel]} zones={ws.zones} onZones={(v) => upd((w) => ({ ...w, zones: v }))}
            onCfg={(fn) => updSlide(sel, fn)} onApplyAll={applyAll} />
        </aside>
      </div>

      {edText && (
        <TextPoolEditor pool={edText} onClose={() => setEditor(null)} onDelete={() => askDeletePool("text", edText.id)}
          onChange={(fn) => setTextPool(edText.id, (t) => scopeFix(fn(t)))} onExtract={() => setOverlay({ k: "extract", poolId: edText.id })} />
      )}
      {edPics && (
        <PicPoolEditor pool={edPics} onClose={() => setEditor(null)} onDelete={() => askDeletePool("pics", edPics.id)}
          onChange={(fn) => setPicPool(edPics.id, (t) => scopeFix(fn(t)))} onBrowse={() => setOverlay({ k: "drive", poolId: edPics.id })} />
      )}

      {overlay?.k === "drive" && (
        <DriveBrowser onClose={() => setOverlay(null)} onAdd={(pics: PicRef[], toAll: boolean) => {
          const ids = new Set<string>([overlay.poolId]);
          if (toAll) project.slides.forEach((s) => s.picPoolId && ids.add(s.picPoolId));
          upd((w) => ({
            ...w,
            picPools: w.picPools.map((t) => {
              if (!ids.has(t.id)) return t;
              const have = new Set(t.pics.map((x) => x.id));
              return { ...t, pics: [...t.pics, ...pics.filter((x) => !have.has(x.id))] };
            }),
          }));
          say(`${pics.length} picture${pics.length > 1 ? "s" : ""} added${ids.size > 1 ? ` to ${ids.size} pools` : ""}`);
        }} />
      )}
      {overlay?.k === "extract" && (
        <HooksExtract pools={vText} initialPoolId={overlay.poolId} initialSource={overlay.source} onClose={() => setOverlay(null)} onAdd={(id, hooks: NewHook[]) => {
          setTextPool(id, (t) => {
            const views = { ...(t.views ?? {}) };
            hooks.forEach((h) => { if (h.views !== undefined) views[hookKey(h.text)] = h.views; });
            return {
              ...t,
              text: (t.text.trim() ? t.text.replace(/\s+$/, "") + "\n" : "") + hooks.map((h) => h.text).join("\n"),
              ...(Object.keys(views).length ? { views } : {}),
            };
          });
          say(`${hooks.length} hook${hooks.length > 1 ? "s" : ""} added`);
        }} />
      )}
      {overlay?.k === "newPool" && <NewPoolDialog tab={tab} onCreate={createPool} onClose={() => setOverlay(null)} />}
      {overlay?.k === "newProject" && <PromptDialog title="New project" label="Release name" confirmLabel="Create" onSubmit={createProject} onClose={() => setOverlay(null)} />}
      {overlay?.k === "rename" && <PromptDialog title="Rename project" label="Name" initial={project.name} confirmLabel="Rename" onSubmit={(n) => updProject((p) => ({ ...p, name: n }))} onClose={() => setOverlay(null)} />}
      {overlay?.k === "confirm" && <ConfirmDialog title={overlay.title} message={overlay.message} confirmLabel={overlay.label} onConfirm={overlay.run} onClose={() => setOverlay(null)} />}
      {overlay?.k === "lyrics" && (
        <Modal title={`Lyrics · ${project.name}`} wide onClose={() => setOverlay(null)}>
          <p className="muted" style={{ margin: 0 }}>Split the song into sections (verse, chorus…). Pick which one goes on the slides with the Lyrics menu. Line breaks are kept exactly as typed.</p>
          <div style={{ display: "grid", gap: 10, maxHeight: "56dvh", overflow: "auto" }}>
            {project.lyrics.map((l) => (
              <div key={l.id} style={{ display: "grid", gap: 6 }}>
                <div className="row">
                  <input className="input grow" value={l.name} aria-label="Section name" onChange={(e) => updProject((p) => ({ ...p, lyrics: p.lyrics.map((x) => (x.id === l.id ? { ...x, name: e.target.value } : x)) }))} />
                  <button className="btn sm" onClick={() => updProject((p) => ({ ...p, lyrics: p.lyrics.filter((x) => x.id !== l.id), lyricsSectionId: p.lyricsSectionId === l.id ? null : p.lyricsSectionId }))}>🗑</button>
                </div>
                <textarea className="input" rows={5} value={l.text} onChange={(e) => updProject((p) => ({ ...p, lyrics: p.lyrics.map((x) => (x.id === l.id ? { ...x, text: e.target.value } : x)) }))} />
              </div>
            ))}
          </div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <button className="btn" onClick={() => updProject((p) => {
              const names = ["Verse 1", "Chorus", "Verse 2", "Bridge", "Outro"];
              const section = { id: uid(), name: names[p.lyrics.length] ?? `Section ${p.lyrics.length + 1}`, text: "" };
              return { ...p, lyrics: [...p.lyrics, section], lyricsSectionId: p.lyricsSectionId ?? section.id };
            })}>+ Add section</button>
            <button className="btn red" onClick={() => setOverlay(null)}>Done</button>
          </div>
        </Modal>
      )}
      <Toast msg={toast} />
    </div>
  );
}
