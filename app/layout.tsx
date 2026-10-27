import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "TkTgen", description: "TikTok carousel generator for artists" };
export const viewport: Viewport = { themeColor: "#09090c", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
