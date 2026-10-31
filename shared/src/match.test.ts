import assert from "node:assert/strict";
import { test } from "node:test";
import { MATCH_RESTART_MS, ROUND_POINTS, ROUND_RESTART_MS, TICK_MS } from "./constants";
import { DEFAULT_MAP } from "./map";
import type { MatchRounds } from "./match";
import { getMap } from "./maps";
import { addTank, createMatchState, createState, step, type GameEvent, type GameState } from "./sim";

const map = DEFAULT_MAP;
const config = { holdMs: 60 };
const ticks = (ms: number) => Math.ceil(ms / TICK_MS);

function run(state: GameState, n: number): GameEvent[] {
  const events: GameEvent[] = [];
  for (let i = 0; i < n; i++) {
    step(state, getMap(state.mapId), {}, config); // the map can change between rounds
    events.push(...state.events);
  }
  return events;
}

function setup(rounds: MatchRounds) {
  const state = createState(map, rounds);
  addTank(state, map, "red1", "red");
  addTank(state, map, "blue1", "blue");
  return state;
}

// Teleport `team`'s soldier with the enemy flag into their own base: a capture next tick.
function capture(state: GameState, team: "red" | "blue") {
  const carrier = state.tanks.find((t) => t.team === team)!;
  const enemyFlag = state.flags.find((f) => f.team !== team)!;
  const base = state.flags.find((f) => f.team === team)!;
  enemyFlag.carrier = carrier.id;
  enemyFlag.atHome = false;
  carrier.x = base.baseX;
  carrier.y = base.baseY;
  run(state, 1);
  assert.equal(state.winner, team);
}

test("single match: one capture wins the match, then a fresh match", () => {
  const state = setup(1);
  capture(state, "blue");
  assert.equal(state.match.champion, "blue");
  assert.equal(state.overMs, MATCH_RESTART_MS);
  run(state, ticks(MATCH_RESTART_MS) + 1);
  assert.equal(state.winner, null);
  const { rounds, round, scores, champion } = state.match;
  assert.deepEqual({ rounds, round, scores, champion }, { rounds: 1, round: 1, scores: { red: 0, blue: 0 }, champion: null });
});

test("tournament: each round won is worth 2 points and all rounds are played", () => {
  const state = setup(5);
  const winners = ["red", "red", "red", "blue", "blue"] as const; // red decided after 3, but all 5 play
  winners.forEach((team, i) => {
    assert.equal(state.match.round, i + 1);
    capture(state, team);
    if (i < winners.length - 1) {
      assert.equal(state.match.champion, null, "no champion before the last round");
      assert.equal(state.overMs, ROUND_RESTART_MS);
      run(state, ticks(ROUND_RESTART_MS) + 1);
      assert.equal(state.winner, null, "next round starts");
      assert.ok(state.flags.every((f) => f.atHome), "flags reset between rounds");
    }
  });
  assert.deepEqual(state.match.scores, { red: 3 * ROUND_POINTS, blue: 2 * ROUND_POINTS });
  assert.equal(state.match.champion, "red");
  assert.equal(state.overMs, MATCH_RESTART_MS);
  run(state, ticks(MATCH_RESTART_MS) + 1);
  const { rounds, round, scores, champion } = state.match;
  assert.deepEqual({ rounds, round, scores, champion }, { rounds: 5, round: 1, scores: { red: 0, blue: 0 }, champion: null }, "a new tournament");
});

test("7 rounds: the team behind early can still be champion on points", () => {
  const state = setup(7);
  const teams = ["blue", "blue", "red", "red", "red", "blue", "red"] as const;
  teams.forEach((team, i) => {
    capture(state, team);
    if (i < teams.length - 1) run(state, ticks(ROUND_RESTART_MS) + 1);
  });
  assert.deepEqual(state.match.scores, { red: 8, blue: 6 });
  assert.equal(state.match.champion, "red");
});

test("a tournament plays each round on the map picked for it, and keeps the picks for the next tournament", () => {
  const picks = ["canyon", "fortress", "arena", "crossfire", "canyon"];
  const state = createMatchState(5, picks);
  addTank(state, getMap(state.mapId), "red1", "red");
  addTank(state, getMap(state.mapId), "blue1", "blue");
  const seen: string[] = [];
  for (let i = 0; i < 5; i++) {
    seen.push(state.mapId);
    const m = getMap(state.mapId);
    // Flags and spawns come from the round's map.
    assert.equal(state.flags.find((f) => f.team === "red")!.homeX, m.flags.red!.x);
    assert.deepEqual([state.tanks[0]!.x, state.tanks[0]!.y], [m.spawns.red[0]!.x, m.spawns.red[0]!.y]);
    capture(state, i % 2 ? "blue" : "red");
    run(state, ticks(state.overMs) + 1);
  }
  assert.deepEqual(seen, picks);
  assert.equal(state.mapId, "canyon", "the next tournament starts again on round 1's map");
  assert.deepEqual(state.match.maps, picks);
});

test("missing or unknown map picks are filled in, never breaking the room", () => {
  const state = createMatchState(5, ["fortress", "no-such-map"]);
  assert.equal(state.match.maps.length, 5);
  assert.equal(state.match.maps[0], "fortress");
  assert.ok(state.match.maps.every((id) => getMap(id).id === id), "every round has a real map");
});
