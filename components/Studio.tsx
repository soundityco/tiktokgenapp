"use client";
import JSZip from "jszip";
import { signOut } from "next-auth/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { defaultWorkspace, isSlidePhotoList, newProject, newSlide, slidePools, uid } from "@/lib/defaults";
import { loadDriveImage } from "@/lib/drive";
import { generateAll, hookKey, pickPic, pickText, poolsVisible, textItems } from "@/lib/generate";
import { useT } from "@/lib/i18n";
import { loadFonts, slideToBlob } from "@/lib/render";
import type { GenSlide, PicPool, PicRef, Project, SlideCfg, TextPool, Workspace } from "@/lib/types";
import DriveBrowser from "./DriveBrowser";
import HooksExtract, { NewHook } from "./HooksExtract";
import Inspector from "./Inspector";
import Logo from "./Logo";
import { PicPoolEditor, TextPoolEditor } from "./PoolEditors";
import SlideCard from "./SlideCard";
import { ConfirmDialog, Menu, Modal, NewPoolDialog, PromptDialog, Toast } from "./ui";

const VERSION = "v0.2";

type Editor = { k: "text" | "photos"; id: string } | null;
type Overlay =
  | null
  | { k: "drive"; poolId: string }
  | { k: "import"; poolId: string | null; source?: "tiktok" }
  | { k: "lyrics" }
  | { k: "newPool"; kind: "text" | "photos" }
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
  const { t, lang, setLang } = useT();
  const [ws, setWs] = useState<Workspace | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error" | "conflict">("saved");
  const [editor, setEditor] = useState<Editor>(null);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [fontsReady, setFontsReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const loaded = useRef(false);
  const rev = useRef(0);
  const conflict = useRef(false);
  const [resume, setResume] = useState(0);
  const restoreInput = useRef<HTMLInputElement>(null);

  const say = useCallback((m: string) => { setToast(m); setTimeout(() => setToast(null), 2600); }, []);

  // ---- load / autosave ----
  useEffect(() => {
    const flag = new URLSearchParams(location.search).get("tiktok");
    if (flag) {
      history.replaceState(null, "", "/studio");
      if (flag === "connected") setOverlay({ k: "import", poolId: null, source: "tiktok" });
      const msg: Record<string, string> = { connected: "TikTok connected", denied: "TikTok connection was cancelled", badstate: "TikTok connection failed (security check). Try again.", error: "TikTok connection failed. Try again.", notconfigured: "TikTok is not set up on this site yet" };
      setTimeout(() => say(t(msg[flag] ?? "TikTok")), 300);
    }
    loadFonts().then(() => setFontsReady(true));
    fetch("/api/workspace")
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "Could not load your data");
        rev.current = j.data?.rev ?? 0;
        setWs(j.data && j.data.v === 1 ? (j.data as Workspace) : defaultWorkspace());
      })
      .catch((e) => setLoadErr(String(e.message ?? e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ws || conflict.current) return;
    if (!loaded.current) { loaded.current = true; return; }
    setSaveState("saving");
    const timer = setTimeout(async () => {
      try {
        const r = await fetch("/api/workspace", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: ws, baseRev: rev.current }) });
        const j = await r.json().catch(() => ({}));
        if (r.ok) { rev.current = j.rev; setSaveState("saved"); }
        else if (r.status === 409) { rev.current = j.rev; conflict.current = true; setSaveState("conflict"); }
        else setSaveState("error");
      } catch { setSaveState("error"); }
    }, 1000);
    return () => clearTimeout(timer);
  }, [ws, resume]);

  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (saveState === "saving" || saveState === "error") e.preventDefault(); };
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
      const el = e.target as HTMLElement;
      if (/INPUT|TEXTAREA|SELECT/.test(el.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
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
      let tp = textPools.find((x) => x.scope === "shared" && x.name === `Slide ${n} text`);
      let pp = picPools.find((x) => x.scope === "shared" && isSlidePhotoList(x.name, n));
      const fresh = slidePools(n);
      if (!tp) { tp = fresh.text; textPools = [...textPools, tp]; }
      if (!pp) { pp = fresh.pics; picPools = [...picPools, pp]; }
      const last = p.slides[p.slides.length - 1];
      const s: SlideCfg = { ...newSlide(n, tp.id, pp.id), format: last.format, pic: { ...last.pic, ox: 0, oy: 0 }, style: { ...last.style } };
      return { ...w, textPools, picPools, projects: w.projects.map((x) => (x.id === p.id ? { ...x, slides: [...x.slides, s], selectedSlide: n - 1 } : x)) };
    });
  const removeSlide = () =>
    updProject((p) => p.slides.length <= 1 ? p : { ...p, slides: p.slides.slice(0, -1), generated: p.generated?.slice(0, p.slides.length - 1) ?? null, selectedSlide: Math.min(p.selectedSlide, p.slides.length - 2) });

  const applyAll = () => {
    updProject((p) => {
      const src = p.slides[p.selectedSlide];
      return { ...p, slides: p.slides.map((s) => ({ ...s, format: src.format, pic: { ...src.pic }, style: { ...src.style } })) };
    });
    say(t("Settings copied to all slides"));
  };

  // ---- lists (pools) ----
  const createPool = (name: string, scope: "shared" | "project", kind: "hooks" | "block") => {
    const projectId = scope === "project" ? project!.id : undefined;
    if (overlay?.k === "newPool" && overlay.kind === "text") upd((w) => ({ ...w, textPools: [...w.textPools, { id: uid(), name, scope, projectId, kind, text: "" }] }));
    else upd((w) => ({ ...w, picPools: [...w.picPools, { id: uid(), name, scope, projectId, pics: [] }] }));
  };
  const askDeletePool = (kind: "text" | "photos", id: string) => {
    const pool = kind === "text" ? ws!.textPools.find((p) => p.id === id) : ws!.picPools.find((p) => p.id === id);
    if (!pool) return;
    const n = kind === "text" ? textItems(pool as TextPool).length : (pool as PicPool).pics.length;
    setOverlay({
      k: "confirm", title: t("Delete list"), label: t("Delete"),
      message: kind === "text"
        ? t("Are you sure you want to delete “{name}”? Its {n} texts will be deleted too. This can't be undone.", { name: pool.name, n })
        : t("Are you sure you want to delete “{name}”? Its {n} photos will be removed from the list (they stay in your Drive). This can't be undone.", { name: pool.name, n }),
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
  const setTextPool = (id: string, fn: (x: TextPool) => TextPool) => upd((w) => ({ ...w, textPools: w.textPools.map((x) => (x.id === id ? fn(x) : x)) }));
  const setPicPool = (id: string, fn: (x: PicPool) => PicPool) => upd((w) => ({ ...w, picPools: w.picPools.map((x) => (x.id === id ? fn(x) : x)) }));
  const scopeFix = <T extends { scope: string; projectId?: string }>(x: T): T => (x.scope === "project" ? { ...x, projectId: project!.id } : { ...x, projectId: undefined });

  // ---- projects ----
  const sharedPool = <T extends { name: string; scope: string }>(pools: T[], name: string) => pools.find((p) => p.scope === "shared" && p.name === name);
  const createProject = (name: string) =>
    upd((w) => {
      const tp = [1, 2, 3].map((n) => sharedPool(w.textPools, `Slide ${n} text`)).filter(Boolean) as TextPool[];
      const pp = [1, 2, 3].map((n) => w.picPools.find((x) => x.scope === "shared" && isSlidePhotoList(x.name, n))).filter(Boolean) as PicPool[];
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
      const copy: Project = { id, name: src.name + " " + t("(copy)"), slides, lyrics: [], lyricsSectionId: null, generated: null, selectedSlide: 0 };
      return { ...w, textPools: [...w.textPools, ...tCopies], picPools: [...w.picPools, ...pCopies], projects: [...w.projects, copy], currentProjectId: id };
    });
  const deleteProject = () =>
    upd((w) => {
      const id = w.currentProjectId;
      const textPools = w.textPools.filter((p) => !(p.scope === "project" && p.projectId === id));
      const picPools = w.picPools.filter((p) => !(p.scope === "project" && p.projectId === id));
      let projects = w.projects.filter((p) => p.id !== id);
      if (!projects.length) projects = [newProject(t("New release"), textPools.slice(0, 2), picPools.slice(0, 3))];
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
    if (!project?.generated) return say(t("Generate a carousel first"));
    setBusy(true);
    try {
      const files = await buildFiles();
      const folder = `${safe(project.name)} ${stamp()}`;
      const zip = new JSZip();
      const dir = zip.folder(folder)!;
      files.forEach((f) => dir.file(f.name, f.blob));
      download(await zip.generateAsync({ type: "blob" }), `${folder}.zip`);
    } catch (e: any) { say(e?.message ?? t("Export failed")); }
    setBusy(false);
  }
  async function shareAll() {
    if (!project?.generated) return say(t("Generate a carousel first"));
    setBusy(true);
    try {
      const files = (await buildFiles()).map((f) => new File([f.blob], f.name, { type: f.blob.type }));
      if (navigator.canShare?.({ files })) await navigator.share({ files });
      else say(t("Sharing files is not supported on this device"));
    } catch (e: any) { if (e?.name !== "AbortError") say(e?.message ?? t("Share failed")); }
    setBusy(false);
  }
  async function saveOne(i: number) {
    try {
      const p = project!, g = p.generated?.[i];
      const img = g?.picId ? await loadDriveImage(g.picId) : null;
      const ext = ws!.exportFormat;
      download(await slideToBlob(p.slides[i], img, g?.text ?? "", ext), `${safe(p.name)} slide${i + 1}.${ext}`);
    } catch (e: any) { say(e?.message ?? t("Export failed")); }
  }

  // ---- backup / restore ----
  const backup = () => download(new Blob([JSON.stringify(ws)], { type: "application/json" }), `TkTgen backup ${stamp()}.json`);
  const restore = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      if (data?.v !== 1 || !Array.isArray(data.projects) || !data.projects.length) throw new Error(t("This is not a TkTgen backup"));
      setOverlay({ k: "confirm", title: t("Restore a backup"), label: t("Replace everything"), message: t("This replaces all your current projects and lists with the backup. This can't be undone."), run: () => { setWs(data as Workspace); say(t("Backup restored")); } });
    } catch (e: any) { say(e?.message ?? t("Could not read this file")); }
  };

  // rev.current already holds the server revision returned with the 409: resuming the autosave overwrites it.
  const keepMine = () => { conflict.current = false; setSaveState("saving"); setResume((n) => n + 1); };

  if (loadErr) return <div className="login"><div className="login-card"><h2 className="title">{t("Could not load your data")}</h2><p className="muted">{loadErr}</p><button className="btn primary" onClick={() => location.reload()}>{t("Try again")}</button></div></div>;
  if (!ws || !project) return <div className="login"><p className="muted">{t("Loading…")}</p></div>;

  const sel = Math.min(project.selectedSlide, project.slides.length - 1);
  const edText = editor?.k === "text" ? ws.textPools.find((x) => x.id === editor.id) : undefined;
  const edPics = editor?.k === "photos" ? ws.picPools.find((x) => x.id === editor.id) : undefined;
  const nSlides = project.slides.length;

  const listRows = (kind: "text" | "photos") =>
    (kind === "text" ? vText : vPics).map((p) => (
      <div key={p.id} className="item" role="button" tabIndex={0} onClick={() => setEditor({ k: kind, id: p.id })}
        onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) setEditor({ k: kind, id: p.id }); }}>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="truncate">{p.name}</div>
          <div className="muted xs">
            {"pics" in p ? t("{n} photos", { n: p.pics.length }) : p.kind === "block" ? t("Lyrics block") : t("{n} texts", { n: textItems(p).length })}
            {" · "}{p.scope === "shared" ? t("all projects") : t("this project")}
          </div>
        </div>
        <button className="btn quiet icon sm del" aria-label={t("Delete {name}", { name: p.name })} title={t("Delete")}
          onClick={(e) => { e.stopPropagation(); askDeletePool(kind, p.id); }}>🗑</button>
      </div>
    ));

  return (
    <div className="app">
      <header className="top">
        <div className="brand"><Logo /> TkTgen <small>{VERSION}</small></div>
        <select className="input" style={{ width: 210 }} aria-label={t("Project")} value={project.id} onChange={(e) => upd((w) => ({ ...w, currentProjectId: e.target.value }))}>
          {ws.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button className="btn icon" aria-label={t("New project")} title={t("New project")} onClick={() => setOverlay({ k: "newProject" })}>+</button>
        <Menu left trigger={(_, toggle) => <button className="btn icon quiet" aria-label={t("Project menu")} onClick={toggle}>⋯</button>}>
          {(close) => (<>
            <button onClick={() => { close(); setOverlay({ k: "rename" }); }}>{t("Rename")}</button>
            <button onClick={() => { close(); duplicateProject(); }}>{t("Duplicate")}</button>
            <div className="sep" />
            <button className="danger" style={{ color: "var(--danger)" }} onClick={() => { close(); setOverlay({ k: "confirm", title: t("Delete project"), label: t("Delete"), message: t("Are you sure you want to delete “{name}”? Its slide setup and project-only lists will be deleted too. This can't be undone.", { name: project.name }), run: deleteProject }); }}>{t("Delete")}</button>
          </>)}
        </Menu>
        <span className="grow" />
        <span className={"badge " + (saveState === "error" || saveState === "conflict" ? "bad" : "")}>
          {saveState === "saved" ? t("Saved") : saveState === "saving" ? t("Saving…") : saveState === "conflict" ? t("Not saved") : t("Not saved")}
        </span>
        <button className="btn" onClick={() => setOverlay({ k: "import", poolId: null })}>{t("Import hooks")}</button>
        <Menu trigger={(_, toggle) => <button className="btn icon quiet" aria-label={t("Settings and account")} title={userName} onClick={toggle}>⚙</button>}>
          {(close) => (<>
            <div className="label">{t("Language")}</div>
            <button onClick={() => { setLang("en"); close(); }}>{lang === "en" ? "✓ " : ""}English</button>
            <button onClick={() => { setLang("fr"); close(); }}>{lang === "fr" ? "✓ " : ""}Français</button>
            <div className="sep" />
            <button onClick={() => { close(); backup(); }}>{t("Back up my data")}</button>
            <button onClick={() => { close(); restoreInput.current?.click(); }}>{t("Restore a backup")}</button>
            <div className="sep" />
            <div className="label truncate">{userName}</div>
            <button onClick={() => signOut({ callbackUrl: "/" })}>{t("Sign out")}</button>
          </>)}
        </Menu>
        <input ref={restoreInput} type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) restore(f); e.target.value = ""; }} />
      </header>

      {saveState === "conflict" && (
        <div className="notice warn row" style={{ margin: "var(--s3) var(--s4) 0", justifyContent: "space-between" }}>
          <span>{t("Your data was changed on another device or tab. Your latest edits are not saved yet.")}</span>
          <span className="row">
            <button className="btn sm" onClick={() => location.reload()}>{t("Load the latest version")}</button>
            <button className="btn sm primary" onClick={keepMine}>{t("Keep my version")}</button>
          </span>
        </div>
      )}

      <div className="main">
        <aside className="col side l">
          <section className="group">
            <div className="group-head"><h3>{t("Texts")}</h3><button className="btn quiet icon sm" aria-label={t("New text list")} title={t("New text list")} onClick={() => setOverlay({ k: "newPool", kind: "text" })}>+</button></div>
            {listRows("text")}
          </section>
          <section className="group">
            <div className="group-head"><h3>{t("Photos")}</h3><button className="btn quiet icon sm" aria-label={t("New photo list")} title={t("New photo list")} onClick={() => setOverlay({ k: "newPool", kind: "photos" })}>+</button></div>
            {listRows("photos")}
          </section>
        </aside>

        <main className="col center">
          <div className="toolbar">
            <button className="btn primary" onClick={generate} title={t("Shortcut: G")}>{t("Generate")}</button>
            <div className="stepper">
              <button className="btn quiet icon sm" aria-label={t("Fewer slides")} onClick={removeSlide} disabled={nSlides <= 1}>−</button>
              <span>{nSlides === 1 ? t("1 slide") : t("{n} slides", { n: nSlides })}</span>
              <button className="btn quiet icon sm" aria-label={t("More slides")} onClick={addSlide} disabled={nSlides >= 10}>+</button>
            </div>
            <div className="row" style={{ gap: "var(--s1)" }}>
              <select className="input" style={{ width: 170 }} aria-label={t("Lyrics section")} value={project.lyricsSectionId ?? ""} onChange={(e) => updProject((p) => ({ ...p, lyricsSectionId: e.target.value || null }))}>
                <option value="">{project.lyrics.length ? t("Lyrics: first section") : t("Lyrics: none yet")}</option>
                {project.lyrics.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
              <button className="btn" onClick={() => setOverlay({ k: "lyrics" })}>{t("Edit lyrics")}</button>
            </div>
            <span className="grow" />
            <Menu trigger={(_, toggle) => <button className="btn" onClick={toggle}>{t("Options")} ▾</button>}>
              {() => (
                <div className="stack" style={{ padding: "var(--s2) var(--s3)", minWidth: 270 }}>
                  <label className="check"><input type="checkbox" checked={ws.noRepeat} onChange={(e) => upd((w) => ({ ...w, noRepeat: e.target.checked }))} />{t("No repeats until everything was used")}</label>
                  <label className="check"><input type="checkbox" checked={!!ws.favorTop} onChange={(e) => upd((w) => ({ ...w, favorTop: e.target.checked }))} />{t("Favor my best hooks (by TikTok views)")}</label>
                  <label className="field">{t("Export format")}
                    <select className="input" value={ws.exportFormat} onChange={(e) => upd((w) => ({ ...w, exportFormat: e.target.value as "jpg" | "png" }))}>
                      <option value="jpg">JPG</option><option value="png">PNG</option>
                    </select>
                  </label>
                </div>
              )}
            </Menu>
            <button className="btn" onClick={downloadAll} disabled={busy || !project.generated}>{busy ? t("Exporting…") : t("Download all")}</button>
            {typeof navigator !== "undefined" && "canShare" in navigator && <button className="btn" onClick={shareAll} disabled={busy || !project.generated}>{t("Share")}</button>}
          </div>
          {!project.generated && (
            <p className="muted" style={{ marginBottom: "var(--s4)" }}>
              {t("1. Add photos from your Drive  ·  2. Write or import your texts and lyrics  ·  3. Press Generate")}
            </p>
          )}
          <div className="slides">
            {project.slides.map((cfg, i) => (
              <SlideCard key={cfg.id} index={i} cfg={cfg} gen={project.generated?.[i]} selected={i === sel}
                textPools={vText} picPools={vPics} zones={ws.zones} fontsReady={fontsReady}
                onSelect={() => i !== project.selectedSlide && updProject((p) => ({ ...p, selectedSlide: i }))}
                onCfg={(fn) => updSlide(i, fn)} onText={(txt) => setGen(i, { text: txt })}
                onRerollPic={() => rerollPic(i)} onRerollText={() => rerollText(i)} onSave={() => saveOne(i)} />
            ))}
          </div>
        </main>

        <aside className="col side r">
          <Inspector index={sel} cfg={project.slides[sel]} zones={ws.zones} onZones={(v) => upd((w) => ({ ...w, zones: v }))}
            onCfg={(fn) => updSlide(sel, fn)} onApplyAll={applyAll} />
        </aside>
      </div>

      {edText && (
        <TextPoolEditor pool={edText} onClose={() => setEditor(null)} onDelete={() => askDeletePool("text", edText.id)}
          onChange={(fn) => setTextPool(edText.id, (x) => scopeFix(fn(x)))} onImport={() => setOverlay({ k: "import", poolId: edText.id })} />
      )}
      {edPics && (
        <PicPoolEditor pool={edPics} onClose={() => setEditor(null)} onDelete={() => askDeletePool("photos", edPics.id)}
          onChange={(fn) => setPicPool(edPics.id, (x) => scopeFix(fn(x)))} onBrowse={() => setOverlay({ k: "drive", poolId: edPics.id })} />
      )}

      {overlay?.k === "drive" && (
        <DriveBrowser onClose={() => setOverlay(null)} onAdd={(pics: PicRef[], toAll: boolean) => {
          const ids = new Set<string>([overlay.poolId]);
          if (toAll) project.slides.forEach((s) => s.picPoolId && ids.add(s.picPoolId));
          upd((w) => ({
            ...w,
            picPools: w.picPools.map((x) => {
              if (!ids.has(x.id)) return x;
              const have = new Set(x.pics.map((y) => y.id));
              return { ...x, pics: [...x.pics, ...pics.filter((y) => !have.has(y.id))] };
            }),
          }));
          say(ids.size > 1 ? t("{n} photos added to {m} lists", { n: pics.length, m: ids.size }) : t("{n} photos added", { n: pics.length }));
        }} />
      )}
      {overlay?.k === "import" && (
        <HooksExtract pools={vText} initialPoolId={overlay.poolId} initialSource={overlay.source} onClose={() => setOverlay(null)} onAdd={(id, hooks: NewHook[]) => {
          setTextPool(id, (x) => {
            const views = { ...(x.views ?? {}) };
            hooks.forEach((h) => { if (h.views !== undefined) views[hookKey(h.text)] = h.views; });
            return {
              ...x,
              text: (x.text.trim() ? x.text.replace(/\s+$/, "") + "\n" : "") + hooks.map((h) => h.text).join("\n"),
              ...(Object.keys(views).length ? { views } : {}),
            };
          });
          say(t("{n} hooks added", { n: hooks.length }));
        }} />
      )}
      {overlay?.k === "newPool" && <NewPoolDialog kind={overlay.kind} onCreate={createPool} onClose={() => setOverlay(null)} />}
      {overlay?.k === "newProject" && <PromptDialog title={t("New project")} label={t("Release name")} confirmLabel={t("Create")} onSubmit={createProject} onClose={() => setOverlay(null)} />}
      {overlay?.k === "rename" && <PromptDialog title={t("Rename project")} label={t("Name")} initial={project.name} confirmLabel={t("Rename")} onSubmit={(n) => updProject((p) => ({ ...p, name: n }))} onClose={() => setOverlay(null)} />}
      {overlay?.k === "confirm" && <ConfirmDialog title={overlay.title} message={overlay.message} confirmLabel={overlay.label} onConfirm={overlay.run} onClose={() => setOverlay(null)} />}
      {overlay?.k === "lyrics" && (
        <Modal title={t("Lyrics · {name}", { name: project.name })} wide onClose={() => setOverlay(null)}>
          <p className="muted">{t("Split the song into sections (verse, chorus…). Choose which one goes on the slides with the Lyrics menu. Line breaks are kept exactly as typed.")}</p>
          <div className="stack" style={{ maxHeight: "56dvh", overflow: "auto" }}>
            {project.lyrics.map((l) => (
              <div key={l.id} className="stack" style={{ gap: "var(--s2)" }}>
                <div className="row nowrap">
                  <input className="input grow" value={l.name} aria-label={t("Section name")} onChange={(e) => updProject((p) => ({ ...p, lyrics: p.lyrics.map((x) => (x.id === l.id ? { ...x, name: e.target.value } : x)) }))} />
                  <button className="btn quiet icon danger" aria-label={t("Delete section")} onClick={() => updProject((p) => ({ ...p, lyrics: p.lyrics.filter((x) => x.id !== l.id), lyricsSectionId: p.lyricsSectionId === l.id ? null : p.lyricsSectionId }))}>🗑</button>
                </div>
                <textarea className="input" rows={5} aria-label={t("Lyrics")} value={l.text} onChange={(e) => updProject((p) => ({ ...p, lyrics: p.lyrics.map((x) => (x.id === l.id ? { ...x, text: e.target.value } : x)) }))} />
              </div>
            ))}
          </div>
          <div className="modal-foot">
            <button className="btn left" onClick={() => updProject((p) => {
              const names = [t("Verse 1"), t("Chorus"), t("Verse 2"), t("Bridge"), t("Outro")];
              const section = { id: uid(), name: names[p.lyrics.length] ?? t("Section {n}", { n: p.lyrics.length + 1 }), text: "" };
              return { ...p, lyrics: [...p.lyrics, section], lyricsSectionId: p.lyricsSectionId ?? section.id };
            })}>+ {t("Add a section")}</button>
            <button className="btn primary" onClick={() => setOverlay(null)}>{t("Done")}</button>
          </div>
        </Modal>
      )}
      <Toast msg={toast} />
    </div>
  );
}
