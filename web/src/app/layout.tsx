import type { Metadata, Viewport } from "next";
import { Lilita_One, Nunito } from "next/font/google";
import "./globals.css";

// Lilita One: chunky display face for titles, buttons and the in-game banners.
// Nunito: rounded body text.
const display = Lilita_One({ weight: "400", subsets: ["latin"], variable: "--font-display" });
const body = Nunito({ subsets: ["latin"], variable: "--font-body" });

export const metadata: Metadata = {
  title: "Tank CTF",
  description: "One-button online capture the flag for friends.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#45a8f5",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}
