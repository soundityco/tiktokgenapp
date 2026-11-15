"use client";
import { useState } from "react";
import { uid } from "@/lib/defaults";
import { NEUTRAL_GRADE, parseCube, PROFILES, wheelsOn } from "@/lib/grade";
import ColorWheels from "./ColorWheels";
import { useT } from "@/lib/i18n";
import { putMedia } from "@/lib/idb";
import type { GradePreset, LutRef, VideoGrade } from "@/lib/types";
import { Range, Section, Select, Hint } from "./ui";
import Icon from "./Icon";

const LUTS_KEY = "tktgen-luts";

/** LUTs this browser has (the files are in IndexedDB "lut:<id>"): looks made in DaVinci, and camera LUTs. */
export function knownLuts(): LutRef[] {
  try { return JSON.parse(localStorage.getItem(LUTS_KEY) ?? "[]"); } catch { return []; }
}
/** Note that this browser now has this LUT file. */
export function rememberLut(id: string, name: string, kind?: LutRef["kind"]) {
  const next = [...knownLuts().filter((l) => l.id !== id), { id, name, ...(kind === "camera" ? { kind } : null) }];
  try { localStorage.setItem(LUTS_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  return next;
}

/** The look LUT imported last on this device: log footage gets it by default. */
export function lastLut(): { id: string; name: string } | undefined {
  const l = knownLuts();
  return l[l.length - 1];
}

/** Colour panel of the video studio: camera profile, look LUT, the sliders, vignette and grain. */
export default function ColorGrade({ grade, onChange, onRaw, lookErr, onLutStored, sdr, presets, onSavePreset, onDeletePreset, library, onImported }: {
  /** The camera file is standard SDR: the grade is not needed. */
  sdr?: boolean;
  grade: VideoGrade | undefined;
  onChange: (g: VideoGrade | undefined) => void;
  onRaw: (v: boolean) => void;
  lookErr: string | null;
  /** The account's colour presets: saved from this grade, put on it (its camera profile stays), deleted. */
  presets: GradePreset[];
  onSavePreset: (name: string) => void;
  onDeletePreset: (id: string) => void;
  /** A LUT file was stored (also a missing one put back under its id): read it again. */
  onLutStored: (id: string) => void;
  /** The account's LUTs (every device), and a LUT just imported here (it joins them, its file goes to the Drive). */
  library: LutRef[];
  onImported: (lut: LutRef) => void;
}) {
  const { t, lang } = useT();
  const luts = library;
  const [err, setErr] = useState<string | null>(null);
  const g = grade ?? NEUTRAL_GRADE;
  const set = (patch: Partial<VideoGrade>) => onChange({ ...g, ...patch });
  const num = (v: number, d = 2) => v.toFixed(d).replace(".", lang === "fr" ? "," : ".");

  const importLut = async (f: File, kind: "look" | "camera") => {
    setErr(null);
    try {
      parseCube(await f.text()); // refuse a file that is not a 3D .cube before keeping it
      // The LUT of this grade, missing in this browser: same name, same id, so every clip using it finds it.
      const name0 = f.name.replace(/\.cube$/i, "");
      const id = lookErr && g.lut && g.lut.name === name0 ? g.lut.id : uid();
      await putMedia(`lut:${id}`, f);
      const name = f.name.replace(/\.cube$/i, "");
      rememberLut(id, name, kind);
      const ref: LutRef = { id, name, ...(kind === "camera" ? { kind } : null) };
      onImported(ref);
      set({ lut: ref });
      onLutStored(id);
    } catch (e) {
      setErr(t("This file is not a 3D LUT (.cube): {why}", { why: e instanceof Error ? e.message : String(e) }));
    }
  };

  // A preset put on: the whole grade (camera profile, output LUT, settings, wheels). Its LUT found in the account's
  // library (its Drive copy); on a standard video, its profile and LUT turned on.
  const applyPreset = (p: GradePreset) => {
    onRaw(false);
    const lib = p.grade.lut && luts.find((l) => l.id === p.grade.lut!.id);
    const lut = p.grade.lut ? { ...p.grade.lut, ...(lib?.driveId ? { driveId: lib.driveId } : null) } : undefined;
    onChange({ ...p.grade, lut, sdrOverride: sdr && (p.grade.profile !== "rec709" || !!lut) ? true : p.grade.sdrOverride });
  };
  const presetsPart = (
    <Section id="color-presets" title={<>{t("Colour presets")}{grade && gradePresetOf(presets, grade) && <span className="sec-sub"> · {gradePresetOf(presets, grade)!.name}</span>}</>} open={false}>
      <GradePresets presets={presets} current={grade} onSave={onSavePreset} onApply={applyPreset} onDelete={onDeletePreset} />
    </Section>
  );

  if (!grade) {
    return (
      <div className="stack">
        {presets.length > 0 && presetsPart}
        <div className="row">
          <button className="btn sm primary" onClick={() => onChange(sdr
            ? { ...NEUTRAL_GRADE, profile: "rec709" } // standard video: the simple settings only
            : { ...NEUTRAL_GRADE, ...(luts.length ? { lut: luts[luts.length - 1] } : {}) })}>{t("Grade this video")}</button>
          <Hint text={t("Grade the camera footage here, live: the log is converted like a CST in DaVinci, then your sliders and your look LUT are applied. The export applies it on the 10-bit camera file.")} />
        </div>
      </div>
    );
  }

  const colour = g.profile !== "none";
  // Standard footage: only the simple sliders, unless the camera profile and LUT were turned back on.
  const simple = !!sdr && !g.sdrOverride;
  return (
    <>
      {presetsPart}
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
      <Section id="color-profile" title={t("Profile and output")}>
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
            {/* The output: the app's own Rec.709, a camera LUT (the camera's log in: Sony's, Alister Chapman's…), or a
                look made in DaVinci (DaVinci Wide Gamut / Intermediate in). The grade above goes before it. */}
            <label className="field">
              <span className="row" style={{ gap: 6 }}>{t("Colour output")}<Hint text={t("Rec.709: the app's own neutral conversion. Camera LUT: a LUT made for the camera's log (Sony's, Alister Chapman's…), the picture is turned back into that log before it. Look LUT: one made in DaVinci (input DaVinci Wide Gamut / Intermediate). Your settings and wheels always go before it.")} /></span>
              <Select className="input" value={g.lut?.id ?? ""}
                onChange={(e) => { const l = luts.find((x) => x.id === e.target.value); set({ lut: l ? { id: l.id, name: l.name, ...(l.kind === "camera" ? { kind: "camera" as const } : null), ...(l.driveId ? { driveId: l.driveId } : null) } : undefined }); }}>
                <option value="">{t("Rec.709 (the app's own conversion)")}</option>
                {luts.map((l) => <option key={l.id} value={l.id}>{`${l.name} · ${l.kind === "camera" ? t("camera LUT") : t("look LUT")}`}</option>)}
                {g.lut && !luts.some((l) => l.id === g.lut!.id) && <option value={g.lut.id}>{g.lut.name}</option>}
              </Select>
            </label>
            <div className="row">
              <label className="btn sm">
                {t("Import a camera LUT")}
                <input type="file" accept=".cube" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importLut(f, "camera"); e.target.value = ""; }} />
              </label>
              <label className="btn sm">
                {t("Import a look LUT")}
                <input type="file" accept=".cube" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importLut(f, "look"); e.target.value = ""; }} />
              </label>
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

      {colour && (
        <Section id="color-wheels" title={<>{t("Colour wheels")}{wheelsOn(g) && <span className="sec-sub"> · {t("on")}</span>}</>} open={false}>
          <ColorWheels wheels={g.wheels ?? {}} onChange={(wheels) => set({ wheels })} />
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

    </>
  );
}

/** The same look (the camera profile apart: it is the video's own). */
const lookKey = (g: VideoGrade) => JSON.stringify([g.profile, g.lut?.id ?? null, g.exposure, g.contrast, g.pivot ?? null, g.temp, g.tint, g.sat, g.vignette, g.vignetteSize, g.grain, g.grainSize, wheelsOn(g) ? g.wheels : null]);
export const gradePresetOf = (presets: GradePreset[], g: VideoGrade) => presets.find((p) => lookKey(p.grade) === lookKey(g));

/** The colour presets, as the text's: a name and "Save the current colour", then each one to put on, or delete. */
function GradePresets({ presets, current, onSave, onApply, onDelete }: {
  presets: GradePreset[]; current?: VideoGrade; onSave: (name: string) => void; onApply: (p: GradePreset) => void; onDelete: (id: string) => void;
}) {
  const { t } = useT();
  const [name, setName] = useState("");
  const save = () => { const n = name.trim(); if (n) { onSave(n); setName(""); } };
  return (
    <div className="stack">
      {current && (
        <form className="row nowrap" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <input className="input sm grow" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("Preset name")} aria-label={t("Preset name")} maxLength={60} />
          <button className="btn sm" type="submit" disabled={!name.trim()} title={t("Save the current colour")}>{t("Save")}</button>
        </form>
      )}
      {!presets.length && <span className="muted xs">{t("No presets yet.")}</span>}
      {presets.map((p) => {
        const on = !!current && lookKey(p.grade) === lookKey(current);
        return (
          <div className="row nowrap" key={p.id}>
            <button className={"btn sm grow preset" + (on ? " on" : "")} onClick={() => onApply(p)} title={on ? t("This is the colour now") : t("Apply")} aria-pressed={on}>
              {on && <Icon name="check" size={13} />}
              <span className="truncate">{p.name}</span>
              <span className="muted xs truncate">{p.grade.lut?.name ?? t("No LUT")}</span>
            </button>
            <button className="btn sm quiet icon" aria-label={t("Delete preset")} title={t("Delete preset")} onClick={() => onDelete(p.id)}>
              <Icon name="trash" size={13} />
            </button>
          </div>
        );
      })}
      <p className="muted xs">{t("A preset keeps the whole grade: the camera profile, the output LUT, the settings and the wheels.")}</p>
    </div>
  );
}
