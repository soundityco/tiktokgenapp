"use client";
import JSZip from "jszip";
import { signIn, signOut } from "next-auth/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { defaultVideo, defaultWorkspace, isLineList, isSlidePhotoList, newProject, normalizeWorkspace, uid } from "@/lib/defaults";
import { delMedia } from "@/lib/idb";
import { canWriteDrive, findSamePicture, keepPicture, sendPictureToDrive, webPicId } from "@/lib/drive";
import DropPhotoDialog, { type DropChoice } from "./DropPhotoDialog";
import { DRIVE_AUTH_EVENT, DriveItem, isImage, listFolder, loadDriveImage, mergeFolder, prefetchDriveImages } from "@/lib/drive";
import { loadSavedFonts, syncFontsWithDrive } from "@/lib/fonts";
import { type FaceInfo, renameFonts } from "@/lib/fontInfo";
import { googleFontsIn, loadGoogleFont } from "@/lib/googleFonts";
import { drawHook, generateAll, hookKey, pickPic, pickText, poolsVisible, textItems } from "@/lib/generate";
import { useT } from "@/lib/i18n";
import { addCarousel, carouselsOf, currentCarouselId, deleteCarousel, duplicateCarousel, mapAllSlides, openCarousel, renameCarousel } from "@/lib/carousels";
import PostCaption from "./PostCaption";
import ShareDialog from "./ShareDialog";
import LyricsEditor from "./LyricsEditor";
import { linkAllLyrics, migrateLyrics, refreshAllLyrics, refreshLyricSlides, relinkSections, slideLyrics, songOf, sungOf } from "@/lib/lyricsSections";
import { loadFonts, slideToBlob, textOverflow } from "@/lib/render";
import type { GenSlide, PicPool, PicRef, Project, SlideCfg, StylePreset, TextPool, Workspace } from "@/lib/types";
import DriveBrowser from "./DriveBrowser";
import HooksExtract, { NEW_IMPORT_POOL, NewHook } from "./HooksExtract";
import Icon from "./Icon";
import Inspector from "./Inspector";
import Wordmark from "./Wordmark";
import { PicPoolEditor, TextPoolEditor } from "./PoolEditors";
import { withPreset } from "./TextControls";
import SlidePreview from "./SlidePreview";
import VersionHistory from "./VersionHistory";
import SlideCard from "./SlideCard";
import VideoStudio from "./VideoStudio";
import Logo from "./Logo";
import { useInstall } from "./InstallApp";
import PicStack from "./PicStack";
import { ConfirmDialog, Family, Menu, Modal, NewPoolDialog, PromptDialog, Select, Toast } from "./ui";

const VERSION = "v0.5";
const HISTORY_KEY = "tktgen-undo";
const MAX_SLIDES = 35;
const STUDIO_KEY = "tktgen-studio";
/**
 * Photos of each list downloaded ahead of time, so Generate shows them at once. A small window that
 * moves forward with the shuffle bag: enough for several Generates, without downloading whole folders.
 */
const PREFETCH_PER_LIST = 8;
/** Linked folders are listed again at most this often when coming back to the tab. */
const FOLDER_SYNC_EVERY = 5 * 60_000;

type Editor = { k: "text" | "photos"; id: string } | null;
type MobileTab = "slides" | "lists" | "style";
type PreflightItem = { key: string; params?: Record<string, string | number> };
type Overlay =
  | null
  | { k: "drive"; poolId: string }
  | { k: "import"; poolId: string | null; source?: "tiktok" }
  | { k: "lyrics" }
  | { k: "newPool"; kind: "text" | "photos"; textKind?: TextPool["kind"] }
  | { k: "renameCarousel" }
  | { k: "newProject" }
  | { k: "rename" }
  | { k: "confirm"; title: string; message: string; label: string; run: () => void };

const stamp = () => {
  const d = new Date(), z = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}-${z(d.getMinutes())}`;
};
const safe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "-").trim() || "Rollout";
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
  const [studio, setStudio] = useState<"carousel" | "video">("carousel");
  // Once opened, the video studio stays mounted (hidden on the carousel): coming back is instant, nothing is read again.
  const [videoSeen, setVideoSeen] = useState(false);
  // Where the pill of the studio switch sits: measured on the chosen button (their widths follow the language).
  const switchRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    const place = (slide: boolean) => {
      const on = switchRef.current?.querySelector<HTMLElement>("button.on");
      // The first time (and when the window changes size) it is placed without moving; otherwise it slides.
      if (on) setThumb((cur) => ({ transform: `translateX(${on.offsetLeft}px)`, width: on.offsetWidth, ...(cur && slide ? {} : { transition: "none" }) }));
    };
    place(true);
    const el = switchRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => place(false));
    ro.observe(el);
    return () => ro.disconnect();
  }, [studio, lang, ws]);
  useEffect(() => { if (studio === "video") setVideoSeen(true); }, [studio]);
  // The studio in use survives a reload (read after mount: the server render has no localStorage).
  useEffect(() => {
    try { if (localStorage.getItem(STUDIO_KEY) === "video") setStudio("video"); } catch { /* private mode */ }
  }, []);
  const [toast, setToast] = useState<string | null>(null);
  const [fontsReady, setFontsReady] = useState(false);
  const [preview, setPreview] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [fonts, setFonts] = useState<string[]>([]);
  /** Fonts saved before their family and style were read from the files: the texts using them follow. */
  const [renamedFonts, setRenamedFonts] = useState<Record<string, FaceInfo>>({});
  /** Font under the pointer in the font list: shown on the selected slide until the pointer leaves. */
  const [fontPreview, setFontPreview] = useState<Partial<SlideCfg["style"]> | null>(null);
  const [busy, setBusy] = useState(false);
  /** "Send to my phone" (QR code) for the open carousel. */
  const [shareOpen, setShareOpen] = useState(false);
  const [mobileTab, setMobileTab] = useState<MobileTab>("slides");
  const { canInstall, installed, install, iosHelp, closeIosHelp } = useInstall();
  // Phone: the tools of the studio head folded under "More" (the release, share, download and generate stay out).
  const [headMore, setHeadMore] = useState(false);
  // Phone: the slides are a deck swiped sideways; the one in the middle is the selected one (and the other way round).
  const deckRef = useRef<HTMLDivElement>(null);
  const deckWrapRef = useRef<HTMLDivElement>(null);
  /** Where the deck bar goes (the top of the room kept under the middle slide's picture), or null off the phone. */
  const [deckTop, setDeckTop] = useState<number | null>(null);
  const deckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deckOn = () => typeof window !== "undefined" && matchMedia("(max-width: 640px)").matches;
  const deckCentre = () => {
    const el = deckRef.current;
    if (!el) return -1;
    const mid = el.scrollLeft + el.clientWidth / 2;
    let best = -1, dist = Infinity;
    [...el.children].forEach((c, i) => { const h = c as HTMLElement; const d = Math.abs(h.offsetLeft + h.offsetWidth / 2 - mid); if (d < dist) { dist = d; best = i; } });
    return best;
  };
  const onDeckScroll = () => {
    if (!deckOn()) return;
    if (deckTimer.current) clearTimeout(deckTimer.current);
    deckTimer.current = setTimeout(() => {
      const i = deckCentre();
      if (i >= 0) updProject((p) => (p.selectedSlide === i ? p : { ...p, selectedSlide: i }));
    }, 90);
  };
  // A new panel starts at its top (each panel is the whole page on a phone).
  const pickMobileTab = (tab: MobileTab) => {
    if (tab === mobileTab) { window.scrollTo({ top: 0, behavior: "smooth" }); return; }
    setMobileTab(tab);
    window.scrollTo({ top: 0 });
    try { navigator.vibrate?.(8); } catch { /* not on this phone */ }
  };
  const [exportProgress, setExportProgress] = useState<{ done: number; total: number } | null>(null);
  const [driveAuth, setDriveAuth] = useState(false);
  const [online, setOnline] = useState(true);
  const [history, setHistory] = useState({ past: 0, future: 0 });
  const loaded = useRef(false);
  const rev = useRef(0);
  const conflict = useRef(false);
  const tooBig = useRef(false);
  const saveBusy = useRef(false);
  const saveAgain = useRef(false);
  /** Failed saves (server or network hiccup) are tried again by themselves: 2 s, 5 s, 15 s, then every 30 s. */
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retries = useRef(0);
  const flushRef = useRef<() => Promise<void>>(async () => {});
  const wsRef = useRef<Workspace | null>(null);
  const past = useRef<Workspace[]>([]);
  const future = useRef<Workspace[]>([]);
  const lastHistory = useRef(0);
  const cancelExport = useRef(false);
  const [resume, setResume] = useState(0);
  const [viewsBusy, setViewsBusy] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const restoreInput = useRef<HTMLInputElement>(null);

  const say = useCallback((m: string) => { setToast(m); setTimeout(() => setToast(null), 2600); }, []);

  const historyTimer = useRef<number | null>(null);
  const persistHistory = useCallback(() => {
    if (historyTimer.current) window.clearTimeout(historyTimer.current);
    historyTimer.current = window.setTimeout(() => {
      try {
        const payload = JSON.stringify({ past: past.current.slice(-10), future: future.current.slice(-10) });
        if (payload.length > 1_500_000) sessionStorage.removeItem(HISTORY_KEY);
        else sessionStorage.setItem(HISTORY_KEY, payload);
      } catch { /* storage full or private mode */ }
    }, 500);
  }, []);
  const syncHistory = () => { setHistory({ past: past.current.length, future: future.current.length }); persistHistory(); };
  const remember = useCallback((snapshot: Workspace) => {
    const now = Date.now();
    // Coalesce quick successive edits (typing, dragging) into one undo step.
    if (now - lastHistory.current < 700 && past.current.length) { future.current = []; syncHistory(); return; }
    past.current.push(snapshot);
    if (past.current.length > 80) past.current.shift();
    future.current = [];
    lastHistory.current = now;
    syncHistory();
  }, []);
  const apply = useCallback((next: Workspace, record = true) => {
    const cur = wsRef.current;
    if (record && cur) remember(cur);
    wsRef.current = next;
    setWs(next);
    if (!record) syncHistory();
  }, [remember]);
  const upd = useCallback((fn: (w: Workspace) => Workspace) => {
    const cur = wsRef.current;
    if (!cur) return;
    const next = fn(cur);
    if (next === cur) return;
    remember(cur);
    wsRef.current = next;
    setWs(next);
  }, [remember]);
  const undo = useCallback(() => {
    const prev = past.current.pop();
    const cur = wsRef.current;
    if (!prev || !cur) return;
    future.current.push(cur);
    wsRef.current = prev;
    lastHistory.current = 0;
    setWs(prev);
    syncHistory();
  }, []);
  const redo = useCallback(() => {
    const next = future.current.pop();
    const cur = wsRef.current;
    if (!next || !cur) return;
    past.current.push(cur);
    wsRef.current = next;
    lastHistory.current = 0;
    setWs(next);
    syncHistory();
  }, []);

  useEffect(() => { wsRef.current = ws; }, [ws]);

  // Fonts renamed when their real family was read: the slides, video texts and presets using them follow.
  useEffect(() => {
    if (!ws || !Object.keys(renamedFonts).length) return;
    upd((w) => renameFonts(w, renamedFonts));
    setRenamedFonts({});
  }, [ws, renamedFonts]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- load / autosave ----
  useEffect(() => {
    const flag = new URLSearchParams(location.search).get("tiktok");
    if (flag) {
      window.history.replaceState(null, "", "/studio");
      if (flag === "connected") setOverlay({ k: "import", poolId: null, source: "tiktok" });
      const msg: Record<string, string> = { connected: "TikTok connected", denied: "TikTok connection was cancelled", badstate: "TikTok connection failed (security check). Try again.", error: "TikTok connection failed. Try again.", notconfigured: "TikTok is not set up on this site yet" };
      setTimeout(() => say(t(msg[flag] ?? "TikTok")), 300);
    }
    Promise.all([loadFonts(), loadSavedFonts().then(({ families, renamed }) => { setFonts(families); setRenamedFonts(renamed); }, () => {})])
      .then(() => setFontsReady(true))
      // The fonts saved in the user's Drive from another browser or device come here too.
      .then(() => syncFontsWithDrive())
      .then((f) => { if (f) setFonts(f); });
    fetch("/api/workspace")
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "Could not load your data");
        rev.current = j.data?.rev ?? 0;
        // Saved data this version cannot read must never be replaced by an empty workspace (the next
        // autosave would overwrite it): stop with an error instead.
        if (j.data && (j.data.v !== 1 || !Array.isArray(j.data.projects))) throw new Error("Your saved data could not be read by this version of the app. Nothing was changed.");
        const next = linkAllLyrics(refreshAllLyrics(migrateLyrics(normalizeWorkspace(j.data ? (j.data as Workspace) : defaultWorkspace()), (n) => t("Part {n}", { n }), t("Chorus"))));
        wsRef.current = next;
        setWs(next);
        // Google fonts used by the texts: loaded, then everything is drawn again with them.
        const gf = googleFontsIn(next);
        if (gf.length) void Promise.all(gf.map((g) => loadGoogleFont(g.family, g.weight, g.italic))).then(() => setFonts((f) => [...f]));
        past.current = []; future.current = []; lastHistory.current = 0;
        try {
          const raw = sessionStorage.getItem(HISTORY_KEY);
          if (raw) {
            const h = JSON.parse(raw);
            if (Array.isArray(h?.past)) past.current = h.past.slice(-10);
            if (Array.isArray(h?.future)) future.current = h.future.slice(-10);
          }
        } catch { /* ignore */ }
        syncHistory();
      })
      .catch((e) => setLoadErr(t(String(e.message ?? e))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveWorkspace = useCallback(async (data: Workspace) => {
    setSaveState("saving");
    try {
      const r = await fetch("/api/workspace", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data, baseRev: rev.current }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) { rev.current = j.rev; retries.current = 0; setSaveState("saved"); return; }
      if (r.status === 409) { rev.current = j.rev; conflict.current = true; setSaveState("conflict"); return; }
      // Too big to save: retrying would fail the same way, say it once.
      if (r.status === 413) { setSaveState("error"); if (!tooBig.current) { tooBig.current = true; say(t("Your data is too big to be saved. Delete old releases or lists, then edit something to save again.")); } return; }
      tooBig.current = false;
      setSaveState("error");
    } catch { setSaveState("error"); }
    // Not saved: try again a little later (a new edit also saves at once).
    if (retryTimer.current) clearTimeout(retryTimer.current);
    const delay = [2000, 5000, 15000][retries.current] ?? 30000;
    retries.current++;
    retryTimer.current = setTimeout(() => { retryTimer.current = null; void flushRef.current(); }, delay);
  }, []);

  // Serialise saves: an immediate save (video studio) and the debounce can overlap, and two
  // PUTs with the same base revision would raise a false "changed on another device" conflict.
  const flushSave = useCallback(async () => {
    if (saveBusy.current) { saveAgain.current = true; return; }
    saveBusy.current = true;
    try {
      do {
        saveAgain.current = false;
        const data = wsRef.current;
        if (!data || conflict.current) break;
        await saveWorkspace(data);
      } while (saveAgain.current && !conflict.current);
    } finally {
      saveBusy.current = false;
    }
  }, [saveWorkspace]);
  flushRef.current = flushSave;

  useEffect(() => {
    if (!ws || conflict.current) return;
    if (!loaded.current) { loaded.current = true; return; }
    setSaveState("saving");
    const timer = setTimeout(() => { void flushSave(); }, 1000);
    return () => clearTimeout(timer);
  }, [ws, resume, flushSave]);

  const wasOffline = useRef(false);
  useEffect(() => {
    const on = () => { setOnline(true); if (wasOffline.current && wsRef.current) void flushSave(); wasOffline.current = false; };
    const off = () => { wasOffline.current = true; setOnline(false); };
    setOnline(navigator.onLine);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, [flushSave]);

  useEffect(() => {
    const h = () => setDriveAuth(true);
    window.addEventListener(DRIVE_AUTH_EVENT, h);
    return () => window.removeEventListener(DRIVE_AUTH_EVENT, h);
  }, []);

  // ---- linked Drive folders: photos added to (or deleted from) the folder follow in the list ----
  const syncing = useRef(false);
  const lastSync = useRef(0);
  const tRef = useRef(t);
  tRef.current = t;
  const syncDrive = useCallback(async (onlyPool?: string, manual = false) => {
    const w = wsRef.current;
    if (!w || syncing.current) return;
    const linked = (p: PicPool) => !!p.folders?.length && (!onlyPool || p.id === onlyPool);
    const ids = [...new Set(w.picPools.filter(linked).flatMap((p) => p.folders!.map((f) => f.id)))];
    if (!ids.length) return;
    syncing.current = true;
    lastSync.current = Date.now();
    try {
      const listed = new Map<string, DriveItem[]>();
      let failed = 0;
      for (const id of ids) {
        try { listed.set(id, (await listFolder(id)).filter(isImage)); } catch { failed++; }
      }
      const cur = wsRef.current;
      if (!cur) return;
      let added = 0, removed = 0;
      const picPools = cur.picPools.map((p) => {
        if (!linked(p)) return p;
        let pics = p.pics;
        for (const f of p.folders!) {
          const l = listed.get(f.id);
          if (l) pics = mergeFolder(pics, f.id, l, p.excluded);
        }
        if (pics === p.pics) return p;
        const before = new Set(p.pics.map((x) => x.id)), after = new Set(pics.map((x) => x.id));
        added += pics.filter((x) => !before.has(x.id)).length;
        removed += p.pics.filter((x) => !after.has(x.id)).length;
        return { ...p, pics };
      });
      // Not an undo step: it mirrors Drive, it is not an edit.
      if (added || removed) apply({ ...cur, picPools }, false);
      if (added) say(tRef.current("{n} new photos from Drive", { n: added }));
      else if (manual) say(tRef.current(failed ? "Some folders could not be read" : "Photo list is up to date"));
    } finally {
      syncing.current = false;
    }
  }, [apply, say]);

  const wsLoaded = !!ws;
  useEffect(() => {
    if (!wsLoaded) return;
    void syncDrive();
    const h = () => { if (document.visibilityState === "visible" && Date.now() - lastSync.current > FOLDER_SYNC_EVERY) void syncDrive(); };
    document.addEventListener("visibilitychange", h);
    return () => document.removeEventListener("visibilitychange", h);
  }, [wsLoaded, syncDrive]);

  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (saveState === "saving" || saveState === "error") e.preventDefault(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [saveState]);

  // ---- derived ----
  const project: Project | null = ws ? ws.projects.find((p) => p.id === ws.currentProjectId) ?? ws.projects[0] : null;
  // The deck bar's place: measured under the middle slide's picture (every picture has the same height, so it
  // does not move while swiping); again when the board changes size.
  useLayoutEffect(() => {
    const wrap = deckWrapRef.current;
    if (!wrap) return;
    const place = () => {
      const sp = wrap.querySelector<HTMLElement>(".card.sel .deck-spacer");
      if (!deckOn() || !sp || !sp.offsetParent) { setDeckTop(null); return; }
      const top = Math.round(sp.getBoundingClientRect().top - wrap.getBoundingClientRect().top);
      setDeckTop((cur) => (cur === top ? cur : top));
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [project?.selectedSlide, project?.slides.length, mobileTab, studio, project?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // The deck follows the selected slide (a dot, a new slide, a tap): it slides to put it in the middle.
  useEffect(() => {
    const el = deckRef.current;
    const i = project?.selectedSlide ?? 0;
    const c = el?.children[i] as HTMLElement | undefined;
    if (!deckOn() || !el || !c || deckCentre() === i) return;
    el.scrollTo({ left: c.offsetLeft - (el.clientWidth - c.offsetWidth) / 2, behavior: "smooth" });
  }, [project?.selectedSlide, project?.slides.length, mobileTab, studio]); // eslint-disable-line react-hooks/exhaustive-deps
  const vText = useMemo(() => (ws && project ? poolsVisible(ws.textPools, project.id) : []), [ws, project]);
  /** Lists a slide can take its text from (not the captions lists, which are for the post). */
  const slideTexts = useMemo(() => vText.filter((p) => p.kind !== "captions"), [vText]);
  const captionPools = useMemo(() => vText.filter((p) => p.kind === "captions"), [vText]);
  const carouselName = (c: { name: string }) => { const m = /^Carousel (\d+)$/.exec(c.name); return m ? t("Carousel {n}", { n: m[1] }) : c.name; };
  /** Another caption from the list of the open carousel (or of a video, with `apply`). */
  const drawCaptionFrom = (poolId: string | undefined, current: string | undefined, apply: (text: string) => void) => {
    const cur = wsRef.current ?? ws;
    if (!cur || !poolId) return;
    const bags = { ...cur.bags };
    const text = drawHook(cur, poolId, bags, current ? [current] : []);
    if (text === null) { say(t("This captions list is empty")); return; }
    upd((w) => ({ ...w, bags: { ...w.bags, [poolId]: bags[poolId] ?? [] } }));
    apply(text);
  };
  const drawCaption = () => drawCaptionFrom(project?.captionPoolId, project?.caption, (caption) => updProject((p) => ({ ...p, caption })));
  const vPics = useMemo(() => (ws && project ? poolsVisible(ws.picPools, project.id) : []), [ws, project]);

  // Photos the next Generate can draw (still in the shuffle bag first) are downloaded ahead of time.
  const prefetchIds = useMemo(() => {
    if (!ws || !project) return "";
    const ids: string[] = [];
    for (const poolId of new Set(project.slides.map((s) => s.picPoolId))) {
      const pool = ws.picPools.find((p) => p.id === poolId);
      if (!pool) continue;
      // The bag is already shuffled and drawn from the front: its order is the order of the next photos.
      const inPool = new Set(pool.pics.map((x) => x.id));
      const bag = (ws.bags[pool.id] ?? []).filter((x) => inPool.has(x));
      const inBag = new Set(bag);
      const next = [...bag, ...pool.pics.map((x) => x.id).filter((x) => !inBag.has(x))];
      ids.push(...next.slice(0, PREFETCH_PER_LIST));
    }
    return ids.join(",");
  }, [ws?.picPools, ws?.bags, project?.slides]);
  useEffect(() => {
    if (!prefetchIds) return;
    const id = setTimeout(() => prefetchDriveImages(prefetchIds.split(",")), 1500);
    return () => clearTimeout(id);
  }, [prefetchIds]);

  // ---- preflight ----
  const warnings = useMemo<PreflightItem[]>(() => {
    if (!ws || !project) return [];
    const out: PreflightItem[] = [];
    const photoIds = new Set<string>();
    const poolUses = new Map<string, number>();
    let photoSlides = 0;
    project.slides.forEach((s, i) => {
      const n = i + 1;
      const source = s.textSource;
      if (source.kind === "none") out.push({ key: "Slide {n} has no text", params: { n } });
      else if (source.kind === "pool") {
        const pool = ws.textPools.find((p) => p.id === source.poolId);
        if (!pool || !textItems(pool).length) out.push({ key: "The text list of slide {n} is empty", params: { n } });
        else poolUses.set(pool.id, (poolUses.get(pool.id) ?? 0) + 1);
      } else if (!slideLyrics(project, source).trim()) {
        out.push({ key: "Slide {n} has no lyrics", params: { n } });
      }
      if (!s.picPoolId) out.push({ key: "Slide {n} has no photo", params: { n } });
      else {
        const pool = ws.picPools.find((p) => p.id === s.picPoolId);
        if (!pool || !pool.pics.length) out.push({ key: "The photo list of slide {n} is empty", params: { n } });
        else { photoSlides++; pool.pics.forEach((p) => photoIds.add(p.id)); }
      }
    });
    if (photoSlides > photoIds.size) out.push({ key: "Only {n} unique photos for {m} slides: some photos will repeat.", params: { n: photoIds.size, m: photoSlides } });
    poolUses.forEach((count, id) => {
      const pool = ws.textPools.find((p) => p.id === id);
      if (!pool || !isLineList(pool)) return;
      const available = textItems(pool).length;
      if (available < count) out.push({ key: "The list “{name}” has {n} texts for {m} slides: some texts will repeat.", params: { name: pool.name, n: available, m: count } });
    });
    if (fontsReady) {
      project.slides.forEach((s, i) => {
        const txt = project.generated?.[i]?.text;
        if (txt && textOverflow(s, txt)) out.push({ key: "The text of slide {n} is too long: it will be cut.", params: { n: i + 1 } });
      });
    }
    return out;
  }, [ws, project, fontsReady]);

  // ---- updaters ----
  // ---- a picture dropped or pasted on a slide (from Pinterest, the desktop…) ----
  const [dropPic, setDropPic] = useState<{ i: number; blob: Blob; name: string } | null>(null);
  const [dropBusy, setDropBusy] = useState(false);
  const [driveWrite, setDriveWrite] = useState(false);
  /** A picture is being dragged over the page: the slides show they take it. */
  const [boardDrag, setBoardDrag] = useState(false);
  useEffect(() => {
    if (dropPic) void canWriteDrive().then(setDriveWrite).catch(() => setDriveWrite(false));
  }, [dropPic]);
  useEffect(() => {
    let depth = 0;
    const outside = (e: DragEvent) => !!e.dataTransfer && (e.dataTransfer.types.includes("Files") || e.dataTransfer.types.includes("text/uri-list"));
    const enter = (e: DragEvent) => { if (studio === "carousel" && outside(e)) { depth++; setBoardDrag(true); } };
    const leave = (e: DragEvent) => { if (outside(e) && --depth <= 0) { depth = 0; setBoardDrag(false); } };
    const done = (e?: Event) => {
      // Dropped beside the slides: the browser would leave the app to open the picture.
      if (e?.type === "drop" && studio === "carousel" && outside(e as DragEvent)) e.preventDefault();
      depth = 0; setBoardDrag(false);
    };
    const over = (e: DragEvent) => { if (studio === "carousel" && outside(e)) e.preventDefault(); };
    window.addEventListener("dragover", over);
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", done);
    window.addEventListener("dragend", done);
    return () => { window.removeEventListener("dragover", over); window.removeEventListener("dragenter", enter); window.removeEventListener("dragleave", leave); window.removeEventListener("drop", done); window.removeEventListener("dragend", done); };
  }, [studio]);
  // Cmd+V of a copied picture: it goes in the selected slide.
  useEffect(() => {
    const paste = (e: ClipboardEvent) => {
      const el = e.target as HTMLElement;
      if (studio !== "carousel" || /INPUT|TEXTAREA|SELECT/.test(el.tagName) || el.isContentEditable || document.querySelector(".ov")) return;
      const item = Array.from(e.clipboardData?.items ?? []).find((x) => x.type.startsWith("image/"));
      const file = item?.getAsFile();
      const cur = wsRef.current?.projects.find((p) => p.id === wsRef.current?.currentProjectId);
      if (!file || !cur || cur.slides[cur.selectedSlide]?.locked) return;
      e.preventDefault();
      setDropPic({ i: cur.selectedSlide, blob: file, name: file.name && file.name !== "image.png" ? file.name : "pasted.png" });
    };
    window.addEventListener("paste", paste);
    return () => window.removeEventListener("paste", paste);
  }, [studio]);
  const confirmDrop = async (c: DropChoice) => {
    if (!dropPic) return;
    const { i, blob, name } = dropPic;
    setDropBusy(true);
    try {
      // In the Drive (the slide shows it on every device), else on this device only.
      // The same picture already in the Drive: that file; else a new one in the Rollout folder (or this device only).
      const id = c.reuse ?? (driveWrite ? await sendPictureToDrive(blob, `photo - ${name}`) : `local:${uid()}`);
      await keepPicture(id, blob);
      setGen(i, { picId: id, picName: name, picCredit: undefined });
      if (c.list) {
        upd((w) => {
          let pools = w.picPools, pid = c.list;
          if (pid === "new") { pid = uid(); pools = [...pools, { id: pid, name: c.newName || "Pinterest", scope: "shared", pics: [] }]; }
          return { ...w, picPools: pools.map((p) => (p.id === pid && !p.pics.some((x) => x.id === id) ? { ...p, pics: [...p.pics, { id, name }] } : p)) };
        });
      }
      say(c.list ? t("Photo added to the slide and to the list") : t("Photo added to the slide"));
      setDropPic(null);
    } catch (e) {
      console.warn("[photo] could not be kept", e);
      say(t("The photo could not be saved. Check your connection and try again."));
    } finally {
      setDropBusy(false);
    }
  };

  const updProject = (fn: (p: Project) => Project) =>
    upd((w) => ({ ...w, projects: w.projects.map((p) => (p.id === w.currentProjectId ? fn(p) : p)) }));
  const updSlide = (i: number, fn: (s: SlideCfg) => SlideCfg) => {
    // Its text source changed: its text follows at once (lyrics: the ticked sections; a list: a text drawn from it).
    const before = project?.slides[i];
    const after = before ? fn(before) : undefined;
    const moved = !!before && !!after && JSON.stringify(before.textSource) !== JSON.stringify(after.textSource);
    updProject((p) => {
      const q = { ...p, slides: p.slides.map((s, k) => (k === i ? fn(s) : s)) };
      if (!moved) return q;
      // A new source: its text is taken again from it, the retouches made on the slide are dropped.
      const generated = q.generated?.map((g, k) => (k === i && g.edited ? { ...g, edited: false } : g)) ?? null;
      return refreshLyricSlides({ ...q, generated });
    });
    if (moved && after?.textSource.kind === "pool") rerollText(i);
  };
  /** The release's lyrics changed (sections edited, moved, cut, merged): every lyrics slide follows. */
  const setLyrics = (lyrics: Project["lyrics"], link?: { from: string; to: string; keep: boolean }) =>
    updProject((p) => {
      // Linked to the video: its text follows (the video places the changed lines again, retouches kept).
      let q: Project = { ...p, lyrics, ...(p.lyricsLinked ? { songLyrics: songOf(lyrics) } : {}) };
      if (link) q = relinkSections(q, link.from, link.to, link.keep);
      return refreshLyricSlides(q);
    });
  const setGen = (i: number, patch: Partial<GenSlide>) =>
    updProject((p) => {
      const g = Array.from({ length: p.slides.length }, (_, k) => p.generated?.[k] ?? { text: "", picId: null });
      // Another photo (dropped, pasted, found on the web): the edits made on the previous one do not follow it.
      const newPic = patch.picId !== undefined && patch.picId !== g[i].picId;
      g[i] = { ...g[i], ...patch };
      return { ...p, generated: g, slides: newPic ? p.slides.map((s, k) => (k === i ? reframe(s) : s)) : p.slides };
    });

  // ---- generate ----
  // A new photo starts centred and untouched: no zoom, offset or photo edits (light, colours…) of the previous one.
  const reframe = (s: SlideCfg): SlideCfg => ({ ...s, pic: { ...s.pic, zoom: 1, ox: 0, oy: 0, adjust: undefined } });

  const generate = useCallback(() => {
    const current = wsRef.current;
    const active = current?.projects.find((x) => x.id === current.currentProjectId);
    if (active?.slides.length && active.slides.every((s, i) => s.locked && active.generated?.[i])) {
      say(t("All slides are locked"));
      return;
    }
    upd((w) => {
      const p = w.projects.find((x) => x.id === w.currentProjectId)!;
      const { slides: drawn, bags } = generateAll(w, p, (i) => (p.slides[i].locked ? p.generated?.[i] : undefined));
      // The lyrics are not drawn: a lyrics slide keeps its text as it is (retouches included), only its photo is new.
      const slides = drawn.map((g, i) => {
        const old = p.generated?.[i];
        return p.slides[i].textSource.kind === "lyrics" && old?.edited ? { ...g, text: old.text, edited: true } : g;
      });
      // Only a slide whose photo changed starts again from a plain photo (the same photo keeps its edits).
      const cfgs = p.slides.map((s, i) => (s.locked || slides[i]?.picId === p.generated?.[i]?.picId ? s : reframe(s)));
      // The post's caption: drawn again from its list, if it has one (another one than the current).
      const caption = p.captionPoolId ? drawHook(w, p.captionPoolId, bags, p.caption ? [p.caption] : []) ?? p.caption : p.caption;
      return { ...w, bags, projects: w.projects.map((x) => (x.id === p.id ? { ...x, generated: slides, slides: cfgs, caption } : x)) };
    });
  }, [say, t, upd]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (/INPUT|TEXTAREA|SELECT/.test(el.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (studio !== "carousel" || document.querySelector(".ov")) return;
      if (e.key.toLowerCase() === "g") generate();
      // Space: clean full-size preview of the selected slide (and no page scroll / button press).
      else if (e.key === " " && !el.isContentEditable) { e.preventDefault(); setPreview(true); }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [generate, studio]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (/INPUT|TEXTAREA|SELECT/.test(el.tagName) || el.isContentEditable) return;
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if (key === "y") { e.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [undo, redo]);

  const rerollPic = (i: number) => {
    if (project?.slides[i]?.locked) return;
    upd((w) => {
      const p = w.projects.find((x) => x.id === w.currentProjectId)!;
      const bags = { ...w.bags };
      const others = new Set((p.generated ?? []).filter((_, k) => k !== i).map((g) => g?.picId).filter(Boolean) as string[]);
      const pic = pickPic(p.slides[i].picPoolId, w, bags, others);
      const g = Array.from({ length: p.slides.length }, (_, k) => p.generated?.[k] ?? { text: "", picId: null });
      g[i] = { ...g[i], picId: pic?.id ?? null, picName: pic?.name, picCredit: undefined }; // a photo of the list: no web credit
      const cfgs = p.slides.map((s, k) => (k === i ? reframe(s) : s));
      return { ...w, bags, projects: w.projects.map((x) => (x.id === p.id ? { ...x, generated: g, slides: cfgs } : x)) };
    });
  };
  const rerollText = (i: number) => {
    if (project?.slides[i]?.locked) return;
    upd((w) => {
      const p = w.projects.find((x) => x.id === w.currentProjectId)!;
      const bags = { ...w.bags };
      const text = pickText(p, w, i, bags);
      const g = Array.from({ length: p.slides.length }, (_, k) => p.generated?.[k] ?? { text: "", picId: null });
      g[i] = { ...g[i], text, edited: false };
      return { ...w, bags, projects: w.projects.map((x) => (x.id === p.id ? { ...x, generated: g } : x)) };
    });
  };

  // ---- slides ----
  const insertSlide = (at: number, copyGenerated: boolean) =>
    upd((w) => {
      const p = w.projects.find((x) => x.id === w.currentProjectId)!;
      if (p.slides.length >= MAX_SLIDES) return w;
      const from = Math.max(0, Math.min(p.slides.length - 1, at));
      const src = p.slides[from];
      const gsrc = p.generated?.[from];
      const s: SlideCfg = {
        ...src,
        id: uid(),
        locked: false,
        textSource: { ...src.textSource },
        pic: { ...src.pic },
        style: { ...src.style },
      };
      const slides = [...p.slides];
      slides.splice(from + 1, 0, s);
      const generated = p.generated
        ? Array.from({ length: p.slides.length }, (_, k) => p.generated?.[k] ?? { text: "", picId: null })
        : null;
      if (generated) generated.splice(from + 1, 0, copyGenerated && gsrc ? { ...gsrc } : { text: "", picId: null });
      return { ...w, projects: w.projects.map((x) => (x.id === p.id ? { ...x, slides, generated, selectedSlide: from + 1 } : x)) };
    });
  const addSlide = () => insertSlide(project?.selectedSlide ?? 0, false);
  const duplicateSlide = (i: number) => insertSlide(i, true);
  const deleteSlide = (i: number) =>
    updProject((p) => {
      if (p.slides.length <= 1) return p;
      const slides = p.slides.filter((_, k) => k !== i);
      const generated = p.generated
        ? Array.from({ length: p.slides.length }, (_, k) => p.generated?.[k] ?? { text: "", picId: null }).filter((_, k) => k !== i)
        : null;
      return { ...p, slides, generated, selectedSlide: Math.min(i, slides.length - 1) };
    });
  const moveSlide = (from: number, to: number) =>
    updProject((p) => {
      if (from === to || to < 0 || to >= p.slides.length) return p;
      const slides = [...p.slides];
      const [s] = slides.splice(from, 1);
      slides.splice(to, 0, s);
      const generated = p.generated
        ? Array.from({ length: p.slides.length }, (_, k) => p.generated?.[k] ?? { text: "", picId: null })
        : null;
      if (generated) { const [g] = generated.splice(from, 1); generated.splice(to, 0, g); }
      return { ...p, slides, generated, selectedSlide: to };
    });

  const applyAll = () => {
    updProject((p) => {
      const src = p.slides[p.selectedSlide];
      return { ...p, slides: p.slides.map((s) => ({ ...s, format: src.format, pic: { ...src.pic }, style: { ...src.style } })) };
    });
    say(t("Settings copied to all slides"));
  };

  // ---- lists (pools) ----
  const createPool = (name: string, scope: "shared" | "project", kind: TextPool["kind"]) => {
    const projectId = scope === "project" ? project!.id : undefined;
    if (overlay?.k === "newPool" && overlay.kind === "text") {
      const id = uid();
      // A captions list made from a post's caption box: that post draws from it right away.
      const forPost = overlay.textKind === "captions" && kind === "captions";
      upd((w) => ({
        ...w, textPools: [...w.textPools, { id, name, scope, projectId, kind, text: "" }],
        projects: !forPost ? w.projects : w.projects.map((p) => (p.id !== w.currentProjectId ? p
          : studio === "video" ? { ...p, videos: p.videos.map((v) => (v.id === (p.videoId ?? p.videos[0]?.id) ? { ...v, captionPoolId: id } : v)) }
          : { ...p, captionPoolId: id })),
      }));
      if (forPost) setEditor({ k: "text", id }); // straight to writing its captions
    }
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
          // Its shuffle bags go too (the whole list's and each theme's).
          const bags = Object.fromEntries(Object.entries(w.bags).filter(([k]) => k !== id && !k.startsWith(id + "#")));
          return {
            ...w, bags,
            textPools: w.textPools.filter((p) => p.id !== id),
            picPools: w.picPools.filter((p) => p.id !== id),
            projects: w.projects.map((p) => {
              const q = mapAllSlides(p, (s) => ({
                ...s,
                textSource: s.textSource.kind === "pool" && s.textSource.poolId === id ? { kind: "none" as const } : s.textSource,
                picPoolId: s.picPoolId === id ? null : s.picPoolId,
              }));
              // A captions list gone: the captions already written stay, nothing is drawn from it any more.
              const off = <T extends { captionPoolId?: string }>(x: T): T => (x.captionPoolId === id ? { ...x, captionPoolId: undefined } : x);
              return { ...off(q), carousels: q.carousels?.map(off), videos: q.videos.map(off) };
            }),
          };
        });
      },
    });
  };
  const setTextPool = (id: string, fn: (x: TextPool) => TextPool) => upd((w) => ({ ...w, textPools: w.textPools.map((x) => (x.id === id ? fn(x) : x)) }));
  const setPicPool = (id: string, fn: (x: PicPool) => PicPool) => upd((w) => ({ ...w, picPools: w.picPools.map((x) => (x.id === id ? fn(x) : x)) }));
  const refreshViews = async (pool: TextPool) => {
    setViewsBusy(true);
    try {
      const r = await fetch("/api/tiktok/posts");
      const j = await r.json().catch(() => ({}));
      if (r.status === 409) throw new Error(t("TikTok connection expired. Connect again."));
      if (!r.ok) throw new Error(j.error ?? t("Could not load your posts"));
      const known = new Map<string, number>();
      for (const post of j.posts ?? []) known.set(hookKey(String(post.title ?? "")), Number(post.views ?? 0));
      const views = { ...(pool.views ?? {}) };
      let n = 0;
      for (const hook of textItems(pool)) {
        const v = known.get(hookKey(hook));
        if (v !== undefined) { views[hookKey(hook)] = v; n++; }
      }
      if (!n) { say(t("No matching posts found for this list")); return; }
      setTextPool(pool.id, (x) => ({ ...x, views }));
      say(t("Views updated for {n} hooks", { n }));
    } catch (e: any) {
      say(e?.message ?? t("Could not update views"));
    } finally { setViewsBusy(false); }
  };
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
      const lmap = new Map(src.lyrics.map((l) => [l.id, uid()]));
      const lyrics = src.lyrics.map((l) => ({ ...l, id: lmap.get(l.id)! }));
      slides.forEach((s) => { if (s.textSource.kind === "lyrics" && s.textSource.sectionIds) s.textSource = { ...s.textSource, sectionIds: s.textSource.sectionIds.map((x) => lmap.get(x) ?? x) }; });
      const section = src.lyrics.findIndex((l) => l.id === src.lyricsSectionId);
      const videoId = uid();
      const copy: Project = { id, name: src.name + " " + t("(copy)"), slides, lyrics, lyricsSectionId: section >= 0 ? lyrics[section].id : null, generated: null, selectedSlide: 0, videos: [{ ...defaultVideo(), id: videoId, name: "Video 1" }], videoId };
      return { ...w, textPools: [...w.textPools, ...tCopies], picPools: [...w.picPools, ...pCopies], projects: [...w.projects, copy], currentProjectId: id };
    });
  const deleteProject = () => {
    const gone = wsRef.current?.projects.find((x) => x.id === wsRef.current!.currentProjectId);
    if (gone) {
      const keys = new Set<string>([`audio:project:${gone.id}`, `audio:${gone.id}`, `video:${gone.id}`]);
      gone.videos?.forEach((v) => { keys.add(`audio:${v.id}`); keys.add(`video:${v.id}`); });
      keys.forEach((k) => void delMedia(k));
    }
    upd((w) => {
      const id = w.currentProjectId;
      const textPools = w.textPools.filter((p) => !(p.scope === "project" && p.projectId === id));
      const picPools = w.picPools.filter((p) => !(p.scope === "project" && p.projectId === id));
      let projects = w.projects.filter((p) => p.id !== id);
      if (!projects.length) projects = [newProject(
        t("New release"),
        textPools.filter((p) => p.scope === "shared").slice(0, 2),
        picPools.filter((p) => p.scope === "shared").slice(0, 3)
      )];
      return { ...w, textPools, picPools, projects, currentProjectId: projects[0].id };
    });
  };

  // ---- export ----
  async function buildFiles(p: Project, onStep?: (done: number, total: number) => void, failures?: string[]) {
    const ext = ws!.exportFormat;
    const out: { name: string; blob: Blob }[] = [];
    for (let i = 0; i < p.slides.length; i++) {
      if (cancelExport.current) break;
      const g = p.generated?.[i];
      try {
        const img = g?.picId ? await loadDriveImage(g.picId) : null;
        out.push({ name: `slide${i + 1}.${ext}`, blob: await slideToBlob(p.slides[i], img, g?.text ?? "", ext) });
      } catch (e: any) {
        failures?.push(`Slide ${i + 1}: ${e?.message ?? t("Export failed")}`);
      }
      onStep?.(i + 1, p.slides.length);
    }
    return out;
  }
  /**
   * Downloads the open carousel, or every carousel of the release (`all`): one zip, one folder per carousel
   * holding its pictures and its caption.txt (the post's text), nothing else.
   */
  async function downloadAll(all = false) {
    if (!project) return;
    const list = all ? carouselsOf(project).map((c) => openCarousel(project, c.id)) : [project];
    const ready = list.filter((p) => p.generated);
    if (!ready.length) return say(t("Generate a carousel first"));
    cancelExport.current = false;
    setBusy(true);
    const total = ready.reduce((n, p) => n + p.slides.length, 0);
    let before = 0;
    setExportProgress({ done: 0, total });
    const failures: string[] = [];
    try {
      const release = safe(project.name);
      const zip = new JSZip();
      const root = all ? zip.folder(`${release} ${stamp()}`)! : null;
      let made = 0, single = "";
      const usedNames = new Set<string>();
      for (const p of ready) {
        const files = await buildFiles(p, (done) => setExportProgress({ done: before + done, total }), failures);
        before += p.slides.length;
        if (cancelExport.current) { say(t("Export cancelled")); return; }
        if (!files.length) continue;
        made += files.length;
        const c = carouselsOf(p).find((x) => x.id === currentCarouselId(p))!;
        const many = carouselsOf(project).length > 1;
        const name = all ? safe(carouselName(c)) : `${safe(project.name + (many ? ` - ${carouselName(c)}` : ""))} ${stamp()}`;
        if (!all) single = name;
        // Two carousels of the same name get two folders (never one over the other).
        let folderName = name;
        for (let k = 2; usedNames.has(folderName.toLowerCase()); k++) folderName = `${name} (${k})`;
        usedNames.add(folderName.toLowerCase());
        const dir = (root ?? zip).folder(folderName)!;
        files.forEach((f) => dir.file(f.name, f.blob));
        // The pictures and the text of the post (ready to paste in TikTok), nothing else.
        if (p.caption?.trim()) dir.file("caption.txt", p.caption.trim() + "\n");
      }
      if (!made) throw new Error(t("Export failed"));
      download(await zip.generateAsync({ type: "blob" }), `${all ? `${release} ${stamp()}` : single}.zip`);
      if (failures.length) say(t("Exported {n} of {m} slides ({f} failed)", { n: made, m: total, f: failures.length }));
      else if (all && ready.length < list.length) say(t("{n} carousels not generated yet were left out", { n: list.length - ready.length }));
    } catch (e: any) { say(e?.message ?? t("Export failed")); }
    finally { setBusy(false); setExportProgress(null); }
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
  const backup = () => download(new Blob([JSON.stringify(ws)], { type: "application/json" }), `Rollout backup ${stamp()}.json`);
  const restore = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      if (data?.v !== 1 || !Array.isArray(data.projects) || !data.projects.length) throw new Error(t("This is not a Rollout backup"));
      setOverlay({ k: "confirm", title: t("Restore a backup"), label: t("Replace everything"), message: t("This replaces all your current projects and lists with the backup. This can't be undone."), run: () => { apply(linkAllLyrics(refreshAllLyrics(migrateLyrics(normalizeWorkspace(data as Workspace), (n) => t("Part {n}", { n }), t("Chorus"))))); say(t("Backup restored")); } });
    } catch (e: any) { say(e?.message ?? t("Could not read this file")); }
  };

  // rev.current already holds the server revision returned with the 409: resuming the autosave overwrites it.
  const keepMine = () => { conflict.current = false; setSaveState("saving"); setResume((n) => n + 1); };

  // Switching studios keeps the same workspace in memory: save first, close any dialog, swap the view.
  const switchStudio = (next: "carousel" | "video") => {
    if (next === studio) return;
    void flushSave();
    setEditor(null);
    setOverlay(null);
    setStudio(next);
    try { localStorage.setItem(STUDIO_KEY, next); } catch { /* private mode */ }
  };

  if (loadErr) return <div className="login"><div className="login-card"><h2 className="title">{t("Could not load your data")}</h2><p className="muted">{loadErr}</p><button className="btn primary" onClick={() => location.reload()}>{t("Try again")}</button></div></div>;
  if (!ws || !project) return (
    <div className="boot" aria-busy="true" role="status" aria-label={t("Loading…")}>
      {/* The same logo and text twice: a dim one, and a glowing copy shown only under a slanted band sweeping left to right. */}
      <div className="boot-mark" aria-hidden>
        {["base", "shine"].map((k) => (
          <div key={k} className={"boot-layer " + k}>
            {/* The app icon drawn here (not an image), so the R itself can glow. */}
            <svg viewBox="0 0 673.68 673.68" width={56} height={56}>
              <rect width="673.68" height="673.68" rx="150" fill="#000" />
              <path fill="currentColor" filter={k === "shine" ? "url(#boot-glow)" : undefined} d="M174.68,170.64h198.2c65.43,0,122.81,18.02,122.81,80.61,0,46.47-31.77,71.13-74.92,77.76v15.65c44.1,2.85,34.61,43.62,24.66,104.32h53.58v54.05h-137.98l46.94-132.29h-168.33v131.34h-64.96V170.64ZM239.64,320.01l131.82.95c32.24.47,59.74-16.6,59.74-48.84s-27.5-48.84-58.8-48.84h-132.77v96.73Z" />
              {k === "shine" && (
                <defs>
                  <filter id="boot-glow" x="-30%" y="-30%" width="160%" height="160%">
                    <feGaussianBlur stdDeviation="14" result="b" />
                    <feMerge><feMergeNode in="b" /><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
                  </filter>
                </defs>
              )}
            </svg>
            <p>{t("Loading…")}</p>
          </div>
        ))}
      </div>
    </div>
  );

  const sel = Math.min(project.selectedSlide, project.slides.length - 1);

  const edText = editor?.k === "text" ? ws.textPools.find((x) => x.id === editor.id) : undefined;
  const edPics = editor?.k === "photos" ? ws.picPools.find((x) => x.id === editor.id) : undefined;
  const nSlides = project.slides.length;
  const presets = ws.presets ?? [];
  const savePreset = (name: string, style: SlideCfg["style"]) => {
    upd((w) => ({ ...w, presets: [...(w.presets ?? []), { id: uid(), name, style: { ...style } }] }));
    say(t("Preset saved"));
  };
  const applyPreset = (preset: StylePreset) => {
    updSlide(sel, (s) => ({ ...s, style: withPreset(s.style, preset) }));
    say(t("Preset applied"));
  };
  const deletePreset = (id: string) => upd((w) => ({ ...w, presets: (w.presets ?? []).filter((x) => x.id !== id) }));

  // A list of the library at a glance: a photo list shows its first photos, a text list its first text.
  const listRows = (kind: "text" | "photos", only?: (p: TextPool) => boolean) =>
    (kind === "text" ? (only ? vText.filter(only) : vText) : vPics).map((p, n) => {
      const pics = "pics" in p;
      const first = pics ? "" : (textItems(p)[0] ?? "").replace(/\|/g, " ").replace(/\s+/g, " ").trim();
      const count = pics ? p.pics.length : textItems(p).length;
      return (
        <div key={p.id} className={"item lib-item" + (pics ? " is-pics" : "")} role="button" tabIndex={0} onClick={() => setEditor({ k: kind, id: p.id })}
          title={p.scope === "shared" ? t("all projects") : t("this project")}
          onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); setEditor({ k: kind, id: p.id }); } }}>
          {pics ? <PicStack ids={p.pics.slice(0, 3).map((x) => x.id)} /> : <span className="idx">{String(n + 1).padStart(2, "0")}</span>}
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="lib-item-top"><span className="truncate item-name">{p.name}</span><span className="lib-count">{count}</span></div>
            <div className="xs truncate lib-preview">
              {pics ? (count ? t("{n} photos", { n: count }) : t("Empty list"))
                : p.kind === "block" ? t("Lyrics block") : first ? <em>{first}</em> : t("Empty list")}
            </div>
          </div>
          <button className="btn quiet icon sm del" aria-label={t("Delete {name}", { name: p.name })} title={t("Delete")}
            onClick={(e) => { e.stopPropagation(); askDeletePool(kind, p.id); }}><Icon name="trash" size={14} /></button>
        </div>
      );
    });

  const sungCount = (() => { const x = sungOf(project.lyrics); return x ? x.split("\n").length : 0; })();
  // The library (left column / phone tab of both studios). The release's lyrics, shown as a file of the release
  // like the official audio; the text lists (hooks, texts, captions), the same in both studios.
  const lyricsRow = (
    <button type="button" className={"media m-lyrics lib-lyrics" + (project.lyrics.length ? "" : " empty warn")} onClick={() => setOverlay({ k: "lyrics" })}>
      <div className="media-head">
        <span className="media-ic"><Icon name="type" size={16} /></span>
        <div className="media-txt">
          <span className="label">{t("Lyrics")}</span>
          <span className="media-name">{project.lyrics.length ? t("{n} sections", { n: project.lyrics.length }) : t("Add the lyrics")}</span>
        </div>
        <Icon name={project.lyrics.length ? "chevron" : "plus"} size={14} />
      </div>
      {project.lyrics.length > 0 && <div className="media-meta"><span>{t("{n} sung lines", { n: sungCount })}</span></div>}
    </button>
  );
  // The text lists by role, each group always there (empty, its "+" makes the first list). The carousel shows the
  // three; the video only hooks and captions (it has no slides after the first).
  const ROLES = { hooks: t("Hooks"), texts: t("Other slides"), captions: t("Captions") } as const;
  // Two families in the library, told apart at a glance: the texts (their roles as branches, like the video's
  // release → video tree), then the photos.
  const ofRole = (role: keyof typeof ROLES) => (p: TextPool) => (role === "texts" ? p.kind === "texts" || p.kind === "block" : p.kind === role);
  const textGroups = (roles: (keyof typeof ROLES)[]) => {
    const n = vText.filter((p) => roles.some((r) => ofRole(r)(p))).length;
    return (
      <Family id="texts" icon="type" title={t("Texts")} count={t("{n} lists", { n })}>
          {roles.map((role) => (
            <section key={role} className="group sub">
              <div className="group-head"><h4 className="sub-label">{ROLES[role]}</h4><button className="btn quiet icon sm" aria-label={t("New list: {role}", { role: ROLES[role] })} title={t("New list: {role}", { role: ROLES[role] })} onClick={() => setOverlay({ k: "newPool", kind: "text", textKind: role })}><Icon name="plus" size={14} /></button></div>
              {vText.some(ofRole(role)) ? listRows("text", ofRole(role)) : <p className="muted xs group-empty">{t("No list yet.")}</p>}
            </section>
          ))}
      </Family>
    );
  };

  // The release: its name is the title of both studios, and the menu to change it (the only place it shows);
  // its lyrics right next to it, at the same place in both studios.
  // Phone: where we are in the deck (a tap goes there) and the TikTok zones on / off (the clean preview, like
  // Space on a computer: the deck already swipes, so no full-screen view). Right under the middle slide's picture.
  const deckBar = (
    <div className="deck-bar" onClick={(e) => e.stopPropagation()}>
      <span />
      <div className="deck-dots" role="tablist" aria-label={t("Slides")}>
        {project.slides.map((_, i) => (
          <button key={i} role="tab" aria-selected={i === sel} aria-label={t("Slide {n}", { n: i + 1 })} className={i === sel ? "on" : ""}
            onClick={() => updProject((p) => ({ ...p, selectedSlide: i }))} />
        ))}
      </div>
      <button className={"deck-zones" + (ws.zones ? " on" : "")} aria-pressed={ws.zones} onClick={() => upd((w) => ({ ...w, zones: !w.zones }))}
        title={t("TikTok's interface zones on the slides")}>
        <Icon name={ws.zones ? "eye" : "eye-off"} size={15} />{t("Zones")}
      </button>
    </div>
  );
  const releaseTitle = (<>
    <div className="stack release-title">
      <span className="label">{t("Release")}</span>
      <Menu left trigger={(open, toggle) => (
        <button className={"release-pick" + (open ? " open" : "")} aria-haspopup="menu" aria-expanded={open} onClick={toggle} title={t("Change, rename or create a release")}>
          <h2 className="display truncate">{project.name}</h2><Icon name="chevron" size={16} />
        </button>
      )}>
        {(close) => (<>
          <div className="label cap">{t("Releases")}</div>
          <div className="release-list">
            {ws.projects.map((p) => (
              <button key={p.id} onClick={() => { close(); if (p.id !== project.id) upd((w) => ({ ...w, currentProjectId: p.id })); }}>
                {p.id === project.id ? <Icon name="check" size={14} /> : <span style={{ width: 14, flex: "none" }} />}<span className="truncate">{p.name}</span>
              </button>
            ))}
          </div>
          <button onClick={() => { close(); setOverlay({ k: "newProject" }); }}><Icon name="plus" size={14} />{t("New release")}</button>
          <div className="sep" />
          <button onClick={() => { close(); setOverlay({ k: "rename" }); }}>{t("Rename")}</button>
          <button onClick={() => { close(); duplicateProject(); }}>{t("Duplicate")}</button>
          <div className="sep" />
          <button className="danger" style={{ color: "var(--danger)" }} onClick={() => { close(); setOverlay({ k: "confirm", title: t("Delete project"), label: t("Delete"), message: t("Are you sure you want to delete “{name}”? Its slide setup and project-only lists will be deleted too. This can't be undone.", { name: project.name }), run: deleteProject }); }}>{t("Delete")}</button>
        </>)}
      </Menu>
    </div>
  </>);

  // Settings and account: in the top bar on a computer, at the end of the tab bar on a phone.
  const settingsMenu = (close: () => void) => (<>
            <div className="label cap">{t("Language")}</div>
            <button onClick={() => { setLang("en"); close(); }}>{lang === "en" ? <Icon name="check" size={14} /> : <span style={{ width: 14 }} />}English</button>
            <button onClick={() => { setLang("fr"); close(); }}>{lang === "fr" ? <Icon name="check" size={14} /> : <span style={{ width: 14 }} />}Français</button>
            <div className="sep" />
            <button onClick={() => { close(); backup(); }}>{t("Back up my data")}</button>
            <button onClick={() => { close(); restoreInput.current?.click(); }}>{t("Restore a backup")}</button>
            <button onClick={() => { close(); setVersionsOpen(true); }}>{t("Version history")}</button>
            {/* The installed app: nothing here. The browser: installed, or the install, standing out. */}
            {canInstall && <><div className="sep" /><button className="menu-primary" onClick={() => { close(); void install(); }}><Icon name="download" size={14} />{t("Install the app")}</button></>}
            {installed && <><div className="sep" /><div className="menu-note"><Icon name="check" size={14} /><span>{t("App installed")}<small>{t("Open it from your dock or home screen.")}</small></span></div></>}
            <div className="sep" />
            <div className="label cap truncate">{userName}</div>
            <button onClick={() => signOut({ callbackUrl: "/" })}>{t("Sign out")}</button>
          </>);
  return (
    <div className="app">
      <header className="top">
        <div className="brand"><span className="brand-full"><Wordmark height={18} /> <small className="version">{VERSION}</small></span><span className="brand-icon"><Logo size={26} /></span></div>
        <div className="studio-switch" role="group" aria-label={t("Studio")} ref={switchRef}>
          {/* The white pill under the chosen studio: it slides from one to the other. */}
          <span className="studio-thumb" aria-hidden style={thumb ?? { opacity: 0 }} />
          <button className={studio === "carousel" ? "on" : ""} aria-pressed={studio === "carousel"} onClick={() => switchStudio("carousel")}>
            <Icon name="image" size={14} />{t("Carousel")}
          </button>
          <button className={studio === "video" ? "on" : ""} aria-pressed={studio === "video"} onClick={() => switchStudio("video")}>
            <Icon name="film" size={14} />{t("Video")}
          </button>
        </div>
        <span className="grow" />
        {/* Undo / redo: the whole release's history, the same for both studios, always here. */}
        <button className="btn icon quiet top-hist" aria-label={t("Undo")} title={`${t("Undo")} (⌘Z)`} onClick={undo} disabled={!history.past}><Icon name="undo" /></button>
        <button className="btn icon quiet top-hist" aria-label={t("Redo")} title={`${t("Redo")} (⇧⌘Z)`} onClick={redo} disabled={!history.future}><Icon name="redo" /></button>
        <span role="status" aria-live="polite" className={"badge save-badge " + (saveState === "error" || saveState === "conflict" ? "bad" : saveState === "saved" ? "ok" : "")}><span className="dot" />
          <span className="badge-text">{saveState === "saved" ? t("Saved") : saveState === "saving" ? <span className="shine">{t("Saving…")}</span> : saveState === "conflict" ? t("Not saved") : t("Not saved")}</span>
        </span>
        {saveState === "error" && <button className="btn sm" onClick={() => void flushSave()}>{t("Try again")}</button>}
        {!online && <span className="badge warn"><span className="dot" />{t("Offline")}</span>}
        <div className="top-settings"><Menu trigger={(open, toggle) => <button className={"me" + (open ? " open" : "")} aria-label={t("Settings and account")} title={userName} onClick={toggle}>{(userName || "?").trim().charAt(0).toUpperCase()}</button>}>
          {settingsMenu}
        </Menu></div>
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
      {driveAuth && (
        <div className="notice bad row" style={{ margin: "var(--s3) var(--s4) 0", justifyContent: "space-between" }}>
          <span>{t("Google Drive access expired. Reconnect to load your photos.")}</span>
          <button className="btn sm" onClick={() => { setDriveAuth(false); void signIn("google", { redirectTo: "/studio" }); }}>{t("Reconnect Google")}</button>
        </div>
      )}

      <div className="main" data-mobile-tab={mobileTab} data-studio={studio}>
        {(studio === "video" || videoSeen) && (
          <div style={{ display: studio === "video" ? "contents" : "none" }}>
          <VideoStudio
            active={studio === "video"}
            canUndo={!!history.past} canRedo={!!history.future} onUndo={undo} onRedo={redo}
            project={project}
            hookPools={poolsVisible(ws.textPools, project.id).filter((p) => p.kind === "hooks")}
            onDrawHook={(poolId, exclude, theme) => {
              // The latest workspace (not the one of this render): several hooks drawn in a row each take theirs out of the bag.
              const cur = wsRef.current ?? ws;
              const bags = { ...cur.bags };
              const hook = drawHook(cur, poolId, bags, exclude, theme);
              // The bag drawn from (the list's, or one theme's) keeps what is left.
              if (hook !== null) upd((w) => ({ ...w, bags: { ...w.bags, ...Object.fromEntries(Object.entries(bags).filter(([k]) => k === poolId || k.startsWith(poolId + "#"))) } }));
              return hook;
            }}
            onProject={(fn) => upd((w) => ({ ...w, projects: w.projects.map((p) => (p.id === project.id ? fn(p) : p)) }))}
            onSaveNow={() => void flushSave()}
            releaseTitle={releaseTitle}
            library={textGroups(["hooks", "captions"])}
            lyricsRow={lyricsRow}
            captionPools={captionPools}
            onDrawCaption={drawCaptionFrom}
            onNewCaptionList={() => setOverlay({ k: "newPool", kind: "text", textKind: "captions" })}
            onEditLyrics={() => setOverlay({ k: "lyrics" })}
            fonts={fonts}
            onFonts={setFonts}
            presets={presets}
            onSavePreset={savePreset}
            onDeletePreset={deletePreset}
          />
          </div>
        )}
        {studio === "carousel" && (
        <>
        <aside className="col side l">
          <h2 className="lib-title">{t("Library")}</h2>
          <section className="group">
            <div className="group-head"><h3 className="label">{t("Release")}</h3></div>
            {lyricsRow}
          </section>
          {textGroups(["hooks", "texts", "captions"])}
          <Family id="photos" icon="image" title={t("Photos")} count={t("{n} lists", { n: vPics.length })}
            action={<button className="btn quiet icon sm" aria-label={t("New photo list")} title={t("New photo list")} onClick={() => setOverlay({ k: "newPool", kind: "photos" })}><Icon name="plus" size={14} /></button>}>
            {vPics.length ? listRows("photos") : <p className="muted xs group-empty">{t("No list yet.")}</p>}
          </Family>
        </aside>

        <main className="col center">
          {/* Same header as the video studio: the release on the left, its tools, the export on the right. */}
          <div className={"video-head studio-head carousel-head" + (headMore ? " more" : "")}>
            <div className="row nowrap video-title">{releaseTitle}</div>
            <div className="row nowrap video-tools">
              {/* Several carousels per release, like the videos: one to keep, another to try. */}
              <label className="field h-pick">{t("Carousel")}
                <Select className="input" style={{ width: 150 }} value={currentCarouselId(project)}
                  onChange={(e) => { const id = e.target.value; updProject((p) => openCarousel(p, id)); }}>
                  {carouselsOf(project).map((c) => <option key={c.id} value={c.id}>{carouselName(c)}</option>)}
                </Select>
              </label>
              <button className="btn icon h-new" aria-label={t("New carousel")} title={t("New carousel: the same slides set-up, to generate again")} onClick={() => { updProject((p) => addCarousel(p)); say(t("New carousel")); }}><Icon name="plus" /></button>
              <div className="slot h-new"><Menu trigger={(_, toggle) => <button className="btn icon quiet" aria-label={t("Carousel menu")} onClick={toggle}><Icon name="more" /></button>}>
                {(closeMenu) => (<>
                  <button onClick={() => { closeMenu(); setOverlay({ k: "renameCarousel" }); }}>{t("Rename")}</button>
                  <button onClick={() => { closeMenu(); updProject((p) => duplicateCarousel(p, t("(copy)"))); }}>{t("Duplicate")}</button>
                  <div className="sep" />
                  <button className="danger" style={{ color: "var(--danger)" }} disabled={carouselsOf(project).length < 2}
                    onClick={() => { closeMenu(); setOverlay({ k: "confirm", title: t("Delete carousel"), label: t("Delete"), message: t("Delete “{name}”? Its slides and drawn texts and photos go with it. This can't be undone.", { name: carouselName(carouselsOf(project).find((c) => c.id === currentCarouselId(project))!) }), run: () => updProject((p) => deleteCarousel(p)) }); }}>{t("Delete this carousel")}</button>
                </>)}
              </Menu></div>
              <div className="field h-gen"><span className="field-k">{t("Draw")}</span>
                <button className="btn primary" onClick={generate} title={t("Draws the texts and photos of every slide again. Shortcut: G")}><Icon name="sparkle" />{t("Generate")}</button>
              </div>
              {/* Phone: the rest of the tools fold under this button. */}
              <button className={"btn h-more" + (headMore ? " on" : "")} aria-expanded={headMore} onClick={() => setHeadMore((v) => !v)}>{t("More")}<Icon name="chevron" size={14} /></button>
              <div className="field h-count">{t("Slides")}
                <div className="stepper">
                  <button className="btn quiet icon sm" aria-label={t("Delete slide")} title={t("Delete slide")} onClick={() => deleteSlide(sel)} disabled={nSlides <= 1}><Icon name="minus" size={14} /></button>
                  <span>{nSlides === 1 ? t("1 slide") : t("{n} slides", { n: nSlides })}</span>
                  <button className="btn quiet icon sm" aria-label={t("Add a slide after this one")} title={t("Add a slide after this one")} onClick={addSlide} disabled={nSlides >= MAX_SLIDES}><Icon name="plus" size={14} /></button>
                </div>
              </div>
              <button className="btn icon quiet hist" aria-label={t("Undo")} title={`${t("Undo")} (⌘Z)`} onClick={undo} disabled={!history.past}><Icon name="undo" /></button>
              <button className="btn icon quiet hist" aria-label={t("Redo")} title={`${t("Redo")} (⇧⌘Z)`} onClick={redo} disabled={!history.future}><Icon name="redo" /></button>
              <div className="row nowrap head-actions">
              {exportProgress && <span className="badge h-progress" aria-live="polite">{exportProgress.done}/{exportProgress.total}</span>}
              {busy && <button className="btn h-cancel" onClick={() => { cancelExport.current = true; }}>{t("Cancel")}</button>}
              <div className="slot h-opts"><Menu trigger={(_, toggle) => <button className="btn quiet" onClick={toggle}>{t("Options")}<Icon name="chevron" size={14} /></button>}>
                {() => (
                  <div className="stack" style={{ padding: "var(--s2) var(--s3)", minWidth: 270 }}>
                    <label className="check"><input type="checkbox" checked={ws.noRepeat} onChange={(e) => upd((w) => ({ ...w, noRepeat: e.target.checked }))} />{t("No repeats until everything was used")}</label>
                    <label className="check"><input type="checkbox" checked={!!ws.favorTop} onChange={(e) => upd((w) => ({ ...w, favorTop: e.target.checked }))} />{t("Favor my best hooks (by TikTok views)")}</label>
                    <label className="field">{t("Export format")}
                      <Select className="input" value={ws.exportFormat} onChange={(e) => upd((w) => ({ ...w, exportFormat: e.target.value as "jpg" | "png" }))}>
                        <option value="jpg">JPG</option><option value="png">PNG</option>
                      </Select>
                    </label>
                  </div>
                )}
              </Menu></div>
              <button className="btn icon h-share" aria-label={t("Send to my phone")} title={t("Send to my phone (QR code)")} onClick={() => setShareOpen(true)} disabled={busy || !project.generated}><Icon name="share" /></button>
              {carouselsOf(project).length > 1 && !busy ? (
                <div className="slot h-dl"><Menu trigger={(_, toggle) => (
                  <button className="btn primary" aria-label={t("Download")} onClick={toggle}><Icon name="download" /><span className="lbl">{t("Download")}</span><Icon name="chevron" size={14} /></button>
                )}>
                  {(closeMenu) => (<>
                    <button disabled={!project.generated} onClick={() => { closeMenu(); void downloadAll(); }}>{t("This carousel")}</button>
                    <button onClick={() => { closeMenu(); void downloadAll(true); }}>{t("All the carousels ({n})", { n: carouselsOf(project).length })}</button>
                  </>)}
                </Menu></div>
              ) : (
                <button className={"btn primary h-dl" + (busy ? " shine-box" : "")} aria-label={t("Download all")} onClick={() => void downloadAll()} disabled={busy || !project.generated}><Icon name="download" /><span className="lbl">{busy ? t("Exporting…") : t("Download all")}</span></button>
              )}
              </div>
            </div>
          </div>
          {warnings.length > 0 && (
            <details className="notice warn preflight">
              <summary>{t("{n} points to check before generating", { n: warnings.length })}</summary>
              <ul className="xs">
                {warnings.map((w, i) => <li key={i}>{t(w.key, w.params)}</li>)}
              </ul>
            </details>
          )}
          {!project.generated && (
            <div className="board-empty">
              <h2 className="display">{t("Make your next")} <em>{t("post")}</em>.</h2>
              <ol>
                <li>{t("Add photos from your Drive")}</li>
                <li>{t("Write or import your texts and lyrics")}</li>
                <li>{t("Press Generate")}</li>
              </ol>
            </div>
          )}
          <div className="deck-wrap" ref={deckWrapRef}>
          <div ref={deckRef} onScroll={onDeckScroll} className={"slides" + (boardDrag ? " drag-in" : "")}>
            {project.slides.map((cfg, i) => (
              <SlideCard key={cfg.id} index={i} cfg={i === sel && fontPreview ? { ...cfg, style: { ...cfg.style, ...fontPreview } } : cfg} gen={project.generated?.[i]} selected={i === sel}
                textPools={slideTexts} picPools={vPics} zones={ws.zones} fontsReady={fontsReady} below={<div className="deck-spacer" aria-hidden />}
                lyrics={project.lyrics} onEditLyrics={() => setOverlay({ k: "lyrics" })}
                locked={!!cfg.locked} canMoveLeft={i > 0} canMoveRight={i < nSlides - 1}
                onSelect={() => i !== project.selectedSlide && updProject((p) => ({ ...p, selectedSlide: i }))}
                onCfg={(fn) => updSlide(i, fn)} onText={(txt) => setGen(i, { text: txt, edited: true })}
                onLyricsBack={() => setGen(i, { text: cfg.textSource.kind === "lyrics" ? slideLyrics(project, cfg.textSource) : "", edited: false })}
                onRerollPic={() => rerollPic(i)} onRerollText={() => rerollText(i)} onSave={() => saveOne(i)}
                onWebPic={(img) => setGen(i, { picId: webPicId(img.full), picName: img.author || img.license,
                  picCredit: { author: img.author, license: img.license, page: img.page, required: img.creditRequired } })}
                onImage={(blob, name) => { setBoardDrag(false); setDropPic({ i, blob, name }); }}
                onDuplicate={() => duplicateSlide(i)} onDelete={() => deleteSlide(i)}
                onAdjustAll={(a) => { updProject((p) => ({ ...p, slides: p.slides.map((s) => (s.locked ? s : { ...s, pic: { ...s.pic, adjust: a ? { ...a } : undefined } })) })); say(t("Photo edits put on every slide")); }}
                onMoveLeft={() => moveSlide(i, i - 1)} onMoveRight={() => moveSlide(i, i + 1)}
                onToggleLock={() => updSlide(i, (s) => ({ ...s, locked: !s.locked }))}
                dragging={dragFrom === i} dragOver={dragOver === i && dragFrom !== i}
                onDragStart={() => setDragFrom(i)} onDragEnd={() => { setDragFrom(null); setDragOver(null); }}
                onDragOver={() => setDragOver(i)}
                onDrop={() => { if (dragFrom !== null && dragFrom !== i) moveSlide(dragFrom, i); setDragFrom(null); setDragOver(null); }} />
            ))}
          </div>
          {/* Phone: the bar stays put while the slides swipe under it, over the room kept under the middle picture. */}
          {deckTop !== null && <div className="deck-float" style={{ top: deckTop }}>{deckBar}</div>}
          </div>
          <section className="post-box">
            <h3 className="label">{t("Caption and hashtags")}</h3>
            <PostCaption auto value={project.caption ?? ""} poolId={project.captionPoolId} pools={captionPools}
              onChange={(caption) => updProject((p) => ({ ...p, caption }))}
              onPool={(captionPoolId) => updProject((p) => ({ ...p, captionPoolId }))}
              onDraw={drawCaption}
              onNewList={() => setOverlay({ k: "newPool", kind: "text", textKind: "captions" })} />
          </section>
        </main>

        <aside className="col side r">
          <Inspector index={sel} cfg={project.slides[sel]} zones={ws.zones} onZones={(v) => upd((w) => ({ ...w, zones: v }))}
            onCfg={(fn) => updSlide(sel, fn)} onApplyAll={applyAll}
            lyrics={project.lyrics} presets={presets} fonts={fonts} onFonts={setFonts} onPreview={setFontPreview}
            onSavePreset={(name) => savePreset(name, project.slides[sel].style)} onApplyPreset={applyPreset} onDeletePreset={deletePreset} />
        </aside>
        </>
        )}
      </div>

      {/* Phone: one panel at a time, like an app (the centre, the files / lists on the left, the style on the right). */}
      <nav className="mobile-tabs" aria-label={t("Sections")} data-tab={mobileTab}>
        <button className={mobileTab === "slides" ? "on" : ""} aria-pressed={mobileTab === "slides"} onClick={() => pickMobileTab("slides")}><Icon name={studio === "video" ? "film" : "image"} size={18} /><span className="tab-name">{studio === "video" ? t("Video") : t("Slides")}</span></button>
        <button className={mobileTab === "lists" ? "on" : ""} aria-pressed={mobileTab === "lists"} onClick={() => pickMobileTab("lists")}><Icon name="library" size={18} /><span className="tab-name">{t("Library")}</span></button>
        <button className={mobileTab === "style" ? "on" : ""} aria-pressed={mobileTab === "style"} onClick={() => pickMobileTab("style")}><Icon name="sliders" size={18} /><span className="tab-name">{t("Style")}</span></button>
        <span className="mobile-tabs-sep" aria-hidden />
        <Menu trigger={(open, toggle) => <button className={"me mobile-me" + (open ? " open" : "")} aria-label={t("Settings and account")} onClick={toggle}>{(userName || "?").trim().charAt(0).toUpperCase()}</button>}>
          {settingsMenu}
        </Menu>
      </nav>

      {edText && (
        <TextPoolEditor pool={edText} onClose={() => setEditor(null)} onDelete={() => askDeletePool("text", edText.id)}
          onChange={(fn) => setTextPool(edText.id, (x) => scopeFix(fn(x)))} onImport={() => setOverlay({ k: "import", poolId: edText.id })}
          onRefreshViews={() => void refreshViews(edText)} viewsBusy={viewsBusy} />
      )}
      {edPics && (
        <PicPoolEditor pool={edPics} onClose={() => setEditor(null)} onDelete={() => askDeletePool("photos", edPics.id)}
          onChange={(fn) => setPicPool(edPics.id, (x) => scopeFix(fn(x)))} onBrowse={() => setOverlay({ k: "drive", poolId: edPics.id })}
          onSync={(manual) => void syncDrive(edPics.id, manual)} />
      )}

      {overlay?.k === "drive" && (
        <DriveBrowser onClose={() => setOverlay(null)} onAdd={(pics: PicRef[], toAll: boolean, folder) => {
          const ids = new Set<string>([overlay.poolId]);
          if (toAll) project.slides.forEach((s) => s.picPoolId && ids.add(s.picPoolId));
          upd((w) => ({
            ...w,
            picPools: w.picPools.map((x) => {
              if (!ids.has(x.id)) return x;
              // The folder is linked to the list being edited only: the other lists just get a copy.
              const link = folder && x.id === overlay.poolId ? folder : null;
              const have = new Set(x.pics.map((y) => y.id));
              const add = pics.filter((y) => !have.has(y.id)).map((y) => (link ? { ...y, folder: link.id } : y));
              const next = { ...x, pics: [...x.pics, ...add] };
              if (link && !x.folders?.some((f) => f.id === link.id)) next.folders = [...(x.folders ?? []), link];
              return next;
            }),
          }));
          say(ids.size > 1 ? t("{n} photos added to {m} lists", { n: pics.length, m: ids.size }) : t("{n} photos added", { n: pics.length }));
        }} />
      )}
      {overlay?.k === "import" && (
        <HooksExtract pools={vText} initialPoolId={overlay.poolId} initialSource={overlay.source} onClose={() => setOverlay(null)} onAdd={(id, hooks: NewHook[]) => {
          if (id === NEW_IMPORT_POOL) {
            // Their own list, shared by every release: the lists made by hand are never touched.
            const views: Record<string, number> = {};
            hooks.forEach((h) => { if (h.views !== undefined) views[hookKey(h.text)] = h.views; });
            const pool: TextPool = { id: uid(), name: t("Imported hooks"), scope: "shared", kind: "hooks", text: hooks.map((h) => h.text).join("\n"), ...(Object.keys(views).length ? { views } : {}) };
            upd((w) => ({ ...w, textPools: [...w.textPools, pool] }));
            say(t("{n} hooks added to “{name}”", { n: hooks.length, name: pool.name }));
            return;
          }
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
      {dropPic && project && (
        <DropPhotoDialog blob={dropPic.blob} slide={dropPic.i} pools={vPics} canDrive={driveWrite} busy={dropBusy}
          findSame={() => findSamePicture(dropPic.blob, vPics.flatMap((p) => p.pics.map((x) => x.id)))}
          onConfirm={(c) => void confirmDrop(c)} onClose={() => { if (!dropBusy) setDropPic(null); }} />
      )}
      {iosHelp && (
        <Modal title={t("Install the app")} onClose={closeIosHelp}>
          <ol className="install-steps">
            <li><Icon name="share" size={16} /><span>{t("Tap Share at the bottom of Safari.")}</span></li>
            <li><Icon name="plus" size={16} /><span>{t("Choose “Add to Home Screen”.")}</span></li>
            <li><Icon name="check" size={16} /><span>{t("Open Rollout from its icon: full screen, like an app.")}</span></li>
          </ol>
          <div className="modal-foot"><button className="btn primary" onClick={closeIosHelp}>{t("Got it")}</button></div>
        </Modal>
      )}
      {versionsOpen && (
        <VersionHistory onClose={() => setVersionsOpen(false)}
          onRestore={(data) => { apply(linkAllLyrics(refreshAllLyrics(migrateLyrics(normalizeWorkspace(data), (n) => t("Part {n}", { n }), t("Chorus"))))); say(t("Version restored: undo to go back")); }} />
      )}
      {preview && studio === "carousel" && (
        <SlidePreview index={sel} total={nSlides} cfg={project.slides[sel]} gen={project.generated?.[sel]} fontsReady={fontsReady}
          onNav={(i) => updProject((p) => ({ ...p, selectedSlide: i }))} onClose={() => setPreview(false)} />
      )}
      {overlay?.k === "newPool" && <NewPoolDialog kind={overlay.kind} textKind={overlay.textKind} onCreate={createPool} onClose={() => setOverlay(null)}
        onCreateImport={(name, scope) => {
          // The new hooks list, then the import window straight into it.
          const id = uid();
          upd((w) => ({ ...w, textPools: [...w.textPools, { id, name: name || t("Imported hooks"), scope, projectId: scope === "project" ? project.id : undefined, kind: "hooks", text: "" }] }));
          setOverlay({ k: "import", poolId: id });
        }} />}
      {overlay?.k === "newProject" && <PromptDialog title={t("New project")} label={t("Release name")} confirmLabel={t("Create")} onSubmit={createProject} onClose={() => setOverlay(null)} />}
      {shareOpen && (
        <ShareDialog kind="images" caption={project.caption} onClose={() => setShareOpen(false)}
          title={carouselsOf(project).length > 1 ? `${project.name} · ${carouselName(carouselsOf(project).find((c) => c.id === currentCarouselId(project))!)}` : project.name}
          build={async () => { cancelExport.current = false; return buildFiles(project); }} />
      )}
      {overlay?.k === "renameCarousel" && <PromptDialog title={t("Rename carousel")} label={t("Name")} initial={carouselName(carouselsOf(project).find((c) => c.id === currentCarouselId(project))!)} confirmLabel={t("Rename")} onSubmit={(n) => updProject((p) => renameCarousel(p, n))} onClose={() => setOverlay(null)} />}
      {overlay?.k === "rename" && <PromptDialog title={t("Rename project")} label={t("Name")} initial={project.name} confirmLabel={t("Rename")} onSubmit={(n) => updProject((p) => ({ ...p, name: n }))} onClose={() => setOverlay(null)} />}
      {overlay?.k === "confirm" && <ConfirmDialog title={overlay.title} message={overlay.message} confirmLabel={overlay.label} onConfirm={overlay.run} onClose={() => setOverlay(null)} />}
      {overlay?.k === "lyrics" && (
        <LyricsEditor name={project.name} lyrics={project.lyrics} song={project.lyricsLinked ? undefined : project.songLyrics} synced={!!project.lyricsLinked && !!project.lyricWords?.length} onChange={setLyrics} onClose={() => setOverlay(null)} />
      )}
      <Toast msg={toast} />
    </div>
  );
}
