"use client";
import { useEffect, useRef, useState } from "react";
import { FONT_LABELS } from "@/lib/defaults";
import { useT } from "@/lib/i18n";
import { addFont, canvasFamily, DuplicateFont, facesOf, removeFont } from "@/lib/fonts";
import { type FaceInfo, groupFamilies, STRETCH_LABEL } from "@/lib/fontInfo";
import { GOOGLE_FONTS, type GoogleFont, googleFont, hasItalic, loadGoogleFont, loadPreview, previewFamily } from "@/lib/googleFonts";
import { bundledFont, parseHex } from "@/lib/render";
import type { FontId, StylePreset, TextStyle } from "@/lib/types";
import Icon from "./Icon";
import { Range } from "./ui";

/** One Google font of the list, written in its own font once it scrolls into view (only its name's letters load). */
function GoogleRow({ g, on, onPick, onHover }: { g: GoogleFont; on: boolean; onPick: () => void; onHover: () => void }) {
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
    <button ref={ref} role="option" aria-selected={on} className={"font-opt" + (on ? " on" : "")} onClick={onPick} onMouseEnter={onHover} onFocus={onHover}
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
  style, fonts, onChange, onFonts, onPreview,
}: {
  style: TextStyle;
  fonts: string[];
  onChange: (patch: Partial<TextStyle>) => void;
  onFonts: (names: string[]) => void;
  /** Font under the pointer in the list, shown on the post at once; null: back to the chosen one. */
  onPreview?: (patch: Partial<TextStyle> | null) => void;
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
  // Italic of the chosen Google font: asked to Google once per family.
  const [italicOk, setItalicOk] = useState(false);
  useEffect(() => {
    setItalicOk(false);
    if (!gf) return;
    let off = false;
    void hasItalic(gf.family).then((v) => { if (!off) setItalicOk(v); });
    return () => { off = true; };
  }, [gf?.family]); // eslint-disable-line react-hooks/exhaustive-deps
  // The styles a loaded family has: the files of its weights, italics and widths.
  const own = style.customFont && !missing ? facesOf(style.customFont) : [];
  const ownWeights = [...new Set(own.map((f) => f.weight))].sort((a, b) => a - b);
  const ownWidths = [...new Set(own.map((f) => f.stretch))];
  const weights = gf ? gf.weights : ownWeights.length ? ownWeights : [style.weight ?? 400];
  const canItalic = gf ? italicOk : own.some((f) => f.italic);
  const canWeight = weights.length > 1;
  const styleOff = !canWeight && !canItalic && ownWidths.length < 2;
  const faceLabel = (f: FaceInfo) => [weightName(f.weight), f.italic ? t("Italic") : "", f.stretch !== "normal" ? t(STRETCH_LABEL[f.stretch] ?? f.stretch) : ""].filter(Boolean).join(" ");
  /** A face as a text style; the regular face of a family when none is given. */
  const faceStyle = (f: FaceInfo): Partial<TextStyle> => ({ customFont: f.family, googleFont: undefined, weight: f.weight, italic: f.italic || undefined, stretch: f.stretch === "normal" ? undefined : f.stretch });
  const regularOf = (family: string) => {
    const all = facesOf(family);
    return [...all].sort((a, b) => Number(a.italic) - Number(b.italic) || Number(a.stretch !== "normal") - Number(b.stretch !== "normal") || Math.abs(a.weight - 400) - Math.abs(b.weight - 400))[0];
  };
  const weightName = (w: number) => ({ 100: t("Thin"), 200: t("Extra light"), 300: t("Light"), 400: t("Regular"), 500: t("Medium"), 600: t("Semibold"), 700: t("Bold"), 800: t("Extra bold"), 900: t("Black") } as Record<number, string>)[w] ?? String(w);

  // ---- hover preview on the post ----
  const hoverTimer = useRef(0);
  const hovered = useRef<string | null>(null);
  const preview = (key: string, patch: Partial<TextStyle> | (() => Promise<Partial<TextStyle> | null>)) => {
    if (!onPreview) return;
    hovered.current = key;
    clearTimeout(hoverTimer.current);
    // A short wait: scrolling through the list does not load every font it passes.
    hoverTimer.current = window.setTimeout(async () => {
      const p = typeof patch === "function" ? await patch() : patch;
      if (p && hovered.current === key) onPreview(p);
    }, 120);
  };
  const endPreview = () => { clearTimeout(hoverTimer.current); hovered.current = null; onPreview?.(null); };
  const hoverGoogle = (g: GoogleFont) => preview(`g:${g.family}`, async () => {
    const w = g.weights.includes(700) ? 700 : g.weights[g.weights.length - 1];
    return (await loadGoogleFont(g.family, w)) ? { googleFont: g.family, weight: w, customFont: undefined } : null;
  });
  useEffect(() => { if (!open) endPreview(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  // Leaving the panel (another tab) while a font is under the pointer: the post gets its own font back.
  const previewRef = useRef(onPreview);
  previewRef.current = onPreview;
  useEffect(() => () => { clearTimeout(hoverTimer.current); if (hovered.current) previewRef.current?.(null); }, []);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  const choose = (patch: Partial<TextStyle>) => { endPreview(); onChange(patch); setOpen(false); setQ(""); };
  const pickGoogle = async (g: GoogleFont, weight?: number, italic?: boolean) => {
    const w = weight ?? (g.weights.includes(700) ? 700 : g.weights[g.weights.length - 1]);
    const it = weight === undefined ? false : italic ?? !!style.italic;
    setBusy(g.family); setFontErr(null);
    const ok = await loadGoogleFont(g.family, w, it);
    setBusy(null);
    if (!ok) { setFontErr(t("This Google font could not be loaded. Check the connection.")); return; }
    if (weight === undefined) choose({ googleFont: g.family, weight: w, italic: undefined, customFont: undefined });
    else onChange({ weight: w, italic: it || undefined });
    onFonts([...fonts]); // drawn again with the font now loaded
  };

  const load = async (files: FileList | null) => {
    setFontErr(null);
    let last: FaceInfo | null = null;
    const names = new Set(fonts);
    const dup: string[] = [], bad: string[] = [];
    for (const f of Array.from(files ?? [])) {
      try { last = await addFont(f); names.add(last.family); }
      catch (e) {
        if (e instanceof DuplicateFont) dup.push(`${e.face.family} ${faceLabel(e.face)}`);
        else bad.push(f.name);
      }
    }
    // One sentence per kind, not one per file.
    const msgs = [
      dup.length ? t("Already loaded ({n}): {names}.", { n: dup.length, names: dup.join(", ") }) : "",
      bad.length ? t("Not readable as a font (damaged, or an old Mac format browsers refuse): {files}.", { files: bad.join(", ") }) : "",
    ].filter(Boolean);
    if (msgs.length) setFontErr(msgs.join(" "));
    onFonts([...names].sort((a, b) => a.localeCompare(b)));
    if (last) onChange(faceStyle(last));
  };

  const drop = async () => {
    if (!style.customFont) return;
    // The whole font: its family and its variants (compressed, rounded…).
    const gone = group ? group.variants.map((v) => v.family) : [style.customFont];
    for (const g of gone) await removeFont(g);
    onFonts(fonts.filter((n) => !gone.includes(n)));
    onChange({ customFont: undefined, weight: undefined, italic: undefined, stretch: undefined });
  };

  const k = q.trim().toLowerCase();
  const has = (s: string) => !k || s.toLowerCase().includes(k);
  const bundled = (Object.keys(FONT_LABELS) as FontId[]).filter((id) => has(FONT_LABELS[id]));
  // Loaded families as fonts: "Helvetica Compressed" and "Helvetica Rounded" go under Helvetica.
  const groups = groupFamilies(fonts);
  const mine = groups.filter((g) => g.variants.some((v) => has(v.family)));
  const group = style.customFont ? groups.find((g) => g.variants.some((v) => v.family === style.customFont)) : undefined;
  const google = GOOGLE_FONTS.filter((g) => has(g.family));

  return (
    <>
      <div className="field font-pick" ref={box}>
        <span>{t("Font")}</span>
        <button className="input font-current" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span style={{ fontFamily: labelCss }} className="truncate">{label}</span>
          <span className={"muted xs" + (busy ? " shine" : "")}>{busy ? t("Loading…") : "▾"}</span>
        </button>
        {open && (
          <div className="font-menu" role="listbox" aria-label={t("Font")}>
            <input className="input sm" autoFocus placeholder={t("Search a font…")} value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="font-list" onMouseLeave={endPreview}>
              {bundled.length > 0 && <span className="font-group">{t("Bundled")}</span>}
              {bundled.map((id) => (
                <button key={id} role="option" aria-selected={!style.customFont && !style.googleFont && style.font === id}
                  className={"font-opt" + (!style.customFont && !style.googleFont && style.font === id ? " on" : "")}
                  style={{ fontFamily: bundledFont(id).family, fontWeight: bundledFont(id).weight, fontStyle: bundledFont(id).italic ? "italic" : undefined }}
                  onMouseEnter={() => preview(`b:${id}`, { font: id, customFont: undefined, googleFont: undefined, weight: undefined })}
                  onClick={() => choose({ font: id, customFont: undefined, googleFont: undefined, weight: undefined })}>{FONT_LABELS[id]}</button>
              ))}
              {mine.length > 0 && <span className="font-group">{t("Your fonts")}</span>}
              {mine.map(({ family: n, variants }) => {
                const on = !!style.customFont && variants.some((v) => v.family === style.customFont);
                const count = variants.reduce((k, v) => k + facesOf(v.family).length, 0);
                return (
                  <button key={n} role="option" aria-selected={on} className={"font-opt" + (on ? " on" : "")}
                    style={{ fontFamily: `"${n}"` }} onMouseEnter={() => preview(`c:${n}`, regularOf(n) ? faceStyle(regularOf(n)) : { customFont: n, googleFont: undefined })}
                    onClick={() => choose(regularOf(n) ? faceStyle(regularOf(n)) : { customFont: n, googleFont: undefined })}>
                    {n}{count > 1 && <span className="muted xs" style={{ fontFamily: "var(--sans)" }}> · {t("{n} styles", { n: count })}</span>}
                  </button>
                );
              })}
              {google.length > 0 && <span className="font-group">Google Fonts</span>}
              {google.map((g) => <GoogleRow key={g.family} g={g} on={!style.customFont && style.googleFont === g.family} onPick={() => void pickGoogle(g)} onHover={() => hoverGoogle(g)} />)}
              {!bundled.length && !mine.length && !google.length && <p className="muted xs">{t("No font with this name.")}</p>}
            </div>
          </div>
        )}
      </div>
      {group && group.variants.length > 1 && (
        <div className="row font-style" role="group" aria-label={t("Variant")}>
          <span className="label">{t("Variant")}</span>
          {group.variants.map((v) => (
            <button key={v.family} className={"btn sm" + (style.customFont === v.family ? " on" : "")} style={{ fontFamily: `"${v.family}"` }}
              onClick={() => { const r = regularOf(v.family); onChange(r ? faceStyle(r) : { customFont: v.family }); }}>{v.label || t("Standard")}</button>
          ))}
        </div>
      )}
      <div className={"row font-style" + (styleOff ? " off" : "")} role="group" aria-label={t("Font style")}
        title={styleOff ? t("This font has a single style.") : undefined}>
        <span className="label">{t("Style")}</span>
        {weights.map((w) => (
          <button key={w} className={"btn sm" + (canWeight && (style.weight ?? 400) === w ? " on" : "")} disabled={!canWeight}
            style={{ fontFamily: labelCss, fontWeight: w, fontStyle: style.italic ? "italic" : undefined }} title={weightName(w)}
            onClick={() => (gf ? void pickGoogle(gf, w) : onChange({ weight: w }))}>{weightName(w)}</button>
        ))}
        <button className={"btn sm" + (style.italic ? " on" : "")} aria-pressed={!!style.italic} disabled={!canItalic}
          style={{ fontFamily: labelCss, fontStyle: "italic" }} title={(gf || own.length) && !canItalic ? t("No italic for this font.") : undefined}
          onClick={() => (gf ? void pickGoogle(gf, style.weight ?? 400, !style.italic) : onChange({ italic: !style.italic || undefined }))}>{t("Italic")}</button>
        {ownWidths.length > 1 && ownWidths.map((w) => (
          <button key={w} className={"btn sm" + ((style.stretch ?? "normal") === w ? " on" : "")}
            style={{ fontFamily: `"${canvasFamily(style.customFont ?? "", w)}"` }} onClick={() => onChange({ stretch: w === "normal" ? undefined : w })}>{t(STRETCH_LABEL[w] ?? w)}</button>
        ))}
      </div>
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
/** Same look (font, colours, effects, sizes…), wherever the text is placed: a preset does not keep the position. */
export function sameLook(a: TextStyle, b: TextStyle): boolean {
  const norm = (st: TextStyle) => JSON.stringify(Object.entries(st).filter(([k, v]) => k !== "x" && k !== "y" && v !== undefined).sort(([x], [y]) => x.localeCompare(y)));
  return norm(a) === norm(b);
}
/** The preset this style is exactly, if any. */
export const presetOf = (presets: StylePreset[], st: TextStyle) => presets.find((p) => sameLook(p.style, st));

export function StylePresets({
  presets, onSave, onApply, onDelete, current,
}: {
  /** The style being edited: its preset shows as chosen. */
  current?: TextStyle;
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
      {presets.map((p) => {
        const on = !!current && sameLook(p.style, current);
        return (
        <div className="row nowrap" key={p.id}>
          <button className={"btn sm grow preset" + (on ? " on" : "")} onClick={() => onApply(p)} title={on ? t("This is the style now") : t("Apply")} aria-pressed={on}>
            {on && <Icon name="check" size={13} />}
            <span className="truncate">{p.name}</span>
            <span className="muted xs truncate">{p.style.customFont ?? p.style.googleFont ?? FONT_LABELS[p.style.font]}</span>
          </button>
          <button className="btn sm quiet icon" aria-label={t("Delete preset")} title={t("Delete preset")} onClick={() => onDelete(p.id)}>
            <Icon name="trash" size={13} />
          </button>
        </div>
        );
      })}
      <p className="muted xs">{t("A preset keeps the look and the font, not the position of the text.")}</p>
    </div>
  );
}

/** Apply a preset on a style without moving the text. */
/** Settings of the chosen look: outline thickness, or the padding of the box. */
/** A colour: the swatch to pick it, and its hex code to type or paste (#e11d48, e11d48, #fff). */
export function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (hex: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const ok = parseHex(text) !== null;
  return (
    <label className="field color-field">
      <span>{label}</span>
      <span className="row">
        <input type="color" value={parseHex(value) ?? "#ffffff"} onChange={(e) => onChange(e.target.value)} aria-label={label} />
        <input className={"input sm mono" + (ok ? "" : " bad")} value={text} spellCheck={false} maxLength={7} aria-label={`${label} (hex)`}
          onChange={(e) => { setText(e.target.value); const h = parseHex(e.target.value); if (h) onChange(h); }}
          onBlur={() => setText(value)} />
      </span>
    </label>
  );
}

/** The two colours of a text: the letters, and the outline / box / shadow. */
export function TextColors({ style, onChange }: { style: TextStyle; onChange: (patch: Partial<TextStyle>) => void }) {
  const { t } = useT();
  const second = style.look === "box" ? t("Box color") : style.look === "shadow" ? t("Shadow color") : t("Outline color");
  return (
    <div className="cols2">
      <ColorField label={t("Text color")} value={style.color} onChange={(color) => onChange({ color })} />
      {style.look !== "plain" && <ColorField label={second} value={style.accent} onChange={(accent) => onChange({ accent })} />}
    </div>
  );
}

export function LookExtras({ style, onChange }: { style: TextStyle; onChange: (patch: Partial<TextStyle>) => void }) {
  const { t } = useT();
  if (style.look === "shadow") {
    const b = style.shadowBlur ?? 35, x = style.shadowX ?? 0, y = style.shadowY ?? 5, o = style.shadowOpacity ?? 100;
    return (
      <div className="cols2">
        <Range label={t("Shadow blur")} value={b} display={`${b}%`} min={0} max={100} onChange={(n) => onChange({ shadowBlur: n })} onReset={() => onChange({ shadowBlur: undefined })} />
        <Range label={t("Shadow opacity")} value={o} display={`${o}%`} min={0} max={100} onChange={(n) => onChange({ shadowOpacity: n })} onReset={() => onChange({ shadowOpacity: undefined })} />
        <Range label={t("Shadow offset, sideways")} value={x} display={`${x}%`} min={-30} max={30} onChange={(n) => onChange({ shadowX: n })} onReset={() => onChange({ shadowX: undefined })} />
        <Range label={t("Shadow offset, down")} value={y} display={`${y}%`} min={-30} max={30} onChange={(n) => onChange({ shadowY: n })} onReset={() => onChange({ shadowY: undefined })} />
      </div>
    );
  }
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
