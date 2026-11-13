"use client";
import { createContext, useContext, useEffect, useState } from "react";

import { Lang, translate, detectLang } from "./translate";
export { translate, detectLang };
export type { Lang };

interface Ctx { lang: Lang; setLang: (l: Lang) => void; t: (k: string, v?: Record<string, string | number>) => string }
const I18n = createContext<Ctx>({ lang: "en", setLang: () => {}, t: (k) => k });

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>("en");
  useEffect(() => {
    let saved: string | null = null;
    try { saved = localStorage.getItem("tktgen-lang"); } catch { /* storage blocked: the browser's language */ }
    setLangState(saved === "fr" || saved === "en" ? saved : detectLang(navigator.language));
  }, []);
  const setLang = (l: Lang) => { setLangState(l); try { localStorage.setItem("tktgen-lang", l); } catch { /* private mode */ } document.documentElement.lang = l; };
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  return <I18n.Provider value={{ lang, setLang, t: (k, v) => translate(lang, k, v) }}>{children}</I18n.Provider>;
}

export const useT = () => useContext(I18n);
