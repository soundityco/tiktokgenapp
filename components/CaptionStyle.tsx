"use client";
import { useRef, useState } from "react";
import { FONT_LABELS } from "@/lib/defaults";
import { useT } from "@/lib/i18n";
import { addFont, removeFont } from "@/lib/fonts";
import type { FontId, TextStyle } from "@/lib/types";
import Icon from "./Icon";
import { Range } from "./ui";

/** Text studio of the video captions: same controls as the carousel inspector, plus loaded fonts. */
export default function CaptionStyle({
  style,
  fonts,
  onChange,
  onFonts,
  onReset,
}: {
  style: TextStyle;
  fonts: string[];
  onChange: (patch: Partial<TextStyle>) => void;
  onFonts: (names: string[]) => void;
  onReset: () => void;
}) {
  const { t } = useT();
  const [fontErr, setFontErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const value = style.customFont ? `custom:${style.customFont}` : style.font;

  const pick = (v: string) => {
    if (v.startsWith("custom:")) onChange({ customFont: v.slice(7) });
    else onChange({ font: v as FontId, customFont: undefined });
  };

  const load = async (files: FileList | null) => {
    setFontErr(null);
    let last: string | null = null;
    const names = new Set(fonts);
    for (const f of Array.from(files ?? [])) {
      try { last = await addFont(f); names.add(last); }
      catch { setFontErr(t("This file is not a usable font.")); }
    }
    onFonts([...names].sort((a, b) => a.localeCompare(b)));
    if (last) onChange({ customFont: last });
  };

  const drop = async () => {
    if (!style.customFont) return;
    const gone = style.customFont;
    await removeFont(gone);
    onFonts(fonts.filter((n) => n !== gone));
    onChange({ customFont: undefined });
  };

  return (
    <div className="stack">
      <label className="field">{t("Font")}
        <select className="input" value={value} onChange={(e) => pick(e.target.value)}>
          {Object.entries(FONT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          {fonts.length > 0 && (
            <optgroup label={t("Your fonts")}>
              {fonts.map((n) => <option key={n} value={`custom:${n}`}>{n}</option>)}
            </optgroup>
          )}
        </select>
      </label>
      <div className="row">
        <button className="btn sm" onClick={() => input.current?.click()}><Icon name="folder" size={14} />{t("Load a font")}</button>
        {style.customFont && <button className="btn sm quiet danger" onClick={() => void drop()}>{t("Remove this font")}</button>}
        <input ref={input} type="file" hidden multiple accept=".ttf,.otf,.woff,.woff2,font/*"
          onChange={(e) => { void load(e.target.files); e.target.value = ""; }} />
      </div>
      <p className="muted xs">{t("Fonts stay on this device (.ttf, .otf, .woff, .woff2).")}</p>
      {fontErr && <p className="notice bad xs">{fontErr}</p>}

      <label className="field">{t("Style")}
        <select className="input" value={style.look} onChange={(e) => onChange({ look: e.target.value as TextStyle["look"] })}>
          <option value="outline">{t("Outline")}</option><option value="box">{t("Box")}</option>
          <option value="shadow">{t("Shadow")}</option><option value="plain">{t("Plain")}</option>
        </select>
      </label>
      <Range label={t("Size")} value={style.size} min={18} max={200} onChange={(v) => onChange({ size: v })} />
      <div className="cols2">
        <label className="field">{t("Text color")}<input type="color" value={style.color} onChange={(e) => onChange({ color: e.target.value })} /></label>
        <label className="field">{style.look === "box" ? t("Box color") : t("Outline color")}<input type="color" value={style.accent} onChange={(e) => onChange({ accent: e.target.value })} /></label>
      </div>
      <div className="cols2">
        <label className="field">{t("Case")}
          <select className="input" value={style.case} onChange={(e) => onChange({ case: e.target.value as TextStyle["case"] })}>
            <option value="asis">{t("As typed")}</option><option value="upper">{t("UPPERCASE")}</option><option value="lower">{t("lowercase")}</option>
          </select>
        </label>
        <label className="field">{t("Align")}
          <select className="input" value={style.align} onChange={(e) => onChange({ align: e.target.value as TextStyle["align"] })}>
            <option value="left">{t("Left")}</option><option value="center">{t("Center")}</option><option value="right">{t("Right")}</option>
          </select>
        </label>
      </div>
      <Range label={t("Max text block width")} value={style.width} display={`${style.width}%`} min={20} max={100} onChange={(v) => onChange({ width: v })} />
      <Range label={t("Line spacing")} value={style.lineHeight} display={style.lineHeight.toFixed(2)} min={0.9} max={1.8} step={0.01} onChange={(v) => onChange({ lineHeight: v })} />
      <Range label={t("Horizontal")} value={Math.round(style.x)} display={`${Math.round(style.x)}%`} min={0} max={100} onChange={(v) => onChange({ x: v })} />
      <Range label={t("Vertical")} value={Math.round(style.y)} display={`${Math.round(style.y)}%`} min={0} max={100} onChange={(v) => onChange({ y: v })} />
      <div className="row">
        <button className="btn sm" onClick={() => onChange({ x: 50 })}>{t("Center horizontally")}</button>
        <button className="btn sm" onClick={onReset}>{t("Reset text style")}</button>
      </div>
    </div>
  );
}
