/**
 * A file the server passes on (a found picture, a TikTok cover, a file shared to the phone) comes from outside: it
 * must never run as a page of the app (an HTML or SVG file opened at its address would see the signed-in account).
 * Only the kinds of files the app uses keep their type, and the answer is sandboxed whatever it holds.
 */
const PICTURE = /^image\/(jpeg|png|webp|gif|avif|heic|heif|bmp|tiff)$/i;
const MEDIA = /^(video\/(mp4|quicktime|webm)|audio\/(mpeg|mp4|aac|wav|x-wav|ogg|flac)|text\/plain)$/i;

const typeOf = (raw: string) => raw.split(";")[0].trim().toLowerCase();

/** A picture the app can draw (no SVG: it may hold scripts). */
export const isPicture = (type: string) => PICTURE.test(typeOf(type));

/** The type to answer with: the file's own when it is a known picture or media, else plain bytes. */
export const safeType = (type: string) => {
  const t = typeOf(type);
  return PICTURE.test(t) || MEDIA.test(t) ? t : "application/octet-stream";
};

/** Headers of a passed-on file: its (safe) type, never sniffed, never run (sandboxed, no scripts, no requests). */
export const fileHeaders = (type: string, more: Record<string, string> = {}): Record<string, string> => ({
  "Content-Type": safeType(type),
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; media-src 'self'; sandbox",
  ...more,
});
