"use client";
import { useEffect, useRef } from "react";
import { wheelRgb, WHEEL_IDS } from "@/lib/grade";
import { useT } from "@/lib/i18n";
import type { Wheel, WheelId } from "@/lib/types";

/** The wheels, as Final Cut shows them (DaVinci's lift / gamma / gain / offset underneath, see lib/grade). */
const LABELS: Record<WheelId, string> = { offset: "Global", lift: "Shadows", gamma: "Midtones", gain: "Highlights" };
const ZERO: Wheel = { x: 0, y: 0, l: 0 };
const isZero = (w?: Wheel) => !w || (!w.x && !w.y && !w.l);

/**
 * The colour wheels of the grade, two by two: Global, Shadows / Midtones, Highlights. Each one: its disc (drag the puck:
 * the colour added there; Shift: finer; double-click: back to the centre) and its brightness bar (drag up or down,
 * double-click: back to zero). The disc shows the very colours the grade adds (same maths).
 */
export default function ColorWheels({ wheels, onChange }: { wheels: Partial<Record<WheelId, Wheel>>; onChange: (w: Partial<Record<WheelId, Wheel>>) => void }) {
  const { t } = useT();
  const set = (id: WheelId, w: Wheel) => {
    const next = { ...wheels, [id]: w };
    if (isZero(w)) delete next[id];
    onChange(next);
  };
  const any = WHEEL_IDS.some((id) => !isZero(wheels[id]));
  return (
    <div className="stack">
      <div className="cw-grid">
        {WHEEL_IDS.map((id) => <WheelPad key={id} label={t(LABELS[id])} value={wheels[id] ?? ZERO} onChange={(w) => set(id, w)} />)}
      </div>
      <div className="row">
        <span className="muted xs grow">{t("Drag a wheel's dot to add a colour, its bar for brightness. Shift: finer. Double-click: back to zero.")}</span>
        <button className="btn sm quiet" disabled={!any} onClick={() => onChange({})}>{t("Reset")}</button>
      </div>
    </div>
  );
}

function WheelPad({ label, value, onChange }: { label: string; value: Wheel; onChange: (w: Wheel) => void }) {
  const disc = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number; px: number; py: number; size: number } | null>(null);
  const barDrag = useRef<{ l: number; py: number; size: number } | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  // The disc: at each point, the colour a puck there adds (lighter towards the edge), grey at the centre.
  useEffect(() => {
    const c = disc.current;
    if (!c) return;
    const S = 120;
    c.width = c.height = S;
    const g = c.getContext("2d")!;
    const img = g.createImageData(S, S);
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const x = ((i + 0.5) / S) * 2 - 1, y = 1 - ((j + 0.5) / S) * 2, r = Math.hypot(x, y), k = (j * S + i) * 4;
      if (r > 1) continue;
      const d = wheelRgb({ x, y });
      for (let ch = 0; ch < 3; ch++) img.data[k + ch] = Math.max(0, Math.min(255, 88 + d[ch] * 68));
      img.data[k + 3] = r > 0.97 ? Math.round(255 * (1 - r) / 0.03) : 255; // a soft edge
    }
    g.putImageData(img, 0, 0);
  }, []);

  const clampDisc = (x: number, y: number) => { const r = Math.hypot(x, y); return r > 1 ? [x / r, y / r] : [x, y]; };
  const round = (v: number) => Math.round(v * 1000) / 1000;
  const fine = (e: { shiftKey: boolean }) => (e.shiftKey ? 0.15 : 0.6);

  return (
    <div className="cw">
      <span className="cw-k">{label}{!isZero(value) && <span className="cw-on" aria-hidden>•</span>}</span>
      <div className="cw-body">
        <div className="cw-disc" role="slider" tabIndex={0} aria-label={label} aria-valuetext={`${round(value.x)}, ${round(value.y)}`}
          onPointerDown={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { x: value.x, y: value.y, px: e.clientX, py: e.clientY, size: r.width / 2 };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            const k = fine(e) / d.size;
            const [x, y] = clampDisc(d.x + (e.clientX - d.px) * k, d.y - (e.clientY - d.py) * k);
            onChange({ ...valueRef.current, x: round(x), y: round(y) });
          }}
          onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
          onDoubleClick={() => onChange({ ...valueRef.current, x: 0, y: 0 })}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 0.005 : 0.02;
            const dx = e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : 0, dy = e.key === "ArrowUp" ? step : e.key === "ArrowDown" ? -step : 0;
            if (!dx && !dy) return;
            e.preventDefault();
            const [x, y] = clampDisc(value.x + dx, value.y + dy);
            onChange({ ...value, x: round(x), y: round(y) });
          }}>
          <canvas ref={disc} aria-hidden />
          <span className="cw-puck" style={{ left: `${50 + value.x * 50}%`, top: `${50 - value.y * 50}%` }} />
        </div>
        <div className="cw-bar" role="slider" tabIndex={0} aria-label={label} aria-orientation="vertical" aria-valuemin={-1} aria-valuemax={1} aria-valuenow={value.l}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            barDrag.current = { l: value.l, py: e.clientY, size: e.currentTarget.getBoundingClientRect().height };
          }}
          onPointerMove={(e) => {
            const d = barDrag.current;
            if (!d) return;
            const l = Math.max(-1, Math.min(1, d.l - ((e.clientY - d.py) / d.size) * 2 * fine(e)));
            onChange({ ...valueRef.current, l: round(l) });
          }}
          onPointerUp={() => { barDrag.current = null; }} onPointerCancel={() => { barDrag.current = null; }}
          onDoubleClick={() => onChange({ ...valueRef.current, l: 0 })}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 0.01 : 0.05;
            const d = e.key === "ArrowUp" ? step : e.key === "ArrowDown" ? -step : 0;
            if (!d) return;
            e.preventDefault();
            onChange({ ...value, l: round(Math.max(-1, Math.min(1, value.l + d))) });
          }}>
          <span className="cw-mid" aria-hidden />
          <span className="cw-knob" style={{ top: `${50 - value.l * 50}%` }} />
        </div>
      </div>
    </div>
  );
}
