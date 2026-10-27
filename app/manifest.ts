import type { MetadataRoute } from "next";
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "TkTgen",
    short_name: "TkTgen",
    start_url: "/studio",
    display: "standalone",
    background_color: "#09090c",
    theme_color: "#09090c",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
