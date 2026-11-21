import type { Metadata, Viewport } from "next";
import "./globals.css";
import { I18nProvider } from "@/lib/i18n";
import InstallApp from "@/components/InstallApp";
import PointerHabits from "@/components/PointerHabits";
import Tooltips from "@/components/Tooltips";
import UpdatePill from "@/components/UpdatePill";

export const metadata: Metadata = {
  title: "RAW by aurare",
  description: "TikTok carousel generator for artists",
  appleWebApp: { capable: true, title: "RAW", statusBarStyle: "black-translucent" },
  icons: { icon: "/icon.svg", apple: "/apple-touch-icon.png" },
  // Google Search Console: proves the site is ours (needed by the Google sign-in branding verification).
  verification: { google: "BQ3-MxnDZrpy5NSr_JF-jjRk3JXlPjV9lFkdp7r82jU" },
};
// viewportFit: the app fills the whole screen of a phone (under the notch), its bars keep clear of it.
// colorScheme dark: the browser paints its own background, scrollbars and controls dark from the very first frame (no
// white flash before the styles).
export const viewport: Viewport = { themeColor: "#08080a", colorScheme: "dark", width: "device-width", initialScale: 1, viewportFit: "cover" };

const FIRST_FONTS = ["tiktok-sans-latin-wght-normal.woff2", "jetbrains-mono-latin-wght-normal.woff2", "instrument-serif-latin-400-normal.woff2", "instrument-serif-latin-400-italic.woff2"];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      {/* The first screen's fonts, fetched with the page (see globals.css): no text jumping once they arrive. */}
      <head>
        {FIRST_FONTS.map((f) => <link key={f} rel="preload" href={`/fonts/${f}`} as="font" type="font/woff2" crossOrigin="anonymous" />)}
      </head>
      <body><I18nProvider>{children}<UpdatePill /></I18nProvider><InstallApp /><PointerHabits /><Tooltips /></body>
    </html>
  );
}
