"use client";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { Backdrop } from "@/lib/types";
import { gradientOf } from "@/lib/backdrop";
import { useT } from "@/lib/i18n";

/**
 * A gradient ground's two points on the video preview (lib/backdrop), as Photoshop's handles: A (its start, or the
 * centre of a radial one) and B (its end, or its edge), dragged anywhere on the post (a little past its sides too); the
 * wheel over either stretches it (B moved away from or towards A). Shown while the Ground panel is open.
 */
export default function GroundHandles({ canvas, value, onChange }: { canvas: RefObject<HTMLCanvasElement | null>; value: Backdrop; onChange: (b: Backdrop) => void }) {
  const { t } = useT();
  const g = gradientOf(value);
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const layer = useRef<HTMLDivElement>(null);
  const live = useRef({ value, g, onChange });
  live.current = { value, g, onChange };
  // over the canvas, following its size
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const place = () => setBox({ left: c.offsetLeft, top: c.offsetTop, width: c.offsetWidth, height: c.offsetHeight });
    place();
    const ro = new ResizeObserver(place);
    ro.observe(c);
    return () => ro.disconnect();
  }, [canvas]);
  // the wheel over a point: B away from or towards A (a native listener: React's is passive, the page would scroll)
  useEffect(() => {
    const el = layer.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (!(e.target as HTMLElement).closest(".gh-pt")) return;
      e.preventDefault();
      const { value: v, g: cur, onChange: set } = live.current;
      const k = Math.exp(-e.deltaY * 0.0025);
      set({ ...v, ax: cur.ax, ay: cur.ay, bx: r3(cur.ax + (cur.bx - cur.ax) * k), by: r3(cur.ay + (cur.by - cur.ay) * k), stops: cur.stops });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [box]);
  if (!box) return null;
  const drag = (which: "a" | "b") => ({
    onPointerDown: (e: React.PointerEvent) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); },
    onPointerMove: (e: React.PointerEvent) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      const r = canvas.current!.getBoundingClientRect();
      const x = r3(clamp((e.clientX - r.left) / r.width)), y = r3(clamp((e.clientY - r.top) / r.height));
      onChange(which === "a" ? { ...value, ax: x, ay: y, bx: g.bx, by: g.by, stops: g.stops } : { ...value, ax: g.ax, ay: g.ay, bx: x, by: y, stops: g.stops });
    },
  });
  const A = { x: g.ax * box.width, y: g.ay * box.height }, B = { x: g.bx * box.width, y: g.by * box.height };
  const radial = value.kind === "radial";
  return (
    <div ref={layer} className="ground-handles" style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
      <svg width={box.width} height={box.height} aria-hidden>
        {radial
          ? <circle cx={A.x} cy={A.y} r={Math.hypot(B.x - A.x, B.y - A.y)} className="gh-ring" />
          : null}
        <line x1={A.x} y1={A.y} x2={B.x} y2={B.y} className="gh-line" />
      </svg>
      <button className="gh-pt a" style={{ left: A.x, top: A.y, background: g.stops[0].color }} aria-label={radial ? t("Centre of the gradient") : t("Start of the gradient")}
        title={radial ? t("Centre of the gradient") : t("Start of the gradient")} {...drag("a")} />
      <button className="gh-pt b" style={{ left: B.x, top: B.y, background: g.stops[g.stops.length - 1].color }} aria-label={radial ? t("Edge of the gradient") : t("End of the gradient")}
        title={radial ? t("Edge of the gradient") : t("End of the gradient")} {...drag("b")} />
    </div>
  );
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
/** A point stays on the post or a little past its sides (a gradient that starts outside it). */
const clamp = (n: number) => Math.min(1.5, Math.max(-0.5, n));
