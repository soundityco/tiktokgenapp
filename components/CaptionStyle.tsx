"use client";
import { useT } from "@/lib/i18n";
import { defaultStyle } from "@/lib/defaults";
import type { TextStyle } from "@/lib/types";
import { CaseOptions, FontPicker, LookExtras, TextColors } from "./TextControls";
import { Range } from "./ui";

/** Text studio of the video captions: same controls as the carousel inspector, plus loaded fonts. */
export default function CaptionStyle({
  style,
  fonts,
  onChange,
  onFonts,
  onReset,
  onPreview,
  defaults = defaultStyle(),
}: {
  /** Font under the pointer in the font list, shown on the video at once. */
  onPreview?: (patch: Partial<TextStyle> | null) => void;
  style: TextStyle;
  /** Values a double-click on a slider goes back to. */
  defaults?: TextStyle;
  fonts: string[];
  onChange: (patch: Partial<TextStyle>) => void;
  onFonts: (names: string[]) => void;
  onReset: () => void;
}) {
  const { t } = useT();
  return (
    <div className="stack">
      <FontPicker style={style} fonts={fonts} onChange={onChange} onFonts={onFonts} onPreview={onPreview} />

      <label className="field">{t("Style")}
        <select className="input" value={style.look} onChange={(e) => onChange({ look: e.target.value as TextStyle["look"] })}>
          <option value="outline">{t("Outline")}</option><option value="box">{t("Box")}</option>
          <option value="shadow">{t("Shadow")}</option><option value="plain">{t("Plain")}</option>
        </select>
      </label>
      <Range label={t("Size")} value={style.size} min={18} max={200} onChange={(v) => onChange({ size: v })} onReset={() => onChange({ size: defaults.size })} />
      <TextColors style={style} onChange={onChange} />
      <LookExtras style={style} onChange={onChange} />
      <div className="cols2">
        <label className="field">{t("Case")}
          <select className="input" value={style.case} onChange={(e) => onChange({ case: e.target.value as TextStyle["case"] })}>
            <CaseOptions />
          </select>
        </label>
        <label className="field">{t("Align")}
          <select className="input" value={style.align} onChange={(e) => onChange({ align: e.target.value as TextStyle["align"] })}>
            <option value="left">{t("Left")}</option><option value="center">{t("Center")}</option><option value="right">{t("Right")}</option>
          </select>
        </label>
      </div>
      <Range label={t("Max text block width")} value={style.width} display={`${style.width}%`} min={20} max={100} onChange={(v) => onChange({ width: v })} onReset={() => onChange({ width: defaults.width })} />
      <Range label={t("Line spacing")} value={style.lineHeight} display={style.lineHeight.toFixed(2)} min={0.9} max={1.8} step={0.01} onChange={(v) => onChange({ lineHeight: v })} onReset={() => onChange({ lineHeight: defaults.lineHeight })} />
      <Range label={t("Horizontal")} value={Math.round(style.x)} display={`${Math.round(style.x)}%`} min={0} max={100} onChange={(v) => onChange({ x: v })} />
      <Range label={t("Vertical")} value={Math.round(style.y)} display={`${Math.round(style.y)}%`} min={0} max={100} onChange={(v) => onChange({ y: v })} />
      <div className="row">
        <button className="btn sm" onClick={() => onChange({ x: 50 })}>{t("Center horizontally")}</button>
        <button className="btn sm" onClick={onReset}>{t("Reset text style")}</button>
      </div>
    </div>
  );
}
