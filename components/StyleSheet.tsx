"use client";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

/** The phone layout (the studios' tabs and dock): the style is a page of its own there, part by part. */
export const PHONE_QUERY = "(max-width: 1000px)";

/** The phone layout is on (the same flag everywhere: one component, placed differently, never two components). */
export function usePhone(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const mq = matchMedia(PHONE_QUERY);
    const f = () => setPhone(mq.matches);
    f();
    mq.addEventListener("change", f);
    return () => mq.removeEventListener("change", f);
  }, []);
  return phone;
}

export interface SheetPart<P extends string> { id: P; label: string }

/**
 * The phone's Style page: the preview on top (it stays in sight), then one part of the style at a time (Text,
 * Photo… / Framing, Lyrics…), chosen in a control above it.
 *
 * - `parts`: for each part, the selector of what the page then shows;
 * - `all`: every top-level part of the style column (the ones not chosen are hidden on the page);
 * - `active`: the Style page is the one open (on a computer the column shows everything, always).
 */
export function useStyleParts<P extends string>(opts: {
  column: () => HTMLElement | null;
  parts: Record<P, string>;
  all: string;
  first: P;
  active: boolean;
  /** Something that swaps the column's content (the video's lyrics / hook tab): the parts are applied again. */
  swap?: unknown;
}) {
  const [part, setPart] = useState<P>(opts.first);
  const [phone, setPhone] = useState(false);
  const o = useRef(opts);
  o.current = opts;
  useEffect(() => {
    const mq = matchMedia(PHONE_QUERY);
    const f = () => setPhone(mq.matches);
    f();
    mq.addEventListener("change", f);
    return () => mq.removeEventListener("change", f);
  }, []);
  const on = opts.active && phone;
  // The preview's height chosen last time on this device (kept within what this screen allows).
  useEffect(() => {
    try { const v = Number(localStorage.getItem(PV_KEY)); if (v > 0) document.documentElement.style.setProperty("--pv-h", `${v}px`); } catch { /* private mode */ }
  }, []);
  useEffect(() => { if (on) requestAnimationFrame(clampPv); }, [on]);

  // The part shown: the others hidden, its panel unfolded. Off the Style page, everything is back.
  useLayoutEffect(() => {
    const col = o.current.column();
    if (!col) return;
    const all = [...col.querySelectorAll<HTMLElement>(o.current.all)];
    if (!on) { all.forEach((e) => e.classList.remove("sheet-hide")); return; }
    const want = o.current.parts[part];
    for (const e of all) e.classList.toggle("sheet-hide", !e.matches(want));
    col.querySelectorAll<HTMLDetailsElement>(want).forEach((d) => { if (d.tagName === "DETAILS") d.open = true; });
  }, [part, on, opts.swap]);

  // Where the preview ends (it holds still under the header): the parts' control sticks right under it.
  useEffect(() => {
    if (!on || typeof ResizeObserver === "undefined") return;
    const centre = [...document.querySelectorAll<HTMLElement>(".main .col.center")].find((e) => e.offsetParent);
    if (!centre) return;
    const root = document.documentElement;
    const col = o.current.column();
    let pvBottom = 0;
    // The column is at least the room between the control and what follows it on the page, measured on the real
    // page (not computed from the screen's height): at the end of the scroll, a short part's first setting is
    // still right under the control, never under it.
    const fit = () => {
      if (!col) return;
      const below = root.scrollHeight - (col.getBoundingClientRect().bottom + window.scrollY);
      const min = Math.max(0, Math.floor(window.innerHeight - pvBottom - below));
      if (col.style.minHeight !== `${min}px`) col.style.minHeight = `${min}px`;
    };
    // The release's head sits above the preview: it scrolls away under the app's header while the preview holds
    // (the block sticks that much higher), so --style-head is its height and the gap after it.
    const head = centre.querySelector<HTMLElement>(".studio-head");
    const set = () => {
      // Measured on the picture itself (the slide or the video): held, it sits 12px under the app's header in both
      // studios, as before the head was there.
      const pic = centre.querySelector<HTMLElement>(".video-stage .cv-wrap, .card.sel .cv-wrap");
      const c = centre.getBoundingClientRect();
      const headH = head?.offsetParent && pic ? Math.max(0, Math.round(pic.getBoundingClientRect().top - c.top - 12)) : 0;
      root.style.setProperty("--style-head", `${headH}px`);
      pvBottom = Math.ceil(parseFloat(getComputedStyle(root).getPropertyValue("--top-h") || "60") + c.height - headH);
      root.style.setProperty("--pv-bottom", `${pvBottom}px`);
      fit();
    };
    set();
    const ro = new ResizeObserver(set);
    ro.observe(centre);
    if (head) ro.observe(head);
    if (col) ro.observe(col);
    window.addEventListener("resize", set);
    // The preview holds still: scrolling up or down over it (wheel, trackpad) does not scroll the settings below.
    // Sideways stays free (the carousel's slides), and the preview's own wheel (zoom, text size) still works.
    const wheel = (e: WheelEvent) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.preventDefault(); };
    centre.addEventListener("wheel", wheel, { passive: false });
    return () => { ro.disconnect(); window.removeEventListener("resize", set); centre.removeEventListener("wheel", wheel); if (col) col.style.minHeight = ""; };
  }, [on, part]);

  return {
    part,
    pick: (p: P) => {
      setPart(p);
      try { navigator.vibrate?.(6); } catch { /* not on this phone */ }
      // The new part from its start, right under the control (not left scrolled away under the preview).
      const col = o.current.column();
      const pvBottom = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--pv-bottom") || "0");
      if (col && pvBottom) {
        const goal = window.scrollY + col.getBoundingClientRect().top - pvBottom;
        if (window.scrollY > goal) requestAnimationFrame(() => window.scrollTo({ top: Math.max(0, goal), behavior: "instant" }));
      }
    },
  };
}

/** The preview's height on the Style page (px), chosen by dragging the control under it; kept on this device. */
const PV_KEY = "tktgen-pv-h";
const visibleCentre = () => [...document.querySelectorAll<HTMLElement>(".main .col.center")].find((e) => e.offsetParent);
/** The block on top is the preview's height plus this, in both studios (see globals.css): the same sizes give
 *  the same place to the control. */
const PV_EXTRA = 76;
/** The preview's height now (the variable, else what the block measures). */
const pvNow = () => {
  const v = parseFloat(document.documentElement.style.getPropertyValue("--pv-h"));
  if (v > 0) return v;
  const c = visibleCentre();
  return c ? c.getBoundingClientRect().height - PV_EXTRA : 300;
};
/** From small to as tall as leaves the parts' control in sight above the dock (`here`: also where the page is now,
 *  for a drag; without it, the screen's own limit, the same in both studios). */
const pvBounds = (here = true) => {
  const root = getComputedStyle(document.documentElement);
  const topH = parseFloat(root.getPropertyValue("--top-h") || "60");
  const dockEl = document.querySelector<HTMLElement>(".mobile-tabs");
  const dock = dockEl?.getBoundingClientRect();
  // The video's dock is taller (its player): the carousel counts that row too, so both allow the same size.
  const playerRow = dockEl?.querySelector(".dock-player:not(:empty)") ? 0 : 60;
  const floor = dock ? dock.top - 8 - playerRow : window.innerHeight - 150;
  const tabs = [...document.querySelectorAll<HTMLElement>(".style-tabs")].find((e) => e.offsetParent)?.getBoundingClientRect();
  const tabsH = tabs?.height ?? 120;
  // Held under the header: the biggest picture that leaves the control above the dock…
  const stuck = floor - topH - PV_EXTRA - tabsH;
  // …and where the page is now (not scrolled yet: the block sits lower).
  const now = here && tabs ? pvNow() + floor - tabs.bottom : stuck;
  return [170, Math.max(200, Math.min(stuck, now))] as const;
};
const clampPv = () => {
  const v = parseFloat(document.documentElement.style.getPropertyValue("--pv-h"));
  if (!(v > 0)) return;
  const [lo, hi] = pvBounds(false);
  document.documentElement.style.setProperty("--pv-h", `${Math.round(Math.min(hi, Math.max(lo, v)))}px`);
};

/** The Style page's control: "Style" over the parts, the chosen one on the studio's gradient (it slides). Dragged
 *  down from its top line, the preview above grows (up: it shrinks), like going from a post to its timeline. */
export function StyleTabs<P extends string>({ parts, part, onPart, tone }: {
  parts: SheetPart<P>[]; part: P; onPart: (p: P) => void; tone: "carousel" | "video";
}) {
  const at = Math.max(0, parts.findIndex((p) => p.id === part));
  const drag = useRef<{ y: number; h: number; hi: number } | null>(null);
  const end = () => {
    if (!drag.current) return;
    drag.current = null;
    document.documentElement.classList.remove("pv-dragging");
    try { localStorage.setItem(PV_KEY, String(parseFloat(document.documentElement.style.getPropertyValue("--pv-h")) || "")); } catch { /* private mode */ }
  };
  return (
    <div className="style-tabs"
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { y: e.clientY, h: pvNow(), hi: pvBounds()[1] };
        document.documentElement.classList.add("pv-dragging");
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const h = Math.round(Math.min(d.hi, Math.max(170, d.h + e.clientY - d.y)));
        document.documentElement.style.setProperty("--pv-h", `${h}px`);
      }}
      onPointerUp={end} onPointerCancel={end}>
      <span className="style-grip" aria-hidden />
      <div className={"sheet-seg " + tone} role="tablist" style={{ "--n": parts.length, "--i": at } as CSSProperties}>
        <span className="sheet-seg-thumb" aria-hidden />
        {parts.map((p) => (
          <button key={p.id} role="tab" className={part === p.id ? "on" : ""} aria-selected={part === p.id} onClick={() => onPart(p.id)}>{p.label}</button>
        ))}
      </div>
    </div>
  );
}
