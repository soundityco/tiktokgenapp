"use client";
import { useRef, useState } from "react";
import type { Backdrop } from "@/lib/types";
import { colorAt, gradientOf, isGradient, startGradient } from "@/lib/backdrop";
import { useT } from "@/lib/i18n";
import { ColorField } from "./TextControls";
import Icon from "./Icon";

type Stop = { at: number; color: string };

/**
 * The post's ground (lib/backdrop): black, a colour, or a gradient (linear / radial). A gradient's stops sit on a bar as
 * in Photoshop: a click on the bar adds one (in the colour already there), a stop is dragged along it, pulled away from it
 * to remove it (two at least), picked to change its colour. Its two points (A, B) are moved on the preview.
 */
export default function BackdropPanel({ value, onChange }: { value?: Backdrop; onChange: (b: Backdrop | undefined) => void }) {
  const { t } = useT();
  const kind = value?.kind ?? "black";
  const [sel, setSel] = useState(0);
  const set = (k: string) => {
    if (k === "black") onChange(undefined);
    else if (k === "color") onChange({ kind: "color", color: value?.kind === "color" ? value.color : isGradient(value) ? gradientOf(value!).stops[0].color : "#f7d9bd" });
    else onChange(value?.kind === k ? value : { ...startGradient(k as "linear" | "radial", value), ...(isGradient(value) ? { stops: gradientOf(value!).stops } : {}) });
  };
  return (
    <div className="ground-panel">
      <div className="row ground-kinds" role="group" aria-label={t("Ground")}>
        {([["black", t("Black")], ["color", t("Colour")], ["linear", t("Linear")], ["radial", t("Radial")]] as const).map(([k, label]) => (
          <button key={k} className={"btn sm grow" + (kind === k ? " on" : "")} aria-pressed={kind === k} onClick={() => set(k)}>{label}</button>
        ))}
      </div>
      {value?.kind === "color" && <ColorField label={t("Colour")} value={value.color ?? "#000000"} onChange={(color) => onChange({ kind: "color", color })} />}
      {value && isGradient(value) && <GradientStops value={value} sel={sel} setSel={setSel} onChange={onChange} />}
      {value && isGradient(value) && <p className="muted xs">{value.kind === "radial"
        ? t("On the preview: move the centre and the edge; scroll over a point to widen or narrow it.")
        : t("On the preview: move its start and end; scroll over a point to stretch it.")}</p>}
    </div>
  );
}

function GradientStops({ value, sel, setSel, onChange }: { value: Backdrop; sel: number; setSel: (i: number) => void; onChange: (b: Backdrop) => void }) {
  const { t } = useT();
  const g = gradientOf(value);
  const stops = g.stops;
  const bar = useRef<HTMLDivElement>(null);
  const drag = useRef<{ i: number; y0: number; moved: boolean } | null>(null);
  const [leaving, setLeaving] = useState(false);
  const put = (next: Stop[]) => onChange({ ...value, ...{ ax: g.ax, ay: g.ay, bx: g.bx, by: g.by }, stops: next });
  const atOf = (x: number) => { const r = bar.current!.getBoundingClientRect(); return Math.min(1, Math.max(0, (x - r.left) / r.width)); };
  const cur = stops[Math.min(sel, stops.length - 1)];
  const css = `linear-gradient(90deg, ${stops.map((s) => `${s.color} ${(s.at * 100).toFixed(1)}%`).join(", ")})`;
  return (
    <div className="grad-edit">
      <div ref={bar} className="grad-bar" style={{ background: css }} title={t("Click to add a colour; drag a stop along, or away to remove it")}
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest(".grad-stop")) return;
          const at = Math.round(atOf(e.clientX) * 1000) / 1000;
          const next = [...stops, { at, color: colorAt(stops, at) }].sort((a, b) => a.at - b.at);
          put(next); setSel(next.findIndex((s) => s.at === at));
        }}>
        {stops.map((s, i) => (
          <button key={i} className={"grad-stop" + (i === sel ? " on" : "") + (i === sel && leaving ? " leaving" : "")} style={{ left: `${s.at * 100}%`, background: s.color }}
            aria-label={`${t("Colour")} ${Math.round(s.at * 100)}%`}
            onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); setSel(i); drag.current = { i, y0: e.clientY, moved: false }; }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) return;
              d.moved = true;
              setLeaving(stops.length > 2 && Math.abs(e.clientY - d.y0) > 28);
              const at = Math.round(atOf(e.clientX) * 1000) / 1000;
              put(stops.map((x, k) => (k === d.i ? { ...x, at } : x)));
            }}
            onPointerUp={(e) => {
              const d = drag.current;
              drag.current = null;
              if (d && stops.length > 2 && Math.abs(e.clientY - d.y0) > 28) { put(stops.filter((_, k) => k !== d.i)); setSel(0); }
              else if (d?.moved) { const next = [...stops].sort((a, b) => a.at - b.at); put(next); setSel(next.indexOf(stops[d.i])); }
              setLeaving(false);
            }} />
        ))}
      </div>
      {cur && (
        <div className="row grad-cur">
          <ColorField label={`${t("Colour")} · ${Math.round(cur.at * 100)}%`} value={cur.color} onChange={(color) => put(stops.map((x, k) => (k === Math.min(sel, stops.length - 1) ? { ...x, color } : x)))} />
          <button className="btn sm quiet icon" title={t("Reverse the gradient")} aria-label={t("Reverse the gradient")}
            onClick={() => put(stops.map((x) => ({ ...x, at: 1 - x.at })).sort((a, b) => a.at - b.at))}><Icon name="swap" size={14} /></button>
          <button className="btn sm quiet icon" title={t("Remove this colour")} aria-label={t("Remove this colour")} disabled={stops.length <= 2}
            onClick={() => { put(stops.filter((_, k) => k !== Math.min(sel, stops.length - 1))); setSel(0); }}><Icon name="trash" size={14} /></button>
        </div>
      )}
    </div>
  );
}
