"use client";
import { useState } from "react";
import { uid } from "@/lib/defaults";
import { NEUTRAL_GRADE, parseCube, PROFILES } from "@/lib/grade";
import { useT } from "@/lib/i18n";
import { putMedia } from "@/lib/idb";
import type { VideoGrade } from "@/lib/types";
import { Range, Section, Select } from "./ui";

const LUTS_KEY = "tktgen-luts";

/** Look LUTs this browser has (the files are in IndexedDB "lut:<id>"). */
export function knownLuts(): { id: string; name: string }[] {
  try { return JSON.parse(localStorage.getItem(LUTS_KEY) ?? "[]"); } catch { return []; }
}
/** Note that this browser now has this LUT file. */
export function rememberLut(id: string, name: string) {
  const next = [...knownLuts().filter((l) => l.id !== id), { id, name }];
  try { localStorage.setItem(LUTS_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  return next;
}

/** The look LUT imported last on this device: log footage gets it by default. */
export function lastLut(): { id: string; name: string } | undefined {
  const l = knownLuts();
  return l[l.length - 1];
}

/** Colour panel of the video studio: camera profile, look LUT, the sliders, vignette and grain. */
export default function ColorGrade({ grade, onChange, raw, onRaw, lookErr, clips, onApplyAll, onLutStored, sdr }: {
  /** The camera file is standard SDR: the grade is not needed. */
  sdr?: boolean;
  grade: VideoGrade | undefined;
  onChange: (g: VideoGrade | undefined) => void;
  raw: boolean;
  onRaw: (v: boolean) => void;
  lookErr: string | null;
  clips: number;
  onApplyAll: () => void;
  /** A LUT file was stored (also a missing one put back under its id): read it again. */
  onLutStored: (id: string) => void;
}) {
  const { t, lang } = useT();
  const [luts, setLuts] = useState(knownLuts);
  const [err, setErr] = useState<string | null>(null);
  const g = grade ?? NEUTRAL_GRADE;
  const set = (patch: Partial<VideoGrade>) => onChange({ ...g, ...patch });
  const num = (v: number, d = 2) => v.toFixed(d).replace(".", lang === "fr" ? "," : ".");

  const importLut = async (f: File) => {
    setErr(null);
    try {
      parseCube(await f.text()); // refuse a file that is not a 3D .cube before keeping it
      // The LUT of this grade, missing in this browser: same name, same id, so every clip using it finds it.
      const name0 = f.name.replace(/\.cube$/i, "");
      const id = lookErr && g.lut && g.lut.name === name0 ? g.lut.id : uid();
      await putMedia(`lut:${id}`, f);
      const name = f.name.replace(/\.cube$/i, "");
      setLuts(rememberLut(id, name));
      set({ lut: { id, name } });
      onLutStored(id);
    } catch (e) {
      setErr(t("This file is not a 3D LUT (.cube): {why}", { why: e instanceof Error ? e.message : String(e) }));
    }
  };

  if (!grade) {
    return (
      <div className="stack">
        <p className="muted xs">{t("Grade the camera footage here, live: the log is converted like a CST in DaVinci, then your sliders and your look LUT are applied. The export applies it on the 10-bit camera file.")}</p>
        <div className="row">
          <button className="btn sm primary" onClick={() => onChange(sdr
            ? { ...NEUTRAL_GRADE, profile: "rec709" } // standard video: the simple settings only
            : { ...NEUTRAL_GRADE, ...(luts.length ? { lut: luts[luts.length - 1] } : {}) })}>{t("Grade this video")}</button>
        </div>
      </div>
    );
  }

  const colour = g.profile !== "none";
  // Standard footage: only the simple sliders, unless the camera profile and LUT were turned back on.
  const simple = !!sdr && !g.sdrOverride;
  return (
    <>
      {simple && (
        <p className="notice xs">
          {t("Standard SDR video detected (a phone, S-Cinetone, Rec.709): the camera profile and the look LUT are turned off, they do not apply to this kind of video. The simple settings below start at zero.")}{" "}
          <button className="btn sm" onClick={() => set({ sdrOverride: true })}>{t("Turn back on")}</button>
        </p>
      )}
      {sdr && !simple && (
        <p className="notice xs">
          {t("Camera profile and LUT turned back on for this standard SDR video.")}{" "}
          <button className="btn sm quiet" onClick={() => { onRaw(false); onChange({ ...NEUTRAL_GRADE, profile: "rec709" }); }}>{t("Turn off again")}</button>
        </p>
      )}
      <Section id="color-profile" title={t("Profile and LUT")}>
        {/* Standard video: the camera conversion and the LUT are off (greyed), the simple sliders below stay. */}
        <fieldset className={"plain-set" + (simple ? " off" : "")} disabled={simple} title={simple ? t("Off for a standard SDR video") : undefined}>
        <label className="field">
          <span>{t("Camera profile")}</span>
          <Select className="input" value={g.profile} onChange={(e) => set({ profile: e.target.value as VideoGrade["profile"] })}>
            {PROFILES.map((p) => <option key={p.id} value={p.id}>{t(p.label)}</option>)}
          </Select>
        </label>
        {colour && (
          <>
            <label className="field">
              <span>{t("Look LUT (made in DaVinci, input DaVinci Wide Gamut / Intermediate)")}</span>
              <Select className="input" value={g.lut?.id ?? ""}
                onChange={(e) => { const l = luts.find((x) => x.id === e.target.value); set({ lut: l }); }}>
                <option value="">{t("None (plain conversion to Rec.709)")}</option>
                {luts.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                {g.lut && !luts.some((l) => l.id === g.lut!.id) && <option value={g.lut.id}>{g.lut.name}</option>}
              </Select>
            </label>
            <div className="row">
              <label className="btn sm">
                {t("Import a LUT (.cube)")}
                <input type="file" accept=".cube" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importLut(f); e.target.value = ""; }} />
              </label>
              <button className={"btn sm" + (raw ? " on" : "")} aria-pressed={raw} onClick={() => onRaw(!raw)}
                title={t("Show the picture as recorded, to compare")}>{raw ? t("Showing the log") : t("Before / after")}</button>
            </div>
            {(err || lookErr) && <p className="notice warn xs">{err ?? lookErr}</p>}
          </>
        )}
      </fieldset>
      </Section>

      {colour && (
        <Section id="color-corrections" title={t("Corrections")} open={false}>
          <Range label={t("Exposure")} value={g.exposure} display={`${g.exposure > 0 ? "+" : ""}${num(g.exposure)} EV`} min={-3} max={3} step={0.05}
            onChange={(v) => set({ exposure: v })} onReset={() => set({ exposure: 0 })} />
          <Range label={t("Contrast")} value={g.contrast} display={num(g.contrast)} min={0.5} max={2} step={0.01}
            onChange={(v) => set({ contrast: v })} onReset={() => set({ contrast: 1 })} />
          <Range label={t("Temperature")} value={g.temp} display={`${g.temp > 0 ? "+" : ""}${g.temp}`} min={-100} max={100}
            onChange={(v) => set({ temp: v })} onReset={() => set({ temp: 0 })} />
          <Range label={t("Tint")} value={g.tint} display={`${g.tint > 0 ? "+" : ""}${g.tint}`} min={-100} max={100}
            onChange={(v) => set({ tint: v })} onReset={() => set({ tint: 0 })} />
          <Range label={t("Saturation")} value={g.sat} scale={100} display={`${Math.round(g.sat * 100)} %`} min={0} max={2} step={0.01}
            onChange={(v) => set({ sat: v })} onReset={() => set({ sat: 1 })} />
        </Section>
      )}

      <Section id="color-finish" title={t("Finish")} open={false}>
        <Range label={t("Vignette")} value={g.vignette} display={`${g.vignette}`} min={0} max={100}
          onChange={(v) => set({ vignette: v })} onReset={() => set({ vignette: 0 })} />
        {g.vignette > 0 && (
          <Range label={t("Vignette size")} value={g.vignetteSize} display={`${g.vignetteSize}`} min={0} max={100}
            onChange={(v) => set({ vignetteSize: v })} onReset={() => set({ vignetteSize: 50 })} />
        )}
        <Range label={t("Grain")} value={g.grain} display={`${g.grain}`} min={0} max={100}
          onChange={(v) => set({ grain: v })} onReset={() => set({ grain: 0 })} />
        {g.grain > 0 && (
          <Range label={t("Grain size")} value={g.grainSize} display={num(g.grainSize, 1)} min={1} max={4} step={0.5}
            onChange={(v) => set({ grainSize: v })} onReset={() => set({ grainSize: 1 })} />
        )}
      </Section>

      <div className="row">
        {clips > 1 && <button className="btn sm" onClick={onApplyAll} title={t("Use this grade on every video of the release")}>{t("On every video")}</button>}
        <button className="btn sm quiet danger" onClick={() => { onRaw(false); onChange(undefined); }}>{t("Remove the grade")}</button>
      </div>
    </>
  );
}
