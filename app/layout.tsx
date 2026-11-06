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
export const viewport: Viewport = { themeColor: "#09090c", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body><I18nProvider>{children}</I18nProvider><InstallApp /></body>
    </html>
  );
}
