"use client";
import { defaultPic, defaultStyle } from "@/lib/defaults";
import { useT } from "@/lib/i18n";
import { zoomPic } from "@/lib/render";
import type { FormatId, LyricSection, PicSettings, SlideCfg, StylePreset, TextStyle } from "@/lib/types";
import { FontPicker, StylePresets } from "./TextControls";
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
}

export default function Inspector({
  index, cfg, zones, onZones, onCfg, onApplyAll,
  lyrics, presets, onSavePreset, onApplyPreset, onDeletePreset, fonts, onFonts,
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
        <Section title={t("Format & photo")}>
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
          <Range label={t("Zoom")} value={pic.zoom} display={`${pic.zoom.toFixed(2)}×`} min={0.5} max={4} step={0.05} onChange={(v) => onCfg((c) => ({ ...c, pic: zoomPic(c.pic, v) }))} />
          <Range label={t("Darken")} value={pic.darken} display={`${pic.darken}%`} min={0} max={80} onChange={(v) => setP({ darken: v })} />
          <div><button className="btn sm" onClick={() => onCfg((c) => ({ ...c, pic: { ...defaultPic(), framing: c.pic.framing, bars: c.pic.bars, darken: c.pic.darken } }))}>{t("Reset framing")}</button></div>
        </Section>

        <Section title={t("Text")}>
          <FontPicker style={st} fonts={fonts} onChange={setS} onFonts={onFonts} />
          <label className="field">{t("Style")}
            <select className="input" value={st.look} onChange={(e) => setS({ look: e.target.value as TextStyle["look"] })}>
              <option value="outline">{t("Outline")}</option><option value="box">{t("Box")}</option><option value="shadow">{t("Shadow")}</option><option value="plain">{t("Plain")}</option>
            </select>
          </label>
          <Range label={t("Size")} value={st.size} min={18} max={200} onChange={(v) => setS({ size: v })} />
          <div className="cols2">
            <label className="field">{t("Text color")}<input type="color" value={st.color} onChange={(e) => setS({ color: e.target.value })} /></label>
            <label className="field">{st.look === "box" ? t("Box color") : t("Outline color")}<input type="color" value={st.accent} onChange={(e) => setS({ accent: e.target.value })} /></label>
          </div>
          <div className="cols2">
            <label className="field">{t("Case")}
              <select className="input" value={st.case} onChange={(e) => setS({ case: e.target.value as TextStyle["case"] })}>
                <option value="asis">{t("As typed")}</option><option value="upper">{t("UPPERCASE")}</option><option value="lower">{t("lowercase")}</option>
              </select>
            </label>
            <label className="field">{t("Align")}
              <select className="input" value={st.align} onChange={(e) => setS({ align: e.target.value as TextStyle["align"] })}>
                <option value="left">{t("Left")}</option><option value="center">{t("Center")}</option><option value="right">{t("Right")}</option>
              </select>
            </label>
          </div>
          <Range label={t("Width")} value={st.width} display={`${st.width}%`} min={20} max={100} onChange={(v) => setS({ width: v })} />
          <Range label={t("Line spacing")} value={st.lineHeight} display={st.lineHeight.toFixed(2)} min={0.9} max={1.8} step={0.01} onChange={(v) => setS({ lineHeight: v })} />
          {cfg.textSource.kind === "lyrics" && (
            <label className="field">{t("Lyrics section for this slide")}
              <select className="input" value={cfg.textSource.sectionId ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  onCfg((c) => ({ ...c, textSource: v ? { kind: "lyrics", sectionId: v } : { kind: "lyrics" } }));
                }}>
                <option value="">{t("Project default")}</option>
                {lyrics.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </label>
          )}
          <div><button className="btn sm" onClick={() => onCfg((c) => ({ ...c, style: { ...defaultStyle(), x: c.style.x, y: c.style.y } }))}>{t("Reset text style")}</button></div>
        </Section>

        <Section title={t("Style presets")} open={false}>
          <StylePresets presets={presets} onSave={onSavePreset} onApply={onApplyPreset} onDelete={onDeletePreset} />
        </Section>

        <Section title={t("Position")} open={false}>
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
    </div>
  );
}
