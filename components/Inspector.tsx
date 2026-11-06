"use client";
import { defaultPic, defaultStyle } from "@/lib/defaults";
import { useT } from "@/lib/i18n";
import { zoomPic } from "@/lib/render";
import type { FormatId, LyricSection, PicSettings, SlideCfg, StylePreset, TextStyle } from "@/lib/types";
import { CaseOptions, FontPicker, LookExtras, presetOf, StylePresets, TextColors } from "./TextControls";
import { Range, Section } from "./ui";

interface Props {
  index: number;
  cfg: SlideCfg;
  zones: boolean;
  onZones: (v: boolean) => void;
  onCfg: (fn: (c: SlideCfg) => SlideCfg) => void;
  onApplyAll: () => void;
  lyrics: LyricSection[];
  presets: StylePreset[];
  onSavePreset: (name: string) => void;
  onApplyPreset: (p: StylePreset) => void;
  onDeletePreset: (id: string) => void;
  fonts: string[];
  onFonts: (names: string[]) => void;
  /** Font under the pointer in the font list, shown on the slide at once. */
  onPreview?: (patch: Partial<TextStyle> | null) => void;
}

export default function Inspector({
  index, cfg, zones, onZones, onCfg, onApplyAll,
  lyrics, presets, onSavePreset, onApplyPreset, onDeletePreset, fonts, onFonts, onPreview,
}: Props) {
  const { t } = useT();
  const st = cfg.style, pic = cfg.pic;
  const setS = (patch: Partial<TextStyle>) => onCfg((c) => ({ ...c, style: { ...c.style, ...patch } }));
  const setP = (patch: Partial<PicSettings>) => onCfg((c) => ({ ...c, pic: { ...c.pic, ...patch } }));
  return (
    <div className="stack">
      {cfg.locked && <p className="notice warn xs">{t("This slide is locked: Generate and re-rolls won't change it.")}</p>}
      <div className="insp-title">
        <h2>{t("Slide {n}", { n: index + 1 })}</h2>
        <button className="btn sm" onClick={onApplyAll} title={t("Copy format, photo and text settings to every slide")}>{t("Apply to all slides")}</button>
      </div>

      <div>
        <Section id="slide-presets" title={<>{t("Style presets")}{presetOf(presets, st) && <span className="sec-sub"> · {presetOf(presets, st)!.name}</span>}</>} open={false}>
          <StylePresets presets={presets} current={st} onSave={onSavePreset} onApply={onApplyPreset} onDelete={onDeletePreset} />
        </Section>

        <Section id="slide-format" title={t("Format & photo")}>
          <label className="field">{t("Format")}
            <select className="input" value={cfg.format} onChange={(e) => onCfg((c) => ({ ...c, format: e.target.value as FormatId }))}>
              <option value="9:16">9:16 · 1080×1920</option>
              <option value="3:4">3:4 · 1080×1440</option>
              <option value="4:5">4:5 · 1080×1350</option>
              <option value="1:1">1:1 · 1080×1080</option>
              <option value="orig">{t("Original shape")}</option>
            </select>
          </label>
          <label className="field">{t("Framing")}
            <select className="input" value={pic.framing === "fill" ? "fill" : pic.bars === "blur" ? "fit-blur" : "fit-black"}
              onChange={(e) => {
                const v = e.target.value;
                setP(v === "fill" ? { framing: "fill" } : { framing: "fit", bars: v === "fit-blur" ? "blur" : "black" });
              }}>
              <option value="fill">{t("Fill (crop)")}</option>
              <option value="fit-blur">{t("Fit whole, blurred bars")}</option>
              <option value="fit-black">{t("Fit whole, black bars")}</option>
            </select>
          </label>
          <Range label={t("Zoom")} value={pic.zoom} display={`${pic.zoom.toFixed(2)}×`} min={0.5} max={4} step={0.05} onChange={(v) => onCfg((c) => ({ ...c, pic: zoomPic(c.pic, v) }))}
            onReset={() => setP({ zoom: 1, ox: 0, oy: 0 })} />
          <Range label={t("Darken")} value={pic.darken} display={`${pic.darken}%`} min={0} max={80} onChange={(v) => setP({ darken: v })} onReset={() => setP({ darken: defaultPic().darken })} />
          <div><button className="btn sm" onClick={() => onCfg((c) => ({ ...c, pic: { ...defaultPic(), framing: c.pic.framing, bars: c.pic.bars, darken: c.pic.darken } }))}>{t("Reset framing")}</button></div>
        </Section>

        <Section id="slide-text" title={t("Text")}>
          <FontPicker style={st} fonts={fonts} onChange={setS} onFonts={onFonts} onPreview={onPreview} />
          <label className="field">{t("Style")}
            <select className="input" value={st.look} onChange={(e) => setS({ look: e.target.value as TextStyle["look"] })}>
              <option value="outline">{t("Outline")}</option><option value="box">{t("Box")}</option><option value="shadow">{t("Shadow")}</option><option value="plain">{t("Plain")}</option>
            </select>
          </label>
          <Range label={t("Size")} value={st.size} min={18} max={200} onChange={(v) => setS({ size: v })} onReset={() => setS({ size: defaultStyle().size })} />
          <TextColors style={st} onChange={setS} />
          <LookExtras style={st} onChange={setS} />
          <div className="cols2">
            <label className="field">{t("Case")}
              <select className="input" value={st.case} onChange={(e) => setS({ case: e.target.value as TextStyle["case"] })}>
                <CaseOptions />
              </select>
            </label>
            <label className="field">{t("Align")}
              <select className="input" value={st.align} onChange={(e) => setS({ align: e.target.value as TextStyle["align"] })}>
                <option value="left">{t("Left")}</option><option value="center">{t("Center")}</option><option value="right">{t("Right")}</option>
              </select>
            </label>
          </div>
          <Range label={t("Width")} value={st.width} display={`${st.width}%`} min={20} max={100} onChange={(v) => setS({ width: v })} onReset={() => setS({ width: defaultStyle().width })} />
          <Range label={t("Letter spacing")} value={st.tracking ?? 0} display={`${st.tracking ?? 0}%`} min={-10} max={50}
            onChange={(v) => setS({ tracking: v || undefined })} onReset={() => setS({ tracking: undefined })} />
          <Range label={t("Line spacing")} value={st.lineHeight} display={st.lineHeight.toFixed(2)} min={0.9} max={1.8} step={0.01} onChange={(v) => setS({ lineHeight: v })} onReset={() => setS({ lineHeight: defaultStyle().lineHeight })} />
          <div><button className="btn sm" onClick={() => onCfg((c) => ({ ...c, style: { ...defaultStyle(), x: c.style.x, y: c.style.y } }))}>{t("Reset text style")}</button></div>
        </Section>

        <Section id="slide-position" title={t("Position")} open={false}>
          <Range label={t("Horizontal")} value={Math.round(st.x)} display={`${Math.round(st.x)}%`} min={0} max={100} onChange={(v) => setS({ x: v })} />
          <Range label={t("Vertical")} value={Math.round(st.y)} display={`${Math.round(st.y)}%`} min={0} max={100} onChange={(v) => setS({ y: v })} />
          <div className="row">
            <button className="btn sm" onClick={() => setS({ x: 50, y: 50 })}>{t("Center")}</button>
            <button className="btn sm" onClick={() => setS({ x: 50 })}>{t("Center horizontally")}</button>
            <button className="btn sm" onClick={() => setS({ y: 50 })}>{t("Center vertically")}</button>
          </div>
          <label className="check"><input type="checkbox" checked={zones} onChange={(e) => onZones(e.target.checked)} />{t("Show TikTok interface zones")}</label>
        </Section>
      </div>

      <p className="muted xs">{t("On the preview: drag the text to move it (it snaps to the centre), scroll on it to resize, drag the photo to reframe it, scroll on it to zoom, double-click it to reset.")}</p>
      <p className="muted xs">{t("Space: full-size preview without the TikTok zones")}</p>
    </div>
  );
}
