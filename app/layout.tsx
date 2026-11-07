import type { Metadata, Viewport } from "next";
import "./globals.css";
import { I18nProvider } from "@/lib/i18n";
import InstallApp from "@/components/InstallApp";

export const metadata: Metadata = {
  title: "Rollout",
  description: "TikTok carousel generator for artists",
  appleWebApp: { capable: true, title: "Rollout", statusBarStyle: "black-translucent" },
  icons: { icon: "/icon.svg", apple: "/apple-touch-icon.png" },
  // Google Search Console: proves the site is ours (needed by the Google sign-in branding verification).
  verification: { google: "BQ3-MxnDZrpy5NSr_JF-jjRk3JXlPjV9lFkdp7r82jU" },
};
// viewportFit: the app fills the whole screen of a phone (under the notch), its bars keep clear of it.
export const viewport: Viewport = { themeColor: "#08080a", width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body><I18nProvider>{children}</I18nProvider><InstallApp /></body>
    </html>
  );
}
