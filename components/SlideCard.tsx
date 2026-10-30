"use client";
import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import Icon from "./Icon";
import { renderSlide, TextBox } from "@/lib/render";
import { useDriveImage } from "@/lib/useImage";
import type { GenSlide, PicPool, SlideCfg, TextPool } from "@/lib/types";

interface Props {
  index: number;
  cfg: SlideCfg;
  gen: GenSlide | undefined;
  selected: boolean;
  textPools: TextPool[];
  picPools: PicPool[];
  zones: boolean;
  fontsReady: boolean;
  onSelect: () => void;
  onCfg: (fn: (c: SlideCfg) => SlideCfg) => void;
  onText: (t: string) => void;
  onRerollPic: () => void;
  onRerollText: () => void;
  onSave: () => void;
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export default function SlideCard(p: Props) {
  const { t } = useT();
  const { cfg, gen } = p;
  const { img, err } = useDriveImage(gen?.picId ?? null);
  const cv = useRef<HTMLCanvasElement>(null);
  const box = useRef<TextBox | null>(null);
  const drag = useRef<null | { kind: "text" | "pic"; sx: number; sy: number; ox: number; oy: number; k: number }>(null);
  const [guides, setGuides] = useState({ v: false, h: false });
  const text = gen?.text ?? "";

  useEffect(() => {
    if (!cv.current) return;
    const r = renderSlide(cv.current, cfg, img, text, { guideV: guides.v, guideH: guides.h, zones: p.zones });
    box.current = r.box;
  }, [cfg, img, text, guides, p.zones, p.fontsReady]);

  const toCanvas = (e: { clientX: number; clientY: number }) => {
    const c = cv.current!;
    const r = c.getBoundingClientRect();
    const k = c.width / r.width;
    return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k, k };
  };
  const inText = (x: number, y: number) => {
    const b = box.current;
    const pad = 30;
    return !!b && x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad;
  };

  const down = (e: React.PointerEvent) => {
    p.onSelect();
    const c = toCanvas(e);
    (e.target as Element).setPointerCapture(e.pointerId);
    const isText = inText(c.x, c.y);
    drag.current = { kind: isText ? "text" : "pic", sx: e.clientX, sy: e.clientY, ox: isText ? cfg.style.x : cfg.pic.ox, oy: isText ? cfg.style.y : cfg.pic.oy, k: c.k };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !cv.current) return;
    const W = cv.current.width, H = cv.current.height;
    const dx = (e.clientX - d.sx) * d.k, dy = (e.clientY - d.sy) * d.k;
    if (d.kind === "text") {
      let x = clamp(d.ox + (dx / W) * 100, 0, 100), y = clamp(d.oy + (dy / H) * 100, 0, 100);
      const sv = Math.abs(x - 50) < 1.5, sh = Math.abs(y - 50) < 1.5;
      if (sv) x = 50;
      if (sh) y = 50;
      setGuides({ v: sv, h: sh });
      p.onCfg((c) => ({ ...c, style: { ...c.style, x, y } }));
    } else {
      p.onCfg((c) => ({ ...c, pic: { ...c.pic, ox: d.ox + dx / W, oy: d.oy + dy / H } }));
    }
  };
  const up = () => { drag.current = null; setGuides({ v: false, h: false }); };

  // Wheel needs a non-passive listener to stop the page from scrolling.
  const wheelRef = useRef<(e: WheelEvent) => void>(() => {});
  wheelRef.current = (e) => {
    e.preventDefault();
    const c = toCanvas(e);
    const dir = e.deltaY < 0 ? 1 : -1;
    if (inText(c.x, c.y)) p.onCfg((s) => ({ ...s, style: { ...s.style, size: clamp(Math.round(s.style.size + dir * 3), 18, 200) } }));
    else p.onCfg((s) => ({ ...s, pic: { ...s.pic, zoom: clamp(+(s.pic.zoom + dir * 0.05).toFixed(2), 0.5, 4) } }));
  };
  useEffect(() => {
    const el = cv.current;
    if (!el) return;
    const h = (e: WheelEvent) => wheelRef.current(e);
    el.addEventListener("wheel", h, { passive: false });
    return () => el.removeEventListener("wheel", h);
  }, []);

  const dbl = (e: React.MouseEvent) => {
    const c = toCanvas(e);
    if (!inText(c.x, c.y)) p.onCfg((s) => ({ ...s, pic: { ...s.pic, ox: 0, oy: 0, zoom: 1 } }));
  };

  const textVal = cfg.textSource.kind === "pool" ? cfg.textSource.poolId : cfg.textSource.kind === "lyrics" ? "__lyrics" : "";

  return (
    <div className={"card" + (p.selected ? " sel" : "")} onClick={p.onSelect}>
      <div className="card-head">
        <span className="idx-chip" aria-label={t("Slide {n}", { n: p.index + 1 })}>{String(p.index + 1).padStart(2, "0")}</span>
        <span className="grow" />
        <button className="btn sm quiet" onClick={p.onRerollPic} disabled={!cfg.picPoolId} title={t("Pick another photo")}><Icon name="refresh" size={13} />{t("Photo")}</button>
        <button className="btn sm quiet" onClick={p.onRerollText} disabled={cfg.textSource.kind === "none"} title={t("Pick another text")}><Icon name="refresh" size={13} />{t("Text")}</button>
        <button className="btn sm quiet icon" onClick={p.onSave} aria-label={t("Save this slide")} title={t("Save this slide")}><Icon name="download" size={14} /></button>
      </div>
      <div className="cv-wrap">
        <canvas ref={cv} className="cv" width={1080} height={1920}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onDoubleClick={dbl} />
      </div>
      {err && <span className="notice bad">{err}</span>}
      <textarea className="input" rows={3} aria-label={t("Caption")} placeholder={t("Slide text")} value={text} onChange={(e) => p.onText(e.target.value)} />
      <div className="cols2 fields">
        <label className="field">{t("Text from")}
          <select className="input" value={textVal} onChange={(e) => {
            const v = e.target.value;
            p.onCfg((c) => ({ ...c, textSource: v === "" ? { kind: "none" } : v === "__lyrics" ? { kind: "lyrics" } : { kind: "pool", poolId: v } }));
          }}>
            <option value="">{t("No text")}</option>
            <option value="__lyrics">{t("Lyrics")}</option>
            {p.textPools.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </label>
        <label className="field">{t("Photo from")}
          <select className="input" value={cfg.picPoolId ?? ""} onChange={(e) => {
            const v = e.target.value || null;
            p.onCfg((c) => ({ ...c, picPoolId: v }));
          }}>
            <option value="">{t("No photo")}</option>
            {p.picPools.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </label>
      </div>
    </div>
  );
}
