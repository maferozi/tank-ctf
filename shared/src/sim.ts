import {
  BED_MASS,
  BED_SIZE,
  BODY_FRICTION,
  BULLET_RANGE,
  BULLET_RADIUS,
  BULLET_SPEED,
  CARRIER_SPEED,
  CRATE_BREAKAWAY_MS,
  CRATE_BREAKS,
  CRATE_MASS,
  CRATE_SIZE,
  CRATE_STATIC,
  DESK_MASS,
  DESK_SIZE,
  DRIVE_RAMP_MS,
  DRIVE_SPEED,
  DRIVE_START,
  FIRE_COOLDOWN_MS,
  FLARE_INTERVAL_MS,
  FLARE_MS,
  HIT_KNOCKBACK,
  MAX_AMMO,
  MAX_REWIND_TICKS,
  AIM_TOLERANCE,
  TANK_HIT_RADIUS,
  POWER_BOX_SIZE,
  POWER_RESPAWN_MAX_MS,
  POWER_RESPAWN_MIN_MS,
  POWER_START_MAX_MS,
  POWER_START_MIN_MS,
  PUSH_GRIP,
  RELOAD_MS,
  RESPAWN_MS,
  RAPID_FIRE_MS,
  RAPID_FIRE_WOBBLE,
  SHIELD_HITS,
  SHIELD_MS,
  SPAWN_SHIELD_MS,
  SPEED_BOOST,
  SPEED_MS,
  SPIN_PAUSE_MS,
  BODY_MASS,
  IDLE_TANK_BRAKE,
  SPIN_SPEED,
  TANK_MASS,
  TANK_RADIUS,
  TICK_MS,
  UNLIMITED_AMMO,
} from "./constants";
import { createFlags, dropFlagOf, isCarrying, tickFlags, type Flag } from "./flags";
import { circleHitsWall, type GameMap, type Team } from "./map";
import { getMap } from "./maps";
import { advanceMatch, createMatch, type Match, type MatchRounds } from "./match";
import { contact, resolveContacts, shove, toLocal, type Body } from "./physics";

export interface Tank {
  id: string;
  team: Team;
  x: number;
  y: number;
  angle: number;
  spinDir: 1 | -1; // flips on every press
  spinPauseMs: number; // heading is held still until this runs out
  // The soldier's own clock: updates (input samples) since the last press that fired. Not
  // the world tick, so a burst plays out the same on the server as on the shooter's screen
  // even when the server applies their samples unevenly (see step()).
  sincePressTicks: number;
  aimAngle: number; // heading of the first shot in the current burst
  held: boolean;
  pressMs: number; // how long the current press has lasted
  driving: boolean; // press has passed holdMs
  driveMs: number; // how long it has been walking this press (walking speeds up)
  cooldownMs: number;
  ammo: number;
  reloadMs: number; // progress towards the next round
  shieldMs: number; // power-ups: time left, 0 = inactive
  shieldHits: number; // bullets the shield can still stop; the last one pops it
  spawnShieldMs: number; // just respawned: can't be hurt until this runs out (not a power)
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
  // Lag compensation: how many ticks behind the present the shooter saw other players when
  // firing (the tick it fired on minus the press's `seen`). Hits on enemies are checked
  // against where they were that long ago.
  rewind: number;
}

// A movable obstacle. Heavy, blocks bullets, and "sticks" before it starts sliding.
// A bed is a bigger, heavier one (BED_SIZE, BED_MASS); a desk a slightly bigger, heavier
// one (DESK_SIZE, DESK_MASS). Plain crates break when shot (CRATE_BREAKS); beds and desks never do.
// Pushed off-centre it turns (see shove in physics.ts) and stays turned.
export interface Crate {
  id: number;
  x: number;
  y: number;
  angle: number; // radians, -π..π; 0 = square with the map, as every map starts
  pushMs: number; // how long it has been pushed recently; loosens it up
  bed?: boolean;
  desk?: boolean;
}

export type PowerKind = "shield" | "speed" | "flare";
export const POWER_KINDS: readonly PowerKind[] = ["shield", "speed", "flare"];

// Touch it to get a random power. A tank that already has a power can't take it:
// for that tank it is a solid box that pushes like a crate. Boxes start each round hidden
// and appear after a random POWER_START_MIN_MS..POWER_START_MAX_MS; once taken a box comes
// back at its home spot after a random POWER_RESPAWN_MIN_MS..POWER_RESPAWN_MAX_MS.
export interface PowerBox {
  id: number;
  x: number;
  y: number;
  homeX: number;
  homeY: number;
  angle: number; // turned by pushes like a crate; back to 0 when it comes home
  respawnMs: number; // 0 = on the map and can be taken; > 0 = hidden, back after this long
  pushMs: number; // same "sticks, then slides" feel as a crate
}

export type GameEvent =
  | { type: "fire"; tankId: string; x: number; y: number }
  | { type: "drop"; tankId: string; x: number; y: number } // bullet ran out of range
  | { type: "dry"; tankId: string; x: number; y: number } // pressed with an empty magazine
  | { type: "crateBreak"; tankId: string; x: number; y: number } // tankId = shooter
  | { type: "kill"; tankId: string; by: string; x: number; y: number }
  | { type: "power"; tankId: string; kind: PowerKind; x: number; y: number }
  | { type: "shieldHit"; tankId: string; x: number; y: number } // shield stopped a bullet
  | { type: "shieldBreak"; tankId: string; x: number; y: number } // and that was its last hit
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
  match: Match; // single match or tournament: round number, points, champion
  mapId: string; // the map this round is played on; look it up with getMap()
  rng: number; // seed for power-up rolls, so server and clients roll the same
  nextBulletId: number;
  events: GameEvent[]; // events produced by the last step only
}

// One sample of one player's button: one update of their soldier. `pressed` is true if a
// press started since the previous sample, so a press and release inside the same sample
// still counts as a tap.
export interface TankInput {
  held: boolean;
  pressed: boolean;
  // With a press, online: the heading the shooter's own prediction fired along (radians). The
  // shot goes exactly along it when it is within AIM_TOLERANCE of the soldier's heading here,
  // so the bullet leaves where the shooter saw it leave. Absent: the soldier's own heading.
  aim?: number;
  // With a press, online: the server tick of the other players as the shooter's screen drew
  // them (they are drawn a little in the past). Hits are checked against them as seen, at
  // most MAX_REWIND_TICKS back. Absent: no rewind (solo, bots).
  seen?: number;
}

// Each player's samples for one tick. A single sample (or none: an idle button) updates the
// soldier once, as solo play and prediction always do. A list updates it once per sample,
// in order: the server passes [] when a player's sample hasn't arrived (the soldier is
// frozen for the tick: no turning, walking or timers, though it can still be pushed and
// shot) and two samples to catch up after a late burst. So every soldier goes through
// exactly the samples its player's prediction went through.
export type TickInputs = Record<string, TankInput | readonly TankInput[]>;

export interface SimConfig {
  holdMs: number;
  // Lag compensation: where soldier `id` was at `tick` (from the server's position history,
  // or on a client from its snapshots), or null if unknown. Without it, or when it doesn't
  // know, hits use present positions.
  rewind?: (id: string, tick: number) => { x: number; y: number } | null;
}

// Pass the map to place its crates, power boxes and flags; without one the arena starts
// empty (handy in tests). For real matches use createMatchState. `seed` starts the power-up
// rolls: the server and solo pass a fresh one per match (picked outside the sim), so box
// timings and kinds differ every game; it then travels in snapshots for prediction.
export const DEFAULT_SEED = 0x2f6b1d3;

export function createState(map?: GameMap, rounds: MatchRounds = 1, maps?: readonly unknown[], seed = DEFAULT_SEED): GameState {
  const match = createMatch(rounds, maps);
  const state: GameState = {
    tick: 0,
    tanks: [],
    bullets: [],
    ...mapObjects(map),
    winner: null,
    overMs: 0,
    match,
    mapId: map?.id ?? match.maps[0]!,
    rng: seed | 0,
    nextBulletId: 1,
    events: [],
  };
  hidePowerBoxes(state);
  return state;
}

// A match: `rounds` picks single match (1) or tournament (5 / 7), `maps` the map for each
// round. The first round's map is set up.
export function createMatchState(rounds: MatchRounds, maps?: readonly unknown[], seed = DEFAULT_SEED): GameState {
  const match = createMatch(rounds, maps);
  return createState(getMap(match.maps[0]!), rounds, match.maps, seed);
}

function mapObjects(map?: GameMap): Pick<GameState, "crates" | "powerBoxes" | "flags"> {
  return {
    crates: [
      ...(map?.crates ?? []).map((c): Omit<Crate, "id"> => ({ x: c.x, y: c.y, angle: 0, pushMs: 0 })),
      ...(map?.beds ?? []).map((b): Omit<Crate, "id"> => ({ x: b.x, y: b.y, angle: 0, pushMs: 0, bed: true })),
      ...(map?.desks ?? []).map((d): Omit<Crate, "id"> => ({ x: d.x, y: d.y, angle: 0, pushMs: 0, desk: true })),
    ].map((c, i) => ({ id: i + 1, ...c })),
    powerBoxes: (map?.powerBoxes ?? []).map((p, i) => ({
      id: i + 1,
      x: p.x,
      y: p.y,
      homeX: p.x,
      homeY: p.y,
      angle: 0,
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
    match: { ...s.match, scores: { ...s.match.scores }, maps: [...s.match.maps] },
    mapId: s.mapId,
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
    spinDir: -1, // counter-clockwise on screen, like the original
    spinPauseMs: 0,
    sincePressTicks: NEVER_PRESSED,
    aimAngle: 0,
    held: false,
    pressMs: 0,
    driving: false,
    driveMs: 0,
    cooldownMs: 0,
    ammo: MAX_AMMO,
    reloadMs: 0,
    shieldMs: 0,
    shieldHits: 0,
    spawnShieldMs: 0,
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
const NEVER_PRESSED = 1e9; // finite so the state stays JSON/network safe

function isList(v: TankInput | readonly TankInput[]): v is readonly TankInput[] {
  return Array.isArray(v);
}

// Advances the state by one tick in place. Deterministic: the same state, inputs
// and config always give the same result, so the server and client prediction agree.
export function step(
  state: GameState,
  map: GameMap,
  inputs: TickInputs,
  config: SimConfig,
): void {
  const dt = TICK_MS / 1000;
  state.tick++;
  state.events = [];

  // Round over: everything holds still under the win banner, then a fresh round.
  if (state.winner) {
    state.overMs -= TICK_MS;
    if (state.overMs <= 1e-6) {
      advanceMatch(state);
      // The next round may be on a different map: callers look the map up from mapId.
      resetRound(state, getMap(state.match.maps[state.match.round - 1]!));
    }
    return;
  }

  // Bullets fired by a soldier's earlier sample in a tick where it gets two: the shooter's
  // screen moved them on with the next sample, so they get the extra move too.
  let ahead: Bullet[] | null = null;
  for (const tank of state.tanks) {
    const given = inputs[tank.id];
    if (given === undefined) updateTank(state, map, tank, NO_INPUT, config, dt);
    else if (!isList(given)) updateTank(state, map, tank, given, config, dt);
    else {
      for (let i = 0; i < given.length; i++) {
        const before = state.bullets.length;
        updateTank(state, map, tank, given[i]!, config, dt);
        for (let k = before; k < state.bullets.length; k++) {
          for (let extra = i + 1; extra < given.length; extra++) (ahead ??= []).push(state.bullets[k]!);
        }
      }
    }
  }

  // Pickups first: a tank without a power that drove into a box takes it, and only the
  // boxes still on the map are solid in the push step.
  collectPowerBoxes(state);
  pushBodies(state, map);
  stepBullets(state, map, dt, config);
  if (ahead) {
    const gone = new Set<Bullet>();
    for (const b of ahead) if (!gone.has(b) && state.bullets.includes(b) && !moveBullet(state, map, dt, config, b, 1)) gone.add(b);
    if (gone.size) state.bullets = state.bullets.filter((b) => !gone.has(b));
  }
  tickFlags(state);
}

// One update of one soldier from one input sample: its timers, powers, firing, spin and walk.
function updateTank(state: GameState, map: GameMap, tank: Tank, input: TankInput, config: SimConfig, dt: number): void {
  tank.sincePressTicks = Math.min(NEVER_PRESSED, tank.sincePressTicks + 1);
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
      tank.spawnShieldMs = SPAWN_SHIELD_MS;
    }
    tank.held = false;
    tank.pressMs = 0;
    tank.driving = false;
    tank.driveMs = 0;
    return;
  }

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

  // A press fires straight away and reverses the spin. A press inside the bounce guard
  // (FIRE_COOLDOWN_MS) does nothing at all: flipping on those made a fast spray swing to
  // one side. With an empty magazine a press still reverses the spin (see below).
  const pressStarted = input.pressed || (input.held && !tank.held);
  if (pressStarted) {
    if (canFire(tank)) {
      const burst = tank.sincePressTicks * TICK_MS <= RAPID_FIRE_MS;
      if (burst) tank.angle = clampAround(tank.angle, tank.aimAngle, RAPID_FIRE_WOBBLE);
      applyAim(tank, input.aim);
      if (!burst) tank.aimAngle = tank.angle;
      tank.sincePressTicks = 0;
      fire(state, tank, rewindTicks(state, input.seen));
      tank.spinDir = tank.spinDir === 1 ? -1 : 1;
      tank.spinPauseMs = SPIN_PAUSE_MS;
    } else if (tank.cooldownMs <= 0) {
      // Empty magazine: a dry click, but the gun still reverses, so you can keep turning
      // to aim while you wait for a round (Asad's call). Only bounce-guard taps don't flip.
      applyAim(tank, input.aim);
      state.events.push({ type: "dry", tankId: tank.id, x: tank.x, y: tank.y });
      tank.spinDir = tank.spinDir === 1 ? -1 : 1;
      tank.spinPauseMs = SPIN_PAUSE_MS;
    }
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
    tank.driveMs += TICK_MS;
    const dist = currentWalkSpeed(state, tank) * dt;
    const move = gripBoxFace(state, tank, Math.cos(tank.angle) * dist, Math.sin(tank.angle) * dist);
    shove(tankBody(tank), map, move.x, move.y);
  } else {
    tank.driveMs = 0;
    // While the button is down the heading stays put, so a hold walks exactly where you
    // pressed (DEFAULT_HOLD_MS is longer than the pause after a shot).
    if (tank.held) {
      // holding still
    } else if (tank.spinPauseMs > 0) tank.spinPauseMs -= TICK_MS;
    else tank.angle = wrapAngle(tank.angle + tank.spinDir * SPIN_SPEED * dt);
  }
}

// Online, a press carries the heading the shooter's prediction fired along. Within
// AIM_TOLERANCE of this soldier's heading, take it exactly; anything else (junk, or a
// heading far from what the server has) is ignored.
function applyAim(tank: Tank, aim: unknown): void {
  if (typeof aim !== "number" || !Number.isFinite(aim)) return;
  const TAU = Math.PI * 2;
  // Already 0..2π (always, from a real client): keep it bit for bit.
  const a = aim >= 0 && aim < TAU ? aim : wrapAngle(aim);
  let d = a - tank.angle;
  d -= Math.round(d / TAU) * TAU;
  if (Math.abs(d) <= AIM_TOLERANCE) tank.angle = a;
}

// Walking into the face of a crate, desk, bed or (solid) power box: the soldier grips the face
// like friction, so the part of its step along the face, up to PUSH_GRIP times the part into
// the face, is dropped. Walking a little off-axis into a face then pushes it on instead of
// sliding along it. Steeper headings, or a block that has turned far enough under the soldier,
// keep the rest and slide. Only on a face: a soldier touching a corner (centre past the face's
// edge) isn't gripped, so they slip past the corner instead of sticking to it.
function gripBoxFace(state: GameState, tank: Tank, dx: number, dy: number): { x: number; y: number } {
  const ahead: Body = { pos: { x: tank.x + dx, y: tank.y + dy }, shape: "circle", size: TANK_RADIUS, mass: TANK_MASS };
  const boxes = [...state.crates.map(crateBody), ...(hasPower(tank) ? solidPowerBoxes(state).map(powerBoxBody) : [])];
  for (const b of boxes) {
    const c = contact(ahead, b);
    if (!c) continue;
    const local = toLocal(b, ahead.pos.x, ahead.pos.y);
    if (Math.abs(local.x) > b.size && Math.abs(local.y) > b.size) continue; // at a corner
    if (Math.abs(local.x) <= b.size && Math.abs(local.y) <= b.size) continue; // already inside
    const forward = dx * c.nx + dy * c.ny;
    if (forward <= 0) continue;
    // Full grip in the middle of the face, none at its ends: pushing near a corner lets the
    // soldier slide towards it as the block turns, so they swing it round and slip off.
    const along = Math.abs(local.x) > b.size ? Math.abs(local.y) : Math.abs(local.x);
    const grip = PUSH_GRIP * Math.max(0, 1 - along / b.size);
    const sx = dx - forward * c.nx;
    const sy = dy - forward * c.ny;
    const side = Math.hypot(sx, sy);
    const keep = side > 1e-12 ? Math.max(0, side - grip * forward) / side : 0;
    return { x: forward * c.nx + sx * keep, y: forward * c.ny + sy * keep };
  }
  return { x: dx, y: dy };
}

// Carrying a flag slows you by CARRIER_SPEED, with or without the speed power: a boosted
// carrier walks at SPEED_BOOST x CARRIER_SPEED (1.6 x 0.8 = 1.28 x normal).
function walkSpeed(state: GameState, tank: Tank): number {
  return DRIVE_SPEED * (tank.speedMs > 0 ? SPEED_BOOST : 1) * (isCarrying(state, tank.id) ? CARRIER_SPEED : 1);
}

// Walking starts at DRIVE_START of full speed and speeds up over DRIVE_RAMP_MS.
function currentWalkSpeed(state: GameState, tank: Tank): number {
  const ramp = DRIVE_RAMP_MS > 0 ? Math.min(1, tank.driveMs / DRIVE_RAMP_MS) : 1;
  return walkSpeed(state, tank) * (DRIVE_START + (1 - DRIVE_START) * ramp);
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
    const speed = currentWalkSpeed(state, t);
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
  t.driveMs = 0;
  clearPowers(t);
  t.respawnMs = RESPAWN_MS;
  state.events.push({ type: "kill", tankId: t.id, by: bullet.owner, x: t.x, y: t.y });
  dropFlagOf(state, t);
}

// A fresh round with the same players: everyone back at their spawn, full ammo, no
// powers, flags home, crates and power boxes back where the map puts them.
export function resetRound(state: GameState, map: GameMap): void {
  Object.assign(state, mapObjects(map));
  hidePowerBoxes(state);
  state.mapId = map.id;
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
      driveMs: 0,
      cooldownMs: 0,
      ammo: MAX_AMMO,
      reloadMs: 0,
      spinPauseMs: 0,
      sincePressTicks: NEVER_PRESSED,
      vx: 0,
      vy: 0,
      spawnShieldMs: 0,
    });
    clearPowers(t);
  }
  state.events.push({ type: "round", tankId: "", x: 0, y: 0 });
}

function powerBoxBody(p: PowerBox): Body {
  return heavyBoxBody(p, POWER_BOX_SIZE);
}

function solidPowerBoxes(state: GameState): PowerBox[] {
  return state.powerBoxes.filter((p) => p.respawnMs <= 0);
}

// A round starts with every power box hidden, each appearing after its own random delay.
function hidePowerBoxes(state: GameState): void {
  for (const box of state.powerBoxes) box.respawnMs = randomMs(state, POWER_START_MIN_MS, POWER_START_MAX_MS);
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
        box.angle = 0;
        box.pushMs = 0;
      }
      continue;
    }
    const taker = state.tanks.find((t) => t.alive && !hasPower(t) && contact(tankBody(t), powerBoxBody(box)));
    if (taker) takePowerBox(state, box, taker);
  }
}

function takePowerBox(state: GameState, box: PowerBox, tank: Tank): void {
  givePower(state, tank, POWER_KINDS[nextRandom(state) % POWER_KINDS.length]!);
  box.respawnMs = randomMs(state, POWER_RESPAWN_MIN_MS, POWER_RESPAWN_MAX_MS);
}

export function hasPower(t: Tank): boolean {
  return t.shieldMs > 0 || t.speedMs > 0 || t.flareMs > 0;
}

// A tank holds one power at a time, so this replaces any power it had.
export function givePower(state: GameState, tank: Tank, kind: PowerKind): void {
  clearPowers(tank);
  if (kind === "shield") {
    tank.shieldMs = SHIELD_MS;
    tank.shieldHits = SHIELD_HITS;
  }
  if (kind === "speed") tank.speedMs = SPEED_MS;
  if (kind === "flare") {
    tank.flareMs = FLARE_MS;
    tank.flareTimerMs = 0; // first burst right away
  }
  state.events.push({ type: "power", tankId: tank.id, kind, x: tank.x, y: tank.y });
}

function tickPowers(state: GameState, tank: Tank): void {
  tank.spawnShieldMs = tank.spawnShieldMs - TICK_MS > 1e-6 ? tank.spawnShieldMs - TICK_MS : 0;
  // Epsilon: summed TICK_MS can leave a sliver of a whole-second SHIELD_MS.
  tank.shieldMs = tank.shieldMs - TICK_MS > 1e-6 ? tank.shieldMs - TICK_MS : 0;
  if (tank.shieldMs === 0) tank.shieldHits = 0;
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
  tank.shieldHits = 0;
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

// A whole number of ms in [min, max], rolled from the state's seed.
function randomMs(state: GameState, min: number, max: number): number {
  return min + (nextRandom(state) % (max - min + 1));
}

function tankBody(t: Tank): Body {
  const mass = !t.alive ? BODY_MASS : t.driving ? TANK_MASS : TANK_MASS * IDLE_TANK_BRAKE;
  // Circles ignore pos.angle, so the soldier's heading never turns its body.
  return { pos: t, shape: "circle", size: TANK_RADIUS, mass };
}

function crateBody(c: Crate): Body {
  if (c.bed) return heavyBoxBody(c, BED_SIZE, BED_MASS);
  if (c.desk) return heavyBoxBody(c, DESK_SIZE, DESK_MASS);
  return heavyBoxBody(c, CRATE_SIZE);
}

// Crates, beds, desks and power boxes: heavy, and stuck at first until pushed for CRATE_BREAKAWAY_MS.
function heavyBoxBody(box: Crate | PowerBox, size: number, mass = CRATE_MASS): Body {
  const stuck = 1 - Math.min(1, box.pushMs / CRATE_BREAKAWAY_MS);
  return { pos: box, shape: "box", size: size / 2, mass: mass * (1 + (CRATE_STATIC - 1) * stuck) };
}

// Tanks, crates and power boxes on the map never overlap; pushing is decided by weight
// (see resolveContacts).
function pushBodies(state: GameState, map: GameMap): void {
  const boxes = [...state.crates, ...solidPowerBoxes(state)];
  const bodies = [
    // Fallen soldiers stay solid where they lie: they can be pushed, and they still
    // shield their team from bullets wherever they end up.
    ...state.tanks.map(tankBody),
    ...state.crates.map(crateBody),
    ...solidPowerBoxes(state).map(powerBoxBody),
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

function canFire(tank: Tank): boolean {
  return tank.cooldownMs <= 0 && (UNLIMITED_AMMO || tank.ammo > 0);
}

function fire(state: GameState, tank: Tank, rewind = 0): void {
  if (!canFire(tank)) return;
  tank.cooldownMs = FIRE_COOLDOWN_MS;
  if (!UNLIMITED_AMMO) tank.ammo--;
  spawnBullet(state, tank, tank.angle, rewind);
}

// Does the segment (ax, ay) -> (bx, by) come within r of (cx, cy)?
function segmentHitsCircle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, r: number): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / len2)) : 0;
  const px = ax + dx * t - cx;
  const py = ay + dy * t - cy;
  return px * px + py * py <= r * r;
}

// How far back the shooter saw the others: this tick minus the tick their screen drew
// (`seen`), made safe: whole ticks within 0..MAX_REWIND_TICKS. Junk or a future tick: 0.
function rewindTicks(state: GameState, seen: unknown): number {
  if (typeof seen !== "number" || !Number.isFinite(seen)) return 0;
  return Math.max(0, Math.min(MAX_REWIND_TICKS, state.tick - Math.round(seen)));
}

function spawnBullet(state: GameState, tank: Tank, angle: number, rewind = 0): void {
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
    rewind,
  });
  state.events.push({ type: "fire", tankId: tank.id, x, y });
}

function stepBullets(state: GameState, map: GameMap, dt: number, config: SimConfig): void {
  state.bullets = state.bullets.filter((b) => moveBullet(state, map, dt, config, b, 0));
}

// Moves one bullet one tick and resolves what it hits; false when it is gone. `later` is
// how many ticks ahead of the world this move is (1 for a bullet's catch-up move, see step()).
function moveBullet(state: GameState, map: GameMap, dt: number, config: SimConfig, b: Bullet, later: number): boolean {
  // TANK_HIT_RADIUS, not TANK_RADIUS: hits match the drawn body, a bit bigger than its
  // collision circle.
  const hitR = TANK_HIT_RADIUS + BULLET_RADIUS;
  const fromX = b.x;
  const fromY = b.y;
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  b.rangeLeft -= BULLET_SPEED * dt;
  if (circleHitsWall(map, b.x, b.y, BULLET_RADIUS)) return false;
  const bulletBody: Body = { pos: b, shape: "circle", size: BULLET_RADIUS, mass: 0 };
  // Crates and power boxes stop bullets (shooting a power box does not take it). With
  // CRATE_BREAKS a crate breaks when shot; beds and desks don't.
  const crate = state.crates.find((c) => contact(bulletBody, crateBody(c)));
  if (crate && CRATE_BREAKS && !crate.bed && !crate.desk) {
    state.crates = state.crates.filter((c) => c !== crate);
    state.events.push({ type: "crateBreak", tankId: b.owner, x: crate.x, y: crate.y });
    return false;
  }
  const blocked = crate || solidPowerBoxes(state).some((p) => contact(bulletBody, powerBoxBody(p)));
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
    // Where the shooter saw this enemy (lag compensation), else where it is now.
    const seen = (b.rewind > 0 && config.rewind?.(t.id, state.tick + later - b.rewind)) || t;
    // The whole stretch the bullet flew this tick, not just where it ended: at 10 px a
    // tick it could otherwise skip past the edge of a soldier.
    if (segmentHitsCircle(fromX, fromY, b.x, b.y, seen.x, seen.y, hitR)) {
      if (t.spawnShieldMs > 0) {
        state.events.push({ type: "shieldHit", tankId: t.id, x: b.x, y: b.y });
        return false;
      }
      if (t.shieldMs > 0) {
        // Each bullet uses up one hit; the last one pops the shield.
        t.shieldHits--;
        if (t.shieldHits <= 0) {
          t.shieldMs = 0;
          t.shieldHits = 0;
          state.events.push({ type: "shieldBreak", tankId: t.id, x: b.x, y: b.y });
        } else {
          state.events.push({ type: "shieldHit", tankId: t.id, x: b.x, y: b.y });
        }
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
}

// `a` moved to within `max` of `center` (the short way round), wrapped to 0..2π.
function clampAround(a: number, center: number, max: number): number {
  let d = a - center;
  d -= Math.round(d / (Math.PI * 2)) * Math.PI * 2; // -π..π
  return wrapAngle(center + Math.max(-max, Math.min(max, d)));
}

export function wrapAngle(a: number): number {
  const TAU = Math.PI * 2;
  return ((a % TAU) + TAU) % TAU;
}
