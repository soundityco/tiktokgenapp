/**
 * Demo mode (?demo in the address): the app as a brand-new account sees it, to check the first steps. The data
 * lives in memory only: nothing is saved to the server nor written to the Drive (no audio, LUT, copy, photo, font
 * upload); a reload starts again from a blank account. The real account is never touched.
 */
export const isDemo = (): boolean => typeof window !== "undefined" && new URLSearchParams(window.location.search).has("demo");
