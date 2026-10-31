import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BASE_RADIUS,
  BODY_FRICTION,
  CARRIER_SPEED,
  DRIVE_SPEED,
  FLAG_RETURN_MS,
  TICK_MS,
} from "./constants";
import { DEFAULT_MAP } from "./map";
import { addTank, createState, step, type GameEvent, type GameState, type TankInput } from "./sim";

const map = DEFAULT_MAP;
const config = { holdMs: 60 };
const ticks = (ms: number) => Math.ceil(ms / TICK_MS);
const hold = { held: true, pressed: false };
const tap = { held: false, pressed: true };

function run(state: GameState, n: number, inputs: Record<string, TankInput> = {}): GameEvent[] {
  const events: GameEvent[] = [];
  for (let i = 0; i < n; i++) {
    step(state, map, inputs, config);
    events.push(...state.events);
  }
  return events;
}

const flagOf = (state: GameState, team: "red" | "blue") => state.flags.find((f) => f.team === team)!;

function setup() {
  const state = createState(map);
  const red = addTank(state, map, "red1", "red");
  const blue = addTank(state, map, "blue1", "blue");
  return { state, red, blue, redFlag: flagOf(state, "red"), blueFlag: flagOf(state, "blue") };
}

test("the map has a flag at each base", () => {
  const { redFlag, blueFlag } = setup();
  assert.ok(redFlag.atHome && blueFlag.atHome);
  assert.ok(redFlag.homeX < map.width / 2 && blueFlag.homeX > map.width / 2, "red base left, blue base right");
});

test("an enemy who touches a flag picks it up and carries it", () => {
  const { state, red, blueFlag } = setup();
  red.x = blueFlag.homeX;
  red.y = blueFlag.homeY;
  const events = run(state, 1);
  assert.equal(blueFlag.carrier, red.id);
  assert.ok(events.some((e) => e.type === "flag" && e.action === "taken"));
  red.x += 20; // the flag follows its carrier
  run(state, 1);
  assert.equal(blueFlag.x, red.x);
});

test("your own flag at home is left alone", () => {
  const { state, red, redFlag } = setup();
  red.x = redFlag.homeX;
  red.y = redFlag.homeY;
  run(state, 1);
  assert.equal(redFlag.carrier, null);
  assert.ok(redFlag.atHome);
});

test("a carrier walks slower", () => {
  const walk = (carrying: boolean) => {
    const { state, red, blueFlag } = setup();
    red.x = 540;
    red.y = 300;
    red.angle = 0;
    if (carrying) {
      blueFlag.carrier = red.id;
      blueFlag.atHome = false;
    }
    run(state, 10, { red1: hold });
    const x0 = red.x;
    run(state, 30, { red1: hold });
    return red.x - x0;
  };
  assert.ok(Math.abs(walk(true) / walk(false) - CARRIER_SPEED) < 1e-6);
});

test("carrying the enemy flag into your own base wins, then a new round starts", () => {
  const { state, red, blue, redFlag, blueFlag } = setup();
  blueFlag.carrier = red.id;
  blueFlag.atHome = false;
  red.x = redFlag.homeX + BASE_RADIUS - 1;
  red.y = redFlag.homeY;
  blue.x = 600;
  const events = run(state, 1);
  assert.equal(state.winner, "red");
  assert.ok(events.some((e) => e.type === "capture" && e.team === "red"));

  // Frozen under the banner: inputs do nothing.
  const bx = blue.x;
  run(state, 30, { blue1: hold });
  assert.equal(blue.x, bx);
  assert.equal(state.winner, "red");

  const after = run(state, ticks(state.overMs) + 1);
  assert.equal(state.winner, null);
  assert.ok(after.some((e) => e.type === "round"));
  assert.ok(blueFlag.atHome === false || flagOf(state, "blue").atHome, "flags are reset");
  assert.ok(flagOf(state, "blue").atHome && flagOf(state, "blue").carrier === null);
  assert.deepEqual([red.x, red.y], [map.spawns.red[0]!.x, map.spawns.red[0]!.y], "everyone back at spawn");
});

test("shooting the carrier drops the flag where they fall", () => {
  const { state, red, blue, blueFlag } = setup();
  blueFlag.carrier = red.id;
  blueFlag.atHome = false;
  red.x = 600;
  red.y = 300;
  blue.x = 500;
  blue.y = 300;
  blue.angle = 0;
  step(state, map, { blue1: tap }, config);
  let events: GameEvent[] = [];
  for (let i = 0; i < 30 && red.alive; i++) {
    red.x = 600;
    red.y = 300;
    events = run(state, 1);
  }
  assert.equal(red.alive, false);
  assert.equal(blueFlag.carrier, null);
  assert.ok(Math.abs(blueFlag.x - 600) < 5);
  assert.ok(events.some((e) => e.type === "flag" && e.action === "dropped"));
});

test("a dropped flag: the enemy can grab it again, its own team sends it home", () => {
  const { state, red, blue, blueFlag } = setup();
  Object.assign(blueFlag, { carrier: null, atHome: false, x: 600, y: 300, returnMs: FLAG_RETURN_MS });
  red.x = 600;
  red.y = 300;
  run(state, 1);
  assert.equal(blueFlag.carrier, red.id, "enemy picks the dropped flag back up");

  Object.assign(blueFlag, { carrier: null, atHome: false, x: 600, y: 300, returnMs: FLAG_RETURN_MS });
  red.x = 200;
  blue.x = 600;
  blue.y = 300;
  const events = run(state, 1);
  assert.ok(blueFlag.atHome && blueFlag.x === blueFlag.homeX, "own team returns it");
  assert.ok(events.some((e) => e.type === "flag" && e.action === "returned"));
});

test("a dropped flag left alone goes home after FLAG_RETURN_MS", () => {
  const { state, red, blue, blueFlag } = setup();
  Object.assign(blueFlag, { carrier: null, atHome: false, x: 600, y: 300, returnMs: FLAG_RETURN_MS });
  red.x = 200;
  blue.x = 300;
  run(state, ticks(FLAG_RETURN_MS) - 2);
  assert.equal(blueFlag.atHome, false);
  run(state, 3);
  assert.equal(blueFlag.atHome, true);
});

test("a carrier who leaves the game drops the flag", () => {
  const { state, red, blueFlag } = setup();
  blueFlag.carrier = red.id;
  blueFlag.atHome = false;
  state.tanks = state.tanks.filter((t) => t.id !== red.id);
  run(state, 1);
  assert.equal(blueFlag.carrier, null);
});

// Falling with inertia
function shootAt(walking: boolean) {
  const state = createState();
  const shooter = addTank(state, map, "shooter", "blue");
  const victim = addTank(state, map, "victim", "red");
  shooter.x = 300;
  shooter.y = 300;
  shooter.angle = 0;
  victim.x = 420;
  victim.y = 300;
  victim.angle = -Math.PI / 2; // walking up, across the bullet's path
  const victimInput: Record<string, TankInput> = walking ? { victim: hold } : {};
  run(state, 10, victimInput); // get walking
  victim.x = 420;
  victim.y = 300;
  shooter.x = 300;
  shooter.y = 300;
  shooter.angle = 0; // it turned during the warm-up
  step(state, map, { shooter: tap, ...victimInput }, config);
  for (let i = 0; i < 30 && victim.alive; i++) {
    victim.x = 420; // keep it in the line of fire (still walking) until hit
    victim.y = 300;
    step(state, map, victimInput, config);
  }
  assert.equal(victim.alive, false);
  const at = { x: victim.x, y: victim.y, fallAngle: victim.fallAngle };
  run(state, 60);
  return { at, end: { x: victim.x, y: victim.y } };
}

test("shot while walking: the body keeps sliding forward and falls face-first", () => {
  const { at, end } = shootAt(true);
  const slid = at.y - end.y; // was walking up (towards smaller y)
  const expected = (DRIVE_SPEED * DRIVE_SPEED) / (2 * BODY_FRICTION);
  assert.ok(Math.abs(slid - expected) < 6, `slid ${slid.toFixed(1)}, expected ~${expected.toFixed(1)}`);
  assert.ok(Math.abs(at.fallAngle - -Math.PI / 2) < 1e-9, "falls in the walking direction");
});

test("shot while standing: knocked back a little along the bullet's path", () => {
  const { at, end } = shootAt(false);
  assert.ok(end.x - at.x > 2 && end.x - at.x < 12, `knocked back ${(end.x - at.x).toFixed(1)} px`);
  assert.ok(Math.abs(at.fallAngle) < 1e-9, "falls away from the shooter");
});

test("a sliding body stops at a wall", () => {
  const state = createState();
  const t = addTank(state, map, "t", "red");
  t.x = 60;
  t.y = 300;
  t.alive = false;
  t.respawnMs = 60_000;
  t.vx = -DRIVE_SPEED * 3; // towards the left wall at x = 40
  run(state, 30);
  assert.ok(t.x >= 40 + 14 - 1e-6, "body went into the wall");
  assert.equal(t.vx, 0);
});
