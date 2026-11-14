"use client";
import { useEffect, useRef, useState } from "react";
import { defaultStyle, newSlide } from "@/lib/defaults";
import { useT } from "@/lib/i18n";
import { renderSlide } from "@/lib/render";
import type { TextStyle } from "@/lib/types";
import Icon from "../Icon";
import { PALETTES, stagePhoto } from "./stagePhotos";

/** What a release's lists could hold: hooks for slide 1, a lyric, a last slide. */
const TEXTS = {
  fr: {
    hooks: ["Ce son va te hanter", "Personne ne parle de ce son", "POV : tu l'écoutes à 3h du matin", "Écoute jusqu'au bout", "Le refrain qui reste en tête"],
    lyrics: ["Je marche seul|dans la nuit", "Les lumières de la ville|me suivent encore", "Dis-moi que tu restes|encore un peu"],
    ends: ["Dispo vendredi", "Lien en bio", "Sauvegarde-le pour vendredi"],
  },
  en: {
    hooks: ["This song will haunt you", "Nobody talks about this song", "POV: you hear it at 3am", "Listen till the end", "The chorus that stays in your head"],
    lyrics: ["I walk alone|through the night", "The city lights|still follow me", "Tell me you'll stay|a little longer"],
    ends: ["Out Friday", "Link in bio", "Save it for Friday"],
  },
};
const LOOKS: TextStyle["look"][] = ["outline", "box", "shadow", "plain"];
const pick = <T,>(list: T[], not?: T) => { const rest = list.filter((x) => x !== not); return rest[Math.floor(Math.random() * rest.length)]; };

/**
 * The home page's carousel: three slides drawn by the app's own renderer, on concert pictures drawn in the browser.
 * "Generate" draws other texts and photos, the chips change the texts' look: what the studio does, in small.
 */
export default function CarouselDemo() {
  const { t, lang } = useT();
  const texts = TEXTS[lang === "fr" ? "fr" : "en"];
  const [photos, setPhotos] = useState<ImageBitmap[]>([]);
  const [draw, setDraw] = useState(() => ({ hook: texts.hooks[0], lyric: texts.lyrics[0], end: texts.ends[0], pics: [0, 1, 2] }));
  const [look, setLook] = useState<TextStyle["look"]>("outline");
  const [spin, setSpin] = useState(0);
  const cvs = [useRef<HTMLCanvasElement>(null), useRef<HTMLCanvasElement>(null), useRef<HTMLCanvasElement>(null)];

  useEffect(() => {
    let off = false;
    void Promise.all(PALETTES.map((p, i) => stagePhoto(p, 11 + i * 7))).then((list) => { if (!off) setPhotos(list); });
    return () => { off = true; };
  }, []);
  // The language changed (the visitor's own): its texts.
  useEffect(() => { setDraw((d) => ({ ...d, hook: texts.hooks[0], lyric: texts.lyrics[0], end: texts.ends[0] })); }, [lang]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!photos.length) return;
    let off = false;
    void document.fonts.ready.then(() => {
      if (off) return;
      const slide = (y: number, size: number, extra: Partial<TextStyle> = {}) => ({ ...newSlide(null, null), style: { ...defaultStyle(), look, y, size, ...extra } });
      const plan = [
        { cfg: slide(30, 92), text: draw.hook },
        { cfg: slide(56, 84, { case: "lower" }), text: draw.lyric },
        { cfg: slide(72, 84), text: draw.end },
      ];
      plan.forEach((s, i) => { const c = cvs[i].current; if (c) renderSlide(c, s.cfg, photos[draw.pics[i]], s.text); });
    });
    return () => { off = true; };
  }, [photos, draw, look]); // eslint-disable-line react-hooks/exhaustive-deps

  const generate = () => {
    const order = [...PALETTES.keys()].sort(() => Math.random() - 0.5).slice(0, 3);
    setDraw((d) => ({ hook: pick(texts.hooks, d.hook), lyric: pick(texts.lyrics, d.lyric), end: pick(texts.ends, d.end), pics: order }));
    setSpin((n) => n + 1);
  };

  return (
    <div className="lp-demo">
      <div className={"lp-deck" + (photos.length ? " ready" : "")} key={spin}>
        {cvs.map((r, i) => (
          <div key={i} className="lp-slide"><canvas ref={r} width={1080} height={1920} aria-label={t("Slide {n}", { n: i + 1 })} /><span className="lp-slide-n mono">{String(i + 1).padStart(2, "0")}</span></div>
        ))}
      </div>
      <div className="lp-demo-bar">
        <button className="btn primary gen-btn" onClick={generate}><Icon name="sparkle-fill" size={15} />{t("Generate")}</button>
        <div className="lp-chips" role="group" aria-label={t("Style")}>
          {LOOKS.map((l) => (
            <button key={l} className={l === look ? "on" : ""} aria-pressed={l === look} onClick={() => setLook(l)}>
              {t(l === "outline" ? "Outline" : l === "box" ? "Box" : l === "shadow" ? "Shadow" : "Plain")}
            </button>
          ))}
        </div>
      </div>
      <p className="lp-demo-note mono">{t("The app's own engine: generate, change the style.")}</p>
    </div>
  );
}
