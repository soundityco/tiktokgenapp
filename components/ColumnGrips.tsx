"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";

/**
 * The library (left) and settings (right) columns widened by dragging their inner edge, as in Photoshop: never
 * narrower than their usual width, at most `MAX` px wide (320 both), the board in the middle keeping `CENTER_MIN` px. The widths
 * are this browser's (`tktgen-col-widths`), the same for both studios; a double click puts the usual width back.
 * Computer only: the grips show only while the studio has its three columns.
 */
const BASE = { l: 240, r: 288 } as const;
const MAX = { l: 320, r: 320 } as const;
const CENTER_MIN = 560;
const KEY = "tktgen-col-widths";

type Side = "l" | "r";
type Widths = { l: number; r: number };

const fit = (side: Side, w: number) => Math.round(Math.min(MAX[side], Math.max(BASE[side], w)));
const apply = (w: Widths) => {
  const s = document.documentElement.style;
  if (w.l > BASE.l) s.setProperty("--col-l", `${w.l}px`); else s.removeProperty("--col-l");
  if (w.r > BASE.r) s.setProperty("--col-r", `${w.r}px`); else s.removeProperty("--col-r");
};

export default function ColumnGrips({ studio }: { studio: string }) {
  const { t } = useT();
  const [widths, setWidths] = useState<Widths>({ ...BASE });
  const [box, setBox] = useState<{ x0: number; x1: number; top: number; h: number } | null>(null);
  const drag = useRef<{ side: Side; x: number; w: number; other: number } | null>(null);
  const [active, setActive] = useState<Side | null>(null);

  // The widths kept in this browser.
  useEffect(() => {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Widths> | null;
      if (v) { const w = { l: fit("l", v.l ?? BASE.l), r: fit("r", v.r ?? BASE.r) }; setWidths(w); apply(w); }
    } catch { /* no storage */ }
  }, []);

  // Where the columns' edges are (only while the studio shows three columns).
  const measure = useCallback(() => {
    const grid = document.querySelector<HTMLElement>(studio === "video" ? ".main .video-shell" : ".main");
    if (!grid) { setBox(null); return; }
    const cols = getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean);
    if (cols.length !== 3) { setBox(null); return; }
    const r = grid.getBoundingClientRect();
    setBox({ x0: r.left + parseFloat(cols[0]), x1: r.right - parseFloat(cols[2]), top: r.top, h: r.height });
  }, [studio]);
  useEffect(() => {
    measure();
    const grid = document.querySelector<HTMLElement>(".main");
    const ro = new ResizeObserver(measure);
    if (grid) ro.observe(grid);
    window.addEventListener("resize", measure);
    // (the video studio mounts its columns a moment later)
    const late = window.setTimeout(measure, 400);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); window.clearTimeout(late); };
  }, [measure, widths]);

  const save = (w: Widths) => { try { localStorage.setItem(KEY, JSON.stringify(w)); } catch { /* no storage */ } };
  const set = (w: Widths) => { setWidths(w); apply(w); };

  if (!box) return null;
  const grip = (side: Side) => (
    <div key={side} className={"col-grip" + (active === side ? " on" : "")} role="separator" aria-orientation="vertical"
      aria-label={side === "l" ? t("Library width") : t("Settings width")} title={t("Drag to widen, double click: usual width")}
      style={{ left: side === "l" ? box.x0 : box.x1, top: box.top, height: box.h }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { side, x: e.clientX, w: widths[side], other: widths[side === "l" ? "r" : "l"] };
        setActive(side);
        document.documentElement.classList.add("col-resizing");
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = (e.clientX - d.x) * (d.side === "l" ? 1 : -1);
        // (the board in the middle keeps its room)
        const room = window.innerWidth - d.other - CENTER_MIN;
        const w = fit(d.side, Math.min(d.w + dx, Math.max(BASE[d.side], room)));
        if (w !== widths[d.side]) set({ ...widths, [d.side]: w });
      }}
      onPointerUp={() => { if (!drag.current) return; drag.current = null; setActive(null); document.documentElement.classList.remove("col-resizing"); save(widths); }}
      onPointerCancel={() => { drag.current = null; setActive(null); document.documentElement.classList.remove("col-resizing"); }}
      onDoubleClick={() => { const w = { ...widths, [side]: BASE[side] }; set(w); save(w); }} />
  );
  return <>{grip("l")}{grip("r")}</>;
}
