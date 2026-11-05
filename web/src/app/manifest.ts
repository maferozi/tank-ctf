import type { MetadataRoute } from "next";

// Installed as an app ("Add to home screen"), the game opens fullscreen and sideways.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Tank CTF",
    short_name: "Tank CTF",
    description: "One-button online capture the flag for friends.",
    start_url: "/",
    display: "fullscreen",
    orientation: "landscape",
    background_color: "#0b1030",
    theme_color: "#0b1030",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
