"use client";
import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import Icon from "./Icon";
import { Menu, Select } from "./ui";
import { clampPic, renderSlide, TextBox, zoomPic } from "@/lib/render";
import { useDriveImage } from "@/lib/useImage";
import { poolThemes, textItems } from "@/lib/generate";
import { themeGroups, themeLabel } from "@/lib/themes";
import type { GenSlide, LyricSection, PhotoAdjust, PicPool, SlideCfg, TextPool } from "@/lib/types";
import { Wheel } from "./ui";
import ImageFinder from "./ImageFinder";
import type { FoundImage } from "@/lib/imageSearch";

/** Photo search on the web (Flickr / Pexels): off for now, the photos did not have the look wanted. */
const FIND_PHOTOS = false;

/** The picture of a drop from another tab (Pinterest…): the file itself, else its address. */
async function droppedImage(dt: DataTransfer): Promise<{ blob: Blob; name: string } | null> {
  const file = Array.from(dt.files).find((f) => f.type.startsWith("image/"));
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
  onDragEnd?: () => void;
  onDrop?: () => void;
  dragging?: boolean;
  dragOver?: boolean;
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export default function SlideCard(p: Props) {
  const { t } = useT();
  const { cfg, gen } = p;
  const { img, err } = useDriveImage(gen?.picId ?? null);
  const cv = useRef<HTMLCanvasElement>(null);
  const box = useRef<TextBox | null>(null);
  const drag = useRef<null | { kind: "text" | "pic"; sx: number; sy: number; ox: number; oy: number; k: number }>(null);
  const [guides, setGuides] = useState({ v: false, h: false });
  const text = gen?.text ?? "";
  // Photo edits panel, over the picture.
  const [adjusting, setAdjusting] = useState(false);
  const [finding, setFinding] = useState(false);
  const [dropHere, setDropHere] = useState(false);
  const [dropErr, setDropErr] = useState<string | null>(null);
  useEffect(() => { if (!dropErr) return; const id = setTimeout(() => setDropErr(null), 4000); return () => clearTimeout(id); }, [dropErr]);
  const [tool, setTool] = useState<keyof PhotoAdjust>("exposure");
  const adj = cfg.pic.adjust ?? {};
  const hasAdjust = Object.values(adj).some((x) => x);

  useEffect(() => {
    if (!cv.current) return;
    const r = renderSlide(cv.current, cfg, img, text, { guideV: guides.v, guideH: guides.h, zones: p.zones });
    box.current = r.box;
  }, [cfg, img, text, guides, p.zones, p.fontsReady]);

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
  const fit = (pic: SlideCfg["pic"]) =>
    img && cv.current ? clampPic(pic, img.width, img.height, cv.current.width, cv.current.height) : pic;

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
    if (d.kind === "text") {
      placeText(d.ox, d.oy, dx, dy, 1.5);
    } else {
      p.onCfg((c) => ({ ...c, pic: fit({ ...c.pic, ox: d.ox + dx / W, oy: d.oy + dy / H }) }));
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
      p.onCfg((s) => ({ ...s, pic: fit({ ...z, ox: z.ox + ((mx - g.mx) * g.k) / W, oy: z.oy + ((my - g.my) * g.k) / H }) }));
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
  const itemThemes = listPool?.kind === "hooks" ? poolThemes(listPool) : [];
  const groups = themeGroups(itemThemes);
  const theme = cfg.textSource.kind === "pool" ? cfg.textSource.theme : undefined;
  const listItems = theme !== undefined && itemThemes.includes(theme) ? allItems.filter((_, i) => itemThemes[i] === theme) : allItems;
  const textVal = cfg.textSource.kind === "pool" ? cfg.textSource.poolId : cfg.textSource.kind === "lyrics" ? "__lyrics" : "";

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
      <div className={"cv-wrap has-adjust" + (dropHere ? " drop-here" : "")} data-drop={t("Drop here")}>
        {dropHere && <div className="drop-hint">{t("Drop the picture here")}</div>}
        <canvas ref={cv} className="cv" width={1080} height={1920}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onDoubleClick={dbl} />
        {!adjusting && img && !p.locked && (
          <button className={"adjust-open" + (hasAdjust ? " set" : "")} title={t("Adjust the photo (exposure, contrast, saturation…)")} aria-label={t("Adjust the photo")}
            onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); p.onSelect(); setAdjusting(true); }}>
            <Icon name="sliders" size={15} />
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
            <div className="adjust-panel" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
              <div className="adjust-tools" role="tablist" aria-label={t("Photo edits")}>
                {ADJUST.map((x) => (
                  <button key={x.k} role="tab" aria-selected={tool === x.k} className={(tool === x.k ? "on" : "") + (adj[x.k] ? " set" : "")}
                    onClick={() => setTool(x.k)}>{t(x.label)}</button>
                ))}
              </div>
              <div className="adjust-value">{v > 0 && cur.min < 0 ? "+" : ""}{v}</div>
              <Wheel value={v} min={cur.min} max={100} label={t(cur.label)} onChange={setAdj} />
              <div className="adjust-actions">
                <button className="btn sm quiet" disabled={!hasAdjust} onClick={() => p.onCfg((c) => ({ ...c, pic: { ...c.pic, adjust: undefined } }))}>{t("Reset")}</button>
                <button className="btn sm" onClick={() => setAdjusting(false)}>{t("Done")}</button>
              </div>
            </div>
          );
        })()}
      </div>
      {err && <span className="notice bad">{err}</span>}
      {dropErr && <span className="notice warn xs">{dropErr}</span>}
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
      {cfg.textSource.kind === "lyrics" && p.gen?.edited && !p.locked && (
        <p className="muted xs row" style={{ gap: 6 }}>
          {t("Retouched on this slide: the lyrics of the release are not changed.")}
          <button type="button" className="field-link" onClick={p.onLyricsBack}>{t("Back to the lyrics")}</button>
        </p>
      )}
      <div className="cols2 fields">
        <label className="field">{t("Text from")}
          <Select className="input" value={textVal} onChange={(e) => {
            const v = e.target.value;
            p.onCfg((c) => ({ ...c, textSource: v === "" ? { kind: "none" } : v === "__lyrics" ? { kind: "lyrics" } : { kind: "pool", poolId: v } }));
          }}>
            <option value="">{t("No text")}</option>
            <option value="__lyrics">{t("Lyrics")}</option>
            {p.textPools.filter((x) => x.kind !== "block" || x.id === textVal).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
        </label>
        <label className="field">{t("Photo from")}
          <Select className="input" value={cfg.picPoolId ?? ""} onChange={(e) => {
            const v = e.target.value || null;
            p.onCfg((c) => ({ ...c, picPoolId: v }));
          }}>
            <option value="">{t("No photo")}</option>
            {p.picPools.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
        </label>
      </div>
      {cfg.textSource.kind === "pool" && groups.length > 1 && !p.locked && (
        <Select className="input sm slide-pick" aria-label={t("Theme")} value={theme ?? "__all"}
          onChange={(e) => { const v = e.target.value; p.onCfg((c) => (c.textSource.kind === "pool" ? { ...c, textSource: { ...c.textSource, theme: v === "__all" ? undefined : v } } : c)); }}>
          <option value="__all">{t("All themes ({n})", { n: allItems.length })}</option>
          {groups.map((g) => <option key={g.id || "other"} value={g.id}>{themeLabel(g.id, t)} · {g.items.length}</option>)}
        </Select>
      )}
      {/* Under the sources, like the sections of a lyrics slide: the same place on every slide. */}
      {listItems.length > 1 && !p.locked && (
        // The text on the slide, drawn or picked, shows as chosen in the list (a text retouched by hand: none).
        <Select className="input sm slide-pick" value={listItems.includes(text) ? text : ""} aria-label={t("Pick from the list")} onClick={(e) => e.stopPropagation()}
          onChange={(e) => { if (e.target.value) p.onText(e.target.value); }}>
          <option value="" disabled={listItems.includes(text)}>{text.trim() && !listItems.includes(text) ? t("Text retouched · pick from the list…") : t("Pick from the list…")}</option>
          {listItems.map((x, k) => <option key={k} value={x}>{x.replace(/\|/g, " ").slice(0, 120)}</option>)}
        </Select>
      )}
      {cfg.textSource.kind === "lyrics" && (() => {
        const src = cfg.textSource;
        // Ticked: its own sections, or (older slides) the one it showed, or the first one.
        const ticked = src.sectionIds ?? (src.sectionId ? [src.sectionId] : p.lyrics[0] ? [p.lyrics[0].id] : []);
        const tick = (id: string, on: boolean) => p.onCfg((c) => ({ ...c, textSource: { ...src, sectionId: undefined,
          sectionIds: p.lyrics.map((l) => l.id).filter((x) => (x === id ? on : ticked.includes(x))) } }));
        const names = p.lyrics.filter((l) => ticked.includes(l.id)).map((l) => l.name);
        if (!p.lyrics.length) return (
          <div className="lyric-src">
            <button className="btn sm" onClick={p.onEditLyrics}><Icon name="plus" size={13} />{t("Add the lyrics")}</button>
          </div>
        );
        return (
          <div className="lyric-src">
            <Menu float trigger={(_, toggle) => (
                <button type="button" className="input lyric-src-pick" onClick={toggle} title={names.join(", ")} aria-label={t("Sections")}>
                  <span className="truncate">{names.length ? names.join(" · ") : t("None ticked")}</span><Icon name="chevron" size={14} />
                </button>
              )}>
                {() => (<>
                  {p.lyrics.map((l) => (
                    <label key={l.id} className="check menu-check" title={l.text.slice(0, 200)}>
                      <input type="checkbox" checked={ticked.includes(l.id)} onChange={(e) => tick(l.id, e.target.checked)} />
                      <span className="truncate">{l.name}</span>
                    </label>
                  ))}
                  <div className="sep" />
                  <button onClick={p.onEditLyrics}>{t("Edit the lyrics…")}</button>
                </>)}
              </Menu>
            <div className="row nowrap lyric-src-head">
              <label className="check xs">
                <input type="checkbox" checked={src.header !== undefined}
                  onChange={(e) => p.onCfg((c) => ({ ...c, textSource: { ...src, header: e.target.checked ? t("Lyrics") : undefined } }))} />
                {t("Header")}
              </label>
              {src.header !== undefined && (
                <input className="input sm grow" value={src.header} aria-label={t("Header")} placeholder={t("Lyrics")}
                  onChange={(e) => p.onCfg((c) => ({ ...c, textSource: { ...src, header: e.target.value } }))} />
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
