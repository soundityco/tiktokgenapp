import { FontId, PicSettings, Project, SlideCfg, TextPool, PicPool, TextStyle, VideoSettings, VideoSetup, Workspace } from "./types";

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const defaultStyle = (): TextStyle => ({
  font: "classic",
  look: "outline",
  case: "asis",
  size: 56,
  width: 70,
  lineHeight: 1.15,
  align: "center",
  color: "#ffffff",
  accent: "#000000",
  x: 50,
  y: 50,
});

/** Lyrics of the video studio: white with a black outline, lower case, in the lower third. */
export const defaultCaptionStyle = (font?: Pick<TextStyle, "font" | "customFont">): TextStyle => ({
  ...defaultStyle(),
  ...(font ? { font: font.font, ...(font.customFont ? { customFont: font.customFont } : {}) } : {}),
  case: "lower",
  stroke: 20,
  width: 80,
  y: 70,
});

export const defaultPic = (): PicSettings => ({ framing: "fill", bars: "blur", zoom: 1, darken: 0, ox: 0, oy: 0 });

export const defaultVideo = (): VideoSettings => ({
  crop: { start: 0, duration: 15 },
  offset: 0,
  captions: true,
  frame: { zoom: 1, ox: 0, oy: 0 },
});

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

/** Default shared photo list of a slide. Older workspaces call it "pictures". */
export const isSlidePhotoList = (name: string, n: number) => name === `Slide ${n} photos` || name === `Slide ${n} pictures`;

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
    // The first slide opens the post with a hook; the next ones carry the other texts.
    text: { id: uid(), name: `Slide ${n} text`, scope: "shared", kind: n === 1 ? "hooks" : "texts", text: "" },
    pics: { id: uid(), name: `Slide ${n} photos`, scope: "shared", pics: [] },
  };
}

export function newProject(name: string, textPools: TextPool[], picPools: PicPool[]): Project {
  // One slide per default pair of shared pools (slide 1 and 2), slide 3 reads the lyrics.
  const slides: SlideCfg[] = [0, 1, 2].map((i) =>
    newSlide(i + 1, i < 2 ? textPools[i]?.id ?? null : null, picPools[i]?.id ?? null, i === 2)
  );
  const videoId = uid();
  return {
    id: uid(), name, slides, lyrics: [], lyricsSectionId: null, generated: null, selectedSlide: 0,
    videos: [{ ...defaultVideo(), id: videoId, name: "Video 1" }],
    videoId,
  };
}

/** Old workspaces had one `project.video`; turn it into the first clip of the release. */
/** A list of one text per line (a hook list or a texts list): the same editor, themes and draws. */
export const isLineList = (p: Pick<TextPool, "kind">) => p.kind === "hooks" || p.kind === "texts";

/** Once: the lists made before the roles were all "hooks". Those named like transitions, and the default lists of
 *  the slides after the first ("Slide 2 text"…), become texts; the artist changes the others in the list's editor. */
export function textRoles(pools: TextPool[]): TextPool[] {
  return pools.map((p) => {
    if (p.kind !== "hooks") return p;
    const slide = /^slide\s*(\d+)\s*text$/i.exec(p.name.trim());
    return /transition/i.test(p.name) || (slide && Number(slide[1]) > 1) ? { ...p, kind: "texts" } : p;
  });
}

export function normalizeWorkspace(w: Workspace): Workspace {
  return {
    ...w,
    ...(w.textRolesV1 ? {} : { textPools: textRoles(w.textPools), textRolesV1: true }),
    projects: w.projects.map((p) => {
      const videos: VideoSetup[] = p.videos?.length
        ? p.videos
        : [{ ...defaultVideo(), ...(p.video ?? {}), id: p.id, name: "Video 1" }];
      const videoId = p.videoId && videos.some((v) => v.id === p.videoId) ? p.videoId : videos[0].id;
      const next: Project = { ...p, videos, videoId };
      if (next.video) delete next.video;
      return next;
    }),
  };
}

/** Names of a new account's first lists, in the user's language (given by the app). */
export interface StarterNames { release: string; hooks: string; transitions: string; captions: string; pics: [string, string, string] }

export function defaultWorkspace(names?: StarterNames): Workspace {
  const textPools: TextPool[] = [];
  const picPools: PicPool[] = [];
  for (let i = 1; i <= 3; i++) {
    const p = slidePools(i);
    // Lists an artist uses for real: the hooks (slide 1), the transitions (slide 2), photos by kind.
    if (names) {
      p.text.name = i === 1 ? names.hooks : names.transitions;
      p.pics.name = names.pics[i - 1];
    }
    if (i < 3) textPools.push(p.text); // slide 3 uses the project's lyrics
    picPools.push(p.pics);
  }
  // The post's captions, empty (its editor shows an example).
  const captions: TextPool = { id: uid(), name: names?.captions ?? "Captions", scope: "shared", kind: "captions", text: "" };
  textPools.push(captions);
  const project = { ...newProject(names?.release ?? "My first release", textPools, picPools), captionPoolId: captions.id };
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
    textRolesV1: true,
  };
}
