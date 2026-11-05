import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BED_MASS,
  BED_SIZE,
  BODY_MASS,
  BULLET_RANGE,
  BULLET_SPEED,
  CRATE_MASS,
  CRATE_BREAKS,
  CRATE_SIZE,
  DRIVE_RAMP_MS,
  DRIVE_SPEED,
  DRIVE_START,
  FLARE_INTERVAL_MS,
  FLARE_MS,
  IDLE_TANK_BRAKE,
  MAX_AMMO,
  DESK_MASS,
  DESK_SIZE,
  POWER_BOX_SIZE,
  POWER_RESPAWN_MAX_MS,
  POWER_RESPAWN_MIN_MS,
  POWER_START_MAX_MS,
  POWER_START_MIN_MS,
  PUSH_GRIP,
  RAPID_FIRE_MS,
  RELOAD_MS,
  RESPAWN_MS,
  SHIELD_HITS,
  SHIELD_MS,
  SPEED_BOOST,
  SPIN_PAUSE_MS,
  TANK_RADIUS,
  TICK_MS,
  UNLIMITED_AMMO,
} from "./constants";
import { boxHitsWall, DEFAULT_MAP, parseMap } from "./map";
import { getMap } from "./maps";
import { contact } from "./physics";
import { addTank, createMatchState, createState, givePower, resetRound, step, type TankInput } from "./sim";

const config = { holdMs: 60 };
const map = DEFAULT_MAP;

function run(inputs: TankInput[], id = "p1") {
  const state = createState();
  const tank = addTank(state, map, id, "red");
  const fired: number[] = [];
  inputs.forEach((input, i) => {
    step(state, map, { [id]: input }, config);
    if (state.events.some((e) => e.type === "fire")) fired.push(i);
  });
  return { state, tank, fired };
}

const down = { held: true, pressed: false };
const up = { held: false, pressed: false };
const ticks = (ms: number) => Math.ceil(ms / TICK_MS);

test("map has spawns for both teams", () => {
  assert.ok(map.spawns.red.length >= 4);
  assert.ok(map.spawns.blue.length >= 4);
});

test("a tap fires on press and does not move", () => {
  const { tank, fired } = run([down, up]);
  assert.deepEqual(fired, [0]);
  assert.equal(tank.driving, false);
  assert.equal(tank.x, map.spawns.red[0]!.x);
});

test("press and release inside one tick still fires", () => {
  const { fired } = run([{ held: false, pressed: true }]);
  assert.deepEqual(fired, [0]);
});

test("taps in quick succession all fire", () => {
  const gap = Array(ticks(150)).fill(up);
  const { fired } = run([down, ...gap, down, ...gap, down]);
  assert.equal(fired.length, 3);
});

test("a hold fires once, then drives after holdMs; release does not fire", () => {
  const holdTicks = ticks(config.holdMs) + 20;
  const { tank, fired } = run([...Array(holdTicks).fill(down), up]);
  assert.deepEqual(fired, [0]);
  const spawn = map.spawns.red[0]!;
  assert.ok(tank.x !== spawn.x || tank.y !== spawn.y, "tank should have moved");
});

test("not driving before holdMs", () => {
  const { tank } = run(Array(ticks(config.holdMs) - 1).fill(down));
  assert.equal(tank.driving, false);
});

test("each press reverses the spin direction", () => {
  const state = createState();
  const tank = addTank(state, map, "p1", "red");
  tank.angle = Math.PI; // away from the 0 / 2π wrap
  step(state, map, {}, config);
  const a0 = tank.angle;
  step(state, map, {}, config);
  assert.ok(tank.angle < a0, "spins counter-clockwise (negative) at start, like the original");
  step(state, map, { p1: { held: false, pressed: true } }, config);
  assert.equal(tank.spinDir, 1);
  const a1 = tank.angle;
  for (let i = 0; i < ticks(SPIN_PAUSE_MS) + 1; i++) step(state, map, {}, config);
  assert.ok(tank.angle > a1, "spins the other way after a tap");
  step(state, map, { p1: { held: false, pressed: true } }, config);
  assert.equal(tank.spinDir, -1);
});

test("heading holds still for SPIN_PAUSE_MS after a press", () => {
  const state = createState();
  const tank = addTank(state, map, "p1", "red");
  step(state, map, {}, config);
  step(state, map, { p1: { held: false, pressed: true } }, config);
  const a = tank.angle;
  for (let i = 0; i < ticks(SPIN_PAUSE_MS) - 1; i++) step(state, map, {}, config);
  assert.equal(tank.angle, a);
});

// The original: ~10 taps a second, each shot 5-12 degrees off the last as the gun wobbles
// back and forth, but the burst stays aimed one way instead of sweeping round.
test("rapid tapping fans shots out a little around one line", () => {
  const state = createState();
  const tank = addTank(state, map, "p1", "red");
  tank.angle = Math.PI; // away from the 0 / 2π wrap
  const angles: number[] = [];
  for (let tap = 0; tap < 12; tap++) {
    tank.ammo = MAX_AMMO; // this test is about the spread, not the magazine
    step(state, map, { p1: { held: false, pressed: true } }, config);
    const b = state.bullets.at(-1);
    if (b && b.id === state.nextBulletId - 1) angles.push(Math.atan2(b.vy, b.vx) + (b.vy < 0 ? Math.PI * 2 : 0));
    for (let i = 0; i < ticks(100); i++) step(state, map, {}, config);
  }
  assert.equal(angles.length, 12);
  const deg = (r: number) => (r * 180) / Math.PI;
  for (let i = 1; i < angles.length; i++) {
    const turn = deg(Math.abs(angles[i]! - angles[i - 1]!));
    assert.ok(turn > 3 && turn < 15, `shot ${i} turned ${turn.toFixed(1)} degrees from the last`);
  }
  const spread = deg(Math.max(...angles) - Math.min(...angles));
  assert.ok(spread < 20, `burst should stay aimed one way, spread ${spread.toFixed(1)} degrees`);
});

test("a tap after a pause aims at the current heading, not the old line", () => {
  const state = createState();
  const tank = addTank(state, map, "p1", "red");
  step(state, map, { p1: { held: false, pressed: true } }, config);
  const first = tank.aimAngle;
  for (let i = 0; i < ticks(RAPID_FIRE_MS) + 30; i++) step(state, map, {}, config);
  const heading = tank.angle;
  step(state, map, { p1: { held: false, pressed: true } }, config);
  const b = state.bullets.at(-1)!;
  assert.notEqual(heading, first);
  assert.ok(Math.abs(Math.atan2(b.vy, b.vx) - Math.atan2(Math.sin(heading), Math.cos(heading))) < 1e-9);
});

test("bullet drops after its range", () => {
  const state = createState();
  const tank = addTank(state, map, "p1", "red");
  tank.angle = 0; // open lane to the right of the red spawn
  step(state, map, { p1: { held: false, pressed: true } }, config);
  assert.equal(state.bullets.length, 1);
  const startX = state.bullets[0]!.x;
  let dropX: number | undefined;
  for (let i = 0; i < ticks((BULLET_RANGE / BULLET_SPEED) * 1000) + 2 && dropX === undefined; i++) {
    step(state, map, {}, config);
    const drop = state.events.find((e) => e.type === "drop");
    if (drop) dropX = drop.x;
  }
  assert.ok(dropX !== undefined, "bullet should drop");
  assert.equal(state.bullets.length, 0);
  assert.ok(Math.abs(dropX - startX - BULLET_RANGE) < BULLET_SPEED / 60 + 1);
});

test("bullet kills an enemy and the enemy respawns", () => {
  const state = createState();
  const shooter = addTank(state, map, "a", "red");
  const target = addTank(state, map, "b", "blue");
  shooter.angle = 0;
  target.x = shooter.x + 100;
  target.y = shooter.y;
  // Tap on the first tick, before spinning has turned the barrel much.
  step(state, map, { a: { held: false, pressed: true } }, config);
  let killed = false;
  for (let i = 0; i < 60 && !killed; i++) {
    target.x = shooter.x + 100; // keep target still while it would spin in place
    step(state, map, {}, config);
    killed = state.events.some((e) => e.type === "kill" && e.tankId === "b");
  }
  assert.ok(killed);
  assert.equal(target.alive, false);
  // Still down just before RESPAWN_MS, back right after.
  for (let i = 0; i < ticks(RESPAWN_MS) - 2; i++) step(state, map, {}, config);
  assert.equal(target.alive, false);
  for (let i = 0; i < 3; i++) step(state, map, {}, config);
  assert.equal(target.alive, true);
});

const tap = { held: false, pressed: true };

test("a full magazine fires MAX_AMMO quick shots, then runs dry", { skip: UNLIMITED_AMMO && "UNLIMITED_AMMO is on" }, () => {
  const state = createState();
  const tank = addTank(state, map, "p1", "red");
  let fired = 0;
  let dryTaps = 0;
  // Tap every 7 ticks (~117 ms, just over the fire cooldown) for 10 taps (~1.05 s).
  for (let i = 0; i < 10; i++) {
    const ammoBefore = tank.ammo;
    step(state, map, { p1: tap }, config);
    if (state.events.some((e) => e.type === "fire")) fired++;
    else if (ammoBefore === 0) dryTaps++;
    for (let k = 0; k < 6; k++) step(state, map, {}, config);
  }
  // The magazine plus whatever reloaded between the first and last tap; the rest are dry taps.
  assert.equal(fired, MAX_AMMO + Math.floor((9 * 7 * TICK_MS) / RELOAD_MS));
  assert.equal(dryTaps, 10 - fired);
});

test("an empty tank cannot fire and gets one round back every RELOAD_MS", { skip: UNLIMITED_AMMO && "UNLIMITED_AMMO is on" }, () => {
  const state = createState();
  const tank = addTank(state, map, "p1", "red");
  tank.ammo = 0;
  tank.reloadMs = 0;
  step(state, map, { p1: tap }, config);
  assert.equal(state.events.filter((e) => e.type === "fire").length, 0);
  for (let i = 0; i < ticks(RELOAD_MS) - 1; i++) step(state, map, {}, config);
  assert.equal(tank.ammo, 1);
  for (let i = 0; i < ticks(RELOAD_MS * MAX_AMMO); i++) step(state, map, {}, config);
  assert.equal(tank.ammo, MAX_AMMO);
});

test("with UNLIMITED_AMMO every quick tap fires and ammo never runs down", { skip: !UNLIMITED_AMMO && "UNLIMITED_AMMO is off" }, () => {
  const state = createState();
  const tank = addTank(state, map, "p1", "red");
  let fired = 0;
  // 20 taps 7 ticks apart (~117 ms, just over the fire cooldown): over 3 magazines' worth.
  for (let i = 0; i < 20; i++) {
    step(state, map, { p1: tap }, config);
    if (state.events.some((e) => e.type === "fire")) fired++;
    for (let k = 0; k < 6; k++) step(state, map, {}, config);
  }
  assert.equal(fired, 20);
  assert.equal(tank.ammo, MAX_AMMO);
});

test("walking starts at DRIVE_START of full speed and reaches full speed after DRIVE_RAMP_MS", () => {
  const state = createState();
  const tank = addTank(state, map, "t", "red");
  tank.x = 200;
  tank.y = 300;
  tank.angle = 0;
  const stepX = () => {
    const x = tank.x;
    step(state, map, { t: down }, config);
    return (tank.x - x) / (TICK_MS / 1000);
  };
  let speed = 0;
  while (speed === 0) speed = stepX(); // waits out the hold time
  assert.ok(Math.abs(speed - DRIVE_SPEED * DRIVE_START) < DRIVE_SPEED * 0.05, `starts at ${speed.toFixed(0)} px/s`);
  for (let i = 0; i < ticks(DRIVE_RAMP_MS); i++) stepX();
  assert.ok(Math.abs(stepX() - DRIVE_SPEED) < 1e-6, "full speed after the ramp");
  step(state, map, { t: up }, config);
  while (stepX() === 0); // a new press starts slow again
  assert.ok(Math.abs(stepX() - DRIVE_SPEED * DRIVE_START) < DRIVE_SPEED * 0.1);
});

// Two tanks in the open middle lane, touching.
function duel(aAngle: number, bAngle: number) {
  const state = createState();
  // Same team so the shot fired when a hold starts can't kill the other tank.
  const a = addTank(state, map, "a", "red");
  const b = addTank(state, map, "b", "red");
  a.x = 500;
  a.y = 300;
  b.x = 500 + TANK_RADIUS * 2;
  b.y = 300;
  a.angle = aAngle;
  b.angle = bAngle;
  return { state, a, b };
}
const hold = { held: true, pressed: false };
const gapOf = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

test("a driving tank pushes an idle tank instead of overlapping it", () => {
  const { state, a, b } = duel(0, Math.PI);
  const bx = b.x;
  for (let i = 0; i < 40; i++) {
    step(state, map, { a: hold }, config);
    assert.ok(gapOf(a, b) >= TANK_RADIUS * 2 - 1e-6, "tanks overlap");
  }
  assert.ok(b.x > bx + 20, `b should be shoved right, moved ${(b.x - bx).toFixed(1)}`);
});

test("two tanks driving head-on stall", () => {
  const { state, a, b } = duel(0, Math.PI);
  const mid = (a.x + b.x) / 2;
  for (let i = 0; i < 40; i++) step(state, map, { a: hold, b: hold }, config);
  assert.ok(Math.abs((a.x + b.x) / 2 - mid) < 0.5);
  assert.ok(gapOf(a, b) >= TANK_RADIUS * 2 - 1e-6);
});

test("the tank that stops pushing gets driven back", () => {
  const { state, a, b } = duel(0, Math.PI);
  for (let i = 0; i < 20; i++) step(state, map, { a: hold, b: hold }, config);
  const bx = b.x;
  for (let i = 0; i < 30; i++) step(state, map, { a: hold }, config);
  assert.ok(b.x > bx + 20, "b should be pushed back once it lets go");
});

test("a tank shoved into a wall pushes back on the shover", () => {
  const { state, a, b } = duel(0, Math.PI);
  // Wall column 9 starts at x=360 on row 3; put b against it from the left side.
  b.x = 360 - TANK_RADIUS - 0.5;
  b.y = 3.5 * 40;
  a.x = b.x - TANK_RADIUS * 2;
  a.y = b.y;
  for (let i = 0; i < 30; i++) step(state, map, { a: hold }, config);
  assert.ok(gapOf(a, b) >= TANK_RADIUS * 2 - 1e-6, "tanks overlap");
  assert.ok(b.x <= 360 - TANK_RADIUS + 1e-6, "b went into the wall");
});

test("many tanks spawning on top of each other never stay overlapped", () => {
  const state = createState();
  for (let i = 0; i < 8; i++) addTank(state, map, `t${i}`, "red"); // 4 spawns, so pairs stack
  for (let tick = 0; tick < 300; tick++) {
    const inputs: Record<string, TankInput> = {};
    state.tanks.forEach((t, i) => (inputs[t.id] = { held: (tick + i * 13) % 50 < 30, pressed: false }));
    step(state, map, inputs, config);
  }
  for (let i = 0; i < state.tanks.length; i++)
    for (let j = i + 1; j < state.tanks.length; j++)
      assert.ok(gapOf(state.tanks[i]!, state.tanks[j]!) >= TANK_RADIUS * 2 - 0.5, `t${i} and t${j} overlap`);
});

test("a pushed idle tank moves at a third of drive speed (its brakes resist)", () => {
  const { state, a, b } = duel(0, Math.PI);
  for (let i = 0; i < 10; i++) step(state, map, { a: hold }, config); // get driving and in contact
  const bx = b.x;
  for (let i = 0; i < 60; i++) step(state, map, { a: hold }, config);
  const expected = DRIVE_SPEED / (1 + IDLE_TANK_BRAKE); // px over 1 s
  assert.ok(Math.abs(b.x - bx - expected) < 3, `moved ${(b.x - bx).toFixed(1)}, expected ~${expected.toFixed(1)}`);
});

// A tank in the open middle lane with a crate right in front of it.
function crateAhead() {
  const state = createState();
  const tank = addTank(state, map, "t", "red");
  tank.x = 500;
  tank.y = 300;
  tank.angle = 0;
  const crate = { id: 1, x: tank.x + TANK_RADIUS + CRATE_SIZE / 2, y: 300, pushMs: 0 };
  state.crates.push(crate);
  tank.cooldownMs = 1e9; // walk in without firing: a shot would break the crate
  return { state, tank, crate };
}

test("a crate is slow to get going, then slides at a steady heavy pace", () => {
  const { state, tank, crate } = crateAhead();
  for (let i = 0; i < 5; i++) step(state, map, { t: hold }, config);
  const x0 = crate.x;
  for (let i = 0; i < 15; i++) step(state, map, { t: hold }, config);
  const early = crate.x - x0; // first quarter second
  for (let i = 0; i < 60; i++) step(state, map, { t: hold }, config);
  const x1 = crate.x;
  for (let i = 0; i < 15; i++) step(state, map, { t: hold }, config);
  const late = crate.x - x1; // a quarter second, once loosened up
  assert.ok(early > 0, "crate should budge");
  assert.ok(late > early * 1.4, `should speed up: early ${early.toFixed(1)} vs late ${late.toFixed(1)}`);
  const steady = (DRIVE_SPEED / (1 + CRATE_MASS)) * 0.25;
  assert.ok(Math.abs(late - steady) < 1, `late ${late.toFixed(2)} vs steady ${steady.toFixed(2)}`);
  assert.ok(late < (DRIVE_SPEED * 0.25) / 3, "crate must be much slower than a free tank");
  const overlap = contact(
    { pos: tank, shape: "circle", size: TANK_RADIUS, mass: 1 },
    { pos: crate, shape: "box", size: CRATE_SIZE / 2, mass: 1 },
  );
  assert.ok((overlap?.depth ?? 0) < 1e-6, "tank overlaps the crate");
});

// An empty walled room, so a big bed has space to slide.
const OPEN_ROOM = parseMap([
  "#".repeat(28),
  `#11${".".repeat(22)}22#`,
  `#11${".".repeat(22)}22#`,
  ...Array.from({ length: 14 }, () => `#${".".repeat(26)}#`),
  "#".repeat(28),
]);

// Pushes a box of the given kind for 1.5 s from rest; returns how far it moved in the last
// quarter second (once loosened up).
function pushFor(bed: boolean): number {
  const state = createState();
  const tank = addTank(state, OPEN_ROOM, "t", "red");
  tank.x = 200;
  tank.y = 360;
  tank.angle = 0;
  const size = bed ? BED_SIZE : CRATE_SIZE;
  const box = { id: 1, x: tank.x + TANK_RADIUS + size / 2, y: 360, pushMs: 0, bed };
  state.crates.push(box);
  tank.cooldownMs = 1e9; // walk in without firing: a shot would break a crate
  for (let i = 0; i < 75; i++) step(state, OPEN_ROOM, { t: hold }, config);
  const x0 = box.x;
  for (let i = 0; i < 15; i++) step(state, OPEN_ROOM, { t: hold }, config);
  return box.x - x0;
}

test("a bed is harder to push than a crate: it slides at the speed its weight allows", () => {
  const crate = pushFor(false);
  const bed = pushFor(true);
  const steady = (DRIVE_SPEED / (1 + BED_MASS)) * 0.25;
  assert.ok(Math.abs(bed - steady) < 1, `bed moved ${bed.toFixed(2)}, expected ~${steady.toFixed(2)}`);
  assert.ok(bed < crate * 0.7, `bed ${bed.toFixed(1)} should be slower than crate ${crate.toFixed(1)}`);
});

test("Classroom starts with its beds as big movable blocks that stop bullets", () => {
  const classroom = getMap("classroom");
  const state = createState(classroom);
  const beds = state.crates.filter((c) => c.bed);
  assert.equal(beds.length, classroom.beds.length);
  assert.ok(beds.length >= 20);
  // A bullet fired straight at a bed drops on it.
  const bed = beds[0]!;
  const tank = addTank(state, classroom, "t", "red");
  tank.x = bed.x - BED_SIZE / 2 - TANK_RADIUS - 30;
  tank.y = bed.y;
  tank.angle = 0;
  step(state, classroom, { t: { held: true, pressed: true } }, config);
  for (let i = 0; i < 30; i++) step(state, classroom, {}, config);
  assert.equal(state.bullets.length, 0);
  assert.ok(Math.abs(bed.x - classroom.beds[0]!.x) < 1e-6, "shooting a bed doesn't move it");
});

test("a crate settles again after it is left alone", () => {
  const { state, crate } = crateAhead();
  for (let i = 0; i < 80; i++) step(state, map, { t: hold }, config);
  assert.ok(crate.pushMs > 0);
  for (let i = 0; i < 60; i++) step(state, map, {}, config);
  assert.equal(crate.pushMs, 0);
});

test("a crate stops at a wall and the tank cannot push through it", () => {
  const { state, tank, crate } = crateAhead();
  // Drive along row 7 towards the right outer wall (x = 25 * 40 = 1000).
  for (let i = 0; i < 60 * 40; i++) step(state, map, { t: hold }, config);
  assert.ok(crate.x + CRATE_SIZE / 2 <= 1000 + 1e-6, "crate went into the wall");
  assert.ok(crate.x + CRATE_SIZE / 2 > 1000 - 1, "crate should reach the wall");
  assert.ok(tank.x + TANK_RADIUS <= crate.x - CRATE_SIZE / 2 + 1e-6, "tank overlaps the crate");
});

test("crates block bullets", () => {
  const { state, tank, crate } = crateAhead();
  tank.cooldownMs = 0;
  const target = addTank(state, map, "enemy", "blue");
  target.x = crate.x + 80;
  target.y = crate.y;
  step(state, map, { t: tap }, config);
  for (let i = 0; i < 40; i++) {
    target.x = crate.x + 80;
    step(state, map, {}, config);
  }
  assert.equal(target.alive, true);
  assert.equal(state.bullets.length, 0);
});

test("with CRATE_BREAKS off, a shot crate stays put and stops the bullet", { skip: CRATE_BREAKS && "CRATE_BREAKS is on" }, () => {
  const state = createState(map);
  const crate = state.crates.find((c) => !c.bed && !c.desk)!;
  const tank = addTank(state, map, "t", "red");
  tank.x = crate.x - CRATE_SIZE / 2 - TANK_RADIUS - 30;
  tank.y = crate.y;
  tank.angle = 0;
  const count = state.crates.length;
  const at = { x: crate.x, y: crate.y };
  step(state, map, { t: tap }, config);
  for (let i = 0; i < 20; i++) {
    step(state, map, {}, config);
    assert.ok(!state.events.some((e) => e.type === "crateBreak"), "no crate may break");
  }
  assert.equal(state.crates.length, count);
  assert.deepEqual({ x: crate.x, y: crate.y }, at, "a shot doesn't move the crate");
  assert.equal(state.bullets.length, 0, "the bullet stops at the crate");
});

test("a crate breaks when shot, a bed doesn't, and crates are back next round", { skip: !CRATE_BREAKS && "CRATE_BREAKS is off" }, () => {
  const state = createState(map);
  const crate = state.crates.find((c) => !c.bed)!;
  const tank = addTank(state, map, "t", "red");
  tank.x = crate.x - CRATE_SIZE / 2 - TANK_RADIUS - 30;
  tank.y = crate.y;
  tank.angle = 0;
  const count = state.crates.length;
  step(state, map, { t: tap }, config);
  let broke = false;
  for (let i = 0; i < 20 && !broke; i++) {
    step(state, map, {}, config);
    broke = state.events.some((e) => e.type === "crateBreak" && e.tankId === "t");
  }
  assert.ok(broke, "the shot should break the crate");
  assert.equal(state.crates.length, count - 1);
  assert.equal(state.bullets.length, 0, "the bullet stops at the crate");
  resetRound(state, map);
  assert.equal(state.crates.length, count);
});

test("the default map spawns its crates clear of walls", () => {
  const state = createState(map);
  assert.ok(state.crates.length > 0);
  for (const c of state.crates) assert.equal(boxHitsWall(map, c.x, c.y, CRATE_SIZE / 2), false);
});

// A tank in the open middle lane with a power box right next to it (not touching).
function powerBoxNearby() {
  const state = createState();
  const tank = addTank(state, map, "t", "red");
  tank.x = 500;
  tank.y = 300;
  tank.angle = 0;
  const x = tank.x + TANK_RADIUS + POWER_BOX_SIZE / 2 + 20;
  const box = { id: 1, x, y: 300, homeX: x, homeY: 300, respawnMs: 0, pushMs: 0 };
  state.powerBoxes.push(box);
  return { state, tank, box };
}

test("driving into a power box gives a power and the box comes back later", () => {
  const { state, tank, box } = powerBoxNearby();
  let got: string | undefined;
  for (let i = 0; i < 30 && !got; i++) {
    step(state, map, { t: hold }, config);
    got = state.events.find((e) => e.type === "power")?.tankId;
  }
  assert.equal(got, "t");
  assert.ok(tank.shieldMs > 0 || tank.speedMs > 0 || tank.flareMs > 0);
  assert.equal(box.respawnMs > 0, true);
  for (let i = 0; i < ticks(POWER_RESPAWN_MAX_MS) + 1; i++) step(state, map, {}, config);
  assert.equal(box.respawnMs, 0);
});

test("shooting a power box does not take it; it stops the bullet like a crate", () => {
  const { state, tank, box } = powerBoxNearby();
  step(state, map, { t: tap }, config);
  for (let i = 0; i < 20; i++) {
    step(state, map, {}, config);
    assert.equal(state.events.some((e) => e.type === "power"), false);
    assert.equal(state.bullets.some((b) => b.x > box.x), false, "bullet went through the box");
  }
  assert.equal(box.respawnMs, 0);
  assert.equal(tank.shieldMs + tank.speedMs + tank.flareMs, 0);
});

test("with a power active, a power box is solid: the tank pushes it instead of passing through", () => {
  const { state, tank, box } = powerBoxNearby();
  givePower(state, tank, "speed");
  const homeX = box.x;
  for (let i = 0; i < 120; i++) {
    step(state, map, { t: hold }, config);
    const overlap = contact(
      { pos: tank, shape: "circle", size: TANK_RADIUS, mass: 1 },
      { pos: box, shape: "box", size: POWER_BOX_SIZE / 2, mass: 1 },
    );
    assert.ok((overlap?.depth ?? 0) < 1e-6, "tank overlaps the power box");
  }
  assert.equal(box.respawnMs, 0, "box must not be taken while a power is active");
  assert.ok(box.x > homeX + 20, "box should be shoved along");
  assert.ok(tank.x < box.x, "tank stays behind the box");
});

test("a tank holds one power at a time; once it runs out, driving into the box takes it", () => {
  const { state, tank, box } = powerBoxNearby();
  givePower(state, tank, "speed");
  for (let i = 0; i < 30; i++) step(state, map, { t: hold }, config);
  assert.equal(box.respawnMs, 0);
  assert.ok(tank.speedMs > 0 && tank.shieldMs === 0 && tank.flareMs === 0);
  tank.speedMs = 0;
  for (let i = 0; i < 5 && box.respawnMs === 0; i++) step(state, map, { t: hold }, config);
  assert.ok(box.respawnMs > 0, "box is taken once the power ran out");
});

test("a pushed power box comes back at its home spot", () => {
  const { state, tank, box } = powerBoxNearby();
  givePower(state, tank, "shield");
  for (let i = 0; i < 90; i++) step(state, map, { t: hold }, config);
  assert.ok(box.x > box.homeX + 10);
  tank.shieldMs = 0;
  for (let i = 0; i < 5 && box.respawnMs === 0; i++) step(state, map, { t: hold }, config);
  assert.ok(box.respawnMs > 0);
  tank.x = 200; // out of the way
  for (let i = 0; i < ticks(POWER_RESPAWN_MAX_MS) + 1; i++) step(state, map, {}, config);
  assert.equal(box.respawnMs, 0);
  assert.equal(box.x, box.homeX);
  assert.equal(box.y, box.homeY);
});

test("givePower replaces the current power", () => {
  const state = createState();
  const tank = addTank(state, map, "t", "red");
  givePower(state, tank, "shield");
  givePower(state, tank, "flare");
  assert.equal(tank.shieldMs, 0);
  assert.ok(tank.flareMs > 0);
});

test("random power rolls cover every kind", () => {
  const { state, tank, box } = powerBoxNearby();
  const kinds = new Set<string>();
  for (let i = 0; i < 30; i++) {
    box.respawnMs = 0;
    tank.shieldMs = tank.speedMs = tank.flareMs = 0;
    box.x = tank.x; // overlapping: taken on the next tick
    step(state, map, {}, config);
    for (const e of state.events) if (e.type === "power") kinds.add(e.kind);
  }
  assert.deepEqual([...kinds].sort(), ["flare", "shield", "speed"]);
});

test("a shield blocks a bullet and runs out after SHIELD_MS", () => {
  const state = createState();
  const shooter = addTank(state, map, "a", "red");
  const target = addTank(state, map, "b", "blue");
  givePower(state, target, "shield");
  const shootAt = () => {
    shooter.x = 500;
    shooter.y = 300;
    shooter.angle = 0;
    shooter.ammo = MAX_AMMO;
    target.x = 600;
    target.y = 300;
    step(state, map, { a: tap }, config);
    for (let i = 0; i < 20; i++) {
      target.x = 600;
      target.y = 300;
      step(state, map, {}, config);
    }
  };
  shootAt();
  assert.equal(target.alive, true, "shield should block the shot");
  for (let i = 0; i < ticks(SHIELD_MS); i++) step(state, map, {}, config);
  assert.equal(target.shieldMs, 0);
  shootAt();
  assert.equal(target.alive, false, "no shield, so the shot kills");
});

test("speed boost drives SPEED_BOOST times as far", () => {
  const drive = (boost: boolean) => {
    const state = createState();
    const tank = addTank(state, map, "t", "red");
    tank.x = 200;
    tank.y = 300;
    tank.angle = 0;
    if (boost) givePower(state, tank, "speed");
    for (let i = 0; i < 10; i++) step(state, map, { t: hold }, config);
    const x0 = tank.x;
    for (let i = 0; i < 30; i++) step(state, map, { t: hold }, config);
    return tank.x - x0;
  };
  const ratio = drive(true) / drive(false);
  assert.ok(Math.abs(ratio - SPEED_BOOST) < 1e-6, `ratio ${ratio}`);
});

test("flare fires 4 normal-speed bullets every FLARE_INTERVAL_MS, without using ammo", () => {
  const state = createState();
  const tank = addTank(state, map, "t", "red");
  tank.x = 540; // centre of the map, away from walls
  tank.y = 380;
  givePower(state, tank, "flare");
  const bursts: number[] = [];
  for (let i = 0; i < ticks(FLARE_MS) + 120; i++) {
    const before = state.nextBulletId;
    step(state, map, {}, config);
    const made = state.nextBulletId - before;
    if (made > 0) {
      assert.equal(made, 4);
      for (const b of state.bullets.slice(-4)) assert.ok(Math.abs(Math.hypot(b.vx, b.vy) - BULLET_SPEED) < 1e-6);
      bursts.push(state.tick);
    }
  }
  assert.equal(bursts.length, FLARE_MS / FLARE_INTERVAL_MS);
  for (let i = 1; i < bursts.length; i++) assert.equal(bursts[i]! - bursts[i - 1]!, ticks(FLARE_INTERVAL_MS));
  assert.equal(tank.ammo, MAX_AMMO);
});

test("dying clears every power", () => {
  const state = createState();
  const shooter = addTank(state, map, "a", "red");
  const target = addTank(state, map, "b", "blue");
  givePower(state, target, "speed");
  shooter.x = 500;
  shooter.y = 300;
  shooter.angle = 0;
  target.x = 600;
  target.y = 300;
  step(state, map, { a: tap }, config);
  for (let i = 0; i < 20 && target.alive; i++) {
    target.x = 600;
    target.y = 300;
    step(state, map, {}, config);
  }
  assert.equal(target.alive, false);
  assert.equal(target.speedMs, 0);
});

test("the default map has power boxes clear of walls", () => {
  const state = createState(map);
  assert.ok(state.powerBoxes.length > 0);
  for (const p of state.powerBoxes) assert.equal(boxHitsWall(map, p.x, p.y, POWER_BOX_SIZE / 2), false);
});

// Red shooter at x=300 facing right, a fallen soldier at x=400, a live target at x=500.
function shootPastBody(bodyTeam: "red" | "blue") {
  const state = createState();
  const shooter = addTank(state, map, "shooter", "red");
  const body = addTank(state, map, "body", bodyTeam);
  const target = addTank(state, map, "target", "blue");
  shooter.x = 300;
  shooter.y = 300;
  shooter.angle = 0;
  body.x = 400;
  body.y = 300;
  body.alive = false;
  body.respawnMs = 5000;
  step(state, map, { shooter: tap }, config);
  for (let i = 0; i < 40; i++) {
    target.x = 500;
    target.y = 300;
    step(state, map, {}, config);
  }
  return target;
}

test("an enemy's fallen body stops my bullets", () => {
  assert.equal(shootPastBody("blue").alive, true, "the blue body should shield the blue target");
});

test("bullets pass through a fallen teammate's body", () => {
  assert.equal(shootPastBody("red").alive, false, "the red body must not block red bullets");
});

test("a fallen body stops blocking once that soldier respawns", () => {
  const state = createState();
  const shooter = addTank(state, map, "shooter", "red");
  const body = addTank(state, map, "body", "blue");
  const target = addTank(state, map, "target", "blue");
  body.alive = false;
  body.respawnMs = TICK_MS; // respawns (back at its spawn) on the next step
  step(state, map, {}, config);
  assert.equal(body.alive, true);
  shooter.x = 300;
  shooter.y = 300;
  shooter.angle = 0;
  step(state, map, { shooter: tap }, config);
  for (let i = 0; i < 40; i++) {
    target.x = 500;
    target.y = 300;
    step(state, map, {}, config);
  }
  assert.equal(target.alive, false);
});

test("a fallen body is solid: walking into it pushes it at body weight", () => {
  const { state, a, b } = duel(0, Math.PI);
  b.alive = false;
  b.respawnMs = 60_000; // stays down for the whole test
  for (let i = 0; i < 10; i++) step(state, map, { a: hold }, config);
  const bx = b.x;
  for (let i = 0; i < 60; i++) {
    step(state, map, { a: hold }, config);
    assert.ok(gapOf(a, b) >= TANK_RADIUS * 2 - 1e-6, "walked into the body");
  }
  const expected = DRIVE_SPEED / (1 + BODY_MASS); // px over 1 s
  assert.ok(Math.abs(b.x - bx - expected) < 3, `moved ${(b.x - bx).toFixed(1)}, expected ~${expected.toFixed(1)}`);
});

test("a pushed body still shields its team where it ends up", () => {
  const state = createState();
  const pusher = addTank(state, map, "pusher", "red");
  const body = addTank(state, map, "body", "blue");
  pusher.x = 300;
  pusher.y = 300;
  pusher.angle = 0;
  body.x = 300 + TANK_RADIUS * 2;
  body.y = 300;
  body.alive = false;
  body.respawnMs = 60_000;
  for (let i = 0; i < 60; i++) step(state, map, { pusher: hold }, config);
  assert.ok(body.x > 360, "body should have been pushed along");
  // Now a red shot from behind the pusher's line hits the body, not a blue soldier behind it.
  const target = addTank(state, map, "target", "blue");
  const shooter = addTank(state, map, "shooter", "red");
  shooter.x = body.x - 80;
  shooter.y = 300 + 0.5;
  shooter.angle = 0;
  pusher.x = 200; // out of the line of fire
  step(state, map, { shooter: tap }, config);
  for (let i = 0; i < 40; i++) {
    target.x = body.x + 80;
    target.y = 300;
    step(state, map, {}, config);
  }
  assert.equal(target.alive, true);
});

// Pushing: a soldier in the open room, facing `angle`, with a crate (or desk / bed) just
// ahead along x, `off` px off its centre line.
function pushSetup(angle: number, off: number, kind: "crate" | "desk" | "bed" = "crate") {
  const state = createState();
  const tank = addTank(state, OPEN_ROOM, "t", "red");
  tank.x = 200;
  tank.y = 360;
  tank.angle = angle;
  tank.cooldownMs = 1e9; // walk in without firing: a shot would break a crate
  const size = kind === "bed" ? BED_SIZE : kind === "desk" ? DESK_SIZE : CRATE_SIZE;
  const box = { id: 1, x: tank.x + TANK_RADIUS + size / 2 + 2, y: 360 + off, pushMs: 0, bed: kind === "bed", desk: kind === "desk" };
  state.crates.push(box);
  return { state, tank, box, size };
}

test("pushing a crate off-centre, near its corner, moves it straight forward", () => {
  // Centre line 20 px off: the soldier's edge only overlaps the crate's face by 10 px.
  const { state, tank, box } = pushSetup(0, CRATE_SIZE / 2 + 4);
  const x0 = box.x;
  const y0 = box.y;
  const ty = tank.y;
  for (let i = 0; i < 120; i++) step(state, OPEN_ROOM, { t: hold }, config);
  assert.ok(box.x - x0 > 50, `crate should move forward, moved ${(box.x - x0).toFixed(1)}`);
  assert.ok(Math.abs(box.y - y0) < 1e-6, `crate drifted sideways ${(box.y - y0).toFixed(2)}`);
  assert.ok(Math.abs(tank.y - ty) < 1e-6, "soldier must not slide round the corner");
  assert.ok(tank.x < box.x, "soldier stays behind the crate");
});

test("a soldier who only clips the corner still glances off and walks past", () => {
  // Further off than above: the soldier's edge overlaps the crate by just 2 px.
  const { state, tank, box } = pushSetup(0, CRATE_SIZE / 2 + TANK_RADIUS - 2);
  for (let i = 0; i < 120; i++) step(state, OPEN_ROOM, { t: hold }, config);
  assert.ok(tank.x > box.x + 10, "a glancing soldier walks past the corner");
});

test("a slightly diagonal heading pushes along the main axis and the soldier grips the face", () => {
  const angle = 0.4; // ~23 degrees: under the PUSH_GRIP limit
  assert.ok(Math.tan(angle) < PUSH_GRIP);
  const { state, tank, box } = pushSetup(angle, 0);
  for (let i = 0; i < 20; i++) step(state, OPEN_ROOM, { t: hold }, config); // reach it
  const x0 = box.x;
  const y0 = box.y;
  const ty = tank.y;
  for (let i = 0; i < 90; i++) step(state, OPEN_ROOM, { t: hold }, config);
  assert.ok(box.x - x0 > 40, `crate should move along x, moved ${(box.x - x0).toFixed(1)}`);
  assert.ok(Math.abs(box.y - y0) < 1e-6, "crate moves along x only");
  assert.ok(Math.abs(tank.y - ty) < 1e-6, "soldier grips the face instead of sliding along it");
});

test("a steep heading pushes along x but slides along the face", () => {
  const angle = 0.7; // ~40 degrees: over the PUSH_GRIP limit, still mostly along x
  assert.ok(Math.tan(angle) > PUSH_GRIP);
  const { state, tank, box } = pushSetup(angle, 0);
  for (let i = 0; i < 20; i++) step(state, OPEN_ROOM, { t: hold }, config); // reach it
  const y0 = box.y;
  const ty = tank.y;
  for (let i = 0; i < 20; i++) step(state, OPEN_ROOM, { t: hold }, config);
  assert.ok(tank.y - ty > 5, "soldier slides along the face");
  assert.ok(Math.abs(box.y - y0) < 1e-6, "the crate is still pushed along x only");
});

test("a soldier beside a crate's corner, walking away from it, slips past instead of sticking", () => {
  // Crate flush against the right wall; the soldier touches it 5 px past its top edge and
  // heads up and to the right, away from it.
  const { state, tank, box } = pushSetup(-0.35, 0);
  box.x = 1064;
  box.y = 360;
  tank.x = box.x - CRATE_SIZE / 2 - TANK_RADIUS;
  tank.y = box.y - CRATE_SIZE / 2 - 5;
  const x0 = box.x;
  const y0 = tank.y;
  for (let i = 0; i < 60; i++) step(state, OPEN_ROOM, { t: hold }, config);
  assert.ok(y0 - tank.y > 20, `soldier should slip up past the corner, moved ${(y0 - tank.y).toFixed(1)}`);
  assert.equal(box.x, x0, "the wall-pinned crate stays put");
});

test("beside an unpinned crate's corner, walking away does not drag the crate by its corner", () => {
  const { state, tank, box } = pushSetup(-0.35, 0);
  tank.y = box.y - CRATE_SIZE / 2 - 5;
  tank.x = box.x - CRATE_SIZE / 2 - TANK_RADIUS;
  const x0 = box.x;
  for (let i = 0; i < 120; i++) step(state, OPEN_ROOM, { t: hold }, config);
  assert.ok(box.x - x0 < 10, `crate dragged ${(box.x - x0).toFixed(1)} px by its corner`);
});

test("walking mostly along y pushes a crate along y", () => {
  const { state, tank, box } = pushSetup(Math.PI / 2 - 0.2, 0);
  box.x = tank.x + 10; // below the soldier, a bit to the right of its path
  box.y = tank.y + TANK_RADIUS + CRATE_SIZE / 2 + 2;
  const x0 = box.x;
  const y0 = box.y;
  for (let i = 0; i < 90; i++) step(state, OPEN_ROOM, { t: hold }, config);
  assert.ok(box.y - y0 > 30, `crate should move down, moved ${(box.y - y0).toFixed(1)}`);
  assert.ok(Math.abs(box.x - x0) < 1e-6, "crate moves along y only");
});

test("a desk is a heavy, sticky, one-tile block: slides at its weight's speed", () => {
  const { state, box } = pushSetup(0, 0, "desk");
  for (let i = 0; i < 75; i++) step(state, OPEN_ROOM, { t: hold }, config);
  const x0 = box.x;
  for (let i = 0; i < 15; i++) step(state, OPEN_ROOM, { t: hold }, config);
  const steady = (DRIVE_SPEED / (1 + DESK_MASS)) * 0.25;
  assert.ok(Math.abs(box.x - x0 - steady) < 1, `desk moved ${(box.x - x0).toFixed(2)}, expected ~${steady.toFixed(2)}`);
});

test("a desk stops bullets and never breaks", () => {
  const { state, tank, box } = pushSetup(0, 0, "desk");
  tank.cooldownMs = 0;
  const target = addTank(state, OPEN_ROOM, "enemy", "blue");
  for (let shot = 0; shot < 3; shot++) {
    tank.cooldownMs = 0;
    step(state, OPEN_ROOM, { t: tap }, config);
    for (let i = 0; i < 30; i++) {
      target.x = box.x + 80;
      target.y = box.y;
      step(state, OPEN_ROOM, {}, config);
      assert.equal(state.events.some((e) => e.type === "crateBreak"), false);
    }
  }
  assert.equal(state.crates.length, 1);
  assert.equal(target.alive, true);
  assert.equal(state.bullets.length, 0);
});

test("power boxes start each round hidden and appear after a random start delay", () => {
  const state = createState(map);
  assert.ok(state.powerBoxes.length > 0);
  for (const p of state.powerBoxes) {
    assert.ok(p.respawnMs >= POWER_START_MIN_MS && p.respawnMs <= POWER_START_MAX_MS, `start delay ${p.respawnMs}`);
  }
  assert.ok(new Set(state.powerBoxes.map((p) => p.respawnMs)).size > 1, "each box rolls its own delay");
  for (let i = 0; i < ticks(POWER_START_MAX_MS) + 1; i++) step(state, map, {}, config);
  for (const p of state.powerBoxes) assert.equal(p.respawnMs, 0);
  resetRound(state, map);
  for (const p of state.powerBoxes) assert.ok(p.respawnMs >= POWER_START_MIN_MS, "hidden again next round");
});

test("a taken power box comes back after a random delay inside the respawn range", () => {
  const { state, tank, box } = powerBoxNearby();
  const delays: number[] = [];
  for (let i = 0; i < 20; i++) {
    box.respawnMs = 0;
    box.x = tank.x; // overlapping: taken on the next tick
    tank.shieldMs = tank.speedMs = tank.flareMs = 0;
    step(state, map, {}, config);
    delays.push(box.respawnMs);
  }
  for (const ms of delays) assert.ok(ms >= POWER_RESPAWN_MIN_MS && ms <= POWER_RESPAWN_MAX_MS, `respawn delay ${ms}`);
  assert.ok(new Set(delays).size > 5, "delays vary");
});

test("power-up rolls are deterministic: the same seed rolls the same delays and kinds", () => {
  const rolls = () => {
    const state = createState(map);
    const tank = addTank(state, map, "t", "red");
    const out: (string | number)[] = state.powerBoxes.map((p) => p.respawnMs);
    const box = state.powerBoxes[0]!;
    for (let i = 0; i < 10; i++) {
      box.respawnMs = 0;
      box.x = tank.x;
      box.y = tank.y;
      tank.shieldMs = tank.speedMs = tank.flareMs = 0;
      step(state, map, {}, config);
      for (const e of state.events) if (e.type === "power") out.push(e.kind);
      out.push(box.respawnMs);
    }
    return out;
  };
  assert.deepEqual(rolls(), rolls());
});

test("each match's seed rolls its own power-box timings, and the seed travels in the state", () => {
  const delays = (seed: number) => createMatchState(1, ["garden"], seed).powerBoxes.map((p) => p.respawnMs);
  assert.deepEqual(delays(12345), delays(12345), "same seed, same rolls");
  const seen = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((s) => delays(s * 7919).join(",")));
  assert.ok(seen.size > 6, "different seeds roll different start delays");
  assert.notEqual(createMatchState(1, undefined, 42).rng, createMatchState(1, undefined, 43).rng);
});

// Red shooter at x=500 facing right, a shielded blue target at x=600.
function shieldDuel() {
  const state = createState();
  const shooter = addTank(state, map, "a", "red");
  const target = addTank(state, map, "b", "blue");
  givePower(state, target, "shield");
  const shoot = () => {
    shooter.x = 500;
    shooter.y = 300;
    shooter.angle = 0;
    shooter.cooldownMs = 0;
    const events: string[] = [];
    step(state, map, { a: tap }, config);
    for (let i = 0; i < 20; i++) {
      target.x = 600;
      target.y = 300;
      step(state, map, {}, config);
      for (const e of state.events) events.push(e.type);
    }
    return events;
  };
  return { state, target, shoot };
}

test("a shield stops SHIELD_HITS bullets; the last one pops it with shieldBreak", () => {
  const { target, shoot } = shieldDuel();
  assert.equal(target.shieldHits, SHIELD_HITS);
  for (let hit = 1; hit < SHIELD_HITS; hit++) {
    const events = shoot();
    assert.ok(events.includes("shieldHit") && !events.includes("shieldBreak"));
    assert.equal(target.shieldHits, SHIELD_HITS - hit);
    assert.ok(target.shieldMs > 0);
  }
  const last = shoot();
  assert.ok(last.includes("shieldBreak") && !last.includes("shieldHit"));
  assert.equal(target.alive, true, "the popping bullet is stopped too");
  assert.equal(target.shieldMs, 0);
  assert.equal(target.shieldHits, 0);
  shoot();
  assert.equal(target.alive, false, "no shield left, so the next shot kills");
});

test("a shield lasts SHIELD_MS at most, even with hits left", () => {
  const { state, target, shoot } = shieldDuel();
  for (let i = 0; i < ticks(SHIELD_MS); i++) step(state, map, {}, config);
  assert.equal(target.shieldMs, 0);
  assert.equal(target.shieldHits, 0);
  shoot();
  assert.equal(target.alive, false);
});
