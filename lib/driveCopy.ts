/**
 * A video's Drive working copy made and sent, outside the video studio: "Make every Drive copy again" runs it in the
 * background over the whole account, the artist staying on what they are working on (never sent to another release).
 * The same copy as the studio's own (`makeCopy` in VideoStudio): the device's video chip first, ffmpeg when it cannot.
 */
import { copyPlanFor, makeWorkCopy } from "./convert";
import { DRIVE_PATHS, uploadToDrive } from "./drive";
import { COPY_VERSION, fastWorkCopy } from "./fastCopy";
import { safeName } from "./files";
import type { VideoSetup } from "./types";

/** One copy at a time on this page (the studio's and the background ones): they wait for each other. */
export const copyBusy = { on: false };

/** The passage of the file a copy holds: what falls on the song where the video is placed (its part kept), ±0.5 s. */
export function copySpan(offset: number, span: [number, number], dur: number, song = Infinity): [number, number] {
  const a = Math.max(0, span[0], -offset), b = Math.min(dur, span[1], song - offset);
  return [Math.max(0, a - 0.5), Math.min(dur, b + 0.5)];
}

/** A copy is named as its camera file (an MP4). */
export const copyFileName = (c: Pick<VideoSetup, "videoName" | "name">) => safeName(`${(c.videoName ?? c.name).replace(/\.[^.]+$/, "")}.mp4`);

/** The copy as saved on the video (`VideoSetup.drive.copy`). */
export type DriveCopy = NonNullable<NonNullable<VideoSetup["drive"]>["copy"]>;

/** Made and sent; `onStep`: making, then sending, each from 0 to 1. */
export async function makeDriveCopy(o: {
  c: VideoSetup; blob: Blob; from: number; to: number; release: { id: string; name: string };
  onStep: (step: "make" | "send", p: number) => void; signal: AbortSignal;
}): Promise<DriveCopy> {
  const { c, blob, from, to, release, onStep, signal } = o;
  const plan = copyPlanFor(c.source);
  let copy: Blob | null = null;
  try {
    const fast = await fastWorkCopy(blob, plan, from, to, (p) => onStep("make", p), signal);
    if (fast) copy = fast.blob;
  } catch (e) {
    if (signal.aborted) throw e;
    console.warn("[copy] video chip failed, ffmpeg instead", e);
  }
  copy ??= await makeWorkCopy(blob, plan, from, to, (p) => onStep("make", p), signal);
  onStep("send", 0);
  const id = await uploadToDrive(copy, copyFileName(c), (p) => onStep("send", p), signal, "video/mp4",
    { tktgen: "copy", clip: c.id, project: release.id, from: from.toFixed(3), to: to.toFixed(3), of: String(blob.size), bits: plan.tenBit ? "10" : "8" },
    DRIVE_PATHS.videos(release.name || "Release"));
  return { id, from, to, of: blob.size, size: copy.size, tenBit: plan.tenBit, q: COPY_VERSION };
}
