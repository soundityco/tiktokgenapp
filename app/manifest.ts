import type { MetadataRoute } from "next";

/** Installable app (Chrome, Edge: "Install TkTgen"): its own window, its icon in the dock / taskbar. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/studio",
    name: "TkTgen",
    short_name: "TkTgen",
    description: "TikTok carousels and lyric videos for music artists",
    start_url: "/studio",
    scope: "/",
    display: "standalone",
    display_override: ["window-controls-overlay", "standalone"],
    background_color: "#09090c",
    theme_color: "#09090c",
    categories: ["music", "productivity", "photo"],
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  };
}
