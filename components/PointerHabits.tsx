"use client";
import { useEffect } from "react";

/**
 * How the app is used, for the whole page:
 * - with the pointer (a click, a tap), no focus ring shows where it went (some browsers draw one after a click); the
 *   Tab key brings them back, for the keyboard;
 * - the browser's own right-click menu is off (the app makes its own where it helps: a photo of a list), except in a
 *   text field (copy, paste, spelling).
 */
export default function PointerHabits() {
  useEffect(() => {
    const root = document.documentElement;
    const pointer = () => root.classList.add("by-pointer");
    const key = (e: KeyboardEvent) => { if (e.key === "Tab") root.classList.remove("by-pointer"); };
    const menu = (e: MouseEvent) => {
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (el && (el.isContentEditable || el.closest("input, textarea, [contenteditable=true]"))) return;
      e.preventDefault();
    };
    pointer();
    window.addEventListener("pointerdown", pointer, true);
    window.addEventListener("keydown", key, true);
    document.addEventListener("contextmenu", menu);
    return () => { window.removeEventListener("pointerdown", pointer, true); window.removeEventListener("keydown", key, true); document.removeEventListener("contextmenu", menu); };
  }, []);
  return null;
}
