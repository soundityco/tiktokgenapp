"use client";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

/** The phone layout (the studios' tabs and dock): the style is a page of its own there, part by part. */
export const PHONE_QUERY = "(max-width: 1000px)";

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

  // The part shown: the others hidden, its panel unfolded. Off the Style page, everything is back.
  useLayoutEffect(() => {
    const col = o.current.column();
    if (!col) return;
    const all = [...col.querySelectorAll<HTMLElement>(o.current.all)];
    if (!on) { all.forEach((e) => e.classList.remove("sheet-hide")); return; }
    const want = o.current.parts[part];
    for (const e of all) e.classList.toggle("sheet-hide", !e.matches(want));
    col.querySelectorAll<HTMLDetailsElement>(want).forEach((d) => { if (d.tagName === "DETAILS") d.open = true; });
  }, [part, on]);

  return {
    part,
    pick: (p: P) => {
      setPart(p);
      try { navigator.vibrate?.(6); } catch { /* not on this phone */ }
    },
  };
}

/** The Style page's control: "Style" over the parts, the chosen one on the studio's gradient (it slides). */
export function StyleTabs<P extends string>({ parts, part, onPart, title, tone }: {
  parts: SheetPart<P>[]; part: P; onPart: (p: P) => void; title: string; tone: "carousel" | "video";
}) {
  const at = Math.max(0, parts.findIndex((p) => p.id === part));
  return (
    <div className="style-tabs">
      <span className="label">{title}</span>
      <div className={"sheet-seg " + tone} role="tablist" style={{ "--n": parts.length, "--i": at } as CSSProperties}>
        <span className="sheet-seg-thumb" aria-hidden />
        {parts.map((p) => (
          <button key={p.id} role="tab" className={part === p.id ? "on" : ""} aria-selected={part === p.id} onClick={() => onPart(p.id)}>{p.label}</button>
        ))}
      </div>
    </div>
  );
}
