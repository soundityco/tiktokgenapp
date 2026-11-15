"use client";
import { useEffect, useRef, type CSSProperties } from "react";
import { wheelRgb, WHEEL_IDS } from "@/lib/grade";
import { useT } from "@/lib/i18n";
import type { Wheel, WheelId } from "@/lib/types";

/** The wheels, named as in Final Cut (DaVinci's offset / lift / gamma / gain underneath, see lib/grade). */
const LABELS: Record<WheelId, string> = { offset: "Global", lift: "Shadows", gamma: "Midtones", gain: "Highlights" };
const ZERO: Wheel = { x: 0, y: 0, l: 0 };
const isZero = (w?: Wheel) => !w || (!w.x && !w.y && !w.l);

/**
 * The colour wheels of the grade, two by two: Global, Shadows / Midtones, Highlights. Each one: its name and its
 * brightness, its disc (a dark disc, a thin ring of the hues it adds at the edge; drag the dot, Shift for finer,
 * double-click to centre it) and its brightness slider under it, filled from the middle (double-click: zero).
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
        <span className="muted xs grow">{t("Drag a wheel's dot to add a colour, its slider for brightness. Shift: finer. Double-click: back to zero.")}</span>
        <button className="btn sm quiet" disabled={!any} onClick={() => onChange({})}>{t("Reset")}</button>
      </div>
    </div>
  );
}

function WheelPad({ label, value, onChange }: { label: string; value: Wheel; onChange: (w: Wheel) => void }) {
  const { lang } = useT();
  const disc = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number; px: number; py: number; size: number } | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  // The disc: transparent over the panel, a soft tint of the colour each point adds (stronger outwards), and at the
  // edge a thin ring of those hues: the colours the grade adds, from the same maths.
  useEffect(() => {
    const c = disc.current;
    if (!c) return;
    const S = 160;
    c.width = c.height = S;
    const g = c.getContext("2d")!;
    const img = g.createImageData(S, S);
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const x = ((i + 0.5) / S) * 2 - 1, y = 1 - ((j + 0.5) / S) * 2, r = Math.hypot(x, y), k = (j * S + i) * 4;
      if (r > 1) continue;
      const d = wheelRgb({ x: x / (r || 1), y: y / (r || 1) }); // the hue of this direction, at full strength
      const ring = r > 0.88;
      for (let ch = 0; ch < 3; ch++) img.data[k + ch] = Math.max(0, Math.min(255, 128 + d[ch] * 62));
      const alpha = ring ? (r > 0.985 ? (1 - r) / 0.015 : 1) * 0.9 : 0.04 + 0.26 * Math.pow(r / 0.88, 2);
      img.data[k + 3] = Math.round(255 * alpha);
    }
    g.putImageData(img, 0, 0);
  }, []);

  const clampDisc = (x: number, y: number) => { const r = Math.hypot(x, y); return r > 0.88 ? [(x / r) * 0.88, (y / r) * 0.88] : [x, y]; };
  const round = (v: number) => Math.round(v * 1000) / 1000;
  const fine = (e: { shiftKey: boolean }) => (e.shiftKey ? 0.15 : 0.6);
  // The dot never leaves the inner disc (0.88 of the radius, inside the ring): the full strength is there.
  const toDisc = (v: number) => v * 0.88, fromDisc = (v: number) => v / 0.88;
  const px = (v: number) => `${50 + toDisc(v) * 50}%`, py = (v: number) => `${50 - toDisc(v) * 50}%`;
  const num = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2).replace(".", lang === "fr" ? "," : ".")}`;
  // The brightness slider, filled from its middle to its value.
  const lo = Math.min(50, 50 + value.l * 50), hi = Math.max(50, 50 + value.l * 50);

  return (
    <div className={"cw" + (isZero(value) ? "" : " on")}>
      <div className="cw-head" onDoubleClick={() => onChange(ZERO)} title={label}>
        <span className="cw-k">{label}</span>
        <span className="cw-v mono">{value.l ? num(value.l) : ""}</span>
      </div>
      <div className="cw-disc" role="slider" tabIndex={0} aria-label={label} aria-valuetext={`${round(value.x)}, ${round(value.y)}`}
        onPointerDown={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: toDisc(value.x), y: toDisc(value.y), px: e.clientX, py: e.clientY, size: r.width / 2 };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const k = fine(e) / d.size;
          const [x, y] = clampDisc(d.x + (e.clientX - d.px) * k, d.y - (e.clientY - d.py) * k);
          onChange({ ...valueRef.current, x: round(fromDisc(x)), y: round(fromDisc(y)) });
        }}
        onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
        onDoubleClick={() => onChange({ ...valueRef.current, x: 0, y: 0 })}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 0.005 : 0.02;
          const dx = e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : 0, dy = e.key === "ArrowUp" ? step : e.key === "ArrowDown" ? -step : 0;
          if (!dx && !dy) return;
          e.preventDefault();
          const [x, y] = clampDisc(toDisc(value.x) + dx, toDisc(value.y) + dy);
          onChange({ ...value, x: round(fromDisc(x)), y: round(fromDisc(y)) });
        }}>
        <canvas ref={disc} aria-hidden />
        {/* Where the colour goes: a thin line from the centre to the dot. */}
        <svg className="cw-vec" viewBox="0 0 100 100" aria-hidden>
          <line x1="50" y1="50" x2={50 + toDisc(value.x) * 50} y2={50 - toDisc(value.y) * 50} />
        </svg>
        <span className="cw-puck" style={{ left: px(value.x), top: py(value.y) }} />
      </div>
      <input type="range" className="cw-range" min={-1} max={1} step={0.01} value={value.l} aria-label={label}
        style={{ "--lo": `${lo}%`, "--hi": `${hi}%` } as CSSProperties}
        onChange={(e) => onChange({ ...valueRef.current, l: round(+e.target.value) })}
        onDoubleClick={() => onChange({ ...valueRef.current, l: 0 })} />
    </div>
  );
}
