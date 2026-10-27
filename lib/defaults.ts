import { FontId, PicSettings, Project, SlideCfg, TextPool, PicPool, TextStyle, Workspace } from "./types";

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const defaultStyle = (): TextStyle => ({
  font: "classic",
  look: "outline",
  case: "asis",
  size: 64,
  width: 80,
  lineHeight: 1.15,
  align: "center",
  color: "#ffffff",
  accent: "#000000",
  x: 50,
  y: 50,
});

export const defaultPic = (): PicSettings => ({ framing: "fill", bars: "blur", zoom: 1, darken: 0, ox: 0, oy: 0 });

export const FONT_LABELS: Record<FontId, string> = {
  classic: "TikTok (Classic)",
  bold: "TikTok Bold",
  clean: "Clean",
  heavy: "Heavy",
  condensed: "Condensed",
  impact: "Impact",
  serif: "Serif",
  serifItalic: "Serif italic",
  typewriter: "Typewriter",
};

export function newSlide(n: number, textPoolId: string | null, picPoolId: string | null, lyrics = false): SlideCfg {
  return {
    id: uid(),
    format: "9:16",
    textSource: lyrics ? { kind: "lyrics" } : textPoolId ? { kind: "pool", poolId: textPoolId } : { kind: "none" },
    picPoolId,
    pic: defaultPic(),
    style: defaultStyle(),
  };
}

export function slidePools(n: number): { text: TextPool; pics: PicPool } {
  return {
    text: { id: uid(), name: `Slide ${n} text`, scope: "shared", kind: "hooks", text: "" },
    pics: { id: uid(), name: `Slide ${n} pictures`, scope: "shared", pics: [] },
  };
}

export function newProject(name: string, textPools: TextPool[], picPools: PicPool[]): Project {
  // One slide per default pair of shared pools (slide 1 and 2), slide 3 reads the lyrics.
  const slides: SlideCfg[] = [0, 1, 2].map((i) =>
    newSlide(i + 1, i < 2 ? textPools[i]?.id ?? null : null, picPools[i]?.id ?? null, i === 2)
  );
  return { id: uid(), name, slides, lyrics: [], lyricsSectionId: null, generated: null, selectedSlide: 0 };
}

export function defaultWorkspace(): Workspace {
  const textPools: TextPool[] = [];
  const picPools: PicPool[] = [];
  for (let i = 1; i <= 3; i++) {
    const p = slidePools(i);
    if (i < 3) textPools.push(p.text); // slide 3 uses the project's lyrics
    picPools.push(p.pics);
  }
  const project = newProject("My first release", textPools, picPools);
  return {
    v: 1,
    projects: [project],
    currentProjectId: project.id,
    textPools,
    picPools,
    noRepeat: true,
    bags: {},
    exportFormat: "jpg",
    zones: false,
  };
}
