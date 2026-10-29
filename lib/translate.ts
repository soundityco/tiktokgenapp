import { FR } from "./fr";

export type Lang = "en" | "fr";

/** English text is the key. Missing French entries fall back to English. `{name}` placeholders are interpolated. */
export function translate(lang: Lang, key: string, vars?: Record<string, string | number>): string {
  let s = (lang === "fr" && FR[key]) || key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  // Singular: "1 photos" -> "1 photo", "1 textes" -> "1 texte" (same rule in English and French for these words).
  return s.replace(/\b1 (photo|text|texte|slide|post|vue|view|hook|screenshot|capture)s\b/g, "1 $1");
}

export const detectLang = (header?: string | null): Lang =>
  /^fr/i.test((header ?? "").trim()) ? "fr" : "en";

