"use client";
import { useEffect } from "react";

/**
 * How the app is used, for the whole page:
 * - with the pointer (a click, a tap), no focus ring shows where it went (some browsers draw one after a click); the
 *   Tab key brings them back, for the keyboard;
 * - the browser's own right-click menu is off (the app makes its own where it helps: a photo of a list), except in a
 *   text field (copy, paste, spelling);
 * - a file let go outside a drop zone is not opened by the browser in place of the app (the video, the photo
 *   replacing the page): refused, the cursor says so;
 * - in the studio, a pinch on the trackpad (Ctrl + wheel, Safari's gestures) never zooms the whole page as a web page
 *   would (the timeline and the preview use it for their own zoom first).
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
    const over = (e: DragEvent) => { if (!e.defaultPrevented && e.dataTransfer?.types.includes("Files")) { e.preventDefault(); e.dataTransfer.dropEffect = "none"; } };
    const drop = (e: DragEvent) => { if (!e.defaultPrevented && e.dataTransfer?.types.includes("Files")) e.preventDefault(); };
    const inStudio = () => location.pathname.startsWith("/studio");
    const wheel = (e: WheelEvent) => { if (e.ctrlKey && inStudio()) e.preventDefault(); };
    const gesture = (e: Event) => { if (inStudio()) e.preventDefault(); };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    window.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("gesturestart", gesture);
    window.addEventListener("gesturechange", gesture);
    pointer();
    window.addEventListener("pointerdown", pointer, true);
    window.addEventListener("keydown", key, true);
    document.addEventListener("contextmenu", menu);
    return () => { window.removeEventListener("pointerdown", pointer, true); window.removeEventListener("keydown", key, true); document.removeEventListener("contextmenu", menu);
      window.removeEventListener("dragover", over); window.removeEventListener("drop", drop); window.removeEventListener("wheel", wheel);
      window.removeEventListener("gesturestart", gesture); window.removeEventListener("gesturechange", gesture); };
  }, []);
  return null;
}
