import {
  BULLET_FADE,
  BULLET_RADIUS,
  CRATE_SIZE,
  FLARE_MS,
  MAX_AMMO,
  POWER_BOX_SIZE,
  POWER_RESPAWN_MS,
  RELOAD_MS,
  RESPAWN_MS,
  SHIELD_MS,
  SPEED_MS,
  TANK_RADIUS,
  TILE,
  isWallAt,
  type GameMap,
  type GameState,
  type PowerBox,
  type PowerKind,
  type Tank,
  type Team,
} from "@tank/shared";

const COLORS: Record<Team, { body: string; dark: string; zone: string }> = {
  red: { body: "#ff5a5f", dark: "#a8262b", zone: "rgba(255, 90, 95, 0.10)" },
  blue: { body: "#3fa7ff", dark: "#1a5f9e", zone: "rgba(63, 167, 255, 0.10)" },
};

export const POWER_STYLE: Record<PowerKind, { color: string; label: string }> = {
  shield: { color: "#4dd8ff", label: "SHIELD" },
  speed: { color: "#9dff5c", label: "SPEED" },
  flare: { color: "#ff9f43", label: "FLARE" },
};

export interface Effect {
  kind: "flash" | "boom" | "puff" | "spark" | "text";
  x: number;
  y: number;
  bornMs: number;
  team: Team;
  label?: string; // for "text"
  color?: string; // for "text" and "spark"
}

export interface RenderInput {
  map: GameMap;
  prev: GameState;
  curr: GameState;
  alpha: number; // 0..1 between prev and curr
  localId: string;
  names?: ReadonlyMap<string, string>; // name tags over soldiers (online only)
  effects: Effect[];
  nowMs: number;
}

export function render(ctx: CanvasRenderingContext2D, r: RenderInput): void {
  const { map } = r;
  ctx.fillStyle = "#1b1e26";
  ctx.fillRect(0, 0, map.width, map.height);
  drawSpawnZones(ctx, map);
  drawGrid(ctx, map);
  drawWalls(ctx, map);

  const prevCrates = new Map(r.prev.crates.map((c) => [c.id, c]));
  for (const c of r.curr.crates) {
    const p = prevCrates.get(c.id);
    drawCrate(ctx, p ? lerp(p.x, c.x, r.alpha) : c.x, p ? lerp(p.y, c.y, r.alpha) : c.y);
  }
  const prevBoxes = new Map(r.prev.powerBoxes.map((b) => [b.id, b]));
  for (const box of r.curr.powerBoxes) {
    const p = prevBoxes.get(box.id);
    // No lerp on the respawn tick, so a box that comes home doesn't slide back.
    const smooth = p && p.respawnMs <= 0 && box.respawnMs <= 0;
    drawPowerBox(ctx, smooth ? { ...box, x: lerp(p.x, box.x, r.alpha), y: lerp(p.y, box.y, r.alpha) } : box, r.nowMs);
  }

  const prevById = new Map(r.prev.tanks.map((t) => [t.id, t]));
  // Fallen soldiers first, so the living walk over them.
  for (const tank of r.curr.tanks) if (!tank.alive) drawFallenSoldier(ctx, tank, r.nowMs);
  for (const tank of r.curr.tanks) {
    if (!tank.alive) continue;
    const before = prevById.get(tank.id);
    const t = before?.alive ? lerpTank(before, tank, r.alpha) : tank;
    drawSoldier(ctx, t, tank.id === r.localId, r.nowMs, r.names?.get(tank.id));
  }

  const prevBullets = new Map(r.prev.bullets.map((b) => [b.id, b]));
  for (const b of r.curr.bullets) {
    const p = prevBullets.get(b.id);
    const x = p ? lerp(p.x, b.x, r.alpha) : b.x;
    const y = p ? lerp(p.y, b.y, r.alpha) : b.y;
    drawBullet(ctx, x, y, Math.atan2(b.vy, b.vx), b.rangeLeft);
  }

  drawEffects(ctx, r.effects, r.nowMs);
}

function drawSpawnZones(ctx: CanvasRenderingContext2D, map: GameMap): void {
  for (const team of ["red", "blue"] as const) {
    ctx.fillStyle = COLORS[team].zone;
    for (const s of map.spawns[team]) {
      ctx.fillRect(s.x - TILE / 2, s.y - TILE / 2, TILE, TILE);
    }
  }
}

function drawGrid(ctx: CanvasRenderingContext2D, map: GameMap): void {
  ctx.strokeStyle = "rgba(255, 255, 255, 0.03)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let c = 1; c < map.cols; c++) {
    ctx.moveTo(c * TILE, 0);
    ctx.lineTo(c * TILE, map.height);
  }
  for (let r = 1; r < map.rows; r++) {
    ctx.moveTo(0, r * TILE);
    ctx.lineTo(map.width, r * TILE);
  }
  ctx.stroke();
}

function drawWalls(ctx: CanvasRenderingContext2D, map: GameMap): void {
  for (let r = 0; r < map.rows; r++) {
    for (let c = 0; c < map.cols; c++) {
      if (!isWallAt(map, c, r)) continue;
      const x = c * TILE;
      const y = r * TILE;
      ctx.fillStyle = "#3a4152";
      ctx.fillRect(x, y, TILE, TILE);
      ctx.fillStyle = "#4a5368";
      ctx.fillRect(x, y, TILE, 4);
    }
  }
}

function drawCrate(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  const h = CRATE_SIZE / 2;
  ctx.fillStyle = "#8a5a2b";
  ctx.fillRect(x - h, y - h, CRATE_SIZE, CRATE_SIZE);
  ctx.strokeStyle = "#5c3a17";
  ctx.lineWidth = 3;
  ctx.strokeRect(x - h + 1.5, y - h + 1.5, CRATE_SIZE - 3, CRATE_SIZE - 3);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x - h + 3, y - h + 3);
  ctx.lineTo(x + h - 3, y + h - 3);
  ctx.moveTo(x + h - 3, y - h + 3);
  ctx.lineTo(x - h + 3, y + h - 3);
  ctx.stroke();
}

// Available: a pulsing purple "?" box. Taken: a faint outline that fills back in.
function drawPowerBox(ctx: CanvasRenderingContext2D, box: PowerBox, nowMs: number): void {
  const h = POWER_BOX_SIZE / 2;
  if (box.respawnMs > 0) {
    ctx.strokeStyle = "rgba(180, 120, 255, 0.25)";
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(box.x - h, box.y - h, POWER_BOX_SIZE, POWER_BOX_SIZE);
    ctx.setLineDash([]);
    const p = 1 - box.respawnMs / POWER_RESPAWN_MS;
    ctx.fillStyle = "rgba(180, 120, 255, 0.15)";
    ctx.fillRect(box.x - h, box.y + h - POWER_BOX_SIZE * p, POWER_BOX_SIZE, POWER_BOX_SIZE * p);
    return;
  }
  const pulse = 0.5 + 0.5 * Math.sin(nowMs / 200);
  ctx.fillStyle = `rgba(180, 120, 255, ${0.2 + 0.2 * pulse})`;
  ctx.fillRect(box.x - h - 4, box.y - h - 4, POWER_BOX_SIZE + 8, POWER_BOX_SIZE + 8);
  ctx.fillStyle = "#7b3fe4";
  ctx.fillRect(box.x - h, box.y - h, POWER_BOX_SIZE, POWER_BOX_SIZE);
  ctx.strokeStyle = "#c9a6ff";
  ctx.lineWidth = 2;
  ctx.strokeRect(box.x - h + 1, box.y - h + 1, POWER_BOX_SIZE - 2, POWER_BOX_SIZE - 2);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 18px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("?", box.x, box.y + 1);
}

// Power auras around a tank: shield bubble, speed streaks, flare markers.
function drawPowers(ctx: CanvasRenderingContext2D, t: Tank, nowMs: number): void {
  if (t.shieldMs > 0) {
    // Blink during the last 2 s so players see it is about to run out.
    const blinking = t.shieldMs < 2000 && Math.floor(nowMs / 120) % 2 === 0;
    if (!blinking) {
      ctx.fillStyle = "rgba(77, 216, 255, 0.15)";
      ctx.strokeStyle = POWER_STYLE.shield.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, TANK_RADIUS + 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
  if (t.speedMs > 0 && t.driving) {
    ctx.save();
    ctx.rotate(t.angle);
    ctx.strokeStyle = POWER_STYLE.speed.color;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    for (const y of [-8, 0, 8]) {
      ctx.moveTo(-TANK_RADIUS - 4, y);
      ctx.lineTo(-TANK_RADIUS - 14 - (y === 0 ? 6 : 0), y);
    }
    ctx.stroke();
    ctx.restore();
  }
  if (t.flareMs > 0) {
    ctx.save();
    ctx.rotate(t.angle);
    ctx.fillStyle = POWER_STYLE.flare.color;
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * (TANK_RADIUS + 6), Math.sin(a) * (TANK_RADIUS + 6), 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

// Time-left bars above the local tank, one per active power.
function drawPowerBars(ctx: CanvasRenderingContext2D, t: Tank): void {
  const bars: [PowerKind, number][] = [
    ["shield", t.shieldMs / SHIELD_MS],
    ["speed", t.speedMs / SPEED_MS],
    ["flare", t.flareMs / FLARE_MS],
  ];
  let y = -TANK_RADIUS - 17; // above the name tag
  for (const [kind, left] of bars) {
    if (left <= 0) continue;
    ctx.fillStyle = "rgba(255, 255, 255, 0.15)";
    ctx.fillRect(-14, y, 28, 3);
    ctx.fillStyle = POWER_STYLE[kind].color;
    ctx.fillRect(-14, y, 28 * left, 3);
    y -= 5;
  }
}

const SKIN = "#e8b48a";
const GUN = "#9aa3b2"; // light gunmetal so the rifle reads against the dark floor
const GUN_EDGE = "#1d2028";

// Top-down soldier facing +x, holding a rifle along the facing direction, so shots
// leave the muzzle where the gun points. Collision size is still TANK_RADIUS.
export function drawSoldier(ctx: CanvasRenderingContext2D, t: Tank, isLocal: boolean, nowMs: number, name?: string): void {
  const color = COLORS[t.team];
  ctx.save();
  ctx.translate(t.x, t.y);
  drawPowers(ctx, t, nowMs);
  if (isLocal) {
    drawPowerBars(ctx, t);
    drawAmmo(ctx, t);
  }
  if (name) drawNameTag(ctx, name, isLocal);

  ctx.rotate(t.angle);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // Shadow
  ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
  ctx.beginPath();
  ctx.ellipse(2, 2.5, 9, 12.5, 0, 0, Math.PI * 2);
  ctx.fill();

  // Boots step out in front of and behind the body while walking.
  const stride = t.driving ? Math.sin(nowMs / 70) * 7 : 0;
  ctx.fillStyle = "#4a4f5c";
  for (const [side, swing] of [[-1, stride], [1, -stride]] as const) {
    ctx.beginPath();
    ctx.ellipse(swing, side * 4.5, 4, 2.6, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Backpack
  ctx.fillStyle = color.dark;
  ctx.beginPath();
  ctx.roundRect(-10.5, -5, 5, 10, 2);
  ctx.fill();

  // Shoulders: a wide, shallow body across the direction of travel.
  ctx.fillStyle = color.body;
  ctx.strokeStyle = color.dark;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.ellipse(-1.5, 0, 5.5, 11, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Rifle on y = 0, the line bullets travel along; muzzle out in front.
  ctx.fillStyle = GUN;
  ctx.strokeStyle = GUN_EDGE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(2, -1.5, TANK_RADIUS + 9, 3); // barrel
  ctx.rect(0, -2.5, 9, 5); // stock and receiver
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = GUN_EDGE;
  ctx.fillRect(TANK_RADIUS + 8, -2, 3, 4); // muzzle

  // Sleeves in the darker team colour so the arms stand out from the shoulders:
  // right hand on the grip, left hand forward on the barrel.
  ctx.strokeStyle = color.dark;
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.moveTo(-1, 9);
  ctx.lineTo(6, 3.5);
  ctx.moveTo(-1, -9);
  ctx.lineTo(13, -2.5);
  ctx.stroke();
  ctx.fillStyle = SKIN;
  for (const [hx, hy] of [[7, 2.5], [14, -1.5]] as const) {
    ctx.beginPath();
    ctx.arc(hx, hy, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Helmet with a rim and a highlight.
  ctx.fillStyle = color.dark;
  ctx.beginPath();
  ctx.arc(-1, 0, 6.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = color.body;
  ctx.beginPath();
  ctx.arc(-1, 0, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
  ctx.beginPath();
  ctx.arc(-2.5, -1.8, 1.8, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

const FALL_MS = 180; // quick topple when hit
const POOL_MS = 600; // the pool spreads out over this long
const FADE_OUT_MS = 350; // body fades just before the respawn

// A shot soldier lying on their back where they fell, arms out, rifle dropped beside
// them. Stays until the respawn, fading out over the last FADE_OUT_MS.
export function drawFallenSoldier(ctx: CanvasRenderingContext2D, t: Tank, nowMs: number): void {
  const color = COLORS[t.team];
  const sinceDeath = RESPAWN_MS - t.respawnMs;
  const fall = Math.min(1, sinceDeath / FALL_MS);
  ctx.save();
  ctx.translate(t.x, t.y);
  ctx.globalAlpha = Math.min(1, t.respawnMs / FADE_OUT_MS);
  // Falls backwards, away from where they were facing, turning a little as they drop.
  ctx.rotate(t.angle + Math.PI + 0.35 * fall);
  ctx.translate(4 * fall, 0);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Pool spreading under the body.
  const pool = Math.min(1, sinceDeath / POOL_MS);
  ctx.fillStyle = "rgba(150, 20, 28, 0.7)";
  ctx.beginPath();
  ctx.ellipse(-1, 1, 6 + 9 * pool, 4 + 6 * pool, 0.3, 0, Math.PI * 2);
  ctx.fill();

  // Legs (toward -x), boots at the ends.
  ctx.strokeStyle = color.dark;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(-4, -3);
  ctx.lineTo(-14, -5);
  ctx.moveTo(-4, 3);
  ctx.lineTo(-13, 6);
  ctx.stroke();
  ctx.fillStyle = "#4a4f5c";
  for (const [bx, by] of [[-15, -5.5], [-14, 6.5]] as const) {
    ctx.beginPath();
    ctx.ellipse(bx, by, 2.6, 2, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Arms flung out to the sides.
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.moveTo(3, -7);
  ctx.lineTo(7, -14);
  ctx.moveTo(3, 7);
  ctx.lineTo(10, 12);
  ctx.stroke();
  ctx.fillStyle = SKIN;
  for (const [hx, hy] of [[7.5, -15], [10.8, 12.8]] as const) {
    ctx.beginPath();
    ctx.arc(hx, hy, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Torso, seen lying flat: longer than it is wide.
  ctx.fillStyle = color.body;
  ctx.strokeStyle = color.dark;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.ellipse(0, 0, 7, 8.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Head with the helmet knocked askew.
  ctx.fillStyle = SKIN;
  ctx.beginPath();
  ctx.arc(10, 0, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = color.dark;
  ctx.beginPath();
  ctx.ellipse(12.5, -2.5, 5.5, 4.5, -0.6, 0, Math.PI * 2);
  ctx.fill();

  // Dropped rifle lying beside the body.
  ctx.save();
  ctx.translate(-2, 15);
  ctx.rotate(-0.5);
  ctx.fillStyle = GUN;
  ctx.strokeStyle = GUN_EDGE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(-8, -1.5, 20, 3);
  ctx.rect(-10, -2.5, 8, 5);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  ctx.restore();
}

// Small name above the soldier; yours in gold so you can find yourself.
function drawNameTag(ctx: CanvasRenderingContext2D, name: string, isLocal: boolean): void {
  ctx.font = "600 9px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  const y = -TANK_RADIUS - 3;
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
  ctx.strokeText(name, 0, y);
  ctx.fillStyle = isLocal ? "#ffd166" : "rgba(255, 255, 255, 0.85)";
  ctx.fillText(name, 0, y);
}

const BULLET_LENGTH = 14;

// A short glowing slug with a fading tracer tail, pointing the way it flies.
export function drawBullet(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, rangeLeft: number): void {
  // Fade and shrink over the last stretch of range, so the drop is visible.
  const fade = Math.max(0, Math.min(1, rangeLeft / BULLET_FADE));
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.globalAlpha = 0.3 + 0.7 * fade;
  const w = BULLET_RADIUS * (0.6 + 0.4 * fade);
  const tail = ctx.createLinearGradient(-BULLET_LENGTH * 1.6, 0, 0, 0);
  tail.addColorStop(0, "rgba(255, 209, 102, 0)");
  tail.addColorStop(1, "rgba(255, 209, 102, 0.7)");
  ctx.fillStyle = tail;
  ctx.beginPath();
  ctx.moveTo(-BULLET_LENGTH * 1.6, 0);
  ctx.lineTo(-BULLET_LENGTH / 2, -w * 0.7);
  ctx.lineTo(-BULLET_LENGTH / 2, w * 0.7);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#fff4c2";
  ctx.beginPath();
  ctx.roundRect(-BULLET_LENGTH / 2, -w * 0.6, BULLET_LENGTH, w * 1.2, w * 0.6);
  ctx.fill();
  ctx.restore();
}

// A row of pips under the soldier: full rounds solid, the reloading one fills up.
function drawAmmo(ctx: CanvasRenderingContext2D, t: Tank): void {
  const gap = 6;
  const y = TANK_RADIUS + 12;
  const x0 = -((MAX_AMMO - 1) * gap) / 2;
  for (let i = 0; i < MAX_AMMO; i++) {
    const x = x0 + i * gap;
    ctx.fillStyle = "rgba(255, 255, 255, 0.15)";
    ctx.beginPath();
    ctx.arc(x, y, 2.2, 0, Math.PI * 2);
    ctx.fill();
    const fill = i < t.ammo ? 1 : i === t.ammo ? t.reloadMs / RELOAD_MS : 0;
    if (fill <= 0) continue;
    ctx.fillStyle = fill >= 1 ? "#ffd166" : "rgba(255, 209, 102, 0.6)";
    ctx.beginPath();
    ctx.arc(x, y, 2.2 * fill, 0, Math.PI * 2);
    ctx.fill();
  }
}

const FLASH_MS = 90;
const BOOM_MS = 450;
const PUFF_MS = 250;
const SPARK_MS = 250;
const TEXT_MS = 1000;

const EFFECT_MS: Record<Effect["kind"], number> = {
  flash: FLASH_MS,
  boom: BOOM_MS,
  puff: PUFF_MS,
  spark: SPARK_MS,
  text: TEXT_MS,
};

function drawEffects(ctx: CanvasRenderingContext2D, effects: Effect[], nowMs: number): void {
  for (const e of effects) {
    const age = nowMs - e.bornMs;
    if (e.kind === "flash" && age < FLASH_MS) {
      ctx.fillStyle = `rgba(255, 230, 150, ${1 - age / FLASH_MS})`;
      ctx.beginPath();
      ctx.arc(e.x, e.y, 7, 0, Math.PI * 2);
      ctx.fill();
    } else if (e.kind === "boom" && age < BOOM_MS) {
      const p = age / BOOM_MS;
      ctx.strokeStyle = COLORS[e.team].body;
      ctx.globalAlpha = 1 - p;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(e.x, e.y, TANK_RADIUS + p * 30, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (e.kind === "puff" && age < PUFF_MS) {
      const p = age / PUFF_MS;
      ctx.fillStyle = `rgba(255, 244, 194, ${0.35 * (1 - p)})`;
      ctx.beginPath();
      ctx.arc(e.x, e.y, BULLET_RADIUS + p * 6, 0, Math.PI * 2);
      ctx.fill();
    } else if (e.kind === "spark" && age < SPARK_MS) {
      const p = age / SPARK_MS;
      ctx.strokeStyle = e.color ?? "#ffffff";
      ctx.globalAlpha = 1 - p;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(e.x, e.y, 4 + p * 10, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (e.kind === "text" && age < TEXT_MS) {
      // Floats up and fades out.
      const p = age / TEXT_MS;
      ctx.globalAlpha = 1 - p * p;
      ctx.fillStyle = e.color ?? "#ffffff";
      ctx.font = "bold 14px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(e.label ?? "", e.x, e.y - TANK_RADIUS - 16 - p * 24);
      ctx.globalAlpha = 1;
    }
  }
}

export function pruneEffects(effects: Effect[], nowMs: number): Effect[] {
  return effects.filter((e) => nowMs - e.bornMs < EFFECT_MS[e.kind]);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function lerpTank(a: Tank, b: Tank, t: number): Tank {
  return { ...b, x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), angle: lerpAngle(a.angle, b.angle, t) };
}
