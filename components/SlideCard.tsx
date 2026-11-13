"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useT } from "@/lib/i18n";
import Icon from "./Icon";
import { ContextMenu, Hint, Menu, Select, Switch, TagChip, Wheel } from "./ui";
import { clamp, clampPic, renderSlide, snapPic, TextBox, zoomPic } from "@/lib/render";
import { useDriveImage } from "@/lib/useImage";
import { looksLikeImage } from "@/lib/imageFormat";
import { type AIProgress, type AIStep, coversFrame, fillFrame, sharpEnough, sharper } from "@/lib/photoAI";
import { poolTags, sourceTags, tagGroups, tagStep, textItems } from "@/lib/generate";
import { themeLabel } from "@/lib/themes";
import type { GenSlide, LyricSection, PhotoAdjust, PicPool, SlideCfg, TextPool } from "@/lib/types";
import { isLineList } from "@/lib/defaults";
import ImageFinder from "./ImageFinder";
import { Thumb } from "./PoolEditors";
import type { FoundImage } from "@/lib/imageSearch";

/** Photo search on the web (Flickr / Pexels): off for now, the photos did not have the look wanted. */
const FIND_PHOTOS = false;

/** The picture of a drop from another tab (Pinterest…): the file itself, else its address. */
async function droppedImage(dt: DataTransfer): Promise<{ blob: Blob; name: string } | null> {
  const file = Array.from(dt.files).find((f) => looksLikeImage(f.name, f.type));
  if (file) return { blob: file, name: file.name };
  let url = dt.getData("text/uri-list").split("\n").find((l) => l && !l.startsWith("#"))?.trim() ?? "";
  if (!url) url = /<img[^>]+src="([^"]+)"/i.exec(dt.getData("text/html"))?.[1] ?? "";
  if (!/^https?:/i.test(url)) return null;
  const name = decodeURIComponent(url.split("/").pop()?.split("?")[0] ?? "image") || "image";
  // Straight from the site when it allows it, else through the app's relay (Pinterest pictures).
  const direct = await fetch(url).then((r) => (r.ok ? r.blob() : null)).catch(() => null);
  const blob = direct && direct.type.startsWith("image/") ? direct
    : await fetch(`/api/images/file?u=${encodeURIComponent(url)}`).then((r) => (r.ok ? r.blob() : null)).catch(() => null);
  return blob ? { blob, name } : null;
}

/** The photo edits, in the order of the panel. Vignette and grain only add. */
const ADJUST: { k: keyof PhotoAdjust; label: string; min: number }[] = [
  { k: "exposure", label: "Exposure", min: -100 }, { k: "contrast", label: "Contrast", min: -100 },
  { k: "saturation", label: "Saturation", min: -100 }, { k: "temperature", label: "Warmth", min: -100 },
  { k: "vignette", label: "Vignette", min: 0 }, { k: "grain", label: "Grain", min: 0 },
];

interface Props {
  index: number;
  cfg: SlideCfg;
  gen: GenSlide | undefined;
  selected: boolean;
  textPools: TextPool[];
  picPools: PicPool[];
  /** The release's lyrics, cut into sections: a lyrics slide ticks the ones it shows. */
  lyrics: LyricSection[];
  onEditLyrics: () => void;
  zones: boolean;
  fontsReady: boolean;
  onSelect: () => void;
  onCfg: (fn: (c: SlideCfg) => SlideCfg) => void;
  onText: (t: string) => void;
  onRerollPic: () => void;
  /** TikTok's zones on and off (the button over the slide). */
  onZones?: () => void;
  /** The slide full screen (the carousel's full view, slides swiped there). */
  onFull?: () => void;
  /** A photo of the slide's list chosen by hand (its picture shown in a grid). */
  onChoosePic?: (id: string, name: string) => void;
  onRerollText: () => void;
  /** A lyrics slide retouched by hand: back to the release's lyrics. */
  onLyricsBack: () => void;
  onSave: () => void;
  locked: boolean;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  onDuplicate: () => void;
  onDelete: () => void;
  onMoveLeft: () => void;
  onMoveRight: () => void;
  onToggleLock: () => void;
  /** Put a photo found on the web in this slide. */
  onWebPic: (img: FoundImage) => void;
  /** A picture dropped on the slide (from Pinterest, the desktop…): asks where to keep it. */
  onImage: (blob: Blob, name: string) => void;
  /** Put these photo edits on every slide. */
  onAdjustAll: (a: PhotoAdjust | undefined) => void;
  onDragStart?: () => void;
  onDragOver?: () => void;
  /** Shown right under the picture of the selected slide (the phone's deck bar: where we are, the zones). */
  below?: React.ReactNode;
  /** "fields": only what is under the picture (the phone shows it once, under the deck). */
  part?: "fields";
  onDragEnd?: () => void;
  onDrop?: () => void;
  dragging?: boolean;
  dragOver?: boolean;
}


/** Window event: a card opened its photo edits (the others close theirs). */
const ADJUST_OPEN = "rollout:adjust-open";

export default function SlideCard(p: Props) {
  /** The slide's photo list (its photos to choose from). */
  const pool = p.picPools.find((x) => x.id === p.cfg.picPoolId);
  const { t } = useT();
  const { cfg, gen } = p;
  const { img, err } = useDriveImage(gen?.picId ?? null);
  const cv = useRef<HTMLCanvasElement>(null);
  const box = useRef<TextBox | null>(null);
  const drag = useRef<null | { kind: "text" | "pic"; sx: number; sy: number; ox: number; oy: number; k: number }>(null);
  const [guides, setGuides] = useState({ v: false, h: false });
  const text = gen?.text ?? "";
  // Photo edits panel, over the picture.
  const [adjusting, setAdjustingNow] = useState(false);
  /** The panel leaving: it slides down and fades, then goes. */
  const [adjustLeaving, setAdjustLeaving] = useState(false);
  const setAdjusting = (on: boolean) => {
    if (on) { setAdjustLeaving(false); setAdjustingNow(true); return; }
    setAdjustLeaving(true);
    window.setTimeout(() => { setAdjustingNow(false); setAdjustLeaving(false); }, 170);
  };
  const [compare, setCompare] = useState(false);
  const [finding, setFinding] = useState(false);
  const [dropHere, setDropHere] = useState(false);
  const [dropErr, setDropErr] = useState<string | null>(null);
  useEffect(() => { if (!dropErr) return; const id = setTimeout(() => setDropErr(null), 4000); return () => clearTimeout(id); }, [dropErr]);
  const [tool, setTool] = useState<keyof PhotoAdjust>("exposure");
  // One photo's edits open at a time: opening another card's closes this one.
  const myId = useRef(Math.random());
  // A click or a tap anywhere off the edits panel closes it (the slide stays selected).
  const picWrap = useRef<HTMLDivElement>(null);
  const adjustPanel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const other = (e: Event) => { if ((e as CustomEvent).detail !== myId.current) setAdjusting(false); };
    window.addEventListener(ADJUST_OPEN, other);
    return () => window.removeEventListener(ADJUST_OPEN, other);
  }, []);
  useEffect(() => {
    if (!adjusting) return;
    // Anywhere off the panel itself (the photo above it too): the same as Done.
    const away = (e: PointerEvent) => { if (!adjustPanel.current?.contains(e.target as Node)) { setCompare(false); setAdjusting(false); } };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [adjusting]);
  // ---- photo AI (a test, lib/photoAI): the result comes in as a new photo (the same way as a dropped one) ----
  const [aiBusy, setAiBusy] = useState<null | { kind: "sharp" | "fill"; step: AIStep; pct?: number }>(null);
  const [aiNote, setAiNote] = useState<string | null>(null);
  // Short and steady while it works (the button itself fills up): the model's download, then the work.
  const aiLabel = (b: { step: AIStep; pct?: number }) => b.step === "model" ? t("Model {n}%", { n: Math.round((b.pct ?? 0) * 100) })
    : b.step === "start" ? t("Starting…") : `${Math.round((b.pct ?? 0) * 100)} %`;
  /** Which AI options this photo can take: sharper under 1600 px, fill only around empty edges of the slide. */
  const aiCan = (im: { width: number; height: number }) => {
    const W = cv.current?.width ?? 1080, H = cv.current?.height ?? 1920;
    return { sharpOk: !sharpEnough(im.width, im.height), fillOk: !coversFrame(im, clampPic(cfg.pic, im.width, im.height, W, H), W, H) };
  };
  // The slide's own right-click menu (a computer: on a phone, a long press edits the text).
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);
  const runAI = async (kind: "sharp" | "fill") => {
    if (!img || !cv.current) return;
    setAiNote(null);
    const base = (gen?.picName ?? "photo").replace(/\.[a-z0-9]+$/i, "");
    if (kind === "sharp" && sharpEnough(img.width, img.height)) { setAiNote(t("Already in high definition")); return; }
    setAiBusy({ kind, step: "start" });
    const t0 = performance.now();
    try {
      const onStep: AIProgress = (step, pct) => setAiBusy({ kind, step, pct });
      const W = cv.current.width, H = cv.current.height;
      const blob = kind === "sharp" ? await sharper(img, onStep) : await fillFrame(img, clampPic(cfg.pic, img.width, img.height, W, H), W, H, onStep);
      if (!blob) { setAiNote(t("The photo already fills the slide: zoom it out to leave edges")); return; }
      console.info(`[photoai] ${kind} in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
      p.onImage(blob, `${base} ${kind === "sharp" ? "HD" : t("filled")}.jpg`);
    } catch (e) {
      console.warn("[photoai]", e);
      setAiNote(t("The AI could not finish on this device: {why}", { why: e instanceof Error ? e.message : String(e) }));
    } finally { setAiBusy(null); }
  };
  const adj = cfg.pic.adjust ?? {};
  const hasAdjust = Object.values(adj).some((x) => x);
  // E: the selected slide's photo edits open or close (the same as its button); Escape closes them. Not while typing,
  // over a window or the full screen, nor when the carousel is hidden (the video studio). See ShortcutsDialog.
  const keyNow = useRef<(e: KeyboardEvent) => void>(() => {});
  keyNow.current = (e) => {
    if (!p.selected || e.metaKey || e.ctrlKey || e.altKey || !cv.current?.offsetParent) return;
    const el = e.target as HTMLElement;
    if (/INPUT|TEXTAREA|SELECT/.test(el.tagName) || el.isContentEditable || document.querySelector(".ov, .pv-full-layer")) return;
    if (e.key === "Escape" && adjusting) { e.preventDefault(); setCompare(false); setAdjusting(false); return; }
    if (e.key.toLowerCase() !== "e") return;
    e.preventDefault();
    if (adjusting) { setCompare(false); setAdjusting(false); return; }
    if (!img || p.locked) return;
    setAdjusting(true);
    window.dispatchEvent(new CustomEvent(ADJUST_OPEN, { detail: myId.current }));
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => keyNow.current(e);
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  useEffect(() => {
    if (!cv.current) return;
    // Comparing (the photo edits' "Before"): the photo drawn without its edits, the rest as it is.
    const shown = compare && cfg.pic.adjust ? { ...cfg, pic: { ...cfg.pic, adjust: undefined } } : cfg;
    const r = renderSlide(cv.current, shown, img, text, { guideV: guides.v, guideH: guides.h, zones: p.zones });
    box.current = r.box;
  }, [cfg, img, text, guides, p.zones, p.fontsReady, compare]);
  // The panel closed (Done, a click away, another photo's): the edits are shown again.
  useEffect(() => { if (!adjusting) setCompare(false); }, [adjusting]);

  const toCanvas = (e: { clientX: number; clientY: number }) => {
    const c = cv.current!;
    const r = c.getBoundingClientRect();
    const k = c.width / r.width;
    return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k, k };
  };
  const inText = (x: number, y: number) => {
    const b = box.current;
    const pad = 30;
    return !!b && x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad;
  };
  // Kept in bounds: covering the slide, or only the part between its black bars (the matte is not kept in the photo).
  const fit = (pic: SlideCfg["pic"]) => {
    if (!img || !cv.current) return pic;
    const r = clampPic({ ...pic, matte: cfg.matte }, img.width, img.height, cv.current.width, cv.current.height);
    return r.ox === pic.ox && r.oy === pic.oy ? pic : { ...pic, ox: r.ox, oy: r.oy };
  };

  const down = (e: React.PointerEvent) => {
    p.onSelect();
    // A finger scrolls the page and swipes the deck; two fingers frame the photo (see the touch gestures below).
    if (e.pointerType === "touch") return;
    const c = toCanvas(e);
    (e.target as Element).setPointerCapture(e.pointerId);
    const isText = inText(c.x, c.y);
    const pic = fit(cfg.pic);
    drag.current = { kind: isText ? "text" : "pic", sx: e.clientX, sy: e.clientY, ox: isText ? cfg.style.x : pic.ox, oy: isText ? cfg.style.y : pic.oy, k: c.k };
  };
  /** The text moved by (dx, dy) canvas pixels from (ox, oy) %, snapped to the middle lines (the guides show). */
  const placeText = (ox: number, oy: number, dx: number, dy: number, snap: number, size?: number) => {
    const W = cv.current!.width, H = cv.current!.height;
    let x = clamp(ox + (dx / W) * 100, 0, 100), y = clamp(oy + (dy / H) * 100, 0, 100);
    const sv = Math.abs(x - 50) < snap, sh = Math.abs(y - 50) < snap;
    if (sv) x = 50;
    if (sh) y = 50;
    setGuides({ v: sv, h: sh });
    p.onCfg((c) => ({ ...c, style: { ...c.style, x, y, ...(size !== undefined ? { size } : {}) } }));
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !cv.current) return;
    const W = cv.current.width, H = cv.current.height;
    const dx = (e.clientX - d.sx) * d.k, dy = (e.clientY - d.sy) * d.k;
    // ⌘ (Ctrl) held: no snapping, as in design apps.
    const free = e.metaKey || e.ctrlKey;
    if (d.kind === "text") {
      placeText(d.ox, d.oy, dx, dy, free ? 0 : 1.5);
    } else {
      // Its centre snaps to the middle lines, as a text does (the blue guides show).
      const sn = snapPic(d.ox + dx / W, d.oy + dy / H, free ? 0 : undefined), room = fit({ ...cfg.pic, ox: 1, oy: 1 });
      const gv = sn.v && room.ox > 0.001, gh = sn.h && room.oy > 0.001; // a guide only where it can move
      if (gv !== guides.v || gh !== guides.h) setGuides({ v: gv, h: gh });
      p.onCfg((c) => ({ ...c, pic: fit({ ...c.pic, ox: sn.ox, oy: sn.oy }) }));
    }
  };
  const up = () => { drag.current = null; setGuides({ v: false, h: false }); };

  // Wheel needs a non-passive listener to stop the page from scrolling.
  const wheelRef = useRef<(e: WheelEvent) => void>(() => {});
  wheelRef.current = (e) => {
    if (!p.selected) return; // let the page scroll until the slide is selected
    e.preventDefault();
    const c = toCanvas(e);
    const dir = e.deltaY < 0 ? 1 : -1;
    if (inText(c.x, c.y)) p.onCfg((s) => ({ ...s, style: { ...s.style, size: clamp(Math.round(s.style.size + dir * 3), 18, 200) } }));
    else p.onCfg((s) => ({ ...s, pic: fit(zoomPic(fit(s.pic), clamp(+(s.pic.zoom + dir * 0.05).toFixed(2), 0.5, 4))) }));
  };
  useEffect(() => {
    const el = cv.current;
    if (!el) return;
    const h = (e: WheelEvent) => wheelRef.current(e);
    el.addEventListener("wheel", h, { passive: false });
    return () => el.removeEventListener("wheel", h);
  }, []);

  // Touch. One finger is the page's (scroll, swipe between slides). Two fingers frame the photo: pinch to zoom,
  // move together to move it. The text: press and hold it (a short buzz), then drag it with one finger (it snaps to
  // the middle lines); a second finger meanwhile pinches its size.
  type Touchy = { mode: "wait" | "text" | "pic"; sx: number; sy: number; ox: number; oy: number; k: number; d: number; size: number; pic: SlideCfg["pic"]; mx: number; my: number };
  const touch = useRef<Touchy | null>(null);
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopHold = () => { if (hold.current) { clearTimeout(hold.current); hold.current = null; } };
  const touchRef = useRef<(e: TouchEvent) => void>(() => {});
  touchRef.current = (e) => {
    const c = cv.current;
    if (!c || p.locked) return;
    const g = touch.current;
    const [a, b] = [e.touches[0], e.touches[1]];
    if (e.type === "touchend" || e.type === "touchcancel") {
      stopHold();
      if (e.touches.length === 0) { touch.current = null; setGuides({ v: false, h: false }); }
      else if (g?.mode === "pic" && e.touches.length < 2) touch.current = null;
      else if (g?.mode === "text" && e.touches.length === 1) {
        // Back to one finger: the drag goes on from where the text is now.
        const m = toCanvas(a);
        touch.current = { ...g, sx: a.clientX, sy: a.clientY, ox: cfg.style.x, oy: cfg.style.y, k: m.k, d: 0 };
      }
      return;
    }
    if (e.type === "touchstart") {
      if (e.touches.length === 1) {
        const m = toCanvas(a);
        if (!inText(m.x, m.y)) return;
        touch.current = { mode: "wait", sx: a.clientX, sy: a.clientY, ox: cfg.style.x, oy: cfg.style.y, k: m.k, d: 0, size: cfg.style.size, pic: cfg.pic, mx: 0, my: 0 };
        stopHold();
        hold.current = setTimeout(() => {
          hold.current = null;
          if (touch.current?.mode !== "wait") return;
          touch.current.mode = "text";
          p.onSelect();
          try { navigator.vibrate?.(12); } catch { /* not on this phone */ }
        }, 320);
        return;
      }
      if (e.touches.length === 2) {
        stopHold();
        e.preventDefault();
        const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
        const mx = (a.clientX + b.clientX) / 2, my = (a.clientY + b.clientY) / 2;
        const m = toCanvas({ clientX: mx, clientY: my });
        p.onSelect();
        if (g?.mode === "text") touch.current = { ...g, d, size: cfg.style.size, sx: mx, sy: my, ox: cfg.style.x, oy: cfg.style.y, k: m.k };
        else touch.current = { mode: "pic", sx: mx, sy: my, ox: 0, oy: 0, k: m.k, d, size: 0, pic: fit(cfg.pic), mx, my };
      }
      return;
    }
    // touchmove
    if (!g) return;
    if (g.mode === "wait") {
      // Moving before the hold: it is a scroll or a swipe, not the text.
      if (Math.hypot(a.clientX - g.sx, a.clientY - g.sy) > 8) { stopHold(); touch.current = null; }
      return;
    }
    e.preventDefault();
    const W = c.width, H = c.height;
    if (g.mode === "text") {
      if (e.touches.length >= 2 && g.d) {
        const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
        const mx = (a.clientX + b.clientX) / 2, my = (a.clientY + b.clientY) / 2;
        placeText(g.ox, g.oy, (mx - g.sx) * g.k, (my - g.sy) * g.k, 2.5, clamp(Math.round(g.size * (d / g.d)), 18, 200));
      } else {
        placeText(g.ox, g.oy, (a.clientX - g.sx) * g.k, (a.clientY - g.sy) * g.k, 2.5);
      }
      return;
    }
    if (g.mode === "pic" && b) {
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
      const mx = (a.clientX + b.clientX) / 2, my = (a.clientY + b.clientY) / 2;
      const z = zoomPic(g.pic, clamp(+(g.pic.zoom * (d / g.d)).toFixed(3), 0.5, 4));
      const sn = snapPic(z.ox + ((mx - g.mx) * g.k) / W, z.oy + ((my - g.my) * g.k) / H, 0.025), room = fit({ ...z, ox: 1, oy: 1 });
      const gv = sn.v && room.ox > 0.001, gh = sn.h && room.oy > 0.001;
      if (gv !== guides.v || gh !== guides.h) setGuides({ v: gv, h: gh });
      p.onCfg((s) => ({ ...s, pic: fit({ ...z, ox: sn.ox, oy: sn.oy }) }));
    }
  };
  useEffect(() => {
    const el = cv.current;
    if (!el) return;
    const h = (e: TouchEvent) => touchRef.current(e);
    const stop = (e: Event) => e.preventDefault(); // Safari's own page zoom
    for (const ev of ["touchstart", "touchmove", "touchend", "touchcancel"]) el.addEventListener(ev, h as EventListener, { passive: false });
    el.addEventListener("gesturestart", stop);
    // A held finger must not open the browser's menu (it would cancel the text drag).
    el.addEventListener("contextmenu", stop);
    return () => {
      for (const ev of ["touchstart", "touchmove", "touchend", "touchcancel"]) el.removeEventListener(ev, h as EventListener);
      el.removeEventListener("gesturestart", stop);
      el.removeEventListener("contextmenu", stop);
    };
  }, []);

  const dbl = (e: React.MouseEvent) => {
    const c = toCanvas(e);
    if (!inText(c.x, c.y)) p.onCfg((s) => ({ ...s, pic: { ...s.pic, ox: 0, oy: 0, zoom: 1 } }));
  };

  // The texts of the list this slide draws from, to pick one by hand.
  const listPool = cfg.textSource.kind === "pool" ? p.textPools.find((x) => cfg.textSource.kind === "pool" && x.id === cfg.textSource.poolId) : undefined;
  // A hooks list sorted by theme: the slide may draw from one theme only.
  const allItems = listPool ? textItems(listPool) : [];
  // Its tags (several per text): the slide draws from the ticked ones only.
  const itemTags = listPool && isLineList(listPool) ? poolTags(listPool) : [];
  const groups = tagGroups(itemTags);
  const ticked = (cfg.textSource.kind === "pool" ? sourceTags(cfg.textSource.tags, cfg.textSource.theme) : undefined)?.filter((x) => groups.some((g) => g.id === x));
  // Its excluded tags (their −): never their texts.
  const notTicked = (cfg.textSource.kind === "pool" ? cfg.textSource.notTags : undefined)?.filter((x) => groups.some((g) => g.id === x)) ?? [];
  const excluded = (i: number) => !!notTicked.length && !!itemTags[i]?.some((x) => notTicked.includes(x));
  const listItems = allItems.filter((_, i) => !excluded(i) && (!ticked?.length || itemTags[i].some((x) => ticked.includes(x))));
  const setTags = (next: { tags: string[]; not: string[] }) => p.onCfg((c) => (c.textSource.kind === "pool"
    ? { ...c, textSource: { ...c.textSource, theme: undefined, tags: next.tags.length ? next.tags : undefined, notTags: next.not.length ? next.not : undefined } } : c));
  const textVal = cfg.textSource.kind === "pool" ? cfg.textSource.poolId : cfg.textSource.kind === "lyrics" ? "__lyrics" : "";

  // A lyrics slide: its sections ticked (picked like a hook, under "Text from"), and its optional header line.
  const lyricSrc = cfg.textSource.kind === "lyrics" ? cfg.textSource : null;
  const lyricTicked = lyricSrc ? (lyricSrc.sectionIds ?? (lyricSrc.sectionId ? [lyricSrc.sectionId] : p.lyrics[0] ? [p.lyrics[0].id] : [])) : [];
  const tickSection = (id: string, on: boolean) => lyricSrc && p.onCfg((c) => ({ ...c, textSource: { ...lyricSrc, sectionId: undefined,
    sectionIds: p.lyrics.map((l) => l.id).filter((x) => (x === id ? on : lyricTicked.includes(x))) } }));
  const lyricNames = p.lyrics.filter((l) => lyricTicked.includes(l.id)).map((l) => l.name);
  const lyricsPick = !lyricSrc ? null : !p.lyrics.length ? (
    <button className="btn sm pick-add" onClick={p.onEditLyrics}><Icon name="plus" size={13} />{t("Add the lyrics")}</button>
  ) : (
    <Menu float left trigger={(open, toggle) => (
      <button type="button" className={"input pick-btn" + (open ? " on" : "")} onClick={(e) => { e.stopPropagation(); toggle(); }} title={lyricNames.join(", ")} aria-label={t("Sections")}>
        <span className="truncate">{lyricNames.length ? lyricNames.join(" · ") : t("None ticked")}</span><Icon name="chevron" size={13} />
      </button>
    )}>
      {() => (<div className="pick-pane" onClick={(e) => e.stopPropagation()}>
        <div className="pick-list">
          {p.lyrics.map((l) => {
            const on = lyricTicked.includes(l.id);
            return (
              <button key={l.id} className={"pick-line" + (on ? " on" : "")} title={l.text.slice(0, 200)} aria-pressed={on} onClick={() => tickSection(l.id, !on)}>
                <span className="dd-check" aria-hidden>{on ? "✓" : ""}</span><span>{l.name}</span>
              </button>
            );
          })}
        </div>
        <div className="sep" />
        <button className="pick-line" onClick={p.onEditLyrics}><Icon name="pencil" size={12} /><span>{t("Edit the lyrics…")}</span></button>
      </div>)}
    </Menu>
  );

  // Under the picture: the slide's text and sources. On a phone they show once, under the deck (part "fields"),
  // so they fade in place instead of sliding with the cards.
  const fields = (<>
      {err && <span className="notice bad">{err}</span>}
      {dropErr && <span className="notice warn xs">{dropErr}</span>}
      {aiNote && <span className="notice warn xs">{aiNote}</span>}
      {finding && <ImageFinder onClose={() => setFinding(false)} onPick={(img) => { setFinding(false); p.onWebPic(img); }} />}
      {gen?.picCredit && (
        <p className="muted xs pic-credit">
          {t("Photo")} : {gen.picCredit.author || "—"} · {gen.picCredit.license}
          {gen.picCredit.required && <> · <button className="link" onClick={(e) => { e.stopPropagation(); void navigator.clipboard?.writeText(`📷 ${gen.picCredit!.author} (${gen.picCredit!.license})`); }}
            title={t("CC BY: put this credit in the TikTok caption")}>{t("copy the credit")}</button></>}
        </p>
      )}
      <label className="field slide-text">{t("Text on the slide")}
        <textarea className="input" rows={3} placeholder={t("Slide text")} value={text} onChange={(e) => p.onText(e.target.value)} />
      </label>
      {/* The slide's sources, as two tiles: its text (an icon of the kind: the release's lyrics in their gold, a
          list) and its photo (the one on the slide, small). Each: where it comes from, then which one. */}
      <div className="src-tiles">
        <div className={"src-tile src-" + cfg.textSource.kind + (listPool ? " src-" + listPool.kind : "")}>
          <div className="src-head">
            {/* One icon per kind of text: hooks (the opening), the release's lyrics (the library's own: its gold T), the other slides' texts. */}
            <span className="src-ico" aria-hidden><Icon name={cfg.textSource.kind === "lyrics" ? "type" : listPool?.kind === "hooks" ? "sparkle" : cfg.textSource.kind === "pool" ? "list" : "minus"} size={14} /></span>
            <span className="src-k" title={t("Text from")}>{t("Text")}</span>
          {/* A lyrics slide retouched by hand: said in an (i), with the way back to the release's lyrics beside it. */}
          {cfg.textSource.kind === "lyrics" && p.gen?.edited && !p.locked && (<>
            <Hint text={t("Retouched on this slide: the lyrics of the release are not changed.")} />
            <button type="button" className="btn icon sm quiet src-back" aria-label={t("Back to the lyrics")} title={t("Back to the lyrics")}
              onClick={(e) => { e.preventDefault(); p.onLyricsBack(); }}><Icon name="undo" size={11} /></button>
          </>)}
          </div>
          <Select className="input" value={textVal} onChange={(e) => {
            const v = e.target.value;
            // Lyrics: "Lyrics:" on top of the text, in the app's language (to retouch on the slide like the rest).
            p.onCfg((c) => ({ ...c, textSource: v === "" ? { kind: "none" } : v === "__lyrics" ? { kind: "lyrics", header: t("Lyrics:") } : { kind: "pool", poolId: v } }));
          }}>
            <option value="">{t("No text")}</option>
            <option value="__lyrics">{t("Lyrics")}</option>
            {p.textPools.filter((x) => x.kind !== "block" || x.id === textVal).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
          {!p.locked && (
          cfg.textSource.kind === "pool" && allItems.length > 0 ? (
              <Menu float left trigger={(open, toggle) => (
                <button type="button" className={"input pick-btn" + (open ? " on" : "")} onClick={(e) => { e.stopPropagation(); toggle(); }} aria-label={t("Pick from the list")}>
                  <span className="truncate">{listItems.includes(text) ? text.replace(/\|/g, " ") : text.trim() ? t("Text retouched") : t("Pick a text")}</span>
                  {ticked?.length ? <span className="pick-tag">{ticked.length === 1 ? themeLabel(ticked[0], t) : t("{n} tags", { n: ticked.length })}</span>
                    : notTicked.length > 0 && <span className="pick-tag">{notTicked.length === 1 ? t("1 excluded") : t("{n} excluded", { n: notTicked.length })}</span>}
                  <Icon name="chevron" size={13} />
                </button>
              )}>
                {(close) => (
                  <div className="pick-pane" onClick={(e) => e.stopPropagation()}>
                    {groups.length > 1 && (
                      <div className="pick-chips" role="group" aria-label={t("Tags")}>
                        <button className={"pick-chip" + (!ticked?.length && !notTicked.length ? " on" : "")} onClick={() => setTags({ tags: [], not: [] })}>{t("All ({n})", { n: allItems.length })}</button>
                        {groups.map((g) => (
                          <TagChip key={g.id || "other"} label={themeLabel(g.id, t)} count={g.items.length}
                            state={ticked?.includes(g.id) ? "on" : notTicked.includes(g.id) ? "not" : undefined}
                            onTick={() => setTags(tagStep(ticked ?? [], notTicked, g.id, "tick"))} onNot={() => setTags(tagStep(ticked ?? [], notTicked, g.id, "not"))} />
                        ))}
                      </div>
                    )}
                    <div className="pick-list">
                      {listItems.map((x, k) => (
                        <button key={k} className={"pick-line" + (x === text ? " on" : "")} onClick={() => { close(); p.onText(x); }}>
                          <span className="dd-check" aria-hidden>{x === text ? "✓" : ""}</span><span>{x.replace(/\|/g, " ")}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </Menu>
            ) : lyricsPick
          )}
        </div>
        <div className="src-tile src-photo">
          <div className="src-head">
            <span className={"src-ico" + (p.gen?.picId ? " has-pic" : "")} aria-hidden>{p.gen?.picId ? <Thumb id={p.gen.picId} name={p.gen.picName ?? ""} /> : <Icon name="image" size={14} />}</span>
            <span className="src-k" title={t("Photo from")}>{t("Photo")}</span>
          </div>
          <Select className="input" value={cfg.picPoolId ?? ""} onChange={(e) => {
            const v = e.target.value || null;
            p.onCfg((c) => ({ ...c, picPoolId: v }));
            // Another list: the slide takes a photo drawn from it at once (none for "No photo").
            if (!p.locked) p.onRerollPic();
          }}>
            <option value="">{t("No photo")}</option>
            {p.picPools.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
          {!p.locked && (
          pool && pool.pics.length > 0 && p.onChoosePic ? (
              <Menu float trigger={(open, toggle) => (
                <button type="button" className={"input pick-btn" + (open ? " on" : "")} onClick={(e) => { e.stopPropagation(); toggle(); }} aria-label={t("Choose the photo")}>
                  <span className="truncate">{p.gen?.picName ?? t("Choose the photo")}</span>
                  <Icon name="chevron" size={13} />
                </button>
              )}>
                {(close) => (
                  <div className="pick-pane" onClick={(e) => e.stopPropagation()}>
                    <div className="pic-grid">
                      {pool.pics.map((x) => (
                        <button key={x.id} className={"pic-cell" + (x.id === p.gen?.picId ? " on" : "")} title={x.name} onClick={() => { close(); p.onChoosePic!(x.id, x.name); }}>
                          <Thumb id={x.id} name={x.name} />
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </Menu>
            ) : null
          )}
        </div>
      </div>
  </>);
  if (p.part === "fields") return <div className="card card-fields">{fields}</div>;

  return (
    <div className={"card" + (p.selected ? " sel" : "") + (p.locked ? " locked" : "") + (p.dragging ? " dragging" : "") + (p.dragOver ? " drop-target" : "")} onClick={p.onSelect}
      onDragOver={(e) => {
        // A picture from outside (another tab, the desktop), not a slide being moved.
        if (!p.locked && (e.dataTransfer.types.includes("Files") || e.dataTransfer.types.includes("text/uri-list"))) {
          e.preventDefault(); e.dataTransfer.dropEffect = "copy"; if (!dropHere) setDropHere(true); return;
        }
        if (p.onDragOver) { e.preventDefault(); p.onDragOver(); }
      }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropHere(false); }}
      onDrop={(e) => {
        if (dropHere) {
          e.preventDefault(); setDropHere(false);
          const dt = e.dataTransfer;
          void droppedImage(dt).then((got) => { if (got) p.onImage(got.blob, got.name); else setDropErr(t("This picture could not be read. Save it, then drop the file.")); });
          return;
        }
        if (p.onDrop) { e.preventDefault(); p.onDrop(); }
      }}
      onDragEnd={p.onDragEnd}>
      <div className="card-head">
        <span className="grip" draggable onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(p.index)); p.onDragStart?.(); }}
          title={t("Drag to reorder")} aria-hidden="true">⠿</span>
        <button className="idx-chip" onClick={(e) => { e.stopPropagation(); p.onSelect(); }} aria-label={p.locked ? `${t("Slide {n}", { n: p.index + 1 })} · ${t("Locked")}` : t("Slide {n}", { n: p.index + 1 })} aria-pressed={p.selected}>
          {p.locked && <Icon name="lock" size={10} />}{String(p.index + 1).padStart(2, "0")}
        </button>
        <span className="grow" />
        {FIND_PHOTOS && <button className="btn sm quiet icon" onClick={(e) => { e.stopPropagation(); setFinding(true); }} disabled={p.locked}
          title={t("Find a photo on the web (free to post)")} aria-label={t("Find a photo")}><Icon name="search" size={14} /></button>}
        <button className="btn sm quiet" onClick={p.onRerollPic} disabled={!cfg.picPoolId || p.locked} title={t("Pick another photo")}><Icon name="refresh" size={13} />{t("Photo")}</button>
        <button className="btn sm quiet" onClick={p.onRerollText} disabled={cfg.textSource.kind !== "pool" || p.locked}
          title={cfg.textSource.kind === "lyrics" ? t("The lyrics are not drawn: tick the sections under the slide") : t("Pick another text")}><Icon name="refresh" size={13} />{t("Text")}</button>
        <button className="btn sm quiet icon" onClick={p.onSave} aria-label={t("Save this slide")} title={t("Save this slide")}><Icon name="download" size={14} /></button>
        <Menu trigger={(_, toggle) => <button className="btn sm quiet icon" aria-label={t("Slide actions")} title={t("Slide actions")} onClick={(e) => { e.stopPropagation(); toggle(); }}><Icon name="more" size={14} /></button>}>
          {(close) => (<>
            <button disabled={!p.canMoveLeft} onClick={(e) => { e.stopPropagation(); close(); p.onMoveLeft(); }}><Icon name="arrowLeft" size={14} />{t("Move left")}</button>
            <button disabled={!p.canMoveRight} onClick={(e) => { e.stopPropagation(); close(); p.onMoveRight(); }}><Icon name="arrowRight" size={14} />{t("Move right")}</button>
            <div className="sep" />
            <button onClick={(e) => { e.stopPropagation(); close(); p.onDuplicate(); }}><Icon name="copy" size={14} />{t("Duplicate slide")}</button>
            <button disabled={!hasAdjust} onClick={(e) => { e.stopPropagation(); close(); p.onAdjustAll(cfg.pic.adjust); }}
              title={t("Handy for photos of the same shoot")}><Icon name="sliders" size={14} />{t("Put these photo edits on every slide")}</button>
            <button onClick={(e) => { e.stopPropagation(); close(); p.onToggleLock(); }}><Icon name={p.locked ? "unlock" : "lock"} size={14} />{p.locked ? t("Unlock slide") : t("Lock slide")}</button>
            <div className="sep" />
            <button className="danger" style={{ color: "var(--danger)" }} onClick={(e) => { e.stopPropagation(); close(); p.onDelete(); }}><Icon name="trash" size={14} />{t("Delete slide")}</button>
          </>)}
        </Menu>
      </div>
      <div ref={picWrap} className={"cv-wrap has-adjust" + (dropHere ? " drop-here" : "") + (adjusting ? " adjusting" : "")} data-drop={t("Drop here")}
        onContextMenu={(e) => {
          e.preventDefault();
          if (adjusting || matchMedia("(hover: none)").matches) return;
          p.onSelect();
          setCtx({ x: e.clientX, y: e.clientY });
        }}>
        {ctx && (() => {
          const can = img ? aiCan(img) : { sharpOk: false, fillOk: false };
          return (
            <ContextMenu x={ctx.x} y={ctx.y} onClose={() => setCtx(null)}>
              <div className="label cap">{t("Slide {n}", { n: p.index + 1 })}{p.locked ? ` · ${t("Locked")}` : ""}</div>
              <button disabled={cfg.textSource.kind !== "pool" || p.locked} onClick={p.onRerollText}><Icon name="refresh" size={14} />{t("Pick another text")}</button>
              <button disabled={!cfg.picPoolId || p.locked} onClick={p.onRerollPic}><Icon name="refresh" size={14} />{t("Pick another photo")}</button>
              <div className="sep" />
              <button disabled={!img || p.locked} onClick={() => { setAdjusting(true); window.dispatchEvent(new CustomEvent(ADJUST_OPEN, { detail: myId.current })); }}>
                <Icon name="tune" size={14} />{t("Adjust the photo")}<kbd>E</kbd></button>
              <button disabled={!img || p.locked || !can.sharpOk || !!aiBusy} onClick={() => void runAI("sharp")}><Icon name="sparkle" size={14} />{t("Sharper")}</button>
              <button disabled={!img || p.locked || !can.fillOk || !!aiBusy} onClick={() => void runAI("fill")}><Icon name="sparkle" size={14} />{t("Fill the frame")}</button>
              <div className="sep" />
              {p.onFull && <button onClick={p.onFull}><Icon name="expand" size={14} />{t("Full screen")}<kbd>F</kbd></button>}
              {p.onZones && <button onClick={p.onZones}><Icon name={p.zones ? "zones-off" : "zones"} size={14} />{t("TikTok zones")}<kbd>G</kbd></button>}
              <button onClick={p.onSave}><Icon name="download" size={14} />{t("Save this slide")}</button>
              <div className="sep" />
              <button onClick={p.onDuplicate}><Icon name="copy" size={14} />{t("Duplicate slide")}</button>
              <button onClick={p.onToggleLock}><Icon name={p.locked ? "unlock" : "lock"} size={14} />{p.locked ? t("Unlock slide") : t("Lock slide")}</button>
              <button className="danger" style={{ color: "var(--danger)" }} onClick={p.onDelete}><Icon name="trash" size={14} />{t("Delete slide")}</button>
            </ContextMenu>
          );
        })()}
        {dropHere && <div className="drop-hint">{t("Drop the picture here")}</div>}
        <canvas ref={cv} className="cv" width={1080} height={1920}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onDoubleClick={dbl} />
        {/* TikTok's zones over the slide, on and off (shown on hover, and on the selected slide). */}
        {!adjusting && p.onZones && (
          <button className={"zones-open" + (p.zones ? " on" : "")} aria-pressed={!!p.zones} title={t("TikTok's interface zones on the slides")} aria-label={t("Zones")}
            onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); p.onZones!(); }}>
            <Icon name={p.zones ? "zones" : "zones-off"} size={18} />
          </button>
        )}
        {!adjusting && img && !p.locked && (
          <button className={"adjust-open" + (hasAdjust ? " set" : "")} title={t("Adjust the photo (exposure, contrast, saturation…)") + " (E)"} aria-label={t("Adjust the photo")}
            onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); p.onSelect(); setAdjusting(true); window.dispatchEvent(new CustomEvent(ADJUST_OPEN, { detail: myId.current })); }}>
            <Icon name="tune" size={18} />
          </button>
        )}
        {/* AI on the device, top right: the photo sharper, or the empty part of the slide invented around it. Each
            option says what it does, and why it cannot when it cannot. Its ring fills while one works. */}
        {!adjusting && img && !p.locked && (
          <div className={"ai-corner" + (aiBusy ? " busy" : "")}>
          <Menu float portal trigger={(open, toggle) => (
            <button className={"ai-open" + (open ? " on" : "") + (aiBusy ? " busy" : "")} aria-label={t("Photo AI")} title={t("Photo AI")} aria-haspopup="menu"
              style={aiBusy ? { "--p": aiBusy.step === "start" ? 0 : aiBusy.pct ?? 0 } as CSSProperties : undefined}
              onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); p.onSelect(); toggle(); }}>
              <span className="ai-glyph" aria-hidden />
            </button>
          )}>
            {(close) => {
              const { sharpOk, fillOk } = aiCan(img);
              const item = (kind: "sharp" | "fill", title: string, what: string, why: string | null) => (
                <button className="ai-item" disabled={!!why || (!!aiBusy && aiBusy.kind !== kind)} onClick={() => { close(); if (!aiBusy) void runAI(kind); }}>
                  <Icon name="sparkle" size={14} />
                  <span><b>{title}</b><small>{aiBusy?.kind === kind ? aiLabel(aiBusy) : why ?? what}</small></span>
                </button>
              );
              return (<div onClick={(e) => e.stopPropagation()}>
                {item("sharp", t("Sharper"), t("Four times more pixels, details rebuilt"), sharpOk ? null : t("Already in high definition"))}
                {item("fill", t("Fill the frame"), t("Invents the empty edges around the photo"), fillOk ? null : t("The photo already fills the slide: zoom it out to leave edges"))}
                <p className="ai-foot">{t("On this device, nothing is sent.")}</p>
              </div>);
            }}
          </Menu>
          </div>
        )}
        {!adjusting && p.onFull && (
          <button className="pv-expand card-full" aria-label={t("Full screen")} title={t("Full screen")}
            onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); p.onSelect(); p.onFull!(); }}>
            <Icon name="expand" size={18} />
          </button>
        )}
        {adjusting && (() => {
          const cur = ADJUST.find((x) => x.k === tool) ?? ADJUST[0];
          const v = adj[cur.k] ?? 0;
          const setAdj = (n: number) => p.onCfg((c) => {
            const next = { ...(c.pic.adjust ?? {}), [cur.k]: n || undefined };
            return { ...c, pic: { ...c.pic, adjust: Object.values(next).some((x) => x) ? next : undefined } };
          });
          return (
            <div ref={adjustPanel} className={"adjust-panel" + (adjustLeaving ? " leaving" : "")} onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
              {/* As on a phone's photo editor: the edit's name, a row of dials to swipe (the middle one is the edit the
                  wheel moves; each one's ring shows how much it is set), then the wheel. */}
              <div className="adjust-name">{t(cur.label)}</div>
              <DialStrip label={t("Photo edits")} current={tool} onPick={(k) => setTool(k as keyof PhotoAdjust)}
                items={ADJUST.map((x) => ({ k: x.k, label: t(x.label), icon: `adj-${x.k}`, value: adj[x.k] ?? 0, min: x.min }))} />
              <Wheel value={v} min={cur.min} max={100} label={t(cur.label)} onChange={setAdj} />
              {/* Under the wheel, centred: the edits on / off to compare; then, at the very bottom, Reset and Done. */}
              <div className="adjust-compare">
                <Switch off={t("Before")} on={t("After")} checked={!compare} disabled={!hasAdjust} onChange={(v) => setCompare(!v)} title={t("Before: the photo without its edits, to compare")} />
              </div>
              <div className="adjust-actions">
                <button className="btn sm danger" disabled={!hasAdjust} onClick={() => p.onCfg((c) => ({ ...c, pic: { ...c.pic, adjust: undefined } }))}>{t("Reset")}</button>
                <button className="btn sm primary" onClick={() => { setCompare(false); setAdjusting(false); }}>{t("Done")}</button>
              </div>
            </div>
          );
        })()}
      </div>
      {p.selected && p.below}
      {fields}
    </div>
  );
}

/**
 * A row of dials, as on a phone's photo editor: swipe it, the one in the middle is picked (a click centres one too).
 * Each dial: its icon, or its value when picked, inside a ring showing how much it is set (backwards when below 0).
 */
function DialStrip({ items, current, onPick, label }: {
  items: { k: string; label: string; icon: string; value: number; min: number }[]; current: string; onPick: (k: string) => void; label: string;
}) {
  const row = useRef<HTMLDivElement>(null);
  const settle = useRef(0);
  const centre = (k: string, smooth: boolean) => {
    const r = row.current, el = r?.querySelector<HTMLElement>(`[data-k="${k}"]`);
    if (r && el) r.scrollTo({ left: el.offsetLeft + el.offsetWidth / 2 - r.clientWidth / 2, behavior: smooth ? "smooth" : "auto" });
  };
  // At first, the picked one in the middle at once; then, picked another way (a click), it slides there.
  const first = useRef(true);
  useEffect(() => { centre(current, !first.current); first.current = false; }, [current]); // eslint-disable-line react-hooks/exhaustive-deps
  const onScroll = () => {
    clearTimeout(settle.current);
    settle.current = window.setTimeout(() => {
      const r = row.current;
      if (!r) return;
      const mid = r.scrollLeft + r.clientWidth / 2;
      let best = current, d = Infinity;
      r.querySelectorAll<HTMLElement>("[data-k]").forEach((el) => {
        const dd = Math.abs(el.offsetLeft + el.offsetWidth / 2 - mid);
        if (dd < d) { d = dd; best = el.dataset.k!; }
      });
      if (best !== current) onPick(best);
    }, 90);
  };
  useEffect(() => () => clearTimeout(settle.current), []);
  const R = 16, C = 2 * Math.PI * R;
  return (
    <div className="dial-strip" ref={row} role="tablist" aria-label={label} onScroll={onScroll}>
      {items.map((x) => {
        const on = x.k === current, part = Math.min(1, Math.abs(x.value) / 100);
        return (
          <button key={x.k} data-k={x.k} role="tab" aria-selected={on} aria-label={x.label} title={x.label}
            className={"dial" + (on ? " on" : "") + (x.value ? " set" : "")} onClick={() => (on ? undefined : onPick(x.k))}>
            <svg className="dial-ring" viewBox="0 0 36 36" aria-hidden style={x.value < 0 ? { transform: "rotate(-90deg) scaleY(-1)" } : undefined}>
              <circle cx="18" cy="18" r={R} className="dial-track" />
              {part > 0 && <circle cx="18" cy="18" r={R} className="dial-arc" strokeDasharray={`${part * C} ${C}`} />}
            </svg>
            {on ? <span className="dial-val">{x.value > 0 && x.min < 0 ? "+" : ""}{x.value}</span> : <Icon name={x.icon} size={16} />}
          </button>
        );
      })}
    </div>
  );
}
