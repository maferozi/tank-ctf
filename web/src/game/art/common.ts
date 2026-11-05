import type { Team } from "@tank/shared";

// Shared look for everything drawn in the game: one ink colour for outlines, team colours,
// the page's fonts, and a helper that paints a sprite once into an offscreen canvas.

export const INK = "#1b2033"; // thick dark outline on everything (cartoon style)

export interface TeamColors {
  body: string; // main fill
  light: string; // highlights, bullet streaks, splats
  dark: string; // shading, sleeves, rims
  glow: string; // translucent halo
}

export const TEAM: Record<Team, TeamColors> = {
  red: { body: "#f0383f", light: "#ff9c8f", dark: "#a81d2a", glow: "rgba(255, 70, 70, 0.35)" },
  blue: { body: "#2f7dff", light: "#9fd2ff", dark: "#1748b0", glow: "rgba(60, 140, 255, 0.35)" },
};

// Sprites are painted at this many pixels per map pixel, so they stay crisp when the map is
// drawn larger than 1:1 (desktop, high-density phones).
export const SPRITE_SCALE = 2;

export interface Sprite {
  canvas: HTMLCanvasElement;
  ox: number; // where the sprite's origin (e.g. a soldier's centre) is, in map pixels from its left
  oy: number;
  w: number; // size in map pixels
  h: number;
}

// Paints `draw` once into an offscreen canvas of w x h map pixels, with the origin at (ox, oy).
export function makeSprite(w: number, h: number, ox: number, oy: number, draw: (g: CanvasRenderingContext2D) => void, scale = SPRITE_SCALE): Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(w * scale);
  canvas.height = Math.ceil(h * scale);
  const g = canvas.getContext("2d")!;
  g.scale(scale, scale);
  g.translate(ox, oy);
  g.lineJoin = "round";
  g.lineCap = "round";
  draw(g);
  return { canvas, ox, oy, w, h };
}

// Draws a sprite with its origin at the context's current (0, 0).
export function blit(ctx: CanvasRenderingContext2D, s: Sprite, scale = 1): void {
  ctx.drawImage(s.canvas, -s.ox * scale, -s.oy * scale, s.w * scale, s.h * scale);
}

// Draws a sprite with its origin at (x, y), no rotation.
export function blitAt(ctx: CanvasRenderingContext2D, s: Sprite, x: number, y: number, scale = 1): void {
  ctx.drawImage(s.canvas, x - s.ox * scale, y - s.oy * scale, s.w * scale, s.h * scale);
}

// The page's fonts (set by next/font in layout.tsx), read once from the CSS variables.
const fontFamilies: Record<string, string> = {};
export function font(size: number, kind: "display" | "body" = "display", weight = 400): string {
  if (!(kind in fontFamilies) && typeof document !== "undefined") {
    fontFamilies[kind] = getComputedStyle(document.documentElement).getPropertyValue(`--font-${kind}`).trim();
  }
  const family = fontFamilies[kind] ? `${fontFamilies[kind]}, ` : "";
  return `${weight} ${size}px ${family}system-ui, sans-serif`;
}

// Text sprites are only cached once the page's fonts have loaded, so a label isn't stuck in
// the fallback font. Until then they are drawn fresh.
export function fontsReady(): boolean {
  return typeof document === "undefined" || !document.fonts || document.fonts.status === "loaded";
}

// Small deterministic noise, so floors and splinters look the same on every screen.
export function hash(a: number, b: number, k: number): number {
  let h = (a * 374761393 + b * 668265263 + k * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

// Rounded rectangle path (fill and stroke it afterwards).
export function rrect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

// Fill then outline the current path in ink.
export function inked(g: CanvasRenderingContext2D, fill: string | CanvasGradient, width = 2): void {
  g.fillStyle = fill;
  g.fill();
  g.strokeStyle = INK;
  g.lineWidth = width;
  g.stroke();
}
