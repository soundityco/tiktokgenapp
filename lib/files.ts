/** The little things every export shares: its date in the name, a name any system takes, the download itself. */

/** "2026-11-12 14-05": the date and time at the end of an exported file's name (`timeSep` "h" for a folder: 14h05). */
export function stamp(timeSep = "-", d = new Date()): string {
  const z = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}${timeSep}${z(d.getMinutes())}`;
}

/** A file or folder name without the characters a system refuses (/ \ : * ? " < > |). */
export const safeName = (s: string, fallback = "Rollout") => s.replace(/[\\/:*?"<>|]+/g, "-").trim() || fallback;

/** Downloads a file made in the page. */
export function saveBlob(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
