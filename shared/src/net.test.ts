import assert from "node:assert/strict";
import { test } from "node:test";
import { getMap } from "./maps";
import {
  SNAPSHOT_EVERY_TICKS,
  SnapshotDecoder,
  applyStateDelta,
  cloneDeep,
  diffState,
  type SnapshotMessage,
  type SnapshotState,
} from "./net";
import { winRound } from "./match";
import { addTank, createMatchState, removeTank, step, type GameState, type TankInput } from "./sim";

// Same as the server's: the state without this tick's events, deep-copied.
function snapshotOf(state: GameState): SnapshotState {
  const { events: _events, ...rest } = state;
  return cloneDeep(rest);
}

// Stand-in for the network (msgpack keeps undefined, order and numbers like this does).
const wire = <T>(v: T): T => structuredClone(v);

// A small seeded generator so the "random" play is the same every run.
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// Plays a match with random buttons and players joining and leaving, sending every
// snapshot as a delta (a keyframe every `keyEvery`), and checks the client rebuilds each
// state exactly.
function playAndDecode(mapIds: string[], seed: number, ticks: number, keyEvery = 60) {
  const rand = lcg(seed);
  const state = createMatchState(5, mapIds);
  const ids: string[] = [];
  for (let i = 0; i < 6; i++) {
    ids.push(`p${i}`);
    addTank(state, getMap(state.mapId), `p${i}`, i % 2 ? "blue" : "red");
  }
  const held = new Map<string, boolean>();
  const decoder = new SnapshotDecoder();
  let base: SnapshotState | null = null;
  let sent = 0;
  let deltaBytes = 0;
  let fullBytes = 0;
  const seen = { added: 0, removed: 0, maps: new Set<string>(), rounds: new Set<number>() };
  for (let t = 0; t < ticks; t++) {
    // Someone leaves now and then, and someone new joins.
    if (rand() < 0.004 && state.tanks.length > 2) {
      removeTank(state, state.tanks[Math.floor(rand() * state.tanks.length)]!.id);
      seen.removed++;
    }
    if (rand() < 0.004 && state.tanks.length < 8) {
      const id = `n${t}`;
      addTank(state, getMap(state.mapId), id, rand() < 0.5 ? "red" : "blue");
      seen.added++;
    }
    // A capture every 25 s, so rounds (and maps) change too.
    if (t % 1500 === 1499 && state.winner === null) winRound(state, rand() < 0.5 ? "red" : "blue");
    const inputs: Record<string, TankInput> = {};
    for (const tank of state.tanks) {
      const was = held.get(tank.id) ?? false;
      const now = rand() < (was ? 0.95 : 0.03);
      inputs[tank.id] = { held: now, pressed: (now && !was) || rand() < 0.02 };
      held.set(tank.id, now);
    }
    step(state, getMap(state.mapId), inputs, { holdMs: 60 });
    seen.maps.add(state.mapId);
    seen.rounds.add(state.match.round);
    if (state.tick % SNAPSHOT_EVERY_TICKS !== 0) continue;

    const next = snapshotOf(state);
    const key = base === null || sent % keyEvery === 0;
    const msg: SnapshotMessage = key
      ? { full: next, events: [], acks: {} }
      : { base: base!.tick, delta: diffState(base!, next), events: [], acks: {} };
    const size = JSON.stringify(msg).length;
    if (key) fullBytes += size;
    else deltaBytes += size;
    const decoded = decoder.decode(wire(msg));
    assert.ok(decoded, `tick ${state.tick}: delta didn't apply`);
    assert.deepEqual(decoded.state, next, `tick ${state.tick}: decoded state differs`);
    base = next;
    sent++;
  }
  return { sent, deltaBytes, fullBytes, seen, decoder };
}

test("snapshot deltas rebuild the exact server state through a whole match", () => {
  const { sent, decoder, seen } = playAndDecode(["arena", "crossfire", "fortress", "canyon", "classroom"], 7, 6000);
  assert.ok(sent > 2900, `only ${sent} snapshots`);
  assert.ok(decoder.deltas > sent * 0.9, "most snapshots should be deltas");
  assert.equal(decoder.failures, 0);
  assert.ok(seen.added > 0 && seen.removed > 0, "players should have joined and left");
  assert.ok(seen.rounds.size >= 3 && seen.maps.size >= 3, "rounds and maps should have changed");
});

test("snapshot deltas hold up over different maps and seeds", () => {
  for (const [i, maps] of [["garden"], ["office"], ["field"], ["crossroads"]].entries()) {
    const { decoder } = playAndDecode(maps, 100 + i, 2400, 30);
    assert.equal(decoder.failures, 0);
  }
});

test("deltas are much smaller than full snapshots", () => {
  const { sent, deltaBytes, fullBytes, decoder } = playAndDecode(["arena"], 3, 3000);
  const avgDelta = deltaBytes / decoder.deltas;
  const avgFull = fullBytes / (sent - decoder.deltas);
  assert.ok(avgDelta < avgFull / 2, `delta ${avgDelta.toFixed(0)} B vs full ${avgFull.toFixed(0)} B`);
});

test("the codec handles nested objects, added and removed items, reordering and new keys", () => {
  type Any = Record<string, unknown>;
  const a = {
    tick: 1,
    list: [
      { id: 1, x: 1, nested: { deep: [1, 2] } },
      { id: 2, x: 2 },
      { id: 3, x: 3, opt: undefined },
    ],
    flags: [
      { team: "red", x: 0, carrier: null },
      { team: "blue", x: 9, carrier: null },
    ],
    match: { round: 1, scores: { red: 0, blue: 0 }, maps: ["a", "b"] },
    plain: [3, 2, 1],
    winner: null,
  } as unknown as SnapshotState;
  const b = {
    tick: 2,
    list: [
      { id: 3, x: 3, opt: true }, // new key: sent whole
      { id: 1, x: 1.5, nested: { deep: [1, 2, 3] } },
      { id: 7, x: -0.25 }, // added; id 2 removed; order changed
    ],
    flags: [
      { team: "red", x: 0, carrier: "p1" },
      { team: "blue", x: 9, carrier: null },
    ],
    match: { round: 2, scores: { red: 1, blue: 0 }, maps: ["a", "c"] },
    plain: [3, 2, 1],
    winner: "red",
  } as unknown as SnapshotState;
  const before = cloneDeep(a);
  const delta = diffState(a, b);
  assert.deepEqual(applyStateDelta(wire(a), wire(delta)), b);
  assert.deepEqual(a, before, "diffing must not change the base");
  assert.deepEqual(diffState(b, cloneDeep(b)), [], "no change, empty delta");
  // Removing everything and adding into an empty list.
  const c = { ...(b as unknown as Any), list: [] } as unknown as SnapshotState;
  assert.deepEqual(applyStateDelta(b, diffState(b, c)), c);
  assert.deepEqual(applyStateDelta(c, diffState(c, b)), b);
});

test("a delta that doesn't fit the client's state is refused until a keyframe arrives", () => {
  const state = createMatchState(1, ["arena"]);
  addTank(state, getMap("arena"), "a", "red");
  const s0 = snapshotOf(state);
  step(state, getMap("arena"), { a: { held: true, pressed: true } }, { holdMs: 60 });
  const s1 = snapshotOf(state);
  step(state, getMap("arena"), { a: { held: true, pressed: false } }, { holdMs: 60 });
  const s2 = snapshotOf(state);

  const decoder = new SnapshotDecoder();
  assert.equal(decoder.decode({ base: s0.tick, delta: diffState(s0, s1), events: [], acks: {} }), null, "no base yet");
  assert.ok(decoder.decode({ full: wire(s0), events: [], acks: {} }));
  // Skipping a snapshot: the delta is for another base.
  assert.equal(decoder.decode({ base: s1.tick, delta: diffState(s1, s2), events: [], acks: {} }), null);
  assert.equal(decoder.decode({ base: s0.tick, delta: diffState(s0, s1), events: [], acks: {} }), null, "still waiting for a keyframe");
  assert.ok(decoder.decode({ full: wire(s1), events: [], acks: {} }));
  const snap = decoder.decode({ base: s1.tick, delta: diffState(s1, s2), events: [], acks: { a: 2 } });
  assert.deepEqual(snap?.state, s2);
  assert.deepEqual(snap?.acks, { a: 2 });
  assert.equal(decoder.failures, 3);
});
