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
  applicationName: "Tank CTF",
  // Added to the home screen on iPhone: open without Safari's bars.
  appleWebApp: { capable: true, title: "Tank CTF", statusBarStyle: "black-translucent" },
};

// viewportFit "cover" lets the game use the whole screen; the page keeps clear of the
// notch and home bar with env(safe-area-inset-*).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#0b1030",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}
