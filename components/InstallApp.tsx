"use client";
import { useEffect } from "react";

/** Registers the service worker, so Chrome offers "Install TkTgen" (address bar icon, or menu ⋮ → Install). */
export default function InstallApp() {
  useEffect(() => {
    if (!("serviceWorker" in navigator) || location.hostname === "localhost") return;
    navigator.serviceWorker.register("/sw.js").catch(() => { /* not installable here: the site works the same */ });
  }, []);
  return null;
}
