"use client";
import { FONT_LABELS, defaultStyle, defaultPic } from "@/lib/defaults";
import type { FontId, FormatId, PicSettings, SlideCfg, TextStyle } from "@/lib/types";

interface Props {
  index: number;
  cfg: SlideCfg;
  zones: boolean;
  onZones: (v: boolean) => void;
  onCfg: (fn: (c: SlideCfg) => SlideCfg) => void;
  onApplyAll: () => void;
}

export default function Inspector({ index, cfg, zones, onZones, onCfg, onApplyAll }: Props) {
  const st = cfg.style, pic = cfg.pic;
  const setS = (patch: Partial<TextStyle>) => onCfg((c) => ({ ...c, style: { ...c.style, ...patch } }));
  const setP = (patch: Partial<PicSettings>) => onCfg((c) => ({ ...c, pic: { ...c.pic, ...patch } }));
  return (
    <div>
      <h3 style={{ margin: 0 }}>Slide {index + 1}</h3>
      <div className="insp-sec">
        <label className="f">Format
          <select className="input" value={cfg.format} onChange={(e) => onCfg((c) => ({ ...c, format: e.target.value as FormatId }))}>
            <option value="9:16">9:16 (1080×1920)</option>
            <option value="3:4">3:4 (1080×1440)</option>
            <option value="4:5">4:5 (1080×1350)</option>
            <option value="1:1">1:1 (1080×1080)</option>
            <option value="orig">Original (keeps the picture’s shape)</option>
          </select>
        </label>
      </div>

      <div className="insp-sec">
        <h3>Picture</h3>
        <div className="two">
          <label className="f">Framing
            <select className="input" value={pic.framing} onChange={(e) => setP({ framing: e.target.value as PicSettings["framing"] })}>
              <option value="fill">Fill (crop)</option><option value="fit">Fit whole</option>
            </select>
          </label>
          <label className="f">Bars
            <select className="input" disabled={pic.framing === "fill"} value={pic.bars} onChange={(e) => setP({ bars: e.target.value as PicSettings["bars"] })}>
              <option value="blur">Blurred</option><option value="black">Black</option>
            </select>
          </label>
        </div>
        <label className="f">Zoom ({pic.zoom.toFixed(2)}×)
          <input type="range" min={0.5} max={4} step={0.05} value={pic.zoom} onChange={(e) => setP({ zoom: +e.target.value })} />
        </label>
        <label className="f">Darken ({pic.darken}%)
          <input type="range" min={0} max={80} value={pic.darken} onChange={(e) => setP({ darken: +e.target.value })} />
        </label>
        <button className="btn sm" onClick={() => setP({ ox: 0, oy: 0, zoom: 1 })}>Reset framing</button>
      </div>

      <div className="insp-sec">
        <h3>Text</h3>
        <label className="f">Font
          <select className="input" value={st.font} onChange={(e) => setS({ font: e.target.value as FontId })}>
            {Object.entries(FONT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <div className="two">
          <label className="f">Look
            <select className="input" value={st.look} onChange={(e) => setS({ look: e.target.value as TextStyle["look"] })}>
              <option value="outline">Outline</option><option value="box">Box</option><option value="shadow">Shadow</option><option value="plain">Plain</option>
            </select>
          </label>
          <label className="f">Case
            <select className="input" value={st.case} onChange={(e) => setS({ case: e.target.value as TextStyle["case"] })}>
              <option value="asis">As typed</option><option value="upper">UPPER</option><option value="lower">lower</option>
            </select>
          </label>
        </div>
        <label className="f">Size ({st.size})<input type="range" min={18} max={200} value={st.size} onChange={(e) => setS({ size: +e.target.value })} /></label>
        <label className="f">Width ({st.width}%)<input type="range" min={20} max={100} value={st.width} onChange={(e) => setS({ width: +e.target.value })} /></label>
        <label className="f">Line spacing ({st.lineHeight.toFixed(2)})<input type="range" min={0.9} max={1.8} step={0.01} value={st.lineHeight} onChange={(e) => setS({ lineHeight: +e.target.value })} /></label>
        <label className="f">Align
          <select className="input" value={st.align} onChange={(e) => setS({ align: e.target.value as TextStyle["align"] })}>
            <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
          </select>
        </label>
        <div className="two">
          <label className="f">Text color<input type="color" value={st.color} onChange={(e) => setS({ color: e.target.value })} /></label>
          <label className="f">Outline / box color<input type="color" value={st.accent} onChange={(e) => setS({ accent: e.target.value })} /></label>
        </div>
        <label className="f">Horizontal ({Math.round(st.x)}%)<input type="range" min={0} max={100} value={st.x} onChange={(e) => setS({ x: +e.target.value })} /></label>
        <label className="f">Vertical ({Math.round(st.y)}%)<input type="range" min={0} max={100} value={st.y} onChange={(e) => setS({ y: +e.target.value })} /></label>
        <div className="row">
          <button className="btn sm" onClick={() => setS({ x: 50, y: 50 })}>Center</button>
          <button className="btn sm" onClick={() => setS({ x: 50 })}>Center H</button>
          <button className="btn sm" onClick={() => setS({ y: 50 })}>Center V</button>
        </div>
      </div>

      <div className="insp-sec">
        <button className="btn" onClick={onApplyAll}>Apply to all slides</button>
        <button className="btn" onClick={() => onCfg((c) => ({ ...c, style: defaultStyle() }))}>Reset text style</button>
        <button className="btn ghost" onClick={() => onCfg((c) => ({ ...c, pic: defaultPic() }))}>Reset picture settings</button>
        <label className="row"><input type="checkbox" checked={zones} onChange={(e) => onZones(e.target.checked)} /> TikTok zones (preview only)</label>
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          On the preview: drag the text to move it (snaps to the centre), scroll on text to resize, drag the picture to reframe, scroll on it to zoom, double-click it to reset.
        </p>
      </div>
    </div>
  );
}
