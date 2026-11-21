"use client";
import type { FxClip } from "@/lib/types";
import { useT } from "@/lib/i18n";
import { ColorField } from "./TextControls";
import Icon from "./Icon";
import { Range, Switch } from "./ui";

/**
 * The settings of an effect clip (the Effects track, lib/fx.ts), in the right column when it is picked: over the texts or
 * not, and each of its effects switched on and set — flash (colour, flashes, how long each shows), zoom blur (strength,
 * centre), slow shutter (frame rate, trail).
 */
export default function FxPanel({ value, onChange, onDelete }: { value: FxClip; onChange: (patch: Partial<FxClip>) => void; onDelete: () => void }) {
  const { t } = useT();
  const s = value.strobe, z = value.zoom, sh = value.shutter;
  const time = (x: number) => `${Math.floor(x / 60)}:${(x % 60).toFixed(1).padStart(4, "0")}`;
  return (
    <div className="fx-panel">
      <div className="look-of fx-of">
        <Icon name="sliders" size={13} />
        <span className="xs muted">{t("Settings of")}</span> <b>{t("Effect")}</b>
        <span className="take-name mono">{time(value.from)} → {time(value.to)}</span>
      </div>
      <div className="row fx-line">
        <span className="label">{t("Over the texts too")}</span>
        <Switch checked={!!value.over} onChange={(over) => onChange({ over: over || undefined })} title={t("On: the effect covers the lyrics and the hook too (a flash over everything). Off: only the picture under them.")} />
      </div>

      <div className={"fx-part" + (s ? " on" : "")}>
        <div className="row fx-line"><b>{t("Flash (strobe)")}</b>
          <Switch checked={!!s} onChange={(on) => onChange({ strobe: on ? { color: "#000000", count: 6, on: 0.5 } : undefined })} /></div>
        {s && <>
          <ColorField label={t("Colour")} value={s.color} onChange={(color) => onChange({ strobe: { ...s, color } })} />
          <Range label={t("Flashes")} value={s.count} display={String(s.count)} min={1} max={30} step={1}
            onChange={(count) => onChange({ strobe: { ...s, count: Math.round(count) } })} onReset={() => onChange({ strobe: { ...s, count: 6 } })} />
          <Range label={t("Colour shown")} value={s.on} display={`${Math.round(s.on * 100)} %`} min={0.1} max={0.9} step={0.05}
            onChange={(on) => onChange({ strobe: { ...s, on } })} onReset={() => onChange({ strobe: { ...s, on: 0.5 } })} />
        </>}
      </div>

      <div className={"fx-part" + (z ? " on" : "")}>
        <div className="row fx-line"><b>{t("Zoom blur")}</b>
          <Switch checked={!!z} onChange={(on) => onChange({ zoom: on ? { amount: 0.5, x: 0.5, y: 0.5 } : undefined })} /></div>
        {z && <>
          <Range label={t("Strength")} value={z.amount} display={`${Math.round(z.amount * 100)} %`} min={0} max={1} step={0.01}
            onChange={(amount) => onChange({ zoom: { ...z, amount } })} onReset={() => onChange({ zoom: { ...z, amount: 0.5 } })} />
          <Range label={t("Centre, across")} value={z.x} display={`${Math.round(z.x * 100)} %`} min={0} max={1} step={0.01}
            onChange={(x) => onChange({ zoom: { ...z, x } })} onReset={() => onChange({ zoom: { ...z, x: 0.5 } })} />
          <Range label={t("Centre, up and down")} value={z.y} display={`${Math.round(z.y * 100)} %`} min={0} max={1} step={0.01}
            onChange={(y) => onChange({ zoom: { ...z, y } })} onReset={() => onChange({ zoom: { ...z, y: 0.5 } })} />
        </>}
      </div>

      <div className={"fx-part" + (sh ? " on" : "")}>
        <div className="row fx-line"><b>{t("Slow shutter")}</b>
          <Switch checked={!!sh} onChange={(on) => onChange({ shutter: on ? { fps: 8, trail: 0.6 } : undefined })} /></div>
        {sh && <>
          <Range label={t("Frames a second")} value={sh.fps} display={sh.fps ? String(Math.round(sh.fps)) : t("Off")} min={0} max={24} step={1}
            onChange={(fps) => onChange({ shutter: { ...sh, fps: Math.round(fps) } })} onReset={() => onChange({ shutter: { ...sh, fps: 8 } })} />
          <Range label={t("Trail")} value={sh.trail} display={`${Math.round(sh.trail * 100)} %`} min={0} max={0.9} step={0.05}
            onChange={(trail) => onChange({ shutter: { ...sh, trail } })} onReset={() => onChange({ shutter: { ...sh, trail: 0.6 } })} />
          <p className="muted xs">{t("Fewer frames a second: the picture stutters. Trail: each frame stays a moment over the next ones (a blur of a slow shutter). Exact in the export; on the preview, while playing.")}</p>
        </>}
      </div>

      <button className="btn sm quiet danger fx-del" onClick={onDelete}><Icon name="trash" size={14} />{t("Delete this effect")}</button>
    </div>
  );
}
