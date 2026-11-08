"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Icon from "./Icon";

/** The phone layout (the studios' tabs and dock): the style opens as a sheet there, not as a column. */
export const PHONE_QUERY = "(max-width: 1000px)";

export interface SheetPart<P extends string> { id: P; label: string }

const OPEN_MS = 380;
const CLOSE_MS = 260;

/**
 * On a phone, the style of what is on screen opens in a sheet over everything (the dock too), from the bottom; the
 * preview glides up under the header (a little smaller if it would not fit), so it stays in sight and changes live.
 *
 * - `parts`: the parts shown in the sheet's head (Text, Photo… / Framing, Lyrics…) and, for each, the selector of
 *   what the sheet then shows;
 * - `all`: every top-level part of the column (the ones not chosen are hidden while the sheet is open).
 */
export function useStyleSheet<P extends string>(opts: {
  preview: () => HTMLElement | null;
  sheet: () => HTMLElement | null;
  parts: Record<P, string>;
  all: string;
  first: P;
}) {
  const [part, setPart] = useState<P | null>(null);
  const [tall, setTall] = useState(false);
  const [closing, setClosing] = useState(false);
  const last = useRef<P>(opts.first);
  const o = useRef(opts);
  o.current = opts;
  const open = part !== null;

  // Opening: the page glides so the preview sits under the header; the sheet starts below it (half the screen at most).
  useLayoutEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    const el = o.current.preview();
    const headBottom = (document.querySelector(".top") as HTMLElement | null)?.getBoundingClientRect().bottom ?? 56;
    const maxTop = Math.round(window.innerHeight * 0.52);
    let top = maxTop;
    root.classList.add("sheet-room");
    let lockTimer = 0;
    if (el) {
      const r = el.getBoundingClientRect();
      // Where the preview will be once the page has glided (the room added below lets it go that far).
      const goal = headBottom + 6;
      const scale = Math.max(0.5, Math.min(1, (maxTop - 8 - goal) / Math.max(1, r.height)));
      el.classList.add("sheet-preview");
      el.style.transformOrigin = "50% 0";
      el.style.scale = scale < 0.999 ? String(scale) : "";
      top = Math.min(maxTop, Math.round(goal + r.height * scale + 8));
      window.scrollTo({ top: Math.max(0, window.scrollY + r.top - goal), behavior: "smooth" });
    }
    root.style.setProperty("--sheet-top", `${Math.max(headBottom + 40, top)}px`);
    root.style.setProperty("--sheet-tall", `${Math.round(headBottom + 8)}px`);
    // The page stops scrolling under the sheet once it got there.
    lockTimer = window.setTimeout(() => root.classList.add("sheet-lock"), OPEN_MS);
    return () => {
      clearTimeout(lockTimer);
      if (el) { el.style.scale = ""; window.setTimeout(() => el.classList.remove("sheet-preview"), OPEN_MS); }
      root.classList.remove("sheet-lock", "sheet-room");
    };
  }, [open]);

  // The part shown: the others hidden, its panel unfolded, from its top.
  useLayoutEffect(() => {
    const sheet = o.current.sheet();
    if (!sheet) return;
    const all = [...sheet.querySelectorAll<HTMLElement>(o.current.all)];
    if (part === null) { all.forEach((e) => e.classList.remove("sheet-hide")); return; }
    const want = o.current.parts[part];
    for (const e of all) e.classList.toggle("sheet-hide", !e.matches(want));
    sheet.querySelectorAll<HTMLDetailsElement>(want).forEach((d) => { if (d.tagName === "DETAILS") d.open = true; });
    sheet.scrollTop = 0;
  }, [part]);

  /** Slides down, then goes. */
  const close = useCallback(() => {
    setClosing(true);
    window.setTimeout(() => { setPart(null); setTall(false); setClosing(false); }, CLOSE_MS);
  }, []);
  // Escape, and leaving the phone layout (a turned tablet, a wider window), close it.
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    const mq = matchMedia(PHONE_QUERY);
    const wide = () => { if (!mq.matches) { setPart(null); setTall(false); } };
    window.addEventListener("keydown", key);
    mq.addEventListener("change", wide);
    return () => { window.removeEventListener("keydown", key); mq.removeEventListener("change", wide); };
  }, [open, close]);

  const openPart = (p: P) => { last.current = p; setClosing(false); setPart(p); try { navigator.vibrate?.(6); } catch { /* not on this phone */ } };
  return {
    part, tall, close, openPart,
    /** The part used last time (the first one at the start). */
    lastPart: () => last.current,
    toggleTall: () => setTall((v) => !v),
    /** Class and data for the column that becomes the sheet. */
    sheetProps: { className: open ? " sheet-open" + (tall ? " tall" : "") + (closing ? " closing" : "") : "", "data-part": part ?? undefined },
  };
}

/** The sheet's top: a grip (pull it down to close, up or a tap to make it tall), the parts, and a close button. */
export function SheetHead<P extends string>({ parts, part, onPart, onClose, onTall, closeLabel, title, tone }: {
  parts: SheetPart<P>[]; part: P | null; onPart: (p: P) => void; onClose: () => void; onTall: () => void; closeLabel: string;
  /** The label over the parts ("Style"), and the studio whose gradient the chosen part wears. */
  title: string; tone: "carousel" | "video";
}) {
  const at = Math.max(0, parts.findIndex((p) => p.id === part));
  const drag = useRef<{ y: number; sheet: HTMLElement } | null>(null);
  const end = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    const dy = e.clientY - d.y;
    d.sheet.classList.remove("dragging");
    // Let go far enough down: it goes on from where the finger left it.
    if (dy > 90) { onClose(); window.setTimeout(() => { d.sheet.style.translate = ""; }, CLOSE_MS + 40); return; }
    d.sheet.style.translate = "";
    if (dy < -30 || Math.abs(dy) < 6) onTall();
  };
  return (
    <div className="sheet-head"
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        const sheet = e.currentTarget.parentElement;
        if (!sheet) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { y: e.clientY, sheet };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        // The sheet follows the finger down (up, it only stretches a little).
        const dy = e.clientY - d.y;
        d.sheet.classList.add("dragging");
        d.sheet.style.translate = `0 ${dy > 0 ? dy : dy / 4}px`;
      }}
      onPointerUp={end} onPointerCancel={end}>
      <span className="sheet-grip" aria-hidden />
      <div className="sheet-top">
        <span className="label">{title}</span>
        <button className="sheet-x" aria-label={closeLabel} onClick={onClose}><Icon name="x" size={16} /></button>
      </div>
      {/* The parts: one control across the sheet, the chosen one on the studio's gradient (it slides to the next). */}
      <div className={"sheet-seg " + tone} role="tablist" style={{ "--n": parts.length, "--i": at } as React.CSSProperties}>
        <span className="sheet-seg-thumb" aria-hidden />
        {parts.map((p) => (
          <button key={p.id} role="tab" className={part === p.id ? "on" : ""} aria-selected={part === p.id} onClick={() => onPart(p.id)}>{p.label}</button>
        ))}
      </div>
    </div>
  );
}
