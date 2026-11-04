"use client";
import { useRef, useState } from "react";
import { FONT_LABELS } from "@/lib/defaults";
import { useT } from "@/lib/i18n";
import { addFont, removeFont } from "@/lib/fonts";
import type { FontId, StylePreset, TextStyle } from "@/lib/types";
import Icon from "./Icon";
import { Range } from "./ui";

/** Font select with the bundled fonts and the ones loaded by the user (shared by both studios). */
export function FontPicker({
  style, fonts, onChange, onFonts,
}: {
  style: TextStyle;
  fonts: string[];
  onChange: (patch: Partial<TextStyle>) => void;
  onFonts: (names: string[]) => void;
}) {
  const { t } = useT();
  const [fontErr, setFontErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const value = style.customFont ? `custom:${style.customFont}` : style.font;
  const missing = !!style.customFont && !fonts.includes(style.customFont);

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
    <>
      <label className="field">{t("Font")}
        <select className="input" value={value} onChange={(e) => pick(e.target.value)}>
          {Object.entries(FONT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          {(fonts.length > 0 || missing) && (
            <optgroup label={t("Your fonts")}>
              {fonts.map((n) => <option key={n} value={`custom:${n}`}>{n}</option>)}
              {missing && <option value={value}>{style.customFont}</option>}
            </optgroup>
          )}
        </select>
      </label>
      {missing && <p className="notice warn xs">{t("This font is not loaded on this device: load the file again to see it.")}</p>}
      <div className="row">
        <button className="btn sm" onClick={() => input.current?.click()}><Icon name="folder" size={14} />{t("Load a font")}</button>
        {style.customFont && !missing && <button className="btn sm quiet danger" onClick={() => void drop()}>{t("Remove this font")}</button>}
        <input ref={input} type="file" hidden multiple accept=".ttf,.otf,.woff,.woff2,font/*"
          onChange={(e) => { void load(e.target.files); e.target.value = ""; }} />
      </div>
      <p className="muted xs">{t("Fonts stay on this device (.ttf, .otf, .woff, .woff2).")}</p>
      {fontErr && <p className="notice bad xs">{fontErr}</p>}
    </>
  );
}

/** Saved text styles (look + font), the same list in the carousel and the video studio. */
export function StylePresets({
  presets, onSave, onApply, onDelete,
}: {
  presets: StylePreset[];
  onSave: (name: string) => void;
  onApply: (p: StylePreset) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useT();
  const [name, setName] = useState("");
  const save = () => {
    const n = name.trim();
    if (!n) return;
    onSave(n);
    setName("");
  };
  return (
    <div className="stack">
      <form className="row nowrap" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <input className="input grow" value={name} onChange={(e) => setName(e.target.value)}
          placeholder={t("Preset name")} aria-label={t("Preset name")} maxLength={60} />
        <button className="btn sm" type="submit" disabled={!name.trim()}>{t("Save current style")}</button>
      </form>
      {!presets.length && <span className="muted xs">{t("No presets yet.")}</span>}
      {presets.map((p) => (
        <div className="row nowrap" key={p.id}>
          <button className="btn sm grow" onClick={() => onApply(p)} title={t("Apply")}>
            <span className="truncate">{p.name}</span>
            <span className="muted xs truncate">{p.style.customFont ?? FONT_LABELS[p.style.font]}</span>
          </button>
          <button className="btn sm quiet icon" aria-label={t("Delete preset")} title={t("Delete preset")} onClick={() => onDelete(p.id)}>
            <Icon name="trash" size={13} />
          </button>
        </div>
      ))}
      <p className="muted xs">{t("A preset keeps the look and the font, not the position of the text.")}</p>
    </div>
  );
}

/** Apply a preset on a style without moving the text. */
/** Settings of the chosen look: outline thickness, or the padding of the box. */
export function LookExtras({ style, onChange }: { style: TextStyle; onChange: (patch: Partial<TextStyle>) => void }) {
  const { t } = useT();
  if (style.look === "outline") {
    const v = style.stroke ?? 20;
    return <Range label={t("Outline thickness")} value={v} display={`${v}%`} min={0} max={50} onChange={(n) => onChange({ stroke: n })} onReset={() => onChange({ stroke: undefined })} />;
  }
  if (style.look !== "box") return null;
  const x = style.padX ?? 30, y = style.padY ?? 0;
  return (
    <div className="cols2">
      <Range label={t("Box padding, sides")} value={x} display={`${x}%`} min={0} max={120} onChange={(n) => onChange({ padX: n })} onReset={() => onChange({ padX: undefined })} />
      <Range label={t("Box padding, height")} value={y} display={`${y}%`} min={0} max={60} onChange={(n) => onChange({ padY: n })} onReset={() => onChange({ padY: undefined })} />
    </div>
  );
}

/** The case options, shared by the carousel and the video. */
export function CaseOptions() {
  const { t } = useT();
  return (
    <>
      <option value="asis">{t("As typed")}</option><option value="upper">{t("UPPERCASE")}</option>
      <option value="lower">{t("lowercase")}</option><option value="sentence">{t("First letter capital")}</option>
    </>
  );
}

export const withPreset = (cur: TextStyle, p: StylePreset): TextStyle => ({ ...p.style, x: cur.x, y: cur.y });
