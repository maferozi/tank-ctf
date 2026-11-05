"use client";

import { DEFAULT_MAP, addTank, createState } from "@tank/shared";
import { useEffect, useRef } from "react";
import { drawBullet, drawFallenSoldier, drawSoldier } from "@/game/render";

const ZOOM = 2.1;
const CELL = 60; // world px per cell

// Rows: red and blue soldiers. Columns: standing, walking (two frames), charging a tap,
// and a bullet in flight, all at the same facing so details can be compared.
export function SpriteSheet() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const cols = 6;
    const rows = 2;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = cols * CELL * ZOOM * dpr;
    canvas.height = rows * CELL * ZOOM * dpr;
    canvas.style.width = `${cols * CELL * ZOOM}px`;
    canvas.style.height = `${rows * CELL * ZOOM}px`;
    ctx.setTransform(ZOOM * dpr, 0, 0, ZOOM * dpr, 0, 0);
    ctx.fillStyle = "#1b1e26";
    ctx.fillRect(0, 0, cols * CELL, rows * CELL);

    const state = createState();
    (["red", "blue"] as const).forEach((team, row) => {
      const t = addTank(state, DEFAULT_MAP, `${team}`, team);
      const cy = row * CELL + CELL / 2;
      const at = (col: number) => ({ ...t, x: col * CELL + CELL / 2, y: cy, angle: -0.4 });
      drawSoldier(ctx, at(0), row === 0, 0);
      // nowMs picks the stride: left foot forward, then right foot forward.
      drawSoldier(ctx, { ...at(1), driving: true }, false, 110);
      drawSoldier(ctx, { ...at(2), driving: true }, false, 330);
      drawSoldier(ctx, { ...at(3), held: true, pressMs: 35 }, true, 0);
      drawBullet(ctx, 4 * CELL + CELL / 2, cy, -0.4, 300, team);
      drawFallenSoldier(ctx, { ...at(5), alive: false, respawnMs: 1000 }, 0);
    });
  }, []);

  return (
    <main style={{ padding: 16 }}>
      <p style={{ color: "#8b91a1", margin: "0 0 12px" }}>
        Standing (you) · walking · walking · charging a tap · bullet · shot — drawn at {ZOOM}×
      </p>
      <canvas ref={ref} />
    </main>
  );
}
