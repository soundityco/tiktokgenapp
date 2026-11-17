import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // A second dev server for automated UI tests (its own build folder, beside the usual one): NEXT_DIST_DIR=.next-test.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // `npm run dev` opened from a phone on the same Wi-Fi (http://192.168.x.x:3000): allowed in development only.
  allowedDevOrigins: ["192.168.*.*", "10.*.*.*", "172.*.*.*", "*.local"],
  // Basic hardening: no framing of the app (clickjacking), no MIME sniffing, no full URLs leaked to
  // other sites, no camera / microphone / location for any embedded content.
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ],
    }];
  },
  webpack(config) {
    config.resolve.alias["@"] = root;
    return config;
  },
};
export default nextConfig;
