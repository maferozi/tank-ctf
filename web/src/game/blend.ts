import type { GameState, Tank } from "@tank/shared";

// Blends two game states (matched by id) into one, t = 0..1. Things only in `b` are taken
// as they are. Used by the online driver, which mixes states from different timelines.
export function blendStates(a: GameState, b: GameState, t: number): GameState {
  if (a === b || t >= 1) return b;
  const tanks = new Map(a.tanks.map((x) => [x.id, x]));
  const bullets = new Map(a.bullets.map((x) => [x.id, x]));
  const crates = new Map(a.crates.map((x) => [x.id, x]));
  const boxes = new Map(a.powerBoxes.map((x) => [x.id, x]));
  const flags = new Map(a.flags.map((x) => [x.team, x]));
  return {
    ...b,
    tanks: b.tanks.map((x) => {
      const p = tanks.get(x.id);
      // Don't slide across the map when someone respawns.
      return p && p.alive === x.alive ? blendTank(p, x, t) : x;
    }),
    bullets: b.bullets.map((x) => {
      const p = bullets.get(x.id);
      return p ? { ...x, x: lerp(p.x, x.x, t), y: lerp(p.y, x.y, t) } : x;
    }),
    crates: b.crates.map((x) => {
      const p = crates.get(x.id);
      return p ? { ...x, x: lerp(p.x, x.x, t), y: lerp(p.y, x.y, t) } : x;
    }),
    powerBoxes: b.powerBoxes.map((x) => {
      const p = boxes.get(x.id);
      // A box that just came home must not slide back.
      return p && p.respawnMs <= 0 && x.respawnMs <= 0 ? { ...x, x: lerp(p.x, x.x, t), y: lerp(p.y, x.y, t) } : x;
    }),
    flags: b.flags.map((x) => {
      const p = flags.get(x.team);
      // Carried flags are drawn on their carrier; a flag sent home must not slide back.
      return p && p.atHome === x.atHome ? { ...x, x: lerp(p.x, x.x, t), y: lerp(p.y, x.y, t) } : x;
    }),
  };
}

export function blendTank(a: Tank, b: Tank, t: number): Tank {
  return { ...b, x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), angle: lerpAngle(a.angle, b.angle, t) };
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
