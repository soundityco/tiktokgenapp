"use client";
import { useEffect } from "react";
import { desktopApp } from "@/lib/desktop";

/**
 * The desktop app without its title bar (desktop/, 1.1.0 on): the page marks <html> (desk-inset, desk-darwin / desk-win32,
 * desk-full in full screen) so its top bar drags the window and leaves room to the window's buttons (globals.css).
 * Nothing in a browser, nor in an older app (it still has its title bar).
 */
export default function DesktopFrame() {
  useEffect(() => {
    const app = desktopApp();
    if (!app || app.frame !== "inset") return;
    const html = document.documentElement;
    html.classList.add("desk-inset", "desk-" + app.platform);
    html.classList.toggle("desk-full", !!app.full);
    app.onFullScreen?.((on) => html.classList.toggle("desk-full", on));
  }, []);
  return null;
}
