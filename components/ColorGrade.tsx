"use client";
import { useState } from "react";
import { uid } from "@/lib/defaults";
import { effectsOf, finishGrade, guessLutInput, lutInputOf, NEUTRAL_GRADE, parseCube, PROFILES, wheelsOn } from "@/lib/grade";
import ColorWheels from "./ColorWheels";
import { effectsOn } from "@/lib/effectsGL";
import { useT } from "@/lib/i18n";
import { putMedia } from "@/lib/idb";
import type { FinishLook, GradePreset, LutInput, LutRef, VideoGrade } from "@/lib/types";
import { Modal, Range, Section, Select, Hint, Switch } from "./ui";
import Icon from "./Icon";
import { presetNamed } from "./TextControls";

const LUTS_KEY = "tktgen-luts";

/** The same LUT: the same entry, or the same name and kind (imported twice, on two devices…). */
export const sameLut = (a: LutRef, b: LutRef) =>
  a.id === b.id || (a.name.trim().toLowerCase() === b.name.trim().toLowerCase() && lutInputOf(a) === lutInputOf(b));
/** This browser forgets a LUT (deleted from the account). */
export function forgetLut(id: string) {
  try { localStorage.setItem(LUTS_KEY, JSON.stringify(knownLuts().filter((l) => l.id !== id))); } catch { /* private mode */ }
}
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
export default function ColorGrade({ grade, onChange, onRaw, lookErr, onLutStored, sdr, footage, presets, onSavePreset, onDeletePreset, library, onImported, onRemoveLut, disabled }: {
  /** The camera file is standard SDR: the grade is not needed. */
  sdr?: boolean;
  /** What the video was recorded in, when known: a preset made for another kind is advised against before it goes on. */
  footage?: Footage;
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
  /** A LUT to delete from the account (asked first). */
  onRemoveLut?: (lut: LutRef) => void;
  /** The whole colour turned off: every part greyed, nothing to change (the parts still open, to look). */
  disabled?: boolean;
}) {
  const { t, lang } = useT();
  const luts = library;
  const [err, setErr] = useState<string | null>(null);
  const g = grade ?? NEUTRAL_GRADE;
  const set = (patch: Partial<VideoGrade>) => onChange({ ...g, ...patch });
  const num = (v: number, d = 2) => v.toFixed(d).replace(".", lang === "fr" ? "," : ".");

  // A LUT imported: its input guessed from its name and header (told when it could not be), the same file again
  // (same name) taking the place of the one there, never a second entry.
  const [guessNote, setGuessNote] = useState<string | null>(null);
  const importLut = async (f: File) => {
    setErr(null); setGuessNote(null);
    try {
      const text = await f.text();
      parseCube(text); // refuse a file that is not a 3D .cube before keeping it
      const name = f.name.replace(/\.cube$/i, "");
      const guessed = guessLutInput(f.name, text);
      const same = luts.find((l) => l.name.trim().toLowerCase() === name.trim().toLowerCase());
      // The LUT of this grade, missing in this browser: same name, same id, so every clip using it finds it.
      const id = same?.id ?? (lookErr && g.lut && g.lut.name === name ? g.lut.id : uid());
      await putMedia(`lut:${id}`, f);
      const input: LutInput = guessed ?? (same ? lutInputOf(same) : "dwg");
      // (Into Cineon or Rec.709, the highlights eased in by default, as a CST's tone mapping in DaVinci.)
      const ref: LutRef = { id, name, input, output: same?.output ?? "display", tonemap: same?.tonemap ?? (input === "cineon709" || input === "gamma709"), ...(same?.driveId ? { driveId: same.driveId } : null) };
      rememberLut(id, name, input === "camera" ? "camera" : "look");
      onImported(ref);
      set({ lut: ref });
      onLutStored(id);
      if (!guessed && !same) setGuessNote(t("The file does not say what it expects: check the LUT's input below."));
    } catch (e) {
      setErr(t("This file is not a 3D LUT (.cube): {why}", { why: e instanceof Error ? e.message : String(e) }));
    }
  };
  /** A setting of the LUT chosen (its input, output, highlights): this video's (its file's), another video can use the
   *  same LUT another way; the library keeps the one a new video starts with. */
  const setLut = (patch: Partial<LutRef>) => { if (!g.lut) return; set({ lut: { ...g.lut, ...patch, kind: undefined } }); };
  const INPUTS: { id: LutInput; label: string }[] = [
    { id: "camera", label: t("The camera's log (S-Log3, Apple Log…)") },
    { id: "dwg", label: t("DaVinci Wide Gamut / Intermediate") },
    { id: "cineon709", label: t("Rec.709 / Cineon film log") },
    { id: "gamma709", label: t("Rec.709 / Gamma 2.4") },
  ];
  const inputShort = (l: LutRef) => ({ camera: t("camera log in"), dwg: t("DWG in"), cineon709: t("Cineon in"), gamma709: t("Rec.709 in") })[lutInputOf(l)];

  // A preset put on: the whole grade (camera profile, output LUT, settings, wheels). Its LUT found in the account's
  // library (its Drive copy); on a standard video, its profile and LUT turned on.
  const [mismatch, setMismatch] = useState<GradePreset | null>(null);
  const askPreset = (p: GradePreset) => {
    if (footage && gradeFootage(p.grade) !== footage) setMismatch(p);
    else applyPreset(p);
  };
  const applyPreset = (p: GradePreset) => {
    onRaw(false);
    const lib = p.grade.lut && luts.find((l) => l.id === p.grade.lut!.id);
    const lut = p.grade.lut ? { ...p.grade.lut, ...(lib?.driveId ? { driveId: lib.driveId } : null) } : undefined;
    // (the preset it comes from kept with it: saving that preset again offers to update this video, if not retouched)
    onChange({ ...p.grade, lut, sdrOverride: sdr && (p.grade.profile !== "rec709" || !!lut) ? true : p.grade.sdrOverride, preset: { id: p.id, key: lookKey(p.grade) } });
  };
  const presetsPart = (
    <Section id="color-presets" title={<>{t("Colour presets")}{grade && gradePresetOf(presets, grade) && <span className="sec-sub"> · {gradePresetOf(presets, grade)!.name}</span>}</>} open={false}>
      <GradePresets presets={presets} current={grade} onSave={onSavePreset} onApply={askPreset} onDelete={onDeletePreset} />
      {mismatch && footage && (
        <Modal title={t("This preset is not made for this video")} onClose={() => setMismatch(null)}>
          <p>{t("“{name}” was made for {preset} footage, and this video is {video}.", { name: mismatch.name, preset: FOOTAGE_LABEL[gradeFootage(mismatch.grade)], video: FOOTAGE_LABEL[footage] })}{" "}
            {gradeFootage(mismatch.grade) === "sdr"
              ? t("Its settings do not convert the camera's log: the picture would stay flat and washed out.")
              : footage === "sdr"
                ? t("It converts a log picture that this video does not have: the colours would come out far too contrasted and saturated.")
                : t("It converts another kind of picture than this video's: the colours would come out wrong.")}</p>
          <p className="muted xs">{t("We advise against it. You can still apply it, and undo it after.")}</p>
          <div className="modal-foot">
            <button className="btn" onClick={() => setMismatch(null)}>{t("Cancel")}</button>
            <button className="btn primary" onClick={() => { applyPreset(mismatch); setMismatch(null); }}>{t("Apply anyway")}</button>
          </div>
        </Modal>
      )}
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

  // Each part on / off (like a node bypassed in DaVinci): its settings stay, it changes nothing while off. The switch
  // sits in the part's title, a click on it never folds or unfolds the part.
  type Part = "corrections" | "wheels" | "effects" | "finish";
  const off = (p: Part) => !!g.bypass?.[p];
  const partSwitch = (p: Part) => (
    <span className="sec-switch" onClick={(e) => { e.preventDefault(); e.stopPropagation(); }} onKeyDown={(e) => e.stopPropagation()}>
      <Switch checked={!off(p)} title={off(p) ? t("Turned off: click to turn it back on") : t("On: click to turn this part off")}
        onChange={(v) => set({ bypass: { ...g.bypass, [p]: !v } })} />
    </span>
  );
  const fx = effectsOf(g);
  const colour = g.profile !== "none";
  // Standard footage: only the simple sliders, unless the camera profile and LUT were turned back on.
  const simple = !!sdr && !g.sdrOverride;
  return (
    <div className={"cg-parts" + (disabled ? " off" : "")} aria-disabled={disabled || undefined}>
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
            {/* The output: the app's own Rec.709, or a LUT, given what it expects in (as a CST before it in DaVinci). The
                grade above goes before it. */}
            <label className="field">
              <span className="row" style={{ gap: 6 }}>{t("Colour output")}<Hint text={t("Rec.709: the app's own neutral conversion. A LUT: the picture is turned into what it expects (its input, below) after your settings and wheels, as a CST before it in DaVinci.")} /></span>
              <Select className="input" value={g.lut?.id ?? ""} removeLabel={t("Delete this LUT")}
                onRemove={onRemoveLut ? (id) => { const l = luts.find((x) => x.id === id); if (l) onRemoveLut(l); } : undefined}
                onChange={(e) => { const l = luts.find((x) => x.id === e.target.value); setGuessNote(null); set({ lut: l ? { ...l } : undefined }); }}>
                <option value="">{t("Rec.709 (the app's own conversion)")}</option>
                {luts.map((l) => <option key={l.id} value={l.id}>{`${l.name} · ${inputShort(l)}`}</option>)}
                {g.lut && !luts.some((l) => l.id === g.lut!.id) && <option value={g.lut.id}>{g.lut.name}</option>}
              </Select>
            </label>
            {/* The LUT chosen: what it expects in, what it gives out, its highlights eased in (its own, for every video). */}
            {g.lut && (
              <div className="stack lut-cst">
                <label className="field">{t("The LUT expects")}
                  <Select className="input sm" value={lutInputOf(g.lut)} onChange={(e) => { const input = e.target.value as LutInput; setGuessNote(null); setLut({ input, kind: undefined, tonemap: input === "cineon709" || input === "gamma709" ? true : undefined }); }}>
                    {INPUTS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                  </Select>
                </label>
                {lutInputOf(g.lut) !== "gamma709" && (
                  <label className="field">{t("The LUT gives")}
                    <Select className="input sm" value={g.lut.output ?? "display"} onChange={(e) => setLut({ output: e.target.value as LutRef["output"] })}>
                      <option value="display">{t("The final picture (Rec.709)")}</option>
                      <option value="same">{t("The same space (then the app's Rec.709)")}</option>
                    </Select>
                  </label>
                )}
                {(lutInputOf(g.lut) === "cineon709" || lutInputOf(g.lut) === "gamma709") && (
                  <div className="row">
                    <span className="grow">{t("Ease the highlights in")}</span>
                    <Hint text={t("As the tone mapping of a CST in DaVinci: the brightest light bent smoothly into the LUT's range instead of clipped. Close to DaVinci's, not the very same curve.")} />
                    <Switch checked={!!g.lut.tonemap} onChange={(v) => setLut({ tonemap: v })} title={t("Ease the highlights in")} />
                  </div>
                )}
                {guessNote && <p className="notice warn xs">{guessNote}</p>}
                <p className="muted xs">{t("These settings are this video's: another video can use the same LUT another way.")}</p>
              </div>
            )}
            <div className="row">
              <label className="btn sm">
                {t("Import a LUT (.cube)")}
                <input type="file" accept=".cube" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importLut(f); e.target.value = ""; }} />
              </label>
            </div>
            {(err || lookErr) && <p className="notice warn xs">{err ?? lookErr}</p>}
          </>
        )}
      </fieldset>
      </Section>

      {colour && (
        <Section id="color-corrections" title={<>{t("Corrections")}{off("corrections") && <span className="sec-sub"> · {t("off")}</span>}{partSwitch("corrections")}</>} open={false}>
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
        <Section id="color-wheels" title={<>{t("Colour wheels")}{off("wheels") ? <span className="sec-sub"> · {t("off")}</span> : wheelsOn(g) && <span className="sec-sub"> · {t("on")}</span>}{partSwitch("wheels")}</>} open={false}>
          <ColorWheels wheels={g.wheels ?? {}} onChange={(wheels) => set({ wheels })} />
        </Section>
      )}


    </div>
  );
}

/** The kind of footage a grade is made for: log (a log camera profile, or a LUT that expects the camera's log), HDR
 *  (HLG / PQ), else standard SDR. */
export type Footage = "sdr" | "log" | "hdr";
export const gradeFootage = (g: VideoGrade): Footage =>
  g.profile === "hlg" || g.profile === "pq" ? "hdr"
    : g.profile === "slog3" || g.profile === "slog3-cine" || g.profile === "applelog" || (g.lut && lutInputOf(g.lut) === "camera") ? "log" : "sdr";
const FOOTAGE_LABEL: Record<Footage, string> = { sdr: "SDR", log: "LOG", hdr: "HDR" };

/** The same look (the camera profile apart: it is the video's own). */
export const lookKey = (g: VideoGrade) => JSON.stringify([g.bypass ?? null, g.profile, g.lut?.id ?? null, g.exposure, g.contrast, g.pivot ?? null, g.temp, g.tint, g.sat, g.vignette, g.vignetteSize, g.grain, g.grainSize, wheelsOn(g) ? g.wheels : null, effectsOn(g) ? effectsOf(g) : null]);
export const gradePresetOf = (presets: GradePreset[], g: VideoGrade) => presets.find((p) => lookKey(p.grade) === lookKey(g));

/** The colour presets, as the text's: a name and "Save the current colour", then each one to put on, or delete. */
function GradePresets({ presets, current, onSave, onApply, onDelete }: {
  presets: GradePreset[]; current?: VideoGrade; onSave: (name: string) => void; onApply: (p: GradePreset) => void; onDelete: (id: string) => void;
}) {
  const { t } = useT();
  const [name, setName] = useState("");
  const save = () => { const n = name.trim(); if (n) { onSave(n); setName(""); } };
  const clash = presetNamed(presets, name);
  return (
    <div className="stack">
      {current && (
        <form className="row nowrap" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <input className="input sm grow" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("Preset name")} aria-label={t("Preset name")} maxLength={60} />
          <button className="btn sm" type="submit" disabled={!name.trim()} title={t("Save the current colour")}>{clash ? t("Replace") : t("Save")}</button>
        </form>
      )}
      {current && clash && <p className="notice warn xs">{t("A preset “{name}” exists already: it will be replaced.", { name: clash.name })}</p>}
      {!presets.length && <span className="muted xs">{t("No presets yet.")}</span>}
      {presets.map((p) => {
        const on = !!current && lookKey(p.grade) === lookKey(current);
        return (
          <div className="row nowrap" key={p.id}>
            <button className={"btn sm grow preset grade-preset" + (on ? " on" : "")} onClick={() => onApply(p)} title={on ? t("This is the colour now") : t("Apply")} aria-pressed={on}>
              {on && <Icon name="check" size={13} />}
              <span className="truncate">{p.name}</span>
              <span className={"preset-kind " + gradeFootage(p.grade)} title={t("Made for {kind} footage", { kind: FOOTAGE_LABEL[gradeFootage(p.grade)] })}>{FOOTAGE_LABEL[gradeFootage(p.grade)]}</span>
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

/**
 * The post's effects and finish (Black Mist, Halation, Haze; vignette, grain): once on the whole picture, every video of
 * the post (the multicam's shots, the ones over it) — set here for the post, never a video's own.
 */
export function FinishParts({ look, onChange }: { look: FinishLook; onChange: (f: FinishLook) => void }) {
  const { t, lang } = useT();
  const g = finishGrade(look);
  const set = (patch: Partial<VideoGrade>) => onChange({ ...look, ...patch });
  type Part = "effects" | "finish";
  const off = (p: Part) => !!look.bypass?.[p];
  const partSwitch = (p: Part) => (
    <span className="sec-switch" onClick={(e) => { e.preventDefault(); e.stopPropagation(); }} onKeyDown={(e) => e.stopPropagation()}>
      <Switch checked={!off(p)} title={off(p) ? t("Turned off: click to turn it back on") : t("On: click to turn this part off")}
        onChange={(v) => onChange({ ...look, bypass: { ...look.bypass, [p]: !v } })} />
    </span>
  );
  const fx = effectsOf(g);
  const num = (v: number, d: number) => v.toFixed(d).replace(".", lang === "fr" ? "," : ".");
  return (
    <div className="cg-parts">
      <Section id="color-effects" title={<>{t("Effects")}{off("effects") ? <span className="sec-sub"> · {t("off")}</span> : effectsOn(g) && <span className="sec-sub"> · {t("on")}</span>}{partSwitch("effects")}</>} open={false}>
        <div className="row" style={{ gap: 6 }}>{t("Black Mist")}<Hint text={t("A diffusion filter, as a Black Mist on the lens: part of the light spreads around it, a glow next to the lights, softer highlights and contrast.")} /></div>
        <Range label={t("Strength")} value={fx.mist} display={`${fx.mist}`} min={0} max={100}
          onChange={(v) => set({ mist: v })} onReset={() => set({ mist: 0 })} />
        {fx.mist > 0 && (<>
          <Range label={t("Glow size")} value={fx.mistSize} display={`${fx.mistSize}`} min={0} max={100}
            onChange={(v) => set({ mistSize: v })} onReset={() => set({ mistSize: 50 })} />
          <Range label={t("Threshold")} value={fx.mistThreshold} display={`${fx.mistThreshold}`} min={0} max={100}
            onChange={(v) => set({ mistThreshold: v })} onReset={() => set({ mistThreshold: 40 })} />
        </>)}
        <div className="row" style={{ gap: 6 }}>{t("Halation")}<Hint text={t("As on film: a red-orange fringe around the strongest lights (a lamp, the sun, a reflection).")} /></div>
        <Range label={t("Strength")} value={fx.halation} display={`${fx.halation}`} min={0} max={100}
          onChange={(v) => set({ halation: v })} onReset={() => set({ halation: 0 })} />
        {fx.halation > 0 && (<>
          <Range label={t("Size")} value={fx.halationSize} display={`${fx.halationSize}`} min={0} max={100}
            onChange={(v) => set({ halationSize: v })} onReset={() => set({ halationSize: 40 })} />
          <Range label={t("Threshold")} value={fx.halationThreshold} display={`${fx.halationThreshold}`} min={0} max={100}
            onChange={(v) => set({ halationThreshold: v })} onReset={() => set({ halationThreshold: 70 })} />
        </>)}
        <div className="row" style={{ gap: 6 }}>{t("Haze")}<Hint text={t("A cinematic fog: denser towards the top of the frame and over the bright, flat parts (sky, background), lit by the scene's own light.")} /></div>
        <Range label={t("Density")} value={fx.haze} display={`${fx.haze}`} min={0} max={100}
          onChange={(v) => set({ haze: v })} onReset={() => set({ haze: 0 })} />
        {fx.haze > 0 && (<>
          <Range label={t("Towards the top")} value={fx.hazeHeight} display={`${fx.hazeHeight}`} min={0} max={100}
            onChange={(v) => set({ hazeHeight: v })} onReset={() => set({ hazeHeight: 60 })} />
          <Range label={t("Tone")} value={fx.hazeTone} display={`${fx.hazeTone > 0 ? "+" : ""}${fx.hazeTone}`} min={-100} max={100}
            onChange={(v) => set({ hazeTone: v })} onReset={() => set({ hazeTone: 0 })} />
        </>)}
      </Section>
      <Section id="color-finish" title={<>{t("Finish")}{off("finish") && <span className="sec-sub"> · {t("off")}</span>}{partSwitch("finish")}</>} open={false}>
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
    </div>
  );
}
