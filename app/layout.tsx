import type { Metadata, Viewport } from "next";
import "./globals.css";
import { I18nProvider } from "@/lib/i18n";

export const metadata: Metadata = { title: "TkTgen", description: "TikTok carousel generator for artists" };
export const viewport: Viewport = { themeColor: "#09090c", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body><I18nProvider>{children}</I18nProvider></body>
    </html>
  );
}
