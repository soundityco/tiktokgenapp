"use client";
import { useEffect, useRef, useState } from "react";
import { FONT_LABELS } from "@/lib/defaults";
import { useT } from "@/lib/i18n";
import { addFont, removeFont } from "@/lib/fonts";
import { GOOGLE_FONTS, type GoogleFont, googleFont, loadGoogleFont, loadPreview, previewFamily } from "@/lib/googleFonts";
import { bundledFont } from "@/lib/render";
import type { FontId, StylePreset, TextStyle } from "@/lib/types";
import Icon from "./Icon";
import { Range } from "./ui";

/** One Google font of the list, written in its own font once it scrolls into view (only its name's letters load). */
function GoogleRow({ g, on, onPick }: { g: GoogleFont; on: boolean; onPick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => {
      if (es.some((x) => x.isIntersecting)) { void loadPreview(g.family).then(() => setSeen(true)); io.disconnect(); }
    }, { rootMargin: "120px" });
    io.observe(el);
    return () => io.disconnect();
  }, [g.family]);
  return (
    <button ref={ref} role="option" aria-selected={on} className={"font-opt" + (on ? " on" : "")} onClick={onPick}
      style={seen ? { fontFamily: `"${previewFamily(g.family)}", system-ui, sans-serif` } : undefined}>
      {g.family}
    </button>
  );
}

/**
 * Font picker shared by both studios: the bundled fonts, the ones loaded by the user, and Google Fonts,
 * each name written in its own font. Search at the top; the weight of a Google font below.
 */
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
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const missing = !!style.customFont && !fonts.includes(style.customFont);
  const gf = !style.customFont && style.googleFont ? googleFont(style.googleFont) : undefined;
  const label = style.customFont ?? style.googleFont ?? FONT_LABELS[style.font];
  const labelCss = style.customFont ? `"${style.customFont}"` : style.googleFont ? `"${style.googleFont}"` : bundledFont(style.font).family;

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  const choose = (patch: Partial<TextStyle>) => { onChange(patch); setOpen(false); setQ(""); };
  const pickGoogle = async (g: GoogleFont, weight?: number) => {
    const w = weight ?? (g.weights.includes(700) ? 700 : g.weights[g.weights.length - 1]);
    setBusy(g.family); setFontErr(null);
    const ok = await loadGoogleFont(g.family, w);
    setBusy(null);
    if (!ok) { setFontErr(t("This Google font could not be loaded. Check the connection.")); return; }
    if (weight === undefined) choose({ googleFont: g.family, weight: w, customFont: undefined });
    else onChange({ weight: w });
    onFonts([...fonts]); // drawn again with the font now loaded
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
    if (last) onChange({ customFont: last, googleFont: undefined });
  };

  const drop = async () => {
    if (!style.customFont) return;
    const gone = style.customFont;
    await removeFont(gone);
    onFonts(fonts.filter((n) => n !== gone));
    onChange({ customFont: undefined });
  };

  const k = q.trim().toLowerCase();
  const has = (s: string) => !k || s.toLowerCase().includes(k);
  const bundled = (Object.keys(FONT_LABELS) as FontId[]).filter((id) => has(FONT_LABELS[id]));
  const mine = fonts.filter(has);
  const google = GOOGLE_FONTS.filter((g) => has(g.family));

  return (
    <>
      <div className="field font-pick" ref={box}>
        <span>{t("Font")}</span>
        <button className="input font-current" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span style={{ fontFamily: labelCss }} className="truncate">{label}</span>
          <span className="muted xs">{busy ? t("Loading…") : "▾"}</span>
        </button>
        {open && (
          <div className="font-menu" role="listbox" aria-label={t("Font")}>
            <input className="input sm" autoFocus placeholder={t("Search a font…")} value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="font-list">
              {bundled.length > 0 && <span className="font-group">{t("Bundled")}</span>}
              {bundled.map((id) => (
                <button key={id} role="option" aria-selected={!style.customFont && !style.googleFont && style.font === id}
                  className={"font-opt" + (!style.customFont && !style.googleFont && style.font === id ? " on" : "")}
                  style={{ fontFamily: bundledFont(id).family, fontWeight: bundledFont(id).weight, fontStyle: bundledFont(id).italic ? "italic" : undefined }}
                  onClick={() => choose({ font: id, customFont: undefined, googleFont: undefined, weight: undefined })}>{FONT_LABELS[id]}</button>
              ))}
              {mine.length > 0 && <span className="font-group">{t("Your fonts")}</span>}
              {mine.map((n) => (
                <button key={n} role="option" aria-selected={style.customFont === n} className={"font-opt" + (style.customFont === n ? " on" : "")}
                  style={{ fontFamily: `"${n}"` }} onClick={() => choose({ customFont: n, googleFont: undefined })}>{n}</button>
              ))}
              {google.length > 0 && <span className="font-group">Google Fonts</span>}
              {google.map((g) => <GoogleRow key={g.family} g={g} on={!style.customFont && style.googleFont === g.family} onPick={() => void pickGoogle(g)} />)}
              {!bundled.length && !mine.length && !google.length && <p className="muted xs">{t("No font with this name.")}</p>}
            </div>
          </div>
        )}
      </div>
      {gf && gf.weights.length > 1 && (
        <div className="row" role="group" aria-label={t("Weight")}>
          <span className="label">{t("Weight")}</span>
          {gf.weights.map((w) => (
            <button key={w} className={"btn sm" + ((style.weight ?? 400) === w ? " primary" : "")} style={{ fontFamily: labelCss, fontWeight: w }}
              onClick={() => void pickGoogle(gf, w)}>{w}</button>
          ))}
        </div>
      )}
      {missing && <p className="notice warn xs">{t("This font is not loaded on this device: load the file again to see it.")}</p>}
      <div className="row">
        <button className="btn sm" onClick={() => input.current?.click()}><Icon name="folder" size={14} />{t("Load a font")}</button>
        {style.customFont && !missing && <button className="btn sm quiet danger" onClick={() => void drop()}>{t("Remove this font")}</button>}
        <input ref={input} type="file" hidden multiple accept=".ttf,.otf,.woff,.woff2,font/*"
          onChange={(e) => { void load(e.target.files); e.target.value = ""; }} />
      </div>
      <p className="muted xs">{t("Your font files stay on this device (.ttf, .otf, .woff, .woff2). Google fonts come from Google's servers.")}</p>
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
            <span className="muted xs truncate">{p.style.customFont ?? p.style.googleFont ?? FONT_LABELS[p.style.font]}</span>
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
