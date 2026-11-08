"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Icon from "./Icon";

/** The phone layout (the studios' tabs and dock): the style opens as a sheet there, not as a column. */
export const PHONE_QUERY = "(max-width: 1000px)";

export interface SheetPart<P extends string> { id: P; label: string }

/**
 * On a phone, the style of what is on screen opens in a sheet over the bottom half, the preview kept in sight above
 * it (scrolled under the header, made a little smaller if it would not fit), and changed live while you adjust.
 *
 * - `parts`: the chips (Text, Photo… / Framing, Lyrics…) and, for each, the selector of what the sheet then shows;
 * - `all`: every top-level part of the column (the ones not chosen are hidden while the sheet is open).
 */
export function useStyleSheet<P extends string>(opts: {
  preview: () => HTMLElement | null;
  sheet: () => HTMLElement | null;
  parts: Record<P, string>;
  all: string;
}) {
  const [part, setPart] = useState<P | null>(null);
  const [tall, setTall] = useState(false);
  const o = useRef(opts);
  o.current = opts;
  const open = part !== null;

  // Opening: the preview goes under the header, and the sheet starts right below it (half the screen at most).
  useLayoutEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    const el = o.current.preview();
    const headBottom = (document.querySelector(".top") as HTMLElement | null)?.getBoundingClientRect().bottom ?? 56;
    const H = window.innerHeight;
    const maxTop = Math.round(H * 0.5);
    let top = maxTop;
    root.classList.add("sheet-room");
    if (el) {
      const r = el.getBoundingClientRect();
      window.scrollTo({ top: Math.max(0, window.scrollY + r.top - headBottom - 6), behavior: "instant" });
      const r2 = el.getBoundingClientRect();
      const scale = Math.max(0.55, Math.min(1, (maxTop - 6 - r2.top) / Math.max(1, r2.height)));
      if (scale < 0.999) { el.style.transformOrigin = "50% 0"; el.style.scale = String(scale); }
      top = Math.min(maxTop, Math.round(r2.top + r2.height * scale + 8));
    }
    root.style.setProperty("--sheet-top", `${Math.max(headBottom + 40, top)}px`);
    root.style.setProperty("--sheet-tall", `${Math.round(headBottom + 8)}px`);
    root.classList.add("sheet-lock");
    return () => {
      if (el) el.style.scale = "";
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
    sheet.querySelectorAll<HTMLDetailsElement>(`${want}`).forEach((d) => { if (d.tagName === "DETAILS") d.open = true; });
    sheet.scrollTop = 0;
  }, [part]);

  const close = useCallback(() => { setPart(null); setTall(false); }, []);
  // Escape, and leaving the phone layout (a turned tablet, a wider window), close it.
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    const mq = matchMedia(PHONE_QUERY);
    const wide = () => { if (!mq.matches) close(); };
    window.addEventListener("keydown", key);
    mq.addEventListener("change", wide);
    return () => { window.removeEventListener("keydown", key); mq.removeEventListener("change", wide); };
  }, [open, close]);

  return {
    part, tall, close,
    openPart: (p: P) => { setPart(p); try { navigator.vibrate?.(6); } catch { /* not on this phone */ } },
    toggleTall: () => setTall((v) => !v),
    /** Class and data for the column that becomes the sheet. */
    sheetProps: { className: open ? " sheet-open" + (tall ? " tall" : "") : "", "data-part": part ?? undefined },
  };
}

/** The sheet's top: a grip (a tap makes it tall or half, a pull down closes it), the parts, and a close button. */
export function SheetHead<P extends string>({ parts, part, onPart, onClose, onTall, closeLabel }: {
  parts: SheetPart<P>[]; part: P | null; onPart: (p: P) => void; onClose: () => void; onTall: () => void; closeLabel: string;
}) {
  const y0 = useRef<number | null>(null);
  return (
    <div className="sheet-head"
      onPointerDown={(e) => { if ((e.target as HTMLElement).closest("button")) return; y0.current = e.clientY; }}
      onPointerUp={(e) => {
        if (y0.current === null) return;
        const dy = e.clientY - y0.current;
        y0.current = null;
        if (dy > 50) onClose(); else if (dy < -30 || Math.abs(dy) < 6) onTall();
      }}
      onPointerCancel={() => { y0.current = null; }}>
      <span className="sheet-grip" aria-hidden />
      <div className="row nowrap sheet-parts">
        {parts.map((p) => (
          <button key={p.id} className={"btn sm" + (part === p.id ? " on" : "")} aria-pressed={part === p.id} onClick={() => onPart(p.id)}>{p.label}</button>
        ))}
        <span className="grow" />
        <button className="btn icon quiet sm" aria-label={closeLabel} onClick={onClose}><Icon name="x" size={16} /></button>
      </div>
    </div>
  );
}

/** Under the preview, on a phone: the style's parts, each opening the sheet on it. */
export function SheetChips<P extends string>({ label, parts, part, onPart }: { label: string; parts: SheetPart<P>[]; part: P | null; onPart: (p: P) => void }) {
  return (
    <div className="row nowrap sheet-chips">
      <span className="label">{label}</span>
      {parts.map((p) => (
        <button key={p.id} className={"btn sm" + (part === p.id ? " on" : "")} aria-pressed={part === p.id} onClick={() => onPart(p.id)}>{p.label}</button>
      ))}
    </div>
  );
}
