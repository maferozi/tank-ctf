import {
  BODY_FRICTION,
  BULLET_RANGE,
  BULLET_RADIUS,
  BULLET_SPEED,
  CARRIER_SPEED,
  CRATE_BREAKAWAY_MS,
  CRATE_MASS,
  CRATE_SIZE,
  CRATE_STATIC,
  DRIVE_SPEED,
  FIRE_COOLDOWN_MS,
  FLARE_INTERVAL_MS,
  FLARE_MS,
  HIT_KNOCKBACK,
  MAX_AMMO,
  POWER_BOX_SIZE,
  POWER_RESPAWN_MS,
  RELOAD_MS,
  RESPAWN_MS,
  RAPID_FIRE_MS,
  SHIELD_MS,
  SPEED_BOOST,
  SPEED_MS,
  SPIN_PAUSE_MS,
  BODY_MASS,
  IDLE_TANK_BRAKE,
  SPIN_SPEED,
  TANK_MASS,
  TANK_RADIUS,
  TICK_MS,
} from "./constants";
import { createFlags, dropFlagOf, isCarrying, tickFlags, type Flag } from "./flags";
import { circleHitsWall, type GameMap, type Team } from "./map";
import { contact, resolveContacts, shove, type Body } from "./physics";

export interface Tank {
  id: string;
  team: Team;
  x: number;
  y: number;
  angle: number;
  spinDir: 1 | -1; // flips on every press
  spinPauseMs: number; // heading is held still until this runs out
  lastPressTick: number;
  aimAngle: number; // heading of the first shot in the current rapid-fire run
  held: boolean;
  pressMs: number; // how long the current press has lasted
  driving: boolean; // press has passed holdMs
  cooldownMs: number;
  ammo: number;
  reloadMs: number; // progress towards the next round
  shieldMs: number; // power-ups: time left, 0 = inactive
  speedMs: number;
  flareMs: number;
  flareTimerMs: number; // time until the next flare burst
  alive: boolean;
  respawnMs: number;
  spawnIndex: number;
  // While down: the body's slide (px/s) and the direction it fell, head first.
  vx: number;
  vy: number;
  fallAngle: number;
}

export interface Bullet {
  id: number;
  owner: string;
  team: Team;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rangeLeft: number; // px left before the bullet drops
}

// A movable obstacle. Heavy, blocks bullets, and "sticks" before it starts sliding.
export interface Crate {
  id: number;
  x: number;
  y: number;
  pushMs: number; // how long it has been pushed recently; loosens it up
}

export type PowerKind = "shield" | "speed" | "flare";
export const POWER_KINDS: readonly PowerKind[] = ["shield", "speed", "flare"];

// Touch it to get a random power. A tank that already has a power can't take it:
// for that tank it is a solid box that pushes like a crate. Once taken it comes back
// at its home spot after POWER_RESPAWN_MS.
export interface PowerBox {
  id: number;
  x: number;
  y: number;
  homeX: number;
  homeY: number;
  respawnMs: number; // 0 = on the map and can be taken
  pushMs: number; // same "sticks, then slides" feel as a crate
}

export type GameEvent =
  | { type: "fire"; tankId: string; x: number; y: number }
  | { type: "drop"; tankId: string; x: number; y: number } // bullet ran out of range
  | { type: "kill"; tankId: string; by: string; x: number; y: number }
  | { type: "power"; tankId: string; kind: PowerKind; x: number; y: number }
  | { type: "shieldHit"; tankId: string; x: number; y: number }
  | { type: "flag"; action: "taken" | "dropped" | "returned"; team: Team; tankId: string; x: number; y: number }
  | { type: "capture"; team: Team; tankId: string; x: number; y: number } // team = winner
  | { type: "round"; tankId: string; x: number; y: number }; // a new round started

export interface GameState {
  tick: number;
  tanks: Tank[];
  bullets: Bullet[];
  crates: Crate[];
  powerBoxes: PowerBox[];
  flags: Flag[];
  winner: Team | null; // set when a flag is captured; the round is over
  overMs: number; // while over: time until the next round starts
  rng: number; // seed for power-up rolls, so server and clients roll the same
  nextBulletId: number;
  events: GameEvent[]; // events produced by the last step only
}

// One tick of input for one tank. `pressed` is true if a press started since the
// previous tick, so a press and release inside the same tick still counts as a tap.
export interface TankInput {
  held: boolean;
  pressed: boolean;
}

export interface SimConfig {
  holdMs: number;
}

// Pass the map to place its crates, power boxes and flags; without one the arena starts
// empty (handy in tests).
export function createState(map?: GameMap): GameState {
  return {
    tick: 0,
    tanks: [],
    bullets: [],
    ...mapObjects(map),
    winner: null,
    overMs: 0,
    rng: 0x2f6b1d3,
    nextBulletId: 1,
    events: [],
  };
}

function mapObjects(map?: GameMap): Pick<GameState, "crates" | "powerBoxes" | "flags"> {
  return {
    crates: (map?.crates ?? []).map((c, i) => ({ id: i + 1, x: c.x, y: c.y, pushMs: 0 })),
    powerBoxes: (map?.powerBoxes ?? []).map((p, i) => ({
      id: i + 1,
      x: p.x,
      y: p.y,
      homeX: p.x,
      homeY: p.y,
      respawnMs: 0,
      pushMs: 0,
    })),
    flags: map ? createFlags(map) : [],
  };
}

export function cloneState(s: GameState): GameState {
  return {
    tick: s.tick,
    tanks: s.tanks.map((t) => ({ ...t })),
    bullets: s.bullets.map((b) => ({ ...b })),
    crates: s.crates.map((c) => ({ ...c })),
    powerBoxes: s.powerBoxes.map((p) => ({ ...p })),
    flags: s.flags.map((f) => ({ ...f })),
    winner: s.winner,
    overMs: s.overMs,
    rng: s.rng,
    nextBulletId: s.nextBulletId,
    events: [...s.events],
  };
}

export function addTank(state: GameState, map: GameMap, id: string, team: Team): Tank {
  const spawnIndex = state.tanks.filter((t) => t.team === team).length;
  const tank: Tank = {
    id,
    team,
    x: 0,
    y: 0,
    angle: 0,
    spinDir: 1,
    spinPauseMs: 0,
    lastPressTick: -1e9, // finite so the state stays JSON/network safe
    aimAngle: 0,
    held: false,
    pressMs: 0,
    driving: false,
    cooldownMs: 0,
    ammo: MAX_AMMO,
    reloadMs: 0,
    shieldMs: 0,
    speedMs: 0,
    flareMs: 0,
    flareTimerMs: 0,
    alive: true,
    respawnMs: 0,
    spawnIndex,
    vx: 0,
    vy: 0,
    fallAngle: 0,
  };
  placeAtSpawn(tank, map);
  state.tanks.push(tank);
  return tank;
}

export function removeTank(state: GameState, id: string): void {
  state.tanks = state.tanks.filter((t) => t.id !== id);
}

function placeAtSpawn(tank: Tank, map: GameMap): void {
  const list = map.spawns[tank.team];
  const spawn = list[tank.spawnIndex % list.length];
  if (!spawn) throw new Error(`map has no spawns for team ${tank.team}`);
  tank.x = spawn.x;
  tank.y = spawn.y;
  tank.angle = spawn.angle;
}

const NO_INPUT: TankInput = { held: false, pressed: false };

// Advances the state by one tick in place. Deterministic: the same state, inputs
// and config always give the same result, so the server and client prediction agree.
export function step(
  state: GameState,
  map: GameMap,
  inputs: Record<string, TankInput>,
  config: SimConfig,
): void {
  const dt = TICK_MS / 1000;
  state.tick++;
  state.events = [];

  // Round over: everything holds still under the win banner, then a fresh round.
  if (state.winner) {
    state.overMs -= TICK_MS;
    if (state.overMs <= 1e-6) resetRound(state, map);
    return;
  }

  for (const tank of state.tanks) {
    if (!tank.alive) {
      slideBody(tank, map, dt);
      tank.respawnMs -= TICK_MS;
      if (tank.respawnMs <= 0) {
        placeAtSpawn(tank, map);
        tank.alive = true;
        tank.cooldownMs = 0;
        tank.ammo = MAX_AMMO;
        tank.reloadMs = 0;
        tank.vx = tank.vy = 0;
      }
      tank.held = false;
      tank.pressMs = 0;
      tank.driving = false;
      continue;
    }

    const input = inputs[tank.id] ?? NO_INPUT;
    tank.cooldownMs = Math.max(0, tank.cooldownMs - TICK_MS);
    if (tank.ammo < MAX_AMMO) {
      tank.reloadMs += TICK_MS;
      // Epsilon: summing TICK_MS (1000/60) can land a hair under a whole RELOAD_MS.
      if (tank.reloadMs >= RELOAD_MS - 1e-6) {
        tank.ammo++;
        tank.reloadMs -= RELOAD_MS;
      }
    } else {
      tank.reloadMs = 0;
    }
    tickPowers(state, tank);

    // Every press fires straight away and reverses the spin.
    const pressStarted = input.pressed || (input.held && !tank.held);
    if (pressStarted) {
      const sinceLastPress = (state.tick - tank.lastPressTick) * TICK_MS;
      if (sinceLastPress <= RAPID_FIRE_MS) tank.angle = tank.aimAngle;
      else tank.aimAngle = tank.angle;
      tank.lastPressTick = state.tick;
      fire(state, tank);
      tank.spinDir = tank.spinDir === 1 ? -1 : 1;
      tank.spinPauseMs = SPIN_PAUSE_MS;
      tank.pressMs = 0;
      tank.driving = false;
    }

    if (input.held) {
      tank.pressMs += TICK_MS;
      if (tank.pressMs >= config.holdMs) tank.driving = true;
    } else {
      tank.pressMs = 0;
      tank.driving = false;
    }
    tank.held = input.held;

    if (tank.driving) {
      const dist = walkSpeed(state, tank) * dt;
      shove(tankBody(tank), map, Math.cos(tank.angle) * dist, Math.sin(tank.angle) * dist);
    } else if (tank.spinPauseMs > 0) {
      tank.spinPauseMs -= TICK_MS;
    } else {
      tank.angle = wrapAngle(tank.angle + tank.spinDir * SPIN_SPEED * dt);
    }
  }

  // Pickups first: a tank without a power that drove into a box takes it, and only the
  // boxes still on the map are solid in the push step.
  collectPowerBoxes(state);
  pushBodies(state, map);
  stepBullets(state, map, dt);
  tickFlags(state);
}

function walkSpeed(state: GameState, tank: Tank): number {
  return DRIVE_SPEED * (tank.speedMs > 0 ? SPEED_BOOST : 1) * (isCarrying(state, tank.id) ? CARRIER_SPEED : 1);
}

// A fallen body keeps the momentum it had and slides to a stop; walls stop it dead.
function slideBody(tank: Tank, map: GameMap, dt: number): void {
  const speed = Math.hypot(tank.vx, tank.vy);
  if (speed < 1) {
    tank.vx = tank.vy = 0;
    return;
  }
  const want = speed * dt;
  const moved = shove(tankBody(tank), map, tank.vx * dt, tank.vy * dt);
  const slower = moved < want * 0.5 ? 0 : Math.max(0, speed - BODY_FRICTION * dt) / speed;
  tank.vx *= slower;
  tank.vy *= slower;
}

// Shot: a walking soldier keeps going and falls forward; a standing one is knocked back
// along the bullet's path. Any flag they carried drops where they fall.
function killTank(state: GameState, t: Tank, bullet: Bullet): void {
  if (t.driving) {
    const speed = walkSpeed(state, t);
    t.vx = Math.cos(t.angle) * speed;
    t.vy = Math.sin(t.angle) * speed;
    t.fallAngle = t.angle;
  } else {
    const along = Math.atan2(bullet.vy, bullet.vx);
    t.vx = Math.cos(along) * HIT_KNOCKBACK;
    t.vy = Math.sin(along) * HIT_KNOCKBACK;
    t.fallAngle = along;
  }
  t.alive = false;
  t.driving = false;
  clearPowers(t);
  t.respawnMs = RESPAWN_MS;
  state.events.push({ type: "kill", tankId: t.id, by: bullet.owner, x: t.x, y: t.y });
  dropFlagOf(state, t);
}

// A fresh round with the same players: everyone back at their spawn, full ammo, no
// powers, flags home, crates and power boxes back where the map puts them.
export function resetRound(state: GameState, map: GameMap): void {
  Object.assign(state, mapObjects(map));
  state.winner = null;
  state.overMs = 0;
  state.bullets = [];
  for (const t of state.tanks) {
    placeAtSpawn(t, map);
    Object.assign(t, {
      alive: true,
      respawnMs: 0,
      held: false,
      pressMs: 0,
      driving: false,
      cooldownMs: 0,
      ammo: MAX_AMMO,
      reloadMs: 0,
      spinPauseMs: 0,
      vx: 0,
      vy: 0,
    });
    clearPowers(t);
  }
  state.events.push({ type: "round", tankId: "", x: 0, y: 0 });
}

function powerBoxBody(p: PowerBox): Body {
  return heavyBoxBody(p, POWER_BOX_SIZE);
}

// Boxes count down while taken. A tank touching an available box takes it, unless it
// already has a power: then the box stays for someone else.
function collectPowerBoxes(state: GameState): void {
  for (const box of state.powerBoxes) {
    if (box.respawnMs > 0) {
      box.respawnMs = Math.max(0, box.respawnMs - TICK_MS);
      if (box.respawnMs === 0) {
        box.x = box.homeX;
        box.y = box.homeY;
        box.pushMs = 0;
      }
      continue;
    }
    const taker = state.tanks.find((t) => t.alive && !hasPower(t) && contact(tankBody(t), powerBoxBody(box)));
    if (taker) takePowerBox(state, box, taker);
  }
}

function takePowerBox(state: GameState, box: PowerBox, tank: Tank): void {
  box.respawnMs = POWER_RESPAWN_MS;
  givePower(state, tank, POWER_KINDS[nextRandom(state) % POWER_KINDS.length]!);
}

export function hasPower(t: Tank): boolean {
  return t.shieldMs > 0 || t.speedMs > 0 || t.flareMs > 0;
}

// A tank holds one power at a time, so this replaces any power it had.
export function givePower(state: GameState, tank: Tank, kind: PowerKind): void {
  clearPowers(tank);
  if (kind === "shield") tank.shieldMs = SHIELD_MS;
  if (kind === "speed") tank.speedMs = SPEED_MS;
  if (kind === "flare") {
    tank.flareMs = FLARE_MS;
    tank.flareTimerMs = 0; // first burst right away
  }
  state.events.push({ type: "power", tankId: tank.id, kind, x: tank.x, y: tank.y });
}

function tickPowers(state: GameState, tank: Tank): void {
  tank.shieldMs = Math.max(0, tank.shieldMs - TICK_MS);
  tank.speedMs = Math.max(0, tank.speedMs - TICK_MS);
  // Epsilon: summed TICK_MS leaves a sliver of flareMs when FLARE_MS is a whole number
  // of intervals, which would fire one burst too many right as the flare ends.
  if (tank.flareMs <= 1e-6) {
    tank.flareMs = 0;
    return;
  }
  // Epsilon as with reload: summed TICK_MS can land a hair off a whole interval.
  if (tank.flareTimerMs <= 1e-6) {
    for (let k = 0; k < 4; k++) spawnBullet(state, tank, tank.angle + (k * Math.PI) / 2);
    tank.flareTimerMs += FLARE_INTERVAL_MS;
  }
  tank.flareTimerMs -= TICK_MS;
  tank.flareMs = Math.max(0, tank.flareMs - TICK_MS);
}

function clearPowers(tank: Tank): void {
  tank.shieldMs = 0;
  tank.speedMs = 0;
  tank.flareMs = 0;
  tank.flareTimerMs = 0;
}

// Small deterministic PRNG (mulberry32) kept in the state.
function nextRandom(state: GameState): number {
  state.rng = (state.rng + 0x6d2b79f5) | 0;
  let t = state.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}

function tankBody(t: Tank): Body {
  const mass = !t.alive ? BODY_MASS : t.driving ? TANK_MASS : TANK_MASS * IDLE_TANK_BRAKE;
  return { pos: t, shape: "circle", size: TANK_RADIUS, mass };
}

function crateBody(c: Crate): Body {
  return heavyBoxBody(c, CRATE_SIZE);
}

// Crates and power boxes: heavy, and stuck at first until pushed for CRATE_BREAKAWAY_MS.
function heavyBoxBody(box: Crate | PowerBox, size: number): Body {
  const stuck = 1 - Math.min(1, box.pushMs / CRATE_BREAKAWAY_MS);
  return { pos: box, shape: "box", size: size / 2, mass: CRATE_MASS * (1 + (CRATE_STATIC - 1) * stuck) };
}

// Tanks, crates and power boxes on the map never overlap; pushing is decided by weight
// (see resolveContacts).
function pushBodies(state: GameState, map: GameMap): void {
  const boxes = [...state.crates, ...state.powerBoxes.filter((p) => p.respawnMs <= 0)];
  const bodies = [
    // Fallen soldiers stay solid where they lie: they can be pushed, and they still
    // shield their team from bullets wherever they end up.
    ...state.tanks.map(tankBody),
    ...state.crates.map(crateBody),
    ...state.powerBoxes.filter((p) => p.respawnMs <= 0).map(powerBoxBody),
  ];
  const pushed = new Set<object>();
  resolveContacts(bodies, map, (b) => pushed.add(b.pos));
  // A box loosens up while it keeps being pushed and settles again quickly when left alone.
  for (const box of boxes) {
    box.pushMs = pushed.has(box)
      ? Math.min(CRATE_BREAKAWAY_MS, box.pushMs + TICK_MS)
      : Math.max(0, box.pushMs - 2 * TICK_MS);
  }
}

function fire(state: GameState, tank: Tank): void {
  if (tank.cooldownMs > 0 || tank.ammo <= 0) return;
  tank.cooldownMs = FIRE_COOLDOWN_MS;
  tank.ammo--;
  spawnBullet(state, tank, tank.angle);
}

function spawnBullet(state: GameState, tank: Tank, angle: number): void {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const muzzle = TANK_RADIUS + BULLET_RADIUS + 2;
  const x = tank.x + cos * muzzle;
  const y = tank.y + sin * muzzle;
  state.bullets.push({
    id: state.nextBulletId++,
    owner: tank.id,
    team: tank.team,
    x,
    y,
    vx: cos * BULLET_SPEED,
    vy: sin * BULLET_SPEED,
    rangeLeft: BULLET_RANGE,
  });
  state.events.push({ type: "fire", tankId: tank.id, x, y });
}

function stepBullets(state: GameState, map: GameMap, dt: number): void {
  const hitR = TANK_RADIUS + BULLET_RADIUS;
  state.bullets = state.bullets.filter((b) => {
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.rangeLeft -= BULLET_SPEED * dt;
    if (circleHitsWall(map, b.x, b.y, BULLET_RADIUS)) return false;
    const bulletBody: Body = { pos: b, shape: "circle", size: BULLET_RADIUS, mass: 0 };
    // Crates and power boxes stop bullets (shooting a power box does not take it).
    const blocked =
      state.crates.some((c) => contact(bulletBody, crateBody(c))) ||
      state.powerBoxes.some((p) => p.respawnMs <= 0 && contact(bulletBody, powerBoxBody(p)));
    if (blocked) {
      state.events.push({ type: "drop", tankId: b.owner, x: b.x, y: b.y });
      return false;
    }

    // A fallen soldier's body is cover for their own team: it stops the other team's
    // bullets until they respawn, while their teammates shoot straight through it.
    const body = state.tanks.find((t) => !t.alive && t.team !== b.team && (t.x - b.x) ** 2 + (t.y - b.y) ** 2 <= hitR * hitR);
    if (body) {
      state.events.push({ type: "drop", tankId: b.owner, x: b.x, y: b.y });
      return false;
    }

    for (const t of state.tanks) {
      if (!t.alive || t.id === b.owner || t.team === b.team) continue;
      const dx = t.x - b.x;
      const dy = t.y - b.y;
      if (dx * dx + dy * dy <= hitR * hitR) {
        if (t.shieldMs > 0) {
          state.events.push({ type: "shieldHit", tankId: t.id, x: b.x, y: b.y });
          return false;
        }
        killTank(state, t, b);
        return false;
      }
    }
    if (b.rangeLeft <= 0) {
      state.events.push({ type: "drop", tankId: b.owner, x: b.x, y: b.y });
      return false;
    }
    return true;
  });
}

export function wrapAngle(a: number): number {
  const TAU = Math.PI * 2;
  return ((a % TAU) + TAU) % TAU;
}
