"use client";
import { signIn, signOut } from "next-auth/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { defaultVideo, defaultWorkspace, isLineList, isSlidePhotoList, newProject, normalizeWorkspace, uid } from "@/lib/defaults";
import { delMedia } from "@/lib/idb";
import { DRIVE_AUTH_EVENT, DRIVE_PATHS, canWriteDrive, driveFolder, ensureDriveTree, findDriveTwins, findSamePicture, keepPicture, loadDriveImage, moveDriveFolder, prefetchDriveImages, renameDriveFolder, sendPictureToDrive, tidyDriveRoot, trashDriveFile, webPicId } from "@/lib/drive";
import DropPhotoDialog, { type DropChoice } from "./DropPhotoDialog";
import { loadSavedFonts, syncFontsWithDrive } from "@/lib/fonts";
import { type FaceInfo, renameFonts } from "@/lib/fontInfo";
import { googleFontsIn, loadGoogleFont } from "@/lib/googleFonts";
import { drawHook, generateAll, hookKey, pickPic, pickText, poolsVisible, textItems } from "@/lib/generate";
import { addVariants, carouselVariants, type Variant } from "@/lib/variants";
import { useT } from "@/lib/i18n";
import { safeName, saveBlob, saveBlobs, stamp } from "@/lib/files";
import { addCarousel, carouselsOf, currentCarouselId, deleteCarousel, duplicateCarousel, mapAllSlides, openCarousel, renameCarousel } from "@/lib/carousels";
import PostCaption from "./PostCaption";
import ShareDialog, { useHandheld } from "./ShareDialog";
import LyricsEditor from "./LyricsEditor";
import { linkAllLyrics, migrateLyrics, refreshAllLyrics, refreshLyricSlides, relinkSections, slideLyrics, songOf, sungOf } from "@/lib/lyricsSections";
import { loadFonts, slideToBlob, textOverflow } from "@/lib/render";
import type { GenSlide, PicEdit, PicPool, Project, SlideCfg, StylePreset, TextPool, Workspace } from "@/lib/types";
import HooksExtract, { NEW_IMPORT_POOL, NewHook } from "./HooksExtract";
import Icon from "./Icon";
import Inspector from "./Inspector";
import Wordmark from "./Wordmark";
import { PicPoolEditor, TextPoolEditor } from "./PoolEditors";
import { withPreset } from "./TextControls";
import SlidePreview from "./SlidePreview";
import VersionHistory from "./VersionHistory";
import SlideCard from "./SlideCard";
import { StyleTabs, useStyleParts, type SheetPart } from "./StyleSheet";
import VideoStudio, { type CopyJob } from "./VideoStudio";
import Logo from "./Logo";
import { useInstall } from "./InstallApp";
import { merge3 } from "@/lib/merge";
import { isDemo } from "@/lib/demo";
import PicStack from "./PicStack";
import StorageDialog from "./StorageDialog";
import HiddenTagsDialog from "./HiddenTagsDialog";
import VariantsDialog from "./VariantsDialog";
import ShortcutsDialog from "./ShortcutsDialog";
import { ConfirmDialog, Family, Menu, Modal, NewPoolDialog, PromptDialog, Select, Toast } from "./ui";

/** The generated slides of a carousel, one per slide (a slide not generated yet: empty). */
const gensOf = (p: Project): GenSlide[] => Array.from({ length: p.slides.length }, (_, k) => p.generated?.[k] ?? { text: "", picId: null });
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

type Editor = { k: "text" | "photos"; id: string; /** Open on the texts sorted by tag (right after an import). */ byTag?: boolean } | null;
type MobileTab = "slides" | "lists" | "style";
type CarPart = "text" | "photo" | "position" | "presets";
type PreflightItem = { key: string; params?: Record<string, string | number> };
type Overlay =
  | null
  | { k: "import"; poolId: string | null; source?: "tiktok" }
  | { k: "lyrics" }
  | { k: "newPool"; kind: "text" | "photos"; textKind?: TextPool["kind"] }
  | { k: "renameCarousel" }
  | { k: "newProject" }
  | { k: "rename" }
  | { k: "hiddenTags" }
  | { k: "variants"; list: Variant[] }
  | { k: "confirm"; title: string; message: string; label: string; run: () => void };


export default function Studio({ userName }: { userName: string }) {
  const { t, lang, setLang } = useT();
  const [ws, setWs] = useState<Workspace | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error" | "conflict">("saved");
  const [editor, setEditor] = useState<Editor>(null);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [studio, setStudio] = useState<"carousel" | "video">("carousel");
  /** The splash stays over the app until what the screen shows is ready (the first slides' photos, the video's
   *  picture), 2.5 s at most, then fades: no half-empty screen filling in after it. */
  const [boot, setBoot] = useState<"hold" | "fade" | "gone">("hold");
  /** How far the start is (0-1), shown under the logo: the app running, the data, then the pictures on screen. */
  const [bootP, setBootP] = useState(0.08);
  const bootTo = (p: number) => setBootP((x) => Math.max(x, Math.min(1, p)));
  useEffect(() => { bootTo(0.22); }, []);
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
    // Only a real change of size re-places it at once (the observer also calls back right away: that one must not
    // cut the slide that just started).
    let width = el.offsetWidth;
    const ro = new ResizeObserver(() => { if (el.offsetWidth !== width) { width = el.offsetWidth; place(false); } });
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
  const [storageOpen, setStorageOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  /** A working copy of a take on its way to the Drive (shown in the top bar, whatever is open). */
  const [copyJob, setCopyJob] = useState<CopyJob | null>(null);
  const [fonts, setFonts] = useState<string[]>([]);
  /** Fonts saved before their family and style were read from the files: the texts using them follow. */
  const [renamedFonts, setRenamedFonts] = useState<Record<string, FaceInfo>>({});
  /** Font under the pointer in the font list: shown on the selected slide until the pointer leaves. */
  const [fontPreview, setFontPreview] = useState<Partial<SlideCfg["style"]> | null>(null);
  const [busy, setBusy] = useState(false);
  /** "Send to my phone" (QR code) for the open carousel. */
  const [shareOpen, setShareOpen] = useState(false);
  const handheld = useHandheld();
  const [mobileTab, setMobileTab] = useState<MobileTab>("slides");
  const { canInstall, installed, install, iosHelp, closeIosHelp } = useInstall();
  // Phone: the tools of the studio head folded under "More" (the release, share, download and generate stay out).
  const [headMore, setHeadMore] = useState(false);
  // The TikTok zones: on a computer the Style setting (saved with the data); on a phone the deck's own switch, kept
  // on this device only, so hiding them on the phone leaves the computer's as they were.
  const [isPhone, setIsPhone] = useState(false);
  const [phoneZones, setPhoneZones] = useState(true);
  useEffect(() => {
    const m = matchMedia("(max-width: 640px)");
    const f = () => setIsPhone(m.matches);
    f();
    m.addEventListener("change", f);
    try { if (localStorage.getItem("tktgen-phone-zones") === "0") setPhoneZones(false); } catch { /* private mode */ }
    return () => m.removeEventListener("change", f);
  }, []);
  const togglePhoneZones = () => setPhoneZones((v) => { try { localStorage.setItem("tktgen-phone-zones", v ? "0" : "1"); } catch { /* private mode */ } return !v; });
  // Phone: the slides are a deck swiped sideways; the one in the middle is the selected one (and the other way round).
  const deckRef = useRef<HTMLDivElement>(null);
  // The caption block as wide as the slides above it (their first row), never wider: 3 slides, 3 slides' width.
  const postRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const deck = deckRef.current, post = postRef.current;
    if (!deck || !post || typeof ResizeObserver === "undefined") return;
    const fit = () => {
      const cards = [...deck.children].filter((x): x is HTMLElement => x instanceof HTMLElement && x.classList.contains("card"));
      // Only the computer's grid: the phone's deck is a row that scrolls (the block takes the page's width there).
      if (getComputedStyle(deck).display !== "grid" || !cards.length) { post.style.maxWidth = ""; return; }
      const row = cards.filter((x) => x.offsetTop === cards[0].offsetTop);
      const last = row[row.length - 1];
      post.style.maxWidth = `${last.offsetLeft + last.offsetWidth - cards[0].offsetLeft}px`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(deck);
    const mo = new MutationObserver(fit); // a slide added or removed (same grid size when the row is not full)
    mo.observe(deck, { childList: true });
    return () => { ro.disconnect(); mo.disconnect(); };
  }, [studio, !!ws]);
  const deckWrapRef = useRef<HTMLDivElement>(null);
  /** Where the deck bar goes (the top of the room kept under the middle slide's picture), or null off the phone. */
  const [deckTop, setDeckTop] = useState<number | null>(null);
  // Phone: the slide's style opens as a sheet under the deck (no Style tab), on the part chosen under the slide.
  const rightColRef = useRef<HTMLElement>(null);
  const carParts: SheetPart<CarPart>[] = [
    { id: "text", label: t("Text") }, { id: "photo", label: t("Photo") }, { id: "position", label: t("Position") }, { id: "presets", label: t("Presets") },
  ];
  // Phone: the Library is one page for the whole release, whatever the studio: the video studio's library column
  // (the release's lyrics, audio and takes, with all they can do, then every text list and the photos) shows there
  // in the carousel too, so nothing needs a studio switch.
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const mq = matchMedia("(max-width: 1000px)");
    const f = () => setPhone(mq.matches);
    f();
    mq.addEventListener("change", f);
    return () => mq.removeEventListener("change", f);
  }, []);
  const libHub = phone && mobileTab === "lists";
  // The dock's pill: placed on the open page's button (measured), it slides from one to the next.
  const dockRef = useRef<HTMLElement>(null);
  const [dockThumb, setDockThumb] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    const nav = dockRef.current;
    if (!nav) return;
    const place = (slide: boolean) => {
      const on = nav.querySelector<HTMLElement>(mobileTab === "lists" ? ".dock-lib" : `.dock-pair > button:nth-of-type(${mobileTab === "style" ? 2 : 1})`);
      if (!on || !on.offsetParent) return;
      // Its place in the dock's layout (inside the dock's border: its padding box is the pill's frame), not on screen:
      // a button moving for a moment (the dock's own animations, pressed) does not move the pill.
      let x = 0, y = 0;
      for (let el: HTMLElement | null = on; el && el !== nav; el = el.offsetParent as HTMLElement | null) { x += el.offsetLeft; y += el.offsetTop; }
      // It slides sideways only: its height place follows at once (the video's player row comes and goes with the
      // library, the dock's buttons move up or down then).
      setDockThumb((cur) => ({ translate: `${x}px 0`, top: y, width: on.offsetWidth, height: on.offsetHeight, ...(cur && slide ? {} : { transition: "none" }) }));
    };
    place(true);
    if (typeof ResizeObserver === "undefined") return;
    let w = nav.offsetWidth, h = nav.offsetHeight;
    const ro = new ResizeObserver(() => { if (nav.offsetWidth !== w || nav.offsetHeight !== h) { w = nav.offsetWidth; h = nav.offsetHeight; place(false); } });
    ro.observe(nav);
    return () => ro.disconnect();
  }, [mobileTab, studio, lang, phone, !!ws]);
  // Kept mounted once shown (its files stay read).
  useEffect(() => { if (libHub) setVideoSeen(true); }, [libHub]);

  // Phone, the studio's own page: the board's dots run from the top down to the end of the preview's block (the
  // video's info lines / the slides' dots and Zones), fading out from the picture's bottom; below, plain black.
  useEffect(() => {
    if (mobileTab !== "slides" || typeof ResizeObserver === "undefined") return;
    const mq = matchMedia("(max-width: 1000px)");
    let ro: ResizeObserver | null = null;
    let centre: HTMLElement | null = null;
    const measure = () => {
      if (!centre) return;
      const top = centre.getBoundingClientRect().top;
      const pic = centre.querySelector<HTMLElement>(".video-stage .cv-wrap, .card.sel .cv-wrap");
      const ends = [...centre.querySelectorAll<HTMLElement>(".video-stage, .deck-float, .deck-wrap")].filter((e) => e.offsetParent);
      if (!pic || !ends.length) { centre.style.removeProperty("--dots-end"); return; }
      const end = Math.max(...ends.map((e) => e.getBoundingClientRect().bottom)) - top + 8;
      centre.style.setProperty("--dots-fade", `${Math.round(pic.getBoundingClientRect().bottom - top)}px`);
      centre.style.setProperty("--dots-end", `${Math.round(end)}px`);
    };
    const t = window.setTimeout(() => {
      centre = [...document.querySelectorAll<HTMLElement>(".main .col.center")].find((e) => e.offsetParent) ?? null;
      if (!centre || !mq.matches) return;
      measure();
      ro = new ResizeObserver(measure);
      ro.observe(centre);
      centre.querySelectorAll<HTMLElement>(".video-stage, .deck-wrap").forEach((e) => ro!.observe(e));
    }, 60);
    window.addEventListener("resize", measure);
    return () => { clearTimeout(t); ro?.disconnect(); window.removeEventListener("resize", measure); };
  }, [mobileTab, studio, !!ws]);
  /**
   * Twins in the Rollout tree (two devices, an older version of the app…), looked for once a day on this device:
   * folders of the same name merged, files with the same bytes in one folder kept once (the workspace then points
   * to the one kept, the others go to the Drive's bin, where they can be taken back for 30 days).
   */
  const tidyTwins = async () => {
    const KEY = "tktgen-drive-twins";
    let last = 0;
    try { last = Number(localStorage.getItem(KEY) ?? 0); } catch { /* private mode */ }
    if (!wsRef.current || isDemo() || Date.now() - last < 24 * 3600_000 || !(await canWriteDrive())) return;
    const used = JSON.stringify(wsRef.current);
    const { merged, twins } = await findDriveTwins((id) => used.includes(`"${id}"`));
    const drops = twins.reduce((n, g) => n + g.drop.length, 0);
    if (drops) {
      const now = wsRef.current;
      if (!now) return;
      let json = JSON.stringify(now);
      for (const g of twins) for (const d of g.drop) json = json.split(`"${d}"`).join(`"${g.keep}"`);
      const next: Workspace = JSON.parse(json);
      // A list that held two twins now holds the same photo twice: once.
      next.picPools = next.picPools.map((p) => {
        const seen = new Set<string>();
        const pics = p.pics.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
        return pics.length === p.pics.length ? p : { ...p, pics };
      });
      apply(next, false);
      await flushSave();
      for (const g of twins) for (const d of g.drop) await trashDriveFile(d);
    }
    try { localStorage.setItem(KEY, String(Date.now())); } catch { /* private mode */ }
    console.info(`[drive] twins: ${merged} folders merged, ${drops} files in double put in the bin`);
    if (merged || drops) say(t("Drive tidied: {n} duplicates removed (in the Drive's bin for 30 days)", { n: merged + drops }));
  };
  // Each photo keeps its own edits (colour, framing): whatever is changed on a slide is remembered for its photo.
  // Only a slide changed since the last look writes: the same photo on two slides with different edits made each
  // write its own in turn, for ever (the page stopped: "Maximum update depth exceeded").
  const slideEditsSeen = useRef(new Map<string, string>());
  useEffect(() => {
    const cur = wsRef.current;
    const p = cur?.projects.find((x) => x.id === cur.currentProjectId);
    if (!cur || !p?.generated) return;
    const edits = cur.picEdits ?? {};
    let changed: Record<string, PicEdit | null> | null = null;
    const seen = slideEditsSeen.current;
    p.slides.forEach((s, i) => {
      const id = p.generated?.[i]?.picId;
      if (!id) return;
      const plain = !s.pic.adjust && s.pic.zoom === 1 && !s.pic.ox && !s.pic.oy;
      const now: PicEdit | null = plain ? null : { adjust: s.pic.adjust, zoom: s.pic.zoom, ox: s.pic.ox, oy: s.pic.oy, format: s.format };
      const json = JSON.stringify(now), key = `${p.id}|${s.id}|${id}`;
      const moved = seen.get(key) !== json;
      seen.set(key, json);
      // A slide not changed since the last look writes nothing; two slides of the same photo changed at once: the first.
      if (!moved || (changed && id in changed)) return;
      if (json !== JSON.stringify(edits[id] ?? null)) (changed ??= {})[id] = now;
    });
    if (!changed) return;
    const diff: Record<string, PicEdit | null> = changed;
    const next = { ...edits };
    for (const [id, e] of Object.entries(diff)) { if (e) next[id] = e; else delete next[id]; }
    // Kept small: the 600 most recent.
    const keys = Object.keys(next);
    for (const k of keys.slice(0, Math.max(0, keys.length - 600))) delete next[k];
    // A note beside the edit, not an edit of its own: no undo step.
    apply({ ...cur, picEdits: next }, false);
  }, [ws]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!ws || boot !== "hold") return;
    const p = ws.projects.find((x) => x.id === ws.currentProjectId) ?? ws.projects[0];
    const ids = (p?.generated ?? []).slice(0, 3).map((g) => g?.picId).filter((x): x is string => !!x);
    // The pictures arriving fill the rest of the bar.
    let got = 0;
    const one = () => bootTo(0.5 + (0.45 * ++got) / Math.max(1, ids.length));
    const file = () => bootTo(0.75);
    window.addEventListener("rollout:video-file", file, { once: true });
    const shown = studio === "video"
      ? new Promise<void>((r) => window.addEventListener("rollout:video-ready", () => r(), { once: true }))
      : Promise.all(ids.map((id) => loadDriveImage(id).catch(() => null).finally(one))).then(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    let off = false;
    void Promise.race([shown, new Promise((r) => setTimeout(r, 2500))]).then(() => {
      if (off) return;
      bootTo(1);
      setBoot("fade");
      setTimeout(() => setBoot("gone"), 320);
    });
    return () => { off = true; window.removeEventListener("rollout:video-file", file); };
  }, [!!ws]); // eslint-disable-line react-hooks/exhaustive-deps
  // Google connected: the Rollout tree's fixed folders exist (Photos, Releases, Utils / LUTS, Fonts), once a visit.
  useEffect(() => {
    if (!ws || isDemo()) return;
    void ensureDriveTree().then(() => {
      // What the app had put loose in Rollout before the tree: each file to its place (once per device).
      const cur = wsRef.current;
      if (!cur) return;
      const photoList = new Map<string, string>();
      for (const pool of cur.picPools) for (const pic of pool.pics) if (!photoList.has(pic.id)) photoList.set(pic.id, pool.name);
      const releaseOf = new Map<string, string>();
      for (const p of cur.projects) {
        if (p.audioDriveId) releaseOf.set(p.audioDriveId, p.name);
        for (const v of p.videos ?? []) {
          if (v.drive?.originalId) releaseOf.set(v.drive.originalId, p.name);
          if (v.drive?.copy?.id) releaseOf.set(v.drive.copy.id, p.name);
          if (v.grade?.lut?.driveId) releaseOf.set(v.grade.lut.driveId, "\u0000lut");
        }
      }
      const byProject = new Map(cur.projects.map((p) => [p.id, p.name]));
      const byClip = new Map(cur.projects.flatMap((p) => (p.videos ?? []).map((v) => [v.id, p.name] as const)));
      return tidyDriveRoot((f) => {
        const kind = f.appProperties?.tktgen;
        const known = releaseOf.get(f.id);
        if (kind === "font" || /\.(ttf|otf|woff2?)$/i.test(f.name)) return DRIVE_PATHS.fonts;
        if (kind === "lut" || known === "\u0000lut" || /\.cube$/i.test(f.name)) return DRIVE_PATHS.luts;
        if (kind === "photo" || photoList.has(f.id)) return photoList.has(f.id) ? DRIVE_PATHS.photoList(photoList.get(f.id)!) : DRIVE_PATHS.photos;
        const release = known ?? (f.appProperties?.project ? byProject.get(f.appProperties.project) : undefined) ?? (f.appProperties?.clip ? byClip.get(f.appProperties.clip) : undefined);
        if (!release) return null;
        return kind === "audio" || f.mimeType.startsWith("audio/") ? DRIVE_PATHS.audios(release) : DRIVE_PATHS.videos(release);
      });
    }).then((n) => { console.info(`[drive] tree ready${n ? `, ${n} files tidied` : ""}`); })
      .then(() => tidyTwins())
      .then(() => import("@/lib/shareP2P").then((m) => m.closeOpenLinks())) // plan B's links of a share that is over
      .catch((e) => console.warn("[drive] tree", e));
  }, [!!ws]); // eslint-disable-line react-hooks/exhaustive-deps
  // The header's height (phone: the Style page holds the preview right under it).
  useEffect(() => {
    const top = document.querySelector<HTMLElement>(".app > .top");
    if (!top || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => document.documentElement.style.setProperty("--top-h", `${Math.round(top.getBoundingClientRect().height)}px`));
    ro.observe(top);
    return () => ro.disconnect();
  }, [studio, mobileTab, !!ws]);
  const carStyle = useStyleParts<CarPart>({
    column: () => rightColRef.current,
    parts: { text: '[data-sec="slide-text"]', photo: '[data-sec="slide-format"]', position: '[data-sec="slide-position"]', presets: '[data-sec="slide-presets"]' },
    all: '[data-sec^="slide-"], .insp-help',
    first: "text",
    active: mobileTab === "style" && studio === "carousel",
  });
  /** The slide in the middle right now (while swiping or scrubbing), before it becomes the selected one. */
  const [deckLive, setDeckLive] = useState<number | null>(null);
  /** The deck is moving (a swipe, a scrub, a jump to a dot): the fields under it fade out meanwhile. */
  const [deckSwiping, setDeckSwiping] = useState(false);
  /** Scrubbing the dots: the finger's place along them moves the deck live (snap off meanwhile). */
  const scrub = useRef(false);
  const scrubTo = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = deckRef.current;
    const cards = el ? ([...el.children] as HTMLElement[]) : [];
    if (!el || cards.length < 2) return;
    const r = e.currentTarget.getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (cards.length - 1);
    const at = (c: HTMLElement) => c.offsetLeft - (el.clientWidth - c.offsetWidth) / 2;
    const a = Math.floor(pos), b = Math.min(cards.length - 1, a + 1);
    el.scrollLeft = at(cards[a]) + (at(cards[b]) - at(cards[a])) * (pos - a);
  };
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
    const live = deckCentre();
    if (live >= 0) setDeckLive((cur) => (cur === live ? cur : live));
    if (deckTimer.current) clearTimeout(deckTimer.current);
    setDeckSwiping(true);
    // The end of the move: the browser's scrollend when it has it (right away), else a short pause.
    deckTimer.current = setTimeout(deckSettle, "onscrollend" in window ? 400 : 70);
  };
  const deckSettle = () => {
    if (deckTimer.current) { clearTimeout(deckTimer.current); deckTimer.current = null; }
    if (scrub.current) return;
    setDeckSwiping(false);
    setDeckLive(null); // at rest, the selected slide is the one in the middle
    const i = deckCentre();
    if (i >= 0) updProject((p) => (p.selectedSlide === i ? p : { ...p, selectedSlide: i }));
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
  /** The data as last loaded from or saved to the server: what a merge starts from (see lib/merge). */
  const baseRef = useRef<unknown>(null);
  const merges = useRef(0);
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
  /** A new account's first lists, named for real use (hooks, transitions, captions, photos by kind). */
  const starterNames = () => ({ release: t("My first release"), hooks: t("Hooks"), transitions: t("Transitions"), captions: t("Captions"),
    pics: [t("Portraits"), t("Stage & live"), t("Studio & backstage")] as [string, string, string] });
  const persistHistory = useCallback(() => {
    if (isDemo()) return; // the demo's steps never reach the account's history
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
    // Demo: a brand-new account, in memory only (lib/demo).
    if (isDemo()) {
      const next = linkAllLyrics(refreshAllLyrics(migrateLyrics(normalizeWorkspace(defaultWorkspace(starterNames())), (n) => t("Part {n}", { n }), t("Chorus"))));
      rev.current = 0;
      wsRef.current = next;
      setWs(next);
      past.current = []; future.current = []; lastHistory.current = 0;
      syncHistory();
      return;
    }
    fetch("/api/workspace")
      .then(async (r) => {
        bootTo(0.35);
        const j = await r.json();
        bootTo(0.5);
        if (!r.ok) throw new Error(j.error ?? "Could not load your data");
        rev.current = j.data?.rev ?? 0;
        baseRef.current = j.data ?? null;
        // Saved data this version cannot read must never be replaced by an empty workspace (the next
        // autosave would overwrite it): stop with an error instead.
        if (j.data && (j.data.v !== 1 || !Array.isArray(j.data.projects))) throw new Error("Your saved data could not be read by this version of the app. Nothing was changed.");
        const next = linkAllLyrics(refreshAllLyrics(migrateLyrics(normalizeWorkspace(j.data ? (j.data as Workspace) : defaultWorkspace(starterNames())), (n) => t("Part {n}", { n }), t("Chorus"))));
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
    if (isDemo()) { setSaveState("saved"); return; } // demo: never saved
    setSaveState("saving");
    try {
      const r = await fetch("/api/workspace", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data, baseRev: rev.current }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) { rev.current = j.rev; retries.current = 0; baseRef.current = data; merges.current = 0; setSaveState("saved"); return; }
      if (r.status === 409) {
        // Another device saved meanwhile: its changes and this one's are merged (lib/merge), then saved.
        if (baseRef.current && merges.current < 3) {
          merges.current++;
          const g = await fetch("/api/workspace", { cache: "no-store" });
          const gj = g.ok ? await g.json() : null;
          if (gj?.data && gj.data.v === 1 && Array.isArray(gj.data.projects)) {
            const merged = merge3(baseRef.current, wsRef.current ?? data, gj.data) as Workspace;
            rev.current = gj.data.rev ?? j.rev;
            baseRef.current = gj.data;
            wsRef.current = merged;
            setWs(merged); // saved by the autosave, on the other device's revision
            say(t("Merged with your changes from another device"));
            return;
          }
        }
        rev.current = j.rev; conflict.current = true; setSaveState("conflict"); return;
      }
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

  // Changes made on another device (the phone extended a passage, its copy was made again…): read again when
  // this page comes back to the front, and every 30 s while it is shown, if nothing here is waiting to be saved.
  const saveStateRef = useRef(saveState);
  saveStateRef.current = saveState;
  const haveWs = !!ws;
  useEffect(() => {
    if (!haveWs) return;
    let busy = false;
    const pull = async () => {
      if (isDemo() || busy || document.visibilityState !== "visible" || saveStateRef.current !== "saved" || saveBusy.current || conflict.current) return;
      busy = true;
      try {
        const r = await fetch("/api/workspace", { cache: "no-store" });
        if (!r.ok) return;
        const j = await r.json();
        const srv = j.data?.rev ?? 0;
        if (!j.data || srv <= rev.current || saveStateRef.current !== "saved" || saveBusy.current) return;
        if (j.data.v !== 1 || !Array.isArray(j.data.projects)) return;
        rev.current = srv;
        baseRef.current = j.data;
        const next = linkAllLyrics(refreshAllLyrics(migrateLyrics(normalizeWorkspace(j.data as Workspace), (n) => t("Part {n}", { n }), t("Chorus"))));
        loaded.current = false; // the saved data itself: not saved back
        // The undo steps were of the old data: undoing would put it back over the other device's changes.
        past.current = []; future.current = []; lastHistory.current = 0;
        wsRef.current = next;
        setWs(next);
        syncHistory();
        say(t("Updated with your changes from another device"));
      } catch { /* offline: next time */ } finally { busy = false; }
    };
    const h = () => void pull();
    document.addEventListener("visibilitychange", h);
    window.addEventListener("focus", h);
    const id = window.setInterval(h, 30_000);
    return () => { document.removeEventListener("visibilitychange", h); window.removeEventListener("focus", h); clearInterval(id); };
  }, [haveWs]); // eslint-disable-line react-hooks/exhaustive-deps

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
  /** After an export: the retouched texts their lists do not have yet, offered once each (see lib/variants). */
  const offerVariants = (list: Variant[]) => {
    const p = project;
    if (!p) return;
    const keyOf = (v: Variant) => `${v.pool}|${hookKey(v.text)}`;
    const asked = new Set(p.variantsAsked ?? []);
    const fresh = list.filter((v, i) => !asked.has(keyOf(v)) && list.findIndex((w) => keyOf(w) === keyOf(v)) === i);
    if (!fresh.length) return;
    updProject((x) => ({ ...x, variantsAsked: [...(x.variantsAsked ?? []), ...fresh.map(keyOf)].slice(-300) }));
    setOverlay({ k: "variants", list: fresh });
  };
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
  // Known from the start (photo lists, new releases, uploads all depend on it), not only when a photo is dropped.
  useEffect(() => { void canWriteDrive().then(setDriveWrite).catch(() => setDriveWrite(false)); }, []);
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
      // Its folder: Rollout / Photos / <the list it goes to> (Photos itself when it goes to no list).
      const target = c.list === "new" ? { name: c.newName || "Pinterest", scope: "shared" } : c.list ? wsRef.current?.picPools.find((p) => p.id === c.list) : undefined;
      const id = c.reuse ?? (driveWrite ? await sendPictureToDrive(blob, `photo - ${name}`, target ? listPath(target) : undefined) : `local:${uid()}`);
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
      // A new source: its text is taken again from it, the retouches made on the slide are dropped. A lyrics
      // slide retouched by hand keeps its retouch aside: back on the lyrics, it comes back (and its (i) with it).
      const leaving = before!.textSource.kind === "lyrics" && after!.textSource.kind !== "lyrics";
      const back = before!.textSource.kind !== "lyrics" && after!.textSource.kind === "lyrics";
      const generated = q.generated?.map((g, k) => {
        if (k !== i) return g;
        if (leaving && g.edited) return { ...g, edited: false, lyricsDraft: g.text };
        if (back && g.lyricsDraft) { const { lyricsDraft, ...rest } = g; return { ...rest, text: lyricsDraft, edited: true }; }
        return g.edited ? { ...g, edited: false } : g;
      }) ?? null;
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
      const g = gensOf(p);
      // Another photo (dropped, pasted, found on the web): the edits made on the previous one do not follow it.
      const newPic = patch.picId !== undefined && patch.picId !== g[i].picId;
      g[i] = { ...g[i], ...patch };
      return { ...p, generated: g, slides: newPic ? p.slides.map((s, k) => (k === i ? reframe(s, g[i].picId) : s)) : p.slides };
    });

  // ---- generate ----
  // A new photo starts centred and untouched: no zoom, offset or photo edits (light, colours…) of the previous one.
  /** A slide gets another photo: that photo's own edits if it had some (its colour always, its framing when the
   *  format is the same), else none. */
  const reframe = (s: SlideCfg, picId?: string | null): SlideCfg => {
    const e = picId ? wsRef.current?.picEdits?.[picId] : undefined;
    if (!e) return { ...s, pic: { ...s.pic, zoom: 1, ox: 0, oy: 0, adjust: undefined } };
    const sameShape = e.format === s.format;
    return { ...s, pic: { ...s.pic, zoom: sameShape ? e.zoom : 1, ox: sameShape ? e.ox : 0, oy: sameShape ? e.oy : 0, adjust: e.adjust } };
  };

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
      const cfgs = p.slides.map((s, i) => (s.locked || slides[i]?.picId === p.generated?.[i]?.picId ? s : reframe(s, slides[i]?.picId)));
      // The post's caption: drawn again from its list, if it has one (another one than the current).
      const caption = p.captionPoolId ? drawHook(w, p.captionPoolId, bags, p.caption ? [p.caption] : []) ?? p.caption : p.caption;
      return { ...w, bags, projects: w.projects.map((x) => (x.id === p.id ? { ...x, generated: slides, slides: cfgs, caption } : x)) };
    });
  }, [say, t, upd]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (/INPUT|TEXTAREA|SELECT/.test(el.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (studio !== "carousel" || document.querySelector(".ov") || el.isContentEditable) return;
      // The list of them all: ShortcutsDialog.
      const key = e.key.toLowerCase();
      if (key === "r") generate();
      else if (key === "g") { if (isPhone) togglePhoneZones(); else upd((w) => ({ ...w, zones: !w.zones })); }
      // Space or F: clean full-size preview of the selected slide (and no page scroll / button press).
      else if (key === " " || key === "f") { e.preventDefault(); setPreview(true); }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [generate, studio, isPhone]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      // Only where text is typed does the field keep its own undo; after a slider, a colour, a checkbox, the app's.
      const typing = el.tagName === "TEXTAREA" || el.isContentEditable
        || (el.tagName === "INPUT" && /^(text|search|email|url|number|password|tel)?$/.test((el as HTMLInputElement).type));
      if (typing) return;
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
      const g = gensOf(p);
      g[i] = { ...g[i], picId: pic?.id ?? null, picName: pic?.name, picCredit: undefined }; // a photo of the list: no web credit
      const cfgs = p.slides.map((s, k) => (k === i ? reframe(s, pic?.id) : s));
      return { ...w, bags, projects: w.projects.map((x) => (x.id === p.id ? { ...x, generated: g, slides: cfgs } : x)) };
    });
  };
  /** A photo of the slide's list picked by hand. */
  const choosePic = (i: number, id: string, name: string) => {
    if (project?.slides[i]?.locked) return;
    upd((w) => {
      const p = w.projects.find((x) => x.id === w.currentProjectId)!;
      const g = gensOf(p);
      g[i] = { ...g[i], picId: id, picName: name, picCredit: undefined };
      const cfgs = p.slides.map((s, k) => (k === i ? reframe(s, id) : s));
      return { ...w, projects: w.projects.map((x) => (x.id === p.id ? { ...x, generated: g, slides: cfgs } : x)) };
    });
  };
  const rerollText = (i: number) => {
    if (project?.slides[i]?.locked) return;
    upd((w) => {
      const p = w.projects.find((x) => x.id === w.currentProjectId)!;
      const bags = { ...w.bags };
      const text = pickText(p, w, i, bags);
      const g = gensOf(p);
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
        ? gensOf(p)
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
        ? gensOf(p).filter((_, k) => k !== i)
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
        ? gensOf(p)
        : null;
      if (generated) { const [g] = generated.splice(from, 1); generated.splice(to, 0, g); }
      return { ...p, slides, generated, selectedSlide: to };
    });

  /** Copies the selected slide's settings to every slide: all of them, or one part only (the phone's Style page:
   *  the text's look without its place, the photo's format and framing, or the text's place). */
  const applyAll = (part?: "text" | "photo" | "position") => {
    updProject((p) => {
      const src = p.slides[p.selectedSlide];
      return { ...p, slides: p.slides.map((s) => {
        if (part === "text") return { ...s, style: { ...src.style, x: s.style.x, y: s.style.y } };
        if (part === "photo") return { ...s, format: src.format, pic: { ...src.pic } };
        if (part === "position") return { ...s, style: { ...s.style, x: src.style.x, y: src.style.y } };
        return { ...s, format: src.format, pic: { ...src.pic }, style: { ...src.style } };
      }) };
    });
    say(part === "text" ? t("Text style copied to all slides") : part === "photo" ? t("Photo settings copied to all slides")
      : part === "position" ? t("Text position copied to all slides") : t("Settings copied to all slides"));
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
    else {
      // Its folder in the Drive right away (Rollout / Photos / <name>, or in its release), and its window open to
      // drop the photos in.
      if (driveWrite) void driveFolder(listPath({ name, scope, projectId })).catch(() => {});
      const id = uid();
      upd((w) => ({ ...w, picPools: [...w.picPools, { id, name, scope, projectId, pics: [] }] }));
      setEditor({ k: "photos", id });
    }
  };
  /** Where a photo list's photos are in the Drive: Rollout / Photos / <list>, or inside its release when it is
   *  kept to one release (Releases / <release> / Photos / <list>). */
  const listPath = (pool: { name: string; scope: string; projectId?: string }) => {
    const rel = pool.scope === "project" ? wsRef.current?.projects.find((p) => p.id === pool.projectId)?.name : undefined;
    return rel ? DRIVE_PATHS.releasePhotos(rel || "Release", pool.name) : DRIVE_PATHS.photoList(pool.name);
  };
  // Photos added to a list from this device: each one sent to the list's folder in the Drive (Rollout / Photos /
  // <list>), kept on this device too, and added to the list as it arrives. Without Drive access: this device only.
  const [picUpload, setPicUpload] = useState<{ pool: string; done: number; total: number } | null>(null);
  // The open photo list's own folder in the Drive, as a link (the user sees where their photos are).
  const [picFolderUrl, setPicFolderUrl] = useState<string | null>(null);
  const openPics = editor?.k === "photos" ? wsRef.current?.picPools.find((x) => x.id === editor.id) : undefined;
  const openPicsPath = openPics && driveWrite ? listPath(openPics).join("/") : "";
  useEffect(() => {
    setPicFolderUrl(null);
    if (!openPics || !driveWrite) return;
    let off = false;
    void driveFolder(listPath(openPics)).then((id) => { if (!off) setPicFolderUrl(`https://drive.google.com/drive/folders/${id}`); }).catch(() => {});
    return () => { off = true; };
  }, [openPicsPath]); // eslint-disable-line react-hooks/exhaustive-deps
  const uploadToList = async (poolId: string, files: File[]) => {
    const pool = wsRef.current?.picPools.find((p) => p.id === poolId);
    if (!pool || !files.length) return;
    setPicUpload({ pool: poolId, done: 0, total: files.length });
    let done = 0, failed = 0;
    for (const file of files) {
      try {
        const id = driveWrite ? await sendPictureToDrive(file, file.name, listPath(pool)) : `local:${uid()}`;
        await keepPicture(id, file);
        setPicPool(poolId, (x) => (x.pics.some((y) => y.id === id) ? x : { ...x, pics: [...x.pics, { id, name: file.name }] }));
      } catch (e) { failed++; console.warn("[photos] upload", e); }
      setPicUpload({ pool: poolId, done: ++done, total: files.length });
    }
    setPicUpload(null);
    void flushSave();
    say(failed ? t("{n} photos could not be sent to your Drive", { n: failed }) : t("{n} photos added", { n: files.length }));
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
  const createProject = (name: string) => {
    // Its folder in the Drive right away: Rollout / Releases / <name> / Audios, Videos.
    if (driveWrite) { void driveFolder(DRIVE_PATHS.audios(name || "Release")).then(() => driveFolder(DRIVE_PATHS.videos(name || "Release"))).catch(() => {}); }
    upd((w) => {
      const tp = [1, 2, 3].map((n) => sharedPool(w.textPools, `Slide ${n} text`)).filter(Boolean) as TextPool[];
      const pp = [1, 2, 3].map((n) => w.picPools.find((x) => x.scope === "shared" && isSlidePhotoList(x.name, n))).filter(Boolean) as PicPool[];
      const p = newProject(name, tp, pp);
      return { ...w, projects: [...w.projects, p], currentProjectId: p.id };
    });
  };
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
    const when = stamp();
    const out: { name: string; blob: Blob }[] = [];
    for (let i = 0; i < p.slides.length; i++) {
      if (cancelExport.current) break;
      const g = p.generated?.[i];
      try {
        const img = g?.picId ? await loadDriveImage(g.picId) : null;
        out.push({ name: `slide${i + 1} ${when}.${ext}`, blob: await slideToBlob(p.slides[i], img, g?.text ?? "", ext) });
      } catch (e: any) {
        failures?.push(`Slide ${i + 1}: ${e?.message ?? t("Export failed")}`);
      }
      onStep?.(i + 1, p.slides.length);
    }
    return out;
  }
  /**
   * Downloads the open carousel: its pictures and its caption.txt (the post's text), straight into the downloads (no
   * zip), named after the release. Every carousel of the release (`all`): one zip, one folder per carousel.
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
      const release = safeName(project.name);
      const zip = all ? new (await import("jszip")).default() : null;
      const root = zip ? zip.folder(`${release} ${stamp()}`)! : null;
      let made = 0;
      const direct: { name: string; blob: Blob }[] = [];
      const usedNames = new Set<string>();
      for (const p of ready) {
        const files = await buildFiles(p, (done) => setExportProgress({ done: before + done, total }), failures);
        before += p.slides.length;
        if (cancelExport.current) { say(t("Export cancelled")); return; }
        if (!files.length) continue;
        made += files.length;
        const c = carouselsOf(p).find((x) => x.id === currentCarouselId(p))!;
        const many = carouselsOf(project).length > 1;
        const caption = p.caption?.trim() ? new Blob([p.caption.trim() + "\n"], { type: "text/plain" }) : null;
        if (!root) {
          // One carousel: the files themselves, named after the release (and the carousel when there are several).
          const prefix = safeName(project.name + (many ? ` - ${carouselName(c)}` : ""));
          direct.push(...files.map((f) => ({ name: `${prefix} - ${f.name}`, blob: f.blob })));
          if (caption) direct.push({ name: `${prefix} - caption ${stamp()}.txt`, blob: caption });
          continue;
        }
        const name = safeName(carouselName(c));
        // Two carousels of the same name get two folders (never one over the other).
        let folderName = name;
        for (let k = 2; usedNames.has(folderName.toLowerCase()); k++) folderName = `${name} (${k})`;
        usedNames.add(folderName.toLowerCase());
        const dir = root.folder(folderName)!;
        files.forEach((f) => dir.file(f.name, f.blob));
        // The pictures and the text of the post (ready to paste in TikTok), nothing else.
        if (caption) dir.file("caption.txt", caption);
      }
      if (!made) throw new Error(t("Export failed"));
      offerVariants(ready.flatMap((p) => carouselVariants(p, vText)));
      if (zip) saveBlob(await zip.generateAsync({ type: "blob" }), `${release} ${stamp()}.zip`);
      else await saveBlobs(direct);
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
      saveBlob(await slideToBlob(p.slides[i], img, g?.text ?? "", ext), `${safeName(p.name)} slide${i + 1} ${stamp()}.${ext}`);
    } catch (e: any) { say(e?.message ?? t("Export failed")); }
  }

  // ---- backup / restore ----
  const backup = () => saveBlob(new Blob([JSON.stringify(ws)], { type: "application/json" }), `Rollout backup ${stamp()}.json`);
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
  const bootEl = (over?: "on" | "out") => (
    <div className={"boot" + (over ? " boot-over" + (over === "out" ? " out" : "") : "")} aria-busy="true" role="status" aria-label={t("Loading…")}>
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
      {/* How far it is: the app, the data, then the pictures of the screen. */}
      <div className="boot-bar" aria-hidden><span style={{ width: `${Math.round(bootP * 100)}%` }} /></div>
      <span className="boot-pct mono">{Math.round(bootP * 100)} %</span>
    </div>
  );
  if (!ws || !project) return bootEl();

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
    (kind === "text" ? (only ? vText.filter(only) : vText) : vPics).map((p) => {
      const pics = "pics" in p;
      const first = pics ? "" : (textItems(p)[0] ?? "").replace(/\|/g, " ").replace(/\s+/g, " ").trim();
      const count = pics ? p.pics.length : textItems(p).length;
      return (
        <div key={p.id} className={"item lib-item" + (pics ? " is-pics" : "")} role="button" tabIndex={0} onClick={() => setEditor({ k: kind, id: p.id })}
          title={p.scope === "shared" ? t("all projects") : t("this project")}
          onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); setEditor({ k: kind, id: p.id }); } }}>
          {pics && <PicStack ids={p.pics.slice(0, 3).map((x) => x.id)} />}
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="lib-item-top"><span className="truncate item-name">{p.name}</span>{!pics && <span className="lib-count">{count}</span>}</div>
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
      <Family id="texts" icon="type" title={t("Texts")} count={(n === 1 ? t("1 list") : t("{n} lists", { n }))}>
          {roles.map((role) => (
            <section key={role} className="group sub">
              <div className="group-head"><h4 className="sub-label">{ROLES[role]}</h4><button className="btn quiet icon sm" aria-label={t("New list: {role}", { role: ROLES[role] })} title={t("New list: {role}", { role: ROLES[role] })} onClick={() => setOverlay({ k: "newPool", kind: "text", textKind: role })}><Icon name="plus" size={14} /></button></div>
              {vText.some(ofRole(role)) ? listRows("text", ofRole(role)) : <p className="muted xs group-empty">{t("No list yet.")}</p>}
            </section>
          ))}
      </Family>
    );
  };

  /** The photo lists (the carousel's; on a phone, the video studio's library shows them too, folded at first). */
  const photosFamily = (id = "photos", defaultOpen = true) => (
    <Family id={id} defaultOpen={defaultOpen} icon="image" title={t("Photos")} count={(vPics.length === 1 ? t("1 list") : t("{n} lists", { n: vPics.length }))}>
      {vPics.length ? listRows("photos") : <p className="muted xs group-empty">{t("No list yet.")}</p>}
      {/* Under the lists (the head keeps only its fold arrow, aligned with the texts'). */}
      <button className="lib-add" onClick={() => setOverlay({ k: "newPool", kind: "photos" })}><Icon name="plus" size={14} />{t("New photo list")}</button>
    </Family>
  );
  /** The draw's options, the same in both studios' Options menu (hooks for the videos, every text for the slides). */
  /** Generate and its warnings badge: in the carousel's head on a computer; floating over the dock on a phone. */
  const genRow = project && (
                <div className="row nowrap gen-row">
                  <button className="btn primary gen-btn" onClick={generate} title={t("Draws the texts and photos of every slide again. Shortcut: G")}><Icon name="sparkle-fill" />{t("Generate")}</button>
                  {/* What to check before generating: a small badge beside it, the list on a click. */}
                  {warnings.length > 0 && (
                    <Menu float left trigger={(open, toggle) => (
                      <button className={"btn warn-badge" + (open ? " open" : "")} onClick={toggle} aria-label={t("{n} points to check before generating", { n: warnings.length })} title={t("{n} points to check before generating", { n: warnings.length })}>
                        <Icon name="alert" size={14} />{warnings.length}
                      </button>
                    )}>
                      {() => (
                        <div className="preflight-pop">
                          <div className="label cap">{t("{n} points to check before generating", { n: warnings.length })}</div>
                          <ul className="xs">{warnings.map((w, i) => <li key={i}>{t(w.key, w.params)}</li>)}</ul>
                        </div>
                      )}
                    </Menu>
                  )}
                </div>
  );
  // The release: its name is the title of both studios, and the menu to change it (the only place it shows);
  // its lyrics right next to it, at the same place in both studios.
  // Phone: where we are in the deck (a tap goes there) and the TikTok zones on / off (the clean preview, like
  // Space on a computer: the deck already swipes, so no full-screen view). Right under the middle slide's picture.
  const deckBar = (
    <div className="deck-bar" onClick={(e) => e.stopPropagation()}>
      {/* The Style page: which slide is styled, across from Zones. */}
      <span className="deck-num">{t("Slide {n}", { n: (deckLive ?? sel) + 1 })}</span>
      {/* A tap on a dot goes there; a finger sliding along the dots scrubs through the deck, live. */}
      <div className="deck-dots" role="tablist" aria-label={t("Slides")}
        onPointerDown={(e) => {
          if (e.pointerType === "mouse") return;
          scrub.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          deckRef.current?.style.setProperty("scroll-snap-type", "none");
          scrubTo(e);
        }}
        onPointerMove={(e) => { if (scrub.current) scrubTo(e); }}
        onPointerUp={() => {
          if (!scrub.current) return;
          scrub.current = false;
          const el = deckRef.current;
          el?.style.removeProperty("scroll-snap-type");
          const i = deckCentre();
          const c = el?.children[i] as HTMLElement | undefined;
          if (el && c) el.scrollTo({ left: c.offsetLeft - (el.clientWidth - c.offsetWidth) / 2, behavior: "smooth" });
        }}
        onPointerCancel={() => { scrub.current = false; deckRef.current?.style.removeProperty("scroll-snap-type"); }}>
        {project.slides.map((_, i) => (
          <button key={i} role="tab" aria-selected={i === sel} aria-label={t("Slide {n}", { n: i + 1 })} className={i === (deckLive ?? sel) ? "on" : ""}
            onClick={() => updProject((p) => ({ ...p, selectedSlide: i }))} />
        ))}
      </div>

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
              <button key={p.id} className={p.id === project.id ? "on" : undefined} onClick={() => { close(); if (p.id !== project.id) upd((w) => ({ ...w, currentProjectId: p.id })); }}>
                {p.id === project.id ? <Icon name="check" size={14} /> : <span style={{ width: 14, flex: "none" }} />}<span className="truncate">{p.name}</span>
              </button>
            ))}
          </div>
          <button onClick={() => { close(); setOverlay({ k: "newProject" }); }}><Icon name="plus" size={14} />{t("New release")}</button>
          <div className="sep" />
          <button onClick={() => { close(); setOverlay({ k: "rename" }); }}>{t("Rename")}</button>
          <button onClick={() => { close(); setOverlay({ k: "hiddenTags" }); }}>{project.hiddenTags?.length ? t("Tags put aside ({n})", { n: project.hiddenTags.length }) : t("Put tags aside…")}</button>
          <button onClick={() => { close(); duplicateProject(); }}>{t("Duplicate")}</button>
          <div className="sep" />
          <button className="danger" style={{ color: "var(--danger)" }} onClick={() => { close(); setOverlay({ k: "confirm", title: t("Delete project"), label: t("Delete"), message: t("Are you sure you want to delete “{name}”? Its slide setup and project-only lists will be deleted too. This can't be undone.", { name: project.name }), run: deleteProject }); }}>{t("Delete")}</button>
        </>)}
      </Menu>
    </div>
  </>);

  // One slide card (the deck's, or on a phone the selected slide's fields under the deck).
  const cardFor = (cfg: SlideCfg, i: number, part?: "fields") => (
              <SlideCard key={(part ?? "") + cfg.id} part={part} index={i} cfg={i === sel && fontPreview ? { ...cfg, style: { ...cfg.style, ...fontPreview } } : cfg} gen={project.generated?.[i]} selected={i === sel}
                textPools={slideTexts} hiddenTags={project.hiddenTags} picPools={vPics} zones={isPhone ? phoneZones : ws.zones} onZones={isPhone ? togglePhoneZones : () => upd((w) => ({ ...w, zones: !w.zones }))} onFull={() => setPreview(true)} fontsReady={fontsReady} below={<div className="deck-spacer" aria-hidden />}
                lyrics={project.lyrics} onEditLyrics={() => setOverlay({ k: "lyrics" })}
                locked={!!cfg.locked} canMoveLeft={i > 0} canMoveRight={i < nSlides - 1}
                onSelect={() => i !== project.selectedSlide && updProject((p) => ({ ...p, selectedSlide: i }))}
                onCfg={(fn) => updSlide(i, fn)} onText={(txt) => { const g = project.generated?.[i]; setGen(i, { text: txt, edited: true, from: g?.edited ? g.from : g?.text }); }}
                onLyricsBack={() => setGen(i, { text: cfg.textSource.kind === "lyrics" ? slideLyrics(project, cfg.textSource) : "", edited: false })}
                onRerollPic={() => rerollPic(i)} onChoosePic={(id, name) => choosePic(i, id, name)} onRerollText={() => rerollText(i)} onSave={() => saveOne(i)}
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
  );

  // Settings and account: in the top bar on a computer, at the end of the tab bar on a phone.
  const settingsMenu = (close: () => void) => (<>
            <div className="label cap">{t("Language")}</div>
            <button onClick={() => { setLang("en"); close(); }}>{lang === "en" ? <Icon name="check" size={14} /> : <span style={{ width: 14 }} />}English</button>
            <button onClick={() => { setLang("fr"); close(); }}>{lang === "fr" ? <Icon name="check" size={14} /> : <span style={{ width: 14 }} />}Français</button>
            {/* The app's settings (both studios): the draw, and the format of the carousel's pictures. */}
            {ws && (
              <div className="menu-draw">
                <div className="sep" />
                <div className="label cap">{t("Draw")}</div>
                <label className="check menu-check"><input type="checkbox" checked={ws.noRepeat} onChange={(e) => upd((w) => ({ ...w, noRepeat: e.target.checked }))} />{t("No repeats until everything was used")}</label>
                <label className="check menu-check"><input type="checkbox" checked={!!ws.favorTop} onChange={(e) => upd((w) => ({ ...w, favorTop: e.target.checked }))} />{t("Favor my best hooks (by TikTok views)")}</label>
                <div className="sep" />
                <div className="label cap">{t("Export format")}</div>
                {(["jpg", "png"] as const).map((f) => (
                  <button key={f} onClick={() => upd((w) => ({ ...w, exportFormat: f }))}>{ws.exportFormat === f ? <Icon name="check" size={14} /> : <span style={{ width: 14 }} />}{f.toUpperCase()}</button>
                ))}
                <div className="sep" />
                <div className="label cap">{t("Playback")}</div>
                <label className="check menu-check" title={t("Play, pause, play again: it starts again from the same point. Off: it goes on from where it stopped.")}>
                  <input type="checkbox" checked={ws.playReturn !== false} onChange={(e) => upd((w) => ({ ...w, playReturn: e.target.checked ? undefined : false }))} />{t("Pause goes back to where play started")}
                </label>
              </div>
            )}
            <div className="sep" />
            <button onClick={() => { close(); backup(); }}><Icon name="download" size={14} />{t("Back up my data")}</button>
            <button onClick={() => { close(); restoreInput.current?.click(); }}><Icon name="upload" size={14} />{t("Restore a backup")}</button>
            <button onClick={() => { close(); setVersionsOpen(true); }}><Icon name="history" size={14} />{t("Version history")}</button>
            <button onClick={() => { close(); setStorageOpen(true); }}><Icon name="storage" size={14} />{t("Storage")}</button>
            <button onClick={() => { close(); setKeysOpen(true); }}><Icon name="keyboard" size={14} />{t("Shortcuts")}</button>
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
        <div className="studio-switch" data-studio={studio} role="group" aria-label={t("Studio")} ref={switchRef}>
          {/* The white pill under the chosen studio: it slides from one to the other. */}
          <span className="studio-thumb" aria-hidden style={thumb ?? { opacity: 0 }} />
          <button className={studio === "carousel" ? "on" : ""} aria-pressed={studio === "carousel"} onClick={() => switchStudio("carousel")}>
            <Icon name="deck" size={15} />{t("Carousel")}
          </button>
          <button className={studio === "video" ? "on" : ""} aria-pressed={studio === "video"} onClick={() => switchStudio("video")}>
            <Icon name="reel" size={15} />{t("Video")}
          </button>
        </div>
        <span className="grow" />
        {isDemo() && (
          <a className="demo-badge" href="/studio" title={t("Demo: a brand-new account, nothing is saved (a reload starts again). Click to go back to your account.")}>{t("Demo")}</a>
        )}
        {/* A background job (a take's copy for the other devices): its progress, wherever the user is; a click opens
            that video. */}
        {copyJob && (
          <button className="bg-job" style={{ "--p": copyJob.p } as CSSProperties}
            title={`${copyJob.step === "make" ? t("Making the copy of {video} for your other devices", { video: copyJob.label }) : t("Sending the copy of {video} to your Drive", { video: copyJob.label })} · ${t("keep this page open")}`}
            onClick={() => { upd((w) => ({ ...w, currentProjectId: copyJob.project, projects: w.projects.map((p) => (p.id === copyJob.project ? { ...p, videoId: copyJob.clip } : p)) })); switchStudio("video"); }}>
            <span className="bg-ring" aria-hidden />
            <span className="bg-label">{t("Drive copy")}</span>
            <span className="mono">{Math.round(copyJob.p * 100)}%</span>
          </button>
        )}
        {/* Undo / redo: the whole release's history, the same for both studios, always here. */}
        <button className="btn icon quiet top-hist" aria-label={t("Undo")} title={`${t("Undo")} (⌘Z)`} onClick={undo} disabled={!history.past}><Icon name="undo" /></button>
        <button className="btn icon quiet top-hist" aria-label={t("Redo")} title={`${t("Redo")} (⇧⌘Z)`} onClick={redo} disabled={!history.future}><Icon name="redo" /></button>
        {!isDemo() && <span role="status" aria-live="polite" className={"badge save-badge " + (saveState === "error" || saveState === "conflict" ? "bad" : saveState === "saved" ? "ok" : "")}><span className="dot" />
          <span className="badge-text">{saveState === "saved" ? t("Saved") : saveState === "saving" ? <span className="shine">{t("Saving…")}</span> : saveState === "conflict" ? t("Not saved") : t("Not saved")}</span>
        </span>}
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
        {(studio === "video" || videoSeen || libHub) && (
          <div style={{ display: studio === "video" || libHub ? "contents" : "none" }}>
          <VideoStudio
            active={studio === "video"}
            stylePage={mobileTab === "style"}
            libraryPage={mobileTab === "lists"}
            canUndo={!!history.past} canRedo={!!history.future} onUndo={undo} onRedo={redo}
            project={project}
            hookPools={poolsVisible(ws.textPools, project.id).filter((p) => p.kind === "hooks")}
            onDrawHook={(poolId, exclude, theme) => {
              // The latest workspace (not the one of this render): several hooks drawn in a row each take theirs out of the bag.
              const cur = wsRef.current ?? ws;
              const bags = { ...cur.bags };
              const hook = drawHook(cur, poolId, bags, exclude, theme, cur.projects.find((x) => x.id === cur.currentProjectId)?.hiddenTags);
              // The bag drawn from (the list's, or one theme's) keeps what is left.
              if (hook !== null) upd((w) => ({ ...w, bags: { ...w.bags, ...Object.fromEntries(Object.entries(bags).filter(([k]) => k === poolId || k.startsWith(poolId + "#"))) } }));
              return hook;
            }}
            onProject={(fn) => upd((w) => ({ ...w, projects: w.projects.map((p) => (p.id === project.id ? fn(p) : p)) }))}
            audioUsedElsewhere={(id) => !!wsRef.current?.projects.some((p) => p.id !== project.id && p.audioDriveId === id)}
            onSaveNow={() => void flushSave()}
            releaseTitle={releaseTitle}
            onCopyJob={setCopyJob}
            onToast={say}
            onVariants={offerVariants}
            playReturn={ws.playReturn !== false}
            library={textGroups(["hooks", "captions"])}
            libraryPhone={<>{textGroups(["hooks", "texts", "captions"])}{photosFamily()}</>}
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
          {photosFamily()}
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
                {genRow}
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
              {busy && <button className="btn h-cancel" onClick={() => { cancelExport.current = true; }}>{t("Cancel")}</button>}

              <button className="btn icon h-share" aria-label={handheld ? t("Share") : t("Send to my phone")} title={handheld ? t("Share") : t("Send to my phone (QR code)")} onClick={() => setShareOpen(true)} disabled={busy || !project.generated}><Icon name="share" /></button>
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
                // While exporting, the button itself fills up (the slides done out of all), its label counts them.
                <button className={"btn primary h-dl" + (busy ? " shine-box" : "") + (exportProgress ? " filling" : "")} aria-label={t("Download all")} onClick={() => void downloadAll()} disabled={busy || !project.generated}
                  style={exportProgress ? { "--p": exportProgress.done / Math.max(1, exportProgress.total) } as CSSProperties : undefined}>
                  <Icon name="download" /><span className="lbl" aria-live="polite">{exportProgress ? `${exportProgress.done} / ${exportProgress.total}` : busy ? t("Exporting…") : t("Download all")}</span>
                </button>
              )}
              </div>
            </div>
          </div>
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
          <div ref={deckRef} onScroll={onDeckScroll} onScrollEnd={() => { if (deckOn()) deckSettle(); }} className={"slides" + (boardDrag ? " drag-in" : "")}>
            {project.slides.map((cfg, i) => cardFor(cfg, i))}
          </div>
          {/* Phone: the bar stays put while the slides swipe under it, over the room kept under the middle picture. */}
          {deckTop !== null && <div className="deck-float" style={{ top: deckTop }}>{deckBar}</div>}
          </div>
          {/* Phone: the selected slide's text and sources, once, under the deck: they fade out while swiping and fade
              back in for the next slide, instead of sliding sideways with the cards. */}
          {deckTop !== null && (() => {
            // The slide in the middle right now: its fields come as soon as it gets there, mid-swipe; before that
            // the current ones fade out.
            const shown = deckLive !== null && project.slides[deckLive] ? deckLive : sel;
            return project.slides[shown] && (
              <div className={"deck-fields" + (deckSwiping && shown === sel ? " leaving" : "")}>{cardFor(project.slides[shown], shown, "fields")}</div>
            );
          })()}
          <section ref={postRef} className="post-box">
            <h3 className="label">{t("Caption and hashtags")}</h3>
            <PostCaption auto value={project.caption ?? ""} poolId={project.captionPoolId} pools={captionPools}
              onChange={(caption) => updProject((p) => ({ ...p, caption }))}
              onPool={(captionPoolId) => updProject((p) => ({ ...p, captionPoolId }))}
              onDraw={drawCaption}
              onNewList={() => setOverlay({ k: "newPool", kind: "text", textKind: "captions" })} />
          </section>
        </main>

        <aside className="col side r" ref={rightColRef}>
          <StyleTabs parts={carParts} part={carStyle.part} onPart={carStyle.pick} tone="carousel" />
          <Inspector index={sel} cfg={project.slides[sel]}
            onCfg={(fn) => updSlide(sel, fn)} onApplyAll={applyAll}
            presets={presets} fonts={fonts} onFonts={setFonts} onPreview={setFontPreview}
            onSavePreset={(name) => savePreset(name, project.slides[sel].style)} onApplyPreset={applyPreset} onDeletePreset={deletePreset} />
          {/* Phone's Style page: at the very end (a computer has it at the top of the column). */}
        </aside>
        </>
        )}
      </div>

      {/* Phone: one panel at a time, like an app (the centre, the files / lists on the left, the style on the right). */}
      {/* Phone, carousel: Generate floating just above the dock (above its fade too), under the thumb. */}
      {studio === "carousel" && mobileTab === "slides" && <div className="gen-fab">{genRow}</div>}
      {/* Phone: the page fades to black behind the dock, like under the header. */}
      <div className="dock-fade" aria-hidden />
      <nav className="mobile-tabs" aria-label={t("Sections")} data-tab={mobileTab} ref={dockRef}>
        {/* One white pill for the three pages (Create, Style, the library): it slides to the open one, taking its size. */}
        <span className="dock-thumb" aria-hidden style={dockThumb ?? { opacity: 0 }} />
        {/* The video studio's player (its play button and a timeline to scrub), on top of the dock. */}
        <div id="dock-player" className="dock-player" />
        {/* The open studio (its icon on its gradient); a tap goes to the other. */}
        <button className={"dock-studio " + studio} aria-label={studio === "video" ? t("Go to the carousel studio") : t("Go to the video studio")}
          onClick={() => {
            switchStudio(studio === "video" ? "carousel" : "video");
            // From the library (the same page in both studios): straight to the other studio's Create page.
            if (mobileTab === "lists") pickMobileTab("slides");
            try { navigator.vibrate?.(8); } catch { /* not on this phone */ }
          }}>
          <span key={studio} className="ds-icon"><Icon name={studio === "video" ? "reel" : "deck"} size={22} /></span>
        </button>
        <span className="mobile-tabs-sep" aria-hidden />
        {/* Create and Style share one white pill that slides from one to the other (the desktop studio switch's
            move: a transform only, same time and curve, the labels' colour along); off on the library. */}
        <div className="dock-pair" data-on={mobileTab === "slides" ? "0" : mobileTab === "style" ? "1" : "none"}>
          <button className={mobileTab === "slides" ? "on" : ""} aria-pressed={mobileTab === "slides"} onClick={() => pickMobileTab("slides")}><Icon name="pencil" size={18} /><span className="tab-name">{/* One word in both studios: the dock keeps its exact layout when switching. */}{t("Create")}</span></button>
          <button className={mobileTab === "style" ? "on" : ""} aria-pressed={mobileTab === "style"} aria-label={t("Style")} onClick={() => pickMobileTab("style")}><Icon name="sliders" size={18} /><span className="tab-name">{t("Style")}</span></button>
        </div>
        <span className="mobile-tabs-sep" aria-hidden />
        {/* The library, a page apart (the release's material, whatever the studio); the account is in the header. */}
        <button className={"dock-lib" + (mobileTab === "lists" ? " on" : "")} aria-pressed={mobileTab === "lists"} aria-label={t("Library")} onClick={() => pickMobileTab("lists")}><Icon name="library" size={20} /><span className="tab-name">{t("Library")}</span></button>
      </nav>

      {edText && (
        <TextPoolEditor key={edText.id + (editor?.byTag ? ":tags" : "")} byTag={!!editor?.byTag} pool={edText} onClose={() => setEditor(null)} onDelete={() => askDeletePool("text", edText.id)}
          onChange={(fn) => setTextPool(edText.id, (x) => scopeFix(fn(x)))} onImport={() => setOverlay({ k: "import", poolId: edText.id })}
          onRefreshViews={() => void refreshViews(edText)} viewsBusy={viewsBusy} />
      )}
      {edPics && (
        <PicPoolEditor pool={edPics} onClose={() => setEditor(null)} onDelete={() => askDeletePool("photos", edPics.id)}
          onChange={(fn) => setPicPool(edPics.id, (x) => scopeFix(fn(x)))}
          onUpload={(files) => void uploadToList(edPics.id, files)} uploading={picUpload?.pool === edPics.id ? picUpload : null}
          onMoved={(from, to) => void moveDriveFolder(listPath(from), listPath(to))}
          savedIn={driveWrite ? listPath(edPics).join(" / ") : null}
          savedHref={picFolderUrl} />
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
            // Straight to the list sorted by tag: the hooks imported, ready to be checked and tagged.
            setEditor({ k: "text", id: pool.id, byTag: true });
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
          setEditor({ k: "text", id, byTag: true });
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
      {keysOpen && <ShortcutsDialog onClose={() => setKeysOpen(false)} />}
      {storageOpen && (
        <StorageDialog onClose={() => setStorageOpen(false)}
          usedCopies={new Set(ws.projects.flatMap((p) => (p.videos ?? []).map((v) => v.drive?.copy?.id).filter((x): x is string => !!x)))} />
      )}
      {versionsOpen && (
        <VersionHistory onClose={() => setVersionsOpen(false)}
          onRestore={(data) => { apply(linkAllLyrics(refreshAllLyrics(migrateLyrics(normalizeWorkspace(data), (n) => t("Part {n}", { n }), t("Chorus"))))); say(t("Version restored: undo to go back")); }} />
      )}
      {preview && studio === "carousel" && (
        <SlidePreview index={sel} total={nSlides} slides={project.slides} gens={project.slides.map((_, i) => project.generated?.[i])} fontsReady={fontsReady}
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
          place={{ release: project.name, what: carouselName(carouselsOf(project).find((c) => c.id === currentCarouselId(project))!) }}
          title={carouselsOf(project).length > 1 ? `${project.name} · ${carouselName(carouselsOf(project).find((c) => c.id === currentCarouselId(project))!)}` : project.name}
          build={async () => { cancelExport.current = false; return buildFiles(project); }} />
      )}
      {overlay?.k === "renameCarousel" && <PromptDialog title={t("Rename carousel")} label={t("Name")} initial={carouselName(carouselsOf(project).find((c) => c.id === currentCarouselId(project))!)} confirmLabel={t("Rename")} onSubmit={(n) => updProject((p) => renameCarousel(p, n))} onClose={() => setOverlay(null)} />}
      {overlay?.k === "rename" && <PromptDialog title={t("Rename project")} label={t("Name")} initial={project.name} confirmLabel={t("Rename")} onSubmit={(n) => { void renameDriveFolder(["Releases", project.name || "Release"], n); updProject((p) => ({ ...p, name: n })); }} onClose={() => setOverlay(null)} />}
      {overlay?.k === "hiddenTags" && (
        <HiddenTagsDialog release={project.name} pools={slideTexts} hidden={project.hiddenTags ?? []}
          onChange={(tags) => updProject((p) => ({ ...p, hiddenTags: tags.length ? tags : undefined }))} onClose={() => setOverlay(null)} />
      )}
      {overlay?.k === "variants" && (
        <VariantsDialog list={overlay.list} pools={vText} onClose={() => setOverlay(null)}
          onKeep={(kept) => { upd((w) => ({ ...w, textPools: addVariants(w.textPools, kept) })); say(kept.length > 1 ? t("{n} texts added to your lists", { n: kept.length }) : t("Text added to your list")); }} />
      )}
      {overlay?.k === "confirm" && <ConfirmDialog title={overlay.title} message={overlay.message} confirmLabel={overlay.label} onConfirm={overlay.run} onClose={() => setOverlay(null)} danger />}
      {overlay?.k === "lyrics" && (
        <LyricsEditor name={project.name} lyrics={project.lyrics} song={project.lyricsLinked ? undefined : project.songLyrics} synced={!!project.lyricsLinked && !!project.lyricWords?.length} onChange={setLyrics} onClose={() => setOverlay(null)} />
      )}
      <Toast msg={toast} />
      {boot !== "gone" && bootEl(boot === "fade" ? "out" : "on")}
    </div>
  );
}
