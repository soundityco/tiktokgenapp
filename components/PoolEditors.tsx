"use client";
import { isLineList } from "@/lib/defaults";
import { useEffect, useRef, useState } from "react";
import { hookKey, joinCaptions, poolThemes, splitCaptions, textItems } from "@/lib/generate";
import { THEMES, themeGroups, themeLabel } from "@/lib/themes";
import { classifyThemes } from "@/lib/themeAI";
import { loadDriveImage } from "@/lib/drive";
import { useT } from "@/lib/i18n";
import { thumbnailLink } from "@/lib/thumb";
import type { PicPool, PicRef, TextPool } from "@/lib/types";
import Icon from "./Icon";
import { Modal, ScopeSelect, Select } from "./ui";

function Thumb({ id, name }: { id: string; name: string }) {
  const holder = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => e[0].isIntersecting && (setVisible(true), io.disconnect()), { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  // 1) Google's own thumbnail (tiny). 2) If unavailable, decode the picture and draw a small version.
  useEffect(() => {
    if (!visible) return;
    let off = false;
    thumbnailLink(id).then((l) => !off && (l ? setSrc(l) : setFallback(true)));
    return () => { off = true; };
  }, [visible, id]);
  useEffect(() => {
    if (!fallback) return;
    let off = false;
    loadDriveImage(id).then((img) => {
      const c = cv.current;
      if (off || !c) return;
      const s = Math.max(120 / img.width, 120 / img.height);
      c.width = 120; c.height = 120;
      c.getContext("2d")!.drawImage(img, (120 - img.width * s) / 2, (120 - img.height * s) / 2, img.width * s, img.height * s);
    }).catch(() => {});
    return () => { off = true; };
  }, [fallback, id]);

  return (
    <div ref={holder} className="thumb" title={name}>
      {fallback ? <canvas ref={cv} /> : src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" referrerPolicy="no-referrer" onError={() => setFallback(true)} />
      ) : null}
    </div>
  );
}

interface Common { onClose: () => void; onDelete: () => void }

/**
 * A captions list: one box per caption, written as it will be posted (line breaks, empty lines, hashtags on
 * their own line). Saved as one text, the captions separated by a "---" line.
 */
function CaptionsEditor({ text, onText }: { text: string; onText: (text: string) => void }) {
  const { t } = useT();
  // Edited here (an empty box being written stays); the list's text follows each change.
  const [items, setItems] = useState(() => { const x = splitCaptions(text); return x.length ? x : [""]; });
  const set = (next: string[]) => { setItems(next); onText(joinCaptions(next.filter((x) => x.trim()))); };
  return (
    <div className="caption-list">
      {items.map((c, i) => (
        <div className="caption-item" key={i}>
          <span className="idx">{String(i + 1).padStart(2, "0")}</span>
          <textarea className="input" rows={Math.min(8, Math.max(3, c.split("\n").length + 1))} value={c} aria-label={t("Caption {n}", { n: i + 1 })}
            placeholder={i === 0 && items.length === 1 ? t("e.g. My new song is out 🎧 tell me your favourite line in the comments") + "\n" + t("#newmusic #independentartist #rap") : t("The caption, then its hashtags (on their own line if you like).")}
            onChange={(e) => set(items.map((x, k) => (k === i ? e.target.value : x)))} />
          <button className="btn quiet icon sm" aria-label={t("Delete this caption")} title={t("Delete this caption")}
            onClick={() => set(items.length > 1 ? items.filter((_, k) => k !== i) : [""])}><Icon name="trash" size={14} /></button>
        </div>
      ))}
      <div><button className="btn sm" onClick={() => setItems([...items, ""])}><Icon name="plus" size={14} />{t("Add a caption")}</button></div>
    </div>
  );
}

/** A hooks list by theme: each group (found locally, or set by hand) with its texts; a text's theme can be changed. */
function ThemesView({ pool, onChange }: { pool: TextPool; onChange: (fn: (t: TextPool) => TextPool) => void }) {
  const { t } = useT();
  const items = textItems(pool);
  const themes = poolThemes(pool);
  const groups = themeGroups(themes);
  // Every theme one can move a text to: the lexicon's, the groups and names already in the list.
  const known = [...new Set([...THEMES.map((x) => x.id), ...themes.filter(Boolean)])];
  const setTheme = (text: string, id: string) => {
    if (id === "__new") {
      const name = window.prompt(t("Name of the new theme"))?.trim();
      if (!name) return;
      id = name;
    }
    onChange((x) => ({ ...x, themes: { ...(x.themes ?? {}), [hookKey(text)]: id } }));
  };
  const handSet = (text: string) => pool.themes?.[hookKey(text)] !== undefined;

  // The local model: the whole list the first time, then only the texts added since.
  const [ai, setAi] = useState<null | { step: "model" | "think"; pct: number }>(null);
  const [aiErr, setAiErr] = useState<string | null>(null);
  const missing = items.filter((x) => !(hookKey(x) in (pool.aiThemes ?? {})));
  const runAi = async (texts: string[]) => {
    if (!texts.length || ai) return;
    setAiErr(null); setAi({ step: "model", pct: 0 });
    try {
      const found = await classifyThemes(texts, setAi);
      onChange((x) => ({ ...x, aiThemes: { ...(x.aiThemes ?? {}), ...Object.fromEntries(texts.map((tx, i) => [hookKey(tx), found[i]])) } }));
    } catch (e) {
      setAiErr(e instanceof Error ? e.message : String(e));
    } finally { setAi(null); }
  };
  // Already sorted by the model once: new texts are sorted as soon as the view opens.
  useEffect(() => { if (pool.aiThemes && missing.length) void runAi(missing); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const sorted = !!pool.aiThemes && !missing.length;

  return (
    <div className="theme-groups">
      <div className="row ai-row">
        {ai ? (
          <span className="xs shine grow">{ai.step === "model" ? t("Downloading the local model (once)… {n}%", { n: Math.round(ai.pct * 100) }) : t("Reading the texts… {n}%", { n: Math.round(ai.pct * 100) })}</span>
        ) : (
          <span className="muted xs grow">{sorted ? t("Sorted by the local model, on this device.") : t("Sorted by keywords. The local model understands the meaning better: it runs on this device, free, nothing is sent.")}</span>
        )}
        {!ai && <button className={"btn sm" + (sorted ? " quiet" : "")} onClick={() => void runAi(sorted ? items : missing.length ? missing : items)}>
          <Icon name="sparkle" size={13} />{sorted ? t("Sort again") : t("Sort with the local model")}</button>}
      </div>
      {aiErr && <p className="notice bad xs">{t("The local model could not run: {why}", { why: aiErr })}</p>}
      {groups.map((g) => (
        <section key={g.id || "other"} className="theme-group">
          <h4 className="label">{themeLabel(g.id, t)} <span className="muted">· {g.items.length}</span></h4>
          {g.items.map((i) => (
            <div key={i} className="row nowrap theme-item">
              <span className="grow truncate" title={items[i]}>{items[i].replace(/\|/g, " ")}</span>
              {handSet(items[i]) && (
                <button className="btn sm quiet" title={t("Back to the theme found automatically")}
                  onClick={() => onChange((x) => { const th = { ...(x.themes ?? {}) }; delete th[hookKey(items[i])]; return { ...x, themes: th }; })}>{t("Auto")}</button>
              )}
              <Select className="input sm" value={themes[i]} aria-label={t("Theme")} onChange={(e) => setTheme(items[i], e.target.value)}>
                {known.map((id) => <option key={id} value={id}>{themeLabel(id, t)}</option>)}
                <option value="">{t("Other")}</option>
                <option value="__new">{t("New theme…")}</option>
              </Select>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

export function TextPoolEditor(p: Common & { pool: TextPool; onChange: (fn: (t: TextPool) => TextPool) => void; onImport: () => void; onRefreshViews?: () => void; viewsBusy?: boolean }) {
  const { t } = useT();
  const { pool } = p;
  const file = useRef<HTMLInputElement>(null);
  const [imports, setImports] = useState(0); // a .txt added: the captions boxes are read again
  const [view, setView] = useState<"text" | "themes">("text");
  const n = textItems(pool).length;
  const perf = pool.kind === "hooks" && pool.views
    ? textItems(pool)
        .map((text) => ({ text, views: pool.views?.[hookKey(text)] ?? 0 }))
        .filter((x) => x.views > 0)
        .sort((a, b) => b.views - a.views)
        .slice(0, 8)
    : [];
  return (
    <Modal title={t("Text list")} onClose={p.onClose} wide>
      <div className="cols2">
        <label className="field">{t("Name")}<input className="input" value={pool.name} onChange={(e) => p.onChange((x) => ({ ...x, name: e.target.value }))} /></label>
        <ScopeSelect value={pool.scope} onChange={(v) => p.onChange((x) => ({ ...x, scope: v }))} />
      </div>
      <label className="field">{t("Role")}
        <Select className="input" value={pool.kind} onChange={(e) => p.onChange((x) => ({ ...x, kind: e.target.value as TextPool["kind"] }))}>
          <option value="hooks">{t("Hooks · the opening of a post (slide 1, the videos)")}</option>
          <option value="texts">{t("Texts · the other slides (transitions…)")}</option>
          {/* Lyrics now live in the release (Lyrics button): an older block list keeps its type, no new one. */}
          {pool.kind === "block" && <option value="block">{t("Lyrics block")}</option>}
          <option value="captions">{t("Captions · the post's text, with its hashtags")}</option>
        </Select>
      </label>
      {isLineList(pool) && n > 1 && (
        <div className="row seg-tabs" role="tablist">
          <button role="tab" aria-selected={view === "text"} className={"btn sm" + (view === "text" ? " on" : "")} onClick={() => setView("text")}>{t("Texts")}</button>
          <button role="tab" aria-selected={view === "themes"} className={"btn sm" + (view === "themes" ? " on" : "")} onClick={() => setView("themes")}>{t("By theme")}</button>

        </div>
      )}
      {isLineList(pool) && view === "themes" && n > 1 ? (
        <ThemesView pool={pool} onChange={p.onChange} />
      ) : pool.kind === "captions" ? (
        <CaptionsEditor key={`${pool.id}:${imports}`} text={pool.text} onText={(text) => p.onChange((x) => ({ ...x, text }))} />
      ) : (
        <textarea className="input" rows={12} aria-label={t("Texts")} value={pool.text} onChange={(e) => p.onChange((x) => ({ ...x, text: e.target.value }))}
          placeholder={isLineList(pool) ? t("One text per line. Use | to force a line break on the slide.")
            : t("Paste the whole text. It is placed on the slide line by line, exactly as typed.")} />
      )}
      {perf.length > 0 && (
        <details className="sec">
          <summary>{t("Best hooks by views")}</summary>
          <div className="body">
            {perf.map((row) => (
              <div className="row" key={row.text}>
                <span className="grow truncate">{row.text}</span>
                <span className="muted xs">{t("{n} views", { n: row.views.toLocaleString("en-US") })}</span>
              </div>
            ))}
          </div>
        </details>
      )}
      <div className="row">
        <span className="muted grow">{isLineList(pool) ? t("{n} texts", { n }) : pool.kind === "captions" ? t("{n} captions", { n }) : n ? t("1 block") : t("Empty")}</span>
        <input ref={file} type="file" accept=".txt,text/plain" hidden onChange={async (e) => {
          const f = e.target.files?.[0];
          if (f) { const txt = await f.text(); p.onChange((x) => ({ ...x, text: x.kind === "captions" ? joinCaptions([...splitCaptions(x.text), ...splitCaptions(txt)])
            : x.text.trim() ? x.text.replace(/\s+$/, "") + "\n" + txt : txt })); setImports((k) => k + 1); }
          e.target.value = "";
        }} />
        <button className="btn sm" onClick={() => file.current?.click()}>{t("Import .txt")}</button>
        {pool.kind === "hooks" && <button className="btn sm primary" onClick={p.onImport} title={t("From TikTok screenshots or your TikTok account")}><Icon name="tiktok" size={14} />{t("Import hooks from TikTok")}</button>}
        {pool.kind === "hooks" && p.onRefreshViews && Object.keys(pool.views ?? {}).length > 0 && (
          <button className={"btn sm" + (p.viewsBusy ? " shine-box" : "")} onClick={p.onRefreshViews} disabled={p.viewsBusy}>
            {p.viewsBusy ? t("Updating…") : t("Update views")}
          </button>
        )}
      </div>
      <div className="modal-foot">
        <button className="btn quiet danger left" onClick={p.onDelete}>{t("Delete list")}</button>
        <button className="btn primary" onClick={p.onClose}>{t("Done")}</button>
      </div>
    </Modal>
  );
}

export function PicPoolEditor(p: Common & { pool: PicPool; onChange: (fn: (t: PicPool) => PicPool) => void; onBrowse: () => void; onSync: (manual: boolean) => void;
  /** Photos dropped or picked: sent to the list's Drive folder (Rollout / Photos / <list>) and added. */
  onUpload: (files: File[]) => void;
  /** Photos being sent (done / total), while it lasts. */
  uploading?: { done: number; total: number } | null;
  /** The list was renamed or its scope changed (its Drive folder follows). */
  onMoved?: (from: { name: string; scope: string; projectId?: string }, to: { name: string; scope: string; projectId?: string }) => void;
  /** Where its photos are kept in the Drive ("Rollout / Photos / …"), null when only on this device. */
  savedIn?: string | null;
  /** Folders of the user's Drive this list was filled from before (their photos stay where they are). */
  linkedFolders?: string[] }) {
  const { t } = useT();
  const { pool } = p;
  const start = useRef({ name: pool.name, scope: pool.scope, projectId: pool.projectId });
  const close = () => {
    const s = start.current;
    if (pool.name.trim() && (pool.name !== s.name || pool.scope !== s.scope || pool.projectId !== s.projectId)) p.onMoved?.(s, { name: pool.name, scope: pool.scope, projectId: pool.projectId });
    p.onClose();
  };
  const pick = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const images = (list: FileList | null) => [...(list ?? [])].filter((f) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif|avif)$/i.test(f.name));
  const folders = pool.folders ?? [];
  const onSync = useRef(p.onSync);
  useEffect(() => { onSync.current(false); }, [pool.id]); // fresh photos each time the list is opened
  // Removing a folder also removes the photos it brought, so a list filled from the wrong folder can be cleaned.
  const unlink = (id: string) => p.onChange((x) => ({
    ...x,
    folders: (x.folders ?? []).filter((f) => f.id !== id),
    pics: x.pics.filter((y) => y.folder !== id),
  }));
  const remove = (pic: PicRef) => p.onChange((x) => ({
    ...x,
    pics: x.pics.filter((y) => y.id !== pic.id),
    ...(pic.folder ? { excluded: [...(x.excluded ?? []), pic.id] } : {}),
  }));
  return (
    <Modal title={t("Photo list")} onClose={close} wide>
      <div className={"pic-drop" + (over ? " over" : "")}
        onDragOver={(e) => { if ([...e.dataTransfer.types].includes("Files")) { e.preventDefault(); setOver(true); } }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false); }}
        onDrop={(e) => { e.preventDefault(); setOver(false); const f = images(e.dataTransfer.files); if (f.length) p.onUpload(f); }}>
      <div className="cols2">
        <label className="field">{t("Name")}<input className="input" value={pool.name} onChange={(e) => p.onChange((x) => ({ ...x, name: e.target.value }))} /></label>
        <ScopeSelect value={pool.scope} onChange={(v) => p.onChange((x) => ({ ...x, scope: v }))} />
      </div>
      <div className="row">
        {/* Photos from this device (or dropped on the window): they go to the list's own folder in the Drive. */}
        <input ref={pick} type="file" accept="image/*" multiple hidden onChange={(e) => { const f = images(e.target.files); e.target.value = ""; if (f.length) p.onUpload(f); }} />
        <button className="btn primary" onClick={() => pick.current?.click()} disabled={!!p.uploading}><Icon name="plus" />{t("Add photos")}</button>
        <span className="muted grow">{p.uploading ? <span className="shine">{t("Sending to your Drive… {n}/{total}", { n: p.uploading.done, total: p.uploading.total })}</span> : (pool.pics.length === 1 ? t("1 photo") : t("{n} photos", { n: pool.pics.length }))}</span>
        <button className="btn sm" disabled={!pool.pics.length} onClick={() => p.onChange((x) => ({ ...x, pics: [], folders: [], excluded: [] }))}>{t("Remove all")}</button>
      </div>
      {/* Where the photos are: the user's own Drive, nowhere else. */}
      <p className={"pic-saved xs" + (p.savedIn ? "" : " local")}>
        <Icon name={p.savedIn ? "check" : "alert"} size={13} />
        {p.savedIn
          ? (p.linkedFolders?.length
            ? t("In your own Drive: your folders {folders}; the photos you add go to {path}. Rollout keeps none of your photos.", { folders: p.linkedFolders.join(", "), path: p.savedIn })
            : t("Saved in your own Drive: {path}. Rollout keeps none of your photos.", { path: p.savedIn }))
          : p.linkedFolders?.length
            ? t("In your own Drive: your folders {folders}.", { folders: p.linkedFolders.join(", ") })
            : t("Kept on this device only (no Google Drive access).")}
      </p>
      {!pool.pics.length && <p className="muted">{t("Drop your photos here, or add them.")}</p>}
      <div className="thumbs" style={{ maxHeight: "46dvh", overflow: "auto" }}>
        {pool.pics.map((pic) => (
          <div key={pic.id} className="thumb-wrap">
            <Thumb id={pic.id} name={pic.name} />
            <button className="x" aria-label={t("Remove {name}", { name: pic.name })}
              onClick={() => remove(pic)}><Icon name="x" size={12} /></button>
          </div>
        ))}
      </div>
      {over && <div className="pic-drop-hint">{t("Drop the photos: they go to your Drive")}</div>}
      </div>
      <div className="modal-foot">
        <button className="btn quiet danger left" onClick={p.onDelete}>{t("Delete list")}</button>
        <button className="btn primary" onClick={close}>{t("Done")}</button>
      </div>
    </Modal>
  );
}
