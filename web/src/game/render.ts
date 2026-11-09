import {
  BULLET_FADE,
  BULLET_RANGE,
  BULLET_SPEED,
  CRATE_SIZE,
  FLAG_RADIUS,
  FLAG_RETURN_MS,
  FLARE_MS,
  MAX_AMMO,
  RELOAD_MS,
  RESPAWN_MS,
  SHIELD_HITS,
  SHIELD_MS,
  SPEED_MS,
  TANK_RADIUS,
  TICK_MS,
  TILE,
  UNLIMITED_AMMO,
  getMap,
  createFlags,
  type Bullet,
  type Crate,
  type GameMap,
  type GameState,
  type Match,
  type PowerBox,
  type PowerKind,
  type Tank,
  type Team,
} from "@tank/shared";
import { INK, TEAM, blit, blitAt, font, hash, rrect } from "./art/common";
import {
  POWER_COLOR,
  SHIELD_R,
  STREAK_LENGTH,
  bedSprite,
  bootSprite,
  bulletBallSprite,
  bulletStreakSprite,
  crateSprite,
  deskSprite,
  fallenSprite,
  flashSprite,
  glowSprite,
  labelSprite,
  nameTagSprite,
  powerBoxSprite,
  shadowSprite,
  shieldSprite,
  soldierSprite,
  sparkleSprite,
  splatSprite,
  youRingSprite,
} from "./art/sprites";
import { drawMapLayer } from "./mapArt";

// Draws one frame of the game with Canvas 2D: the cached map layer, then furniture, power
// boxes, bodies, flags, soldiers, bullets and effects. Sprites are painted once into
// offscreen canvases (art/sprites.ts) and copied here, so a frame mostly costs drawImage
// calls; the loop reuses its lookup maps instead of allocating new ones every frame.

export const POWER_STYLE: Record<PowerKind, { color: string; label: string }> = {
  shield: { color: POWER_COLOR.shield, label: "SHIELD" },
  speed: { color: POWER_COLOR.speed, label: "SPEED" },
  flare: { color: POWER_COLOR.flare, label: "FLARE" },
};

export interface Effect {
  kind: "flash" | "boom" | "splinters" | "spark" | "shatter" | "ring" | "text";
  x: number;
  y: number;
  bornMs: number;
  team: Team;
  label?: string; // for "text"
  color?: string; // for "text", "spark" and "ring"
  angle?: number; // for "flash": the way the gun points
}

export interface RenderInput {
  prev: GameState;
  curr: GameState;
  alpha: number; // 0..1 between prev and curr
  localId: string;
  names?: ReadonlyMap<string, string>; // name tags over soldiers (online only)
  speaking?: ReadonlySet<string>; // voice chat: who is talking (a ring round their name tag)
  effects: Effect[];
  nowMs: number;
}

// Lookups reused every frame.
const prevTanks = new Map<string, Tank>();
const prevCrates = new Map<number, Crate>();
const prevBoxes = new Map<number, PowerBox>();
const prevBullets = new Map<number, Bullet>();

// Where each living soldier was drawn this frame, for the overlays drawn on top of everyone.
interface Drawn {
  t: Tank;
  x: number;
  y: number;
  angle: number;
}
const drawn: Drawn[] = [];
let drawnCount = 0;

export function render(ctx: CanvasRenderingContext2D, r: RenderInput): void {
  const { prev, curr, alpha, nowMs } = r;
  const map = getMap(curr.mapId); // the round's map; all maps share one size
  noteRound(curr);
  drawMapLayer(ctx, map);

  prevCrates.clear();
  for (const c of prev.crates) prevCrates.set(c.id, c);
  for (const c of curr.crates) {
    const p = prevCrates.get(c.id);
    drawCrate(ctx, c, p ? lerp(p.x, c.x, alpha) : c.x, p ? lerp(p.y, c.y, alpha) : c.y);
  }

  prevBoxes.clear();
  for (const b of prev.powerBoxes) prevBoxes.set(b.id, b);
  for (const box of curr.powerBoxes) {
    const shown = box.respawnMs <= 0;
    const since = boxAppeared(box.id, shown, nowMs);
    if (!shown) continue; // hidden boxes are not on the map
    const p = prevBoxes.get(box.id);
    // No lerp on the tick it appears, so a box that comes home doesn't slide back.
    const smooth = p && p.respawnMs <= 0;
    drawPowerBox(ctx, smooth ? lerp(p.x, box.x, alpha) : box.x, smooth ? lerp(p.y, box.y, alpha) : box.y, nowMs, since);
  }

  prevTanks.clear();
  for (const t of prev.tanks) prevTanks.set(t.id, t);
  // Fallen soldiers first, so the living are drawn on top. Bodies can be pushed, so they
  // are smoothed between states like everything else.
  for (const t of curr.tanks) {
    if (t.alive) continue;
    lastAlive.set(t.id, false);
    const p = prevTanks.get(t.id);
    const smooth = p && !p.alive;
    drawFallenAt(ctx, t, smooth ? lerp(p.x, t.x, alpha) : t.x, smooth ? lerp(p.y, t.y, alpha) : t.y);
  }
  // Flags on the ground (home or dropped) under the soldiers.
  for (const flag of curr.flags) {
    if (flag.carrier) continue;
    let x = flag.x;
    let y = flag.y;
    for (const p of prev.flags) {
      if (p.team === flag.team && !p.carrier && p.atHome === flag.atHome) {
        x = lerp(p.x, flag.x, alpha);
        y = lerp(p.y, flag.y, alpha);
      }
    }
    if (!flag.atHome) drawReturnRing(ctx, flag.team, x, y, flag.returnMs / FLAG_RETURN_MS);
    drawFlagShape(ctx, flag.team, x, y, FLAG_RADIUS, nowMs);
  }

  drawnCount = 0;
  for (const t of curr.tanks) {
    if (!t.alive) continue;
    const p = prevTanks.get(t.id);
    const smooth = p?.alive;
    const x = smooth ? lerp(p.x, t.x, alpha) : t.x;
    const y = smooth ? lerp(p.y, t.y, alpha) : t.y;
    const angle = smooth ? lerpAngle(p.angle, t.angle, alpha) : t.angle;
    let carrying: Team | null = null;
    for (const f of curr.flags) if (f.carrier === t.id) carrying = f.team;
    drawSoldierAt(ctx, t, x, y, angle, t.id === r.localId, nowMs, carrying, spawnedAt(t, nowMs));
    const d = (drawn[drawnCount] ??= { t, x, y, angle });
    d.t = t;
    d.x = x;
    d.y = y;
    d.angle = angle;
    drawnCount++;
  }

  prevBullets.clear();
  for (const b of prev.bullets) prevBullets.set(b.id, b);
  for (const b of curr.bullets) {
    const p = prevBullets.get(b.id);
    const x = p ? lerp(p.x, b.x, alpha) : b.x;
    const y = p ? lerp(p.y, b.y, alpha) : b.y;
    const range = p ? lerp(p.rangeLeft, b.rangeLeft, alpha) : b.rangeLeft;
    drawBulletAt(ctx, x, y, b.vx, b.vy, range, b.team);
  }
  trackBullets(curr, nowMs);

  drawBits(ctx, nowMs);
  drawEffects(ctx, r.effects, nowMs);
  // Name tags and power bars over everything, so nobody's tag is hidden by another soldier.
  for (let i = 0; i < drawnCount; i++) {
    const d = drawn[i]!;
    const isLocal = d.t.id === r.localId;
    drawOverhead(ctx, d.t, d.x, d.y, isLocal, r.names?.get(d.t.id), r.speaking?.has(d.t.id) ?? false, nowMs);
  }
  if (curr.match.rounds > 1) drawScoreboard(ctx, map, curr.match);
  if (curr.winner) drawWinBanner(ctx, map, curr.winner, curr.overMs, curr.match, nowMs);
  else bannerSince = -1; // the next win pops in again, even on the same map
}

// A still picture of a map for the map picker: walls, spawns, stands with flags, crates,
// desks, beds and power boxes. Call with the context already scaled so that map pixels fit
// the canvas.
export function drawMapPreview(ctx: CanvasRenderingContext2D, map: GameMap): void {
  drawMapLayer(ctx, map, 0.6);
  for (const flag of createFlags(map)) drawFlagShape(ctx, flag.team, flag.x, flag.y, FLAG_RADIUS * 1.6, 0);
  for (const c of map.crates) blitAt(ctx, crateSprite(), c.x, c.y);
  for (const d of map.desks) blitAt(ctx, deskSprite(), d.x, d.y);
  for (const b of map.beds) blitAt(ctx, bedSprite(), b.x, b.y);
  for (const p of map.powerBoxes) drawPowerBox(ctx, p.x, p.y, 0, -Infinity);
}

// --- Round bookkeeping ------------------------------------------------------------------

// Per-object animation state (power box pops, respawn rings, bullets in flight) belongs to
// one round on one map; a new round or map starts it over.
let roundKey = "";
let lastTick = -1;
function noteRound(curr: GameState): void {
  const key = curr.mapId;
  if (key !== roundKey || curr.tick < lastTick) {
    roundKey = key;
    boxes.clear();
    lastAlive.clear();
    spawns.clear();
    flying.clear();
    // Not bannerSince: a banner already on screen must not restart its fade and pop when
    // the map changes behind it. It resets when the winner clears (see render()).
  }
  lastTick = curr.tick;
}

const boxes = new Map<number, { shown: boolean; since: number }>();
// When a power box last appeared (it pops in), or -Infinity if it was there all along.
function boxAppeared(id: number, shown: boolean, nowMs: number): number {
  let s = boxes.get(id);
  if (!s) {
    s = { shown, since: shown ? -Infinity : nowMs };
    boxes.set(id, s);
  }
  if (shown && !s.shown) s.since = nowMs;
  s.shown = shown;
  return s.since;
}

const lastAlive = new Map<string, boolean>();
const spawns = new Map<string, number>();
// When this soldier last came back to life (a ring shows round them for a moment).
function spawnedAt(t: Tank, nowMs: number): number {
  if (lastAlive.get(t.id) === false) spawns.set(t.id, nowMs);
  lastAlive.set(t.id, true);
  return spawns.get(t.id) ?? -Infinity;
}

// --- Soldiers ---------------------------------------------------------------------------

const SPAWN_RING_MS = 700;
const CARRIER_GLOW: Record<Team, string> = { red: "rgba(255, 70, 70, 0.9)", blue: "rgba(60, 140, 255, 0.9)" };

// Top-down soldier facing +x with a rifle along the facing direction, so shots leave the
// muzzle where the gun points. Collision size is TANK_RADIUS. Kept for the sprite sheet.
export function drawSoldier(ctx: CanvasRenderingContext2D, t: Tank, isLocal: boolean, nowMs: number, name?: string): void {
  drawSoldierAt(ctx, t, t.x, t.y, t.angle, isLocal, nowMs, null, -Infinity);
  drawOverhead(ctx, t, t.x, t.y, isLocal, name, false, nowMs);
}

function drawSoldierAt(
  ctx: CanvasRenderingContext2D,
  t: Tank,
  x: number,
  y: number,
  angle: number,
  isLocal: boolean,
  nowMs: number,
  carrying: Team | null,
  spawned: number,
): void {
  const team = TEAM[t.team];
  blitAt(ctx, shadowSprite(), x + 2, y + 3.5);
  if (isLocal) {
    ctx.globalAlpha = 0.75 + 0.25 * Math.sin(nowMs / 260);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(nowMs / 1400);
    blit(ctx, youRingSprite(t.team));
    ctx.restore();
    ctx.globalAlpha = 1;
  }
  // Carrying a flag: a pulsing halo in that flag's colour, so everyone sees who has it.
  if (carrying) {
    ctx.globalAlpha = 0.7 + 0.3 * Math.sin(nowMs / 140);
    blitAt(ctx, glowSprite(CARRIER_GLOW[carrying]), x, y, 0.95);
    ctx.globalAlpha = 1;
  }
  if (t.flareMs > 0) {
    ctx.globalAlpha = 0.55 + 0.35 * Math.sin(nowMs / 90);
    blitAt(ctx, glowSprite("rgba(255, 165, 61, 0.85)"), x, y, 0.9);
    ctx.globalAlpha = 1;
  }
  const sprite = soldierSprite(t.team);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // Speed: two fading after-images behind a walking soldier.
  if (t.speedMs > 0 && t.driving) {
    for (let k = 2; k >= 1; k--) {
      ctx.globalAlpha = 0.16 * (3 - k);
      ctx.save();
      ctx.translate(x - cos * 9 * k, y - sin * 9 * k);
      ctx.rotate(angle);
      blit(ctx, sprite);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = POWER_COLOR.speed;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const off of [-9, 9]) {
      const sx = x - cos * 16 - sin * off;
      const sy = y - sin * 16 + cos * off;
      const len = 10 + 4 * Math.sin(nowMs / 50 + off);
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx - cos * len, sy - sin * len);
    }
    ctx.stroke();
  }

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  // Boots step out in front of and behind the body while walking.
  const stride = t.driving ? Math.sin(nowMs / 70) * 8 : 0;
  const boot = bootSprite();
  ctx.drawImage(boot.canvas, stride - 2 - boot.ox, -6.5 - boot.oy, boot.w, boot.h);
  ctx.drawImage(boot.canvas, -stride - 2 - boot.ox, 6.5 - boot.oy, boot.w, boot.h);
  blit(ctx, sprite);
  ctx.restore();

  if (t.shieldMs > 0) drawShield(ctx, t, x, y, nowMs);
  if (carrying) drawCarriedFlag(ctx, carrying, x - cos * 10, y - sin * 10, nowMs);

  // Just respawned: a ring that closes in on them, and a quick flash.
  const age = nowMs - spawned;
  if (age < SPAWN_RING_MS) {
    const p = age / SPAWN_RING_MS;
    ctx.strokeStyle = team.light;
    ctx.globalAlpha = 1 - p;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, TANK_RADIUS + 22 * (1 - p), 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

// The shield bubble, with three segments round it showing the hits it has left. Blinks in
// its last 2 s.
function drawShield(ctx: CanvasRenderingContext2D, t: Tank, x: number, y: number, nowMs: number): void {
  if (t.shieldMs < 2000 && Math.floor(nowMs / 120) % 2 === 0) return;
  blitAt(ctx, shieldSprite(), x, y);
  const gap = 0.35;
  const seg = (Math.PI * 2) / SHIELD_HITS;
  const spin = nowMs / 900;
  for (let i = 0; i < SHIELD_HITS; i++) {
    const a0 = spin + i * seg + gap / 2;
    const lit = i < t.shieldHits;
    ctx.beginPath();
    ctx.arc(x, y, SHIELD_R, a0, a0 + seg - gap);
    if (lit) {
      ctx.strokeStyle = INK;
      ctx.lineWidth = 5;
      ctx.stroke();
      ctx.strokeStyle = POWER_COLOR.shield;
      ctx.lineWidth = 3;
    } else {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
      ctx.lineWidth = 1.5;
    }
    ctx.stroke();
  }
}

// Name tag, plus your own power bars, above a soldier.
function drawOverhead(
  ctx: CanvasRenderingContext2D,
  t: Tank,
  x: number,
  y: number,
  isLocal: boolean,
  name: string | undefined,
  speaking: boolean,
  nowMs: number,
): void {
  let top = y - TANK_RADIUS - 6;
  if (name) {
    const tag = nameTagSprite(name, isLocal);
    if (speaking) drawSpeakingRing(ctx, x, top - tag.h / 2 + 1, tag.w - 2, nowMs);
    blitAt(ctx, tag, x, top - tag.h / 2 + 1);
    top -= tag.h + 1;
  }
  if (!isLocal) return;
  if (!UNLIMITED_AMMO) drawAmmo(ctx, t, x, y);
  if (drawPowerBar(ctx, x, top, t.shieldMs / SHIELD_MS, "shield")) top -= 6;
  if (drawPowerBar(ctx, x, top, t.speedMs / SPEED_MS, "speed")) top -= 6;
  drawPowerBar(ctx, x, top, t.flareMs / FLARE_MS, "flare");
}

// Voice chat: a soft pulsing green ring round the name tag of whoever is talking. Two
// strokes, no shadow blur (cheap on phones).
const SPEAKING_COLOR = "#5dffa0";
function drawSpeakingRing(ctx: CanvasRenderingContext2D, x: number, cy: number, tagW: number, nowMs: number): void {
  const h = 17;
  const w = tagW + 4;
  rrect(ctx, x - w / 2, cy - h / 2, w, h, h / 2);
  ctx.strokeStyle = SPEAKING_COLOR;
  ctx.globalAlpha = 0.25 + 0.1 * Math.sin(nowMs / 120);
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// Time left on one power: a small rounded bar with an ink edge.
function drawPowerBar(ctx: CanvasRenderingContext2D, x: number, bottom: number, left: number, kind: PowerKind): boolean {
  if (left <= 0) return false;
  const w = 28;
  const h = 4;
  const y = bottom - h - 1;
  ctx.fillStyle = "rgba(16, 20, 38, 0.7)";
  ctx.beginPath();
  ctx.roundRect(x - w / 2 - 1, y - 1, w + 2, h + 2, 3);
  ctx.fill();
  ctx.fillStyle = POWER_COLOR[kind];
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y, Math.max(h, w * Math.min(1, left)), h, 2);
  ctx.fill();
  return true;
}

// A row of pips under the soldier (only with the magazine on): full rounds solid, the
// reloading one fills up.
function drawAmmo(ctx: CanvasRenderingContext2D, t: Tank, x: number, y: number): void {
  const gap = 6;
  const py = y + TANK_RADIUS + 12;
  const x0 = x - ((MAX_AMMO - 1) * gap) / 2;
  for (let i = 0; i < MAX_AMMO; i++) {
    const fill = i < t.ammo ? 1 : i === t.ammo ? t.reloadMs / RELOAD_MS : 0;
    ctx.fillStyle = "rgba(16, 20, 38, 0.4)";
    ctx.beginPath();
    ctx.arc(x0 + i * gap, py, 2.4, 0, Math.PI * 2);
    ctx.fill();
    if (fill <= 0) continue;
    ctx.fillStyle = "#ffc83a";
    ctx.beginPath();
    ctx.arc(x0 + i * gap, py, 2.4 * fill, 0, Math.PI * 2);
    ctx.fill();
  }
}

const FALL_MS = 180; // quick topple when hit
const SPLAT_MS = 260; // the splat spreads out over this long
const FADE_OUT_MS = 350; // body fades just before the respawn

// A shot soldier lying flat where they fell. Stays until the respawn, fading out over the
// last FADE_OUT_MS. Kept for the sprite sheet.
export function drawFallenSoldier(ctx: CanvasRenderingContext2D, t: Tank, _nowMs: number): void {
  drawFallenAt(ctx, t, t.x, t.y);
}

function drawFallenAt(ctx: CanvasRenderingContext2D, t: Tank, x: number, y: number): void {
  // Clamped: a respawn timer longer than RESPAWN_MS must not give negative sizes.
  const sinceDeath = Math.max(0, RESPAWN_MS - t.respawnMs);
  const fall = Math.min(1, sinceDeath / FALL_MS);
  const splat = Math.min(1, sinceDeath / SPLAT_MS);
  ctx.save();
  ctx.translate(x, y);
  ctx.globalAlpha = Math.max(0, Math.min(1, t.respawnMs / FADE_OUT_MS));
  // Falls head-first in the direction they were going, turning a little as they drop.
  ctx.rotate(t.fallAngle + 0.35 * fall);
  blit(ctx, splatSprite(t.team), 0.35 + 0.65 * easeOut(splat));
  ctx.translate(4 * fall, 0);
  blit(ctx, fallenSprite(t.team), 1.15 - 0.15 * fall);
  ctx.restore();
}

// --- Flags ------------------------------------------------------------------------------

// A small flag on a pole, seen from slightly above, that fits inside a circle of `size`
// around (x, y): on the ground that is FLAG_RADIUS, the distance a soldier must reach.
function drawFlagShape(ctx: CanvasRenderingContext2D, team: Team, x: number, y: number, size: number, nowMs: number): void {
  const color = TEAM[team];
  const wave = Math.sin(nowMs / 150) * 0.12;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size, size);
  const px = 1 / size; // one map pixel in these units
  // Shadow at the foot of the pole
  ctx.fillStyle = "rgba(10, 14, 30, 0.3)";
  ctx.beginPath();
  ctx.ellipse(-0.45, 0.82, 0.4, 0.16, 0, 0, Math.PI * 2);
  ctx.fill();
  // Cloth: a bold pennant filling most of the circle, so it reads even this small.
  ctx.beginPath();
  ctx.moveTo(-0.5, -0.86);
  ctx.quadraticCurveTo(0.25, -0.75 + wave, 0.94, -0.28 + wave);
  ctx.quadraticCurveTo(0.25, -0.02 - wave, -0.5, 0.3);
  ctx.closePath();
  ctx.lineJoin = "round";
  ctx.fillStyle = color.body;
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = Math.min(1.3 * px, 0.12);
  ctx.stroke();
  ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
  ctx.beginPath();
  ctx.moveTo(-0.48, -0.8);
  ctx.quadraticCurveTo(0.2, -0.68 + wave, 0.7, -0.38 + wave);
  ctx.lineTo(-0.48, -0.5);
  ctx.closePath();
  ctx.fill();
  // Pole
  ctx.lineCap = "round";
  ctx.strokeStyle = INK;
  ctx.lineWidth = Math.min(2.8 * px, 0.26);
  ctx.beginPath();
  ctx.moveTo(-0.55, 0.8);
  ctx.lineTo(-0.55, -0.84);
  ctx.stroke();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = Math.min(1.3 * px, 0.12);
  ctx.stroke();
  ctx.restore();
}

// Carried on the back, drawn bigger than on the ground so the whole map sees it.
function drawCarriedFlag(ctx: CanvasRenderingContext2D, team: Team, x: number, y: number, nowMs: number): void {
  drawFlagShape(ctx, team, x, y, 13, nowMs);
}

// A dropped flag: a dashed ring where soldiers can touch it, and an arc that empties as
// its automatic return gets closer.
function drawReturnRing(ctx: CanvasRenderingContext2D, team: Team, x: number, y: number, left: number): void {
  const r = TANK_RADIUS + FLAG_RADIUS;
  ctx.fillStyle = TEAM[team].glow;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 4.5;
  ctx.beginPath();
  ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + left * Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2.5;
  ctx.stroke();
}

// --- Furniture and power boxes -----------------------------------------------------------

function drawCrate(ctx: CanvasRenderingContext2D, c: Crate, x: number, y: number): void {
  blitAt(ctx, c.bed ? bedSprite() : c.desk ? deskSprite() : crateSprite(), x, y);
}

const POP_MS = 420;

// The "?" box: a soft violet halo, a gentle bob, a twinkle, and a pop when it appears.
function drawPowerBox(ctx: CanvasRenderingContext2D, x: number, y: number, nowMs: number, since: number): void {
  const age = nowMs - since;
  const pop = age < POP_MS ? easeOutBack(age / POP_MS) : 1;
  const bob = Math.sin(nowMs / 320) * 1.5;
  ctx.globalAlpha = 0.45 + 0.25 * Math.sin(nowMs / 260);
  blitAt(ctx, glowSprite("rgba(176, 110, 255, 0.85)"), x, y, 0.75 * pop);
  ctx.globalAlpha = 1;
  if (age < POP_MS) {
    // A ring bursting out as it lands.
    const p = age / POP_MS;
    ctx.strokeStyle = "rgba(220, 190, 255, " + (1 - p) + ")";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, 10 + p * 24, 0, Math.PI * 2);
    ctx.stroke();
  }
  blitAt(ctx, powerBoxSprite(), x, y + bob * pop, pop);
  const tw = (nowMs / 900) % 1;
  if (tw < 0.5) {
    const s = Math.sin(tw * 2 * Math.PI);
    ctx.globalAlpha = s;
    blitAt(ctx, sparkleSprite(), x + 9, y - 10 + bob, 0.5 + 0.5 * s);
    ctx.globalAlpha = 1;
  }
}

// --- Bullets ----------------------------------------------------------------------------

// A bright ball with a long, thin light streak behind it that fades. The streak grows out of
// the muzzle until it reaches its full length (longer for faster bullets), and the bullet
// fades over the last BULLET_FADE px of its range.
export function drawBullet(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, rangeLeft: number, team: Team = "red"): void {
  drawBulletAt(ctx, x, y, Math.cos(angle) * BULLET_SPEED, Math.sin(angle) * BULLET_SPEED, rangeLeft, team);
}

function drawBulletAt(ctx: CanvasRenderingContext2D, x: number, y: number, vx: number, vy: number, rangeLeft: number, team: Team): void {
  const speed = Math.hypot(vx, vy);
  const full = STREAK_LENGTH * (speed / BULLET_SPEED);
  const len = Math.max(0, Math.min(full, BULLET_RANGE - rangeLeft));
  const fade = Math.max(0, Math.min(1, rangeLeft / BULLET_FADE));
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.atan2(vy, vx));
  ctx.globalAlpha = 0.25 + 0.75 * fade;
  if (len > 1) {
    const s = bulletStreakSprite(team);
    ctx.drawImage(s.canvas, -len, -s.oy, len, s.h);
  }
  blit(ctx, bulletBallSprite(team), 0.75 + 0.25 * fade);
  ctx.restore();
}

// Bullets that vanished since the last frame (hit a wall, a crate, a soldier, or ran out of
// range) burst into small bits where they were last seen. Tracked here rather than from
// events so every way a bullet ends looks the same.
interface Flying {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rangeLeft: number;
  team: Team;
  seen: number;
}
const flying = new Map<number, Flying>();
let frameNo = 0;

function trackBullets(curr: GameState, nowMs: number): void {
  frameNo++;
  // Between rounds the map is cleared, not shot at: no bursts for those bullets.
  if (curr.winner) {
    flying.clear();
    return;
  }
  for (const b of curr.bullets) {
    let f = flying.get(b.id);
    if (!f) {
      f = { x: 0, y: 0, vx: 0, vy: 0, rangeLeft: 0, team: b.team, seen: 0 };
      flying.set(b.id, f);
    }
    f.x = b.x;
    f.y = b.y;
    f.vx = b.vx;
    f.vy = b.vy;
    f.rangeLeft = b.rangeLeft;
    f.team = b.team;
    f.seen = frameNo;
  }
  for (const [id, f] of flying) {
    if (f.seen === frameNo) continue;
    flying.delete(id);
    // Ran out of range in the open: bits all round. Hit something: they bounce back off it,
    // from about where it hit (half a tick further on).
    const expired = f.rangeLeft <= (BULLET_SPEED * TICK_MS) / 1000 + 1;
    const dt = TICK_MS / 2000;
    spawnBits(f.x + f.vx * dt, f.y + f.vy * dt, Math.atan2(f.vy, f.vx), expired, f.team, nowMs);
  }
}

// A fixed pool of particles, so bursts never allocate.
const BIT_COUNT = 160;
const BIT_MS = 300;
const bitX = new Float32Array(BIT_COUNT);
const bitY = new Float32Array(BIT_COUNT);
const bitVX = new Float32Array(BIT_COUNT);
const bitVY = new Float32Array(BIT_COUNT);
const bitBorn = new Float64Array(BIT_COUNT).fill(-Infinity);
const bitTeam = new Uint8Array(BIT_COUNT);
let bitNext = 0;
let bitSeed = 1;

function spawnBits(x: number, y: number, heading: number, allRound: boolean, team: Team, nowMs: number): void {
  const n = 6;
  for (let k = 0; k < n; k++) {
    bitSeed++;
    const a = allRound ? (k / n) * Math.PI * 2 + hash(bitSeed, k, 1) * 0.8 : heading + Math.PI + (hash(bitSeed, k, 2) - 0.5) * 2.6;
    const v = 50 + hash(bitSeed, k, 3) * 70; // px/s
    const i = bitNext;
    bitNext = (bitNext + 1) % BIT_COUNT;
    bitX[i] = x;
    bitY[i] = y;
    bitVX[i] = Math.cos(a) * v;
    bitVY[i] = Math.sin(a) * v;
    bitBorn[i] = nowMs;
    bitTeam[i] = team === "red" ? 0 : 1;
  }
}

function drawBits(ctx: CanvasRenderingContext2D, nowMs: number): void {
  for (let team = 0; team < 2; team++) {
    ctx.fillStyle = team === 0 ? TEAM.red.light : TEAM.blue.light;
    ctx.beginPath();
    let any = false;
    for (let i = 0; i < BIT_COUNT; i++) {
      const age = nowMs - bitBorn[i]!;
      if (age < 0 || age >= BIT_MS || bitTeam[i] !== team) continue;
      const p = age / BIT_MS;
      const t = (age / 1000) * (1 - p / 2); // slows down as it flies
      const s = 2.6 * (1 - p);
      const x = bitX[i]! + bitVX[i]! * t;
      const y = bitY[i]! + bitVY[i]! * t;
      ctx.moveTo(x + s, y);
      ctx.arc(x, y, s, 0, Math.PI * 2);
      any = true;
    }
    if (any) {
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fill();
    }
  }
}

// --- Effects ----------------------------------------------------------------------------

const EFFECT_MS: Record<Effect["kind"], number> = {
  flash: 80,
  boom: 520,
  splinters: 600,
  spark: 300,
  shatter: 520,
  ring: 480,
  text: 1100,
};

function drawEffects(ctx: CanvasRenderingContext2D, effects: Effect[], nowMs: number): void {
  for (const e of effects) {
    const age = nowMs - e.bornMs;
    const life = EFFECT_MS[e.kind];
    if (age < 0 || age >= life) continue;
    const p = age / life;
    const seed = Math.round(e.x * 13 + e.y * 7 + e.bornMs);
    switch (e.kind) {
      case "flash": {
        ctx.save();
        ctx.translate(e.x, e.y);
        ctx.rotate(e.angle ?? 0);
        ctx.globalAlpha = 1 - p;
        blit(ctx, flashSprite(), 0.8 + 0.5 * p);
        ctx.restore();
        break;
      }
      case "boom": {
        // A white pop, a ring in the fallen soldier's colour, and bits flying out.
        const c = TEAM[e.team];
        if (p < 0.25) {
          ctx.fillStyle = `rgba(255, 255, 255, ${0.9 * (1 - p / 0.25)})`;
          ctx.beginPath();
          ctx.arc(e.x, e.y, 10 + 30 * p, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1 - p;
        ctx.strokeStyle = c.light;
        ctx.lineWidth = 5 * (1 - p) + 1;
        ctx.beginPath();
        ctx.arc(e.x, e.y, TANK_RADIUS + easeOut(p) * 26, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        for (let k = 0; k < 9; k++) {
          const a = (k / 9) * Math.PI * 2 + hash(seed, k, 1);
          const d = 8 + easeOut(p) * (26 + hash(seed, k, 2) * 16);
          const s = 3.2 * (1 - p) + 0.5;
          const bx = e.x + Math.cos(a) * d;
          const by = e.y + Math.sin(a) * d;
          ctx.moveTo(bx + s, by);
          ctx.arc(bx, by, s, 0, Math.PI * 2);
        }
        ctx.fillStyle = c.body;
        ctx.strokeStyle = INK;
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.fill();
        ctx.globalAlpha = 1;
        break;
      }
      case "splinters": {
        // A broken crate: a puff of dust and planks spinning out.
        ctx.globalAlpha = 0.5 * (1 - p);
        ctx.fillStyle = "#d9b98a";
        ctx.beginPath();
        for (let k = 0; k < 4; k++) {
          const a = (k / 4) * Math.PI * 2 + 0.5;
          const d = 6 + p * 14;
          const r = CRATE_SIZE * (0.3 + 0.25 * easeOut(p));
          ctx.moveTo(e.x + Math.cos(a) * d + r, e.y + Math.sin(a) * d);
          ctx.arc(e.x + Math.cos(a) * d, e.y + Math.sin(a) * d, r, 0, Math.PI * 2);
        }
        ctx.fill();
        ctx.globalAlpha = 1 - p * p;
        for (let k = 0; k < 9; k++) {
          const a = (k / 9) * Math.PI * 2 + hash(seed, k, 3) * 0.6;
          const d = 4 + easeOut(p) * (CRATE_SIZE * 0.9 + hash(seed, k, 4) * 18);
          ctx.save();
          ctx.translate(e.x + Math.cos(a) * d, e.y + Math.sin(a) * d);
          ctx.rotate(a + p * (4 + hash(seed, k, 5) * 6));
          ctx.fillStyle = k % 3 === 0 ? "#8b5524" : "#e0a35e";
          ctx.strokeStyle = INK;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.rect(-5, -1.8, 10, 3.6);
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        }
        ctx.globalAlpha = 1;
        break;
      }
      case "spark": {
        // A shield stops a bullet: a bright ring and short sparks.
        const color = e.color ?? POWER_COLOR.shield;
        ctx.globalAlpha = 1 - p;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(e.x, e.y, 4 + p * 12, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2 + hash(seed, k, 6);
          const d0 = 5 + p * 10;
          ctx.moveTo(e.x + Math.cos(a) * d0, e.y + Math.sin(a) * d0);
          ctx.lineTo(e.x + Math.cos(a) * (d0 + 6), e.y + Math.sin(a) * (d0 + 6));
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
        break;
      }
      case "shatter": {
        // The shield's last hit: the bubble bursts into glassy shards.
        ctx.globalAlpha = 1 - p;
        ctx.strokeStyle = POWER_COLOR.shield;
        ctx.lineWidth = 3 * (1 - p) + 1;
        ctx.beginPath();
        ctx.arc(e.x, e.y, SHIELD_R + easeOut(p) * 18, 0, Math.PI * 2);
        ctx.stroke();
        for (let k = 0; k < 10; k++) {
          const a = (k / 10) * Math.PI * 2 + hash(seed, k, 7) * 0.5;
          const d = SHIELD_R * 0.6 + easeOut(p) * (22 + hash(seed, k, 8) * 14);
          ctx.save();
          ctx.translate(e.x + Math.cos(a) * d, e.y + Math.sin(a) * d);
          ctx.rotate(a + p * 5);
          ctx.fillStyle = k % 2 ? "#ffffff" : POWER_COLOR.shield;
          ctx.strokeStyle = INK;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(-4, -3);
          ctx.lineTo(5, 0);
          ctx.lineTo(-3, 3.5);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        }
        ctx.globalAlpha = 1;
        break;
      }
      case "ring": {
        // A power picked up: a ring in its colour and a few sparkles.
        const color = e.color ?? "#ffffff";
        ctx.globalAlpha = 1 - p;
        ctx.strokeStyle = color;
        ctx.lineWidth = 4 * (1 - p) + 1;
        ctx.beginPath();
        ctx.arc(e.x, e.y, 10 + easeOut(p) * 26, 0, Math.PI * 2);
        ctx.stroke();
        for (let k = 0; k < 4; k++) {
          const a = (k / 4) * Math.PI * 2 + 0.6;
          const d = 14 + easeOut(p) * 18;
          blitAt(ctx, sparkleSprite(), e.x + Math.cos(a) * d, e.y + Math.sin(a) * d, 1 - p * 0.5);
        }
        ctx.globalAlpha = 1;
        break;
      }
      case "text": {
        // Pops in, floats up and fades out.
        const pop = age < 160 ? easeOutBack(age / 160) : 1;
        ctx.globalAlpha = p < 0.75 ? 1 : 1 - (p - 0.75) / 0.25;
        blitAt(ctx, labelSprite(e.label ?? "", e.color ?? "#ffffff"), e.x, e.y - TANK_RADIUS - 18 - easeOut(p) * 20, pop);
        ctx.globalAlpha = 1;
        break;
      }
    }
  }
}

// Drops finished effects, in place (no new array each frame).
export function pruneEffects(effects: Effect[], nowMs: number): Effect[] {
  let n = 0;
  for (const e of effects) if (nowMs - e.bornMs < EFFECT_MS[e.kind]) effects[n++] = e;
  effects.length = n;
  return effects;
}

// --- Tournament scoreboard and win banner ------------------------------------------------

// Tournaments only: a small glassy bar on the top wall, outside the play area: red points,
// the round and map, blue points.
function drawScoreboard(ctx: CanvasRenderingContext2D, map: GameMap, match: Match): void {
  const cx = map.width / 2;
  const cy = TILE / 2;
  const round = Math.min(match.round, match.rounds);
  const label = `ROUND ${round}/${match.rounds} · ${getMap(match.maps[round - 1] ?? "").name.toUpperCase()}`;
  ctx.font = font(11);
  const lw = ctx.measureText(label).width;
  const w = lw + 24 + 2 * 44;
  ctx.fillStyle = "rgba(14, 18, 36, 0.78)";
  ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(cx - w / 2, cy - 13, w, 26, 13);
  ctx.fill();
  ctx.stroke();
  for (const [team, sx] of [
    ["red", cx - w / 2 + 3],
    ["blue", cx + w / 2 - 41],
  ] as const) {
    const c = TEAM[team];
    const grad = ctx.createLinearGradient(0, cy - 10, 0, cy + 10);
    grad.addColorStop(0, c.light);
    grad.addColorStop(0.5, c.body);
    grad.addColorStop(1, c.dark);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(sx, cy - 10, 38, 20, 10);
    ctx.fill();
    ctx.font = font(16);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = INK;
    const score = String(match.scores[team]);
    ctx.strokeText(score, sx + 19, cy + 1);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(score, sx + 19, cy + 1);
  }
  ctx.font = font(11);
  ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
  ctx.textAlign = "center";
  ctx.fillText(label, cx, cy + 1);
}

let bannerSince = -1;

// Single match: "RED WINS". Tournament: "RED WINS ROUND 2" with the points, and after the
// last round "RED WINS THE TOURNAMENT" with the final score. A team-coloured ribbon pops in
// over a darkened map.
function drawWinBanner(ctx: CanvasRenderingContext2D, map: GameMap, winner: Team, overMs: number, match: Match, nowMs: number): void {
  if (bannerSince < 0 || nowMs < bannerSince) bannerSince = nowMs;
  const age = nowMs - bannerSince;
  const tournament = match.rounds > 1;
  const finished = match.round >= match.rounds;
  const champion = finished ? match.champion : null;
  const headlineTeam = finished && tournament ? champion ?? winner : winner;
  const color = TEAM[headlineTeam];
  const name = headlineTeam.toUpperCase();
  const headline = !tournament ? `${name} WINS` : finished ? `${name} WINS THE TOURNAMENT` : `${winner.toUpperCase()} WINS ROUND ${match.round}`;
  const seconds = Math.max(1, Math.ceil(overMs / 1000));
  const score = `Red ${match.scores.red} : ${match.scores.blue} Blue`;
  const subline = !tournament
    ? `New match in ${seconds}`
    : finished
      ? `Final score ${score} · New tournament in ${seconds}`
      : `${score} · Round ${match.round + 1} on ${getMap(match.maps[match.round] ?? "").name} in ${seconds}`;

  const fadeIn = Math.min(1, age / 250);
  ctx.fillStyle = `rgba(8, 11, 26, ${0.55 * fadeIn})`;
  ctx.fillRect(0, 0, map.width, map.height);

  const cx = map.width / 2;
  const cy = map.height / 2 - 14;
  const pop = age < 450 ? easeOutBack(age / 450) : 1;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(pop, pop);
  const big = headline.length > 16 ? 54 : 78;
  ctx.font = font(big);
  const w = Math.min(map.width - 60, ctx.measureText(headline).width + 120);
  const h = big + 46;
  // Ribbon: ink shadow, team gradient, a shine across the top.
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.roundRect(-w / 2, -h / 2 + 8, w, h, 22);
  ctx.fill();
  const grad = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
  grad.addColorStop(0, color.light);
  grad.addColorStop(0.45, color.body);
  grad.addColorStop(1, color.dark);
  ctx.fillStyle = grad;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.roundRect(-w / 2, -h / 2, w, h, 22);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "rgba(255, 255, 255, 0.22)";
  ctx.beginPath();
  ctx.roundRect(-w / 2 + 8, -h / 2 + 6, w - 16, h * 0.36, 16);
  ctx.fill();
  // Headline
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = 12;
  ctx.strokeStyle = INK;
  ctx.strokeText(headline, 0, 5);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(headline, 0, 2);
  // Subline on a dark pill under the ribbon
  ctx.font = font(20);
  const sw = ctx.measureText(subline).width + 40;
  ctx.fillStyle = "rgba(14, 18, 36, 0.88)";
  ctx.beginPath();
  ctx.roundRect(-sw / 2, h / 2 + 18, sw, 38, 19);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.fillText(subline, 0, h / 2 + 38);
  ctx.restore();
}

// --- Helpers ----------------------------------------------------------------------------

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function easeOut(p: number): number {
  return 1 - (1 - p) * (1 - p);
}

function easeOutBack(p: number): number {
  const c = 1.7;
  const q = p - 1;
  return 1 + (c + 1) * q * q * q + c * q * q;
}
