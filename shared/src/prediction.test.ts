import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_MAP } from "./map";
import { SNAPSHOT_EVERY_TICKS } from "./net";
import { CALM_TICKS, InputQueue, MAX_INPUT_QUEUE, MAX_SAMPLES_PER_TICK, MAX_TARGET_INPUT_QUEUE, Predictor, TARGET_INPUT_QUEUE, type InputFrame } from "./prediction";
import { addTank, cloneState, createState, step, type GameState, type TankInput } from "./sim";

const map = DEFAULT_MAP;
const config = { holdMs: 60 };

test("input queue applies one sample per tick and acks it; with none it applies none", () => {
  const q = new InputQueue();
  q.push([
    { seq: 1, held: true, pressed: true },
    { seq: 2, held: true, pressed: false },
  ]);
  assert.deepEqual(q.next(), [{ held: true, pressed: true }]);
  assert.equal(q.ack, 1);
  assert.deepEqual(q.next(), [{ held: true, pressed: false }]);
  assert.equal(q.ack, 2);
  // Nothing queued: nothing is made up (the soldier waits), ack unchanged.
  assert.deepEqual(q.next(), []);
  assert.equal(q.ack, 2);
});

test("input queue skips malformed frames instead of throwing", () => {
  const q = new InputQueue();
  const bad = [null, 1, "x", undefined, { seq: 1, held: true, pressed: true }] as unknown as InputFrame[];
  assert.doesNotThrow(() => q.push(bad));
  assert.equal(q.length, 1);
  assert.deepEqual(q.next(), [{ held: true, pressed: true }]);
});

test("input queue keeps a press's aim and seen tick, only finite numbers, only on presses", () => {
  const q = new InputQueue();
  q.push([
    { seq: 1, held: false, pressed: true, aim: 1.25, seen: 40 },
    { seq: 2, held: false, pressed: true, aim: Number.NaN, seen: Infinity },
    { seq: 3, held: false, pressed: false, aim: 2, seen: 41 },
    { seq: 4, held: false, pressed: true, aim: "x", seen: null } as unknown as InputFrame,
  ]);
  const applied = [...q.next(), ...q.next(), ...q.next()];
  assert.deepEqual(applied, [
    { held: false, pressed: true, aim: 1.25, seen: 40 },
    { held: false, pressed: true },
    { held: false, pressed: false },
    { held: false, pressed: true },
  ]);
});

test("a backlog drains two samples a tick, in order, never skipping one", () => {
  const q = new InputQueue();
  const n = 20;
  const frames: InputFrame[] = [];
  for (let s = 1; s <= n; s++) frames.push({ seq: s, held: s % 3 === 0, pressed: s === 2 || s === 5 });
  q.push(frames);
  const applied: number[] = [];
  let fired = 0;
  let next = n + 1;
  for (let tick = 0; tick < 40; tick++) {
    const before = q.ack;
    const got = q.next();
    assert.ok(got.length >= 1 && got.length <= MAX_SAMPLES_PER_TICK, `tick ${tick}: ${got.length} samples`);
    for (let i = 0; i < got.length; i++) applied.push(before + 1 + i);
    fired += got.filter((x) => x.pressed).length;
    // A steady client adds one sample per tick.
    q.push([{ seq: next++, held: false, pressed: false }]);
  }
  assert.deepEqual(applied, Array.from({ length: applied.length }, (_, i) => i + 1), "every sample once, in order");
  assert.equal(fired, 2);
  assert.ok(q.length <= TARGET_INPUT_QUEUE + 1, `drained to ${q.length}`);
  assert.equal(q.dropped, 0);
});

test("input queue ignores duplicates and old samples", () => {
  const q = new InputQueue();
  q.push([{ seq: 5, held: true, pressed: true }]);
  q.push([
    { seq: 5, held: false, pressed: false },
    { seq: 3, held: false, pressed: false },
  ]);
  assert.deepEqual(q.next(), [{ held: true, pressed: true }]);
  assert.deepEqual(q.next(), [], "only seq 5 was queued");
});

test("only past the hard cap are samples dropped, and a tap still survives", () => {
  const q = new InputQueue();
  const frames: InputFrame[] = [{ seq: 1, held: false, pressed: true }];
  for (let s = 2; s <= MAX_INPUT_QUEUE; s++) frames.push({ seq: s, held: false, pressed: false });
  q.push(frames);
  assert.equal(q.dropped, 0, "a backlog up to the cap is kept whole");
  q.push([2, 3, 4].map((k) => ({ seq: MAX_INPUT_QUEUE + k - 1, held: false, pressed: false })));
  assert.equal(q.dropped, 3);
  assert.equal(q.length, MAX_INPUT_QUEUE);
  assert.equal(q.next()[0]!.pressed, true, "the tap must still fire");
});

test("dropping at the hard cap never merges two taps into one", () => {
  const q = new InputQueue();
  // A 10 taps/s spray (a 2-tick tap every 6 ticks), more of it than the cap holds.
  const frames: InputFrame[] = [];
  for (let s = 1; s <= MAX_INPUT_QUEUE + 6; s++) {
    const k = (s - 1) % 6;
    frames.push({ seq: s, held: k < 2, pressed: k === 0 });
  }
  q.push(frames);
  let taps = 0;
  for (let tick = 0; tick < 60; tick++) for (const x of q.next()) if (x.pressed) taps++;
  assert.equal(taps, 6, "all six taps fire");
  assert.equal(q.lostPresses, 0);
  assert.equal(q.dropped, 6);
});

test("the input buffer deepens when a player's packets run late and shrinks again when calm", () => {
  const q = new InputQueue();
  let seq = 0;
  const sample = () => ({ seq: ++seq, held: false, pressed: false });
  // Packets arrive in bursts of 4 every 4 ticks (a jittery phone): the buffer runs dry.
  for (let tick = 0; tick < 60; tick++) {
    if (tick % 4 === 0) q.push([sample(), sample(), sample(), sample()]);
    q.next();
  }
  assert.ok(q.target > TARGET_INPUT_QUEUE, `deepened to ${q.target}`);
  assert.ok(q.target <= MAX_TARGET_INPUT_QUEUE);
  // Then a steady connection: one sample per tick, well buffered.
  q.push(Array.from({ length: q.target }, sample));
  for (let tick = 0; tick < CALM_TICKS * MAX_TARGET_INPUT_QUEUE; tick++) {
    q.push([sample()]);
    q.next();
  }
  assert.equal(q.target, TARGET_INPUT_QUEUE, "back to the smallest depth");
});

// A tiny network: samples reach the server after `up` ticks, snapshots reach the client
// after `down` ticks. Client and server tick in lockstep.
function playOverNetwork(pattern: (tick: number) => TankInput, ticks: number, up = 6, down = 6) {
  const server = createState(map);
  addTank(server, map, "me", "red");
  const queue = new InputQueue();
  const predictor = new Predictor("me", config);
  predictor.reconcile(cloneState(server), 0);

  const toServer: { at: number; frame: InputFrame }[] = [];
  const toClient: { at: number; state: GameState; ack: number }[] = [];
  const predicted = new Map<number, { x: number; y: number; angle: number }>(); // by seq
  const authoritative = new Map<number, { x: number; y: number; angle: number }>(); // by ack
  let firstFireTick: number | null = null;
  const pressTicks: number[] = [];

  for (let t = 0; t < ticks; t++) {
    // Client
    for (const s of toClient.filter((s) => s.at === t)) predictor.reconcile(s.state, s.ack);
    const input = pattern(t);
    if (input.pressed) pressTicks.push(t);
    const { frame, events } = predictor.tick(input);
    if (firstFireTick === null && events.some((e) => e.type === "fire")) firstFireTick = t;
    const me = predictor.state!.tanks[0]!;
    predicted.set(frame.seq, { x: me.x, y: me.y, angle: me.angle });
    toServer.push({ at: t + up, frame });

    // Server
    queue.push(toServer.filter((m) => m.at === t).map((m) => m.frame));
    step(server, map, { me: queue.next() }, config);
    const sm = server.tanks[0]!;
    authoritative.set(queue.ack, { x: sm.x, y: sm.y, angle: sm.angle });
    if (server.tick % SNAPSHOT_EVERY_TICKS === 0) toClient.push({ at: t + down, state: cloneState(server), ack: queue.ack });
  }
  return { predicted, authoritative, firstFireTick, pressTicks, predictor };
}

// Tap now and then, walk in between: exercises spin, flips, firing and walking.
const playPattern = (t: number): TankInput => {
  const phase = t % 90;
  if (phase === 0) return { held: false, pressed: true }; // tap
  if (phase >= 30 && phase < 70) return { held: true, pressed: phase === 30 }; // walk
  return { held: false, pressed: false };
};

test("prediction shows your own shot on the same tick you press, despite latency", () => {
  const { firstFireTick, pressTicks } = playOverNetwork(playPattern, 30);
  assert.equal(firstFireTick, pressTicks[0], "fire must be predicted immediately, not a round trip later");
});

test("after the first snapshot, prediction matches what the server later decides, sample for sample", () => {
  const up = 6;
  const down = 6;
  const { predicted, authoritative } = playOverNetwork(playPattern, 600, up, down);
  // Until the first snapshot arrives the client doesn't know the server already ran a few
  // ticks without its samples (they were still in flight); that one-time offset is fixed
  // by the first reconcile. From then on the two must agree exactly.
  const warmUp = up + down + SNAPSHOT_EVERY_TICKS;
  let compared = 0;
  for (const [seq, server] of authoritative) {
    const mine = predicted.get(seq);
    if (!mine || seq <= warmUp) continue;
    compared++;
    assert.ok(Math.abs(mine.x - server.x) < 1e-9 && Math.abs(mine.y - server.y) < 1e-9, `position differs at seq ${seq}`);
    assert.ok(Math.abs(mine.angle - server.angle) < 1e-9, `angle differs at seq ${seq}`);
  }
  assert.ok(compared > 500, `only compared ${compared} samples`);
});

test("only samples the server hasn't applied are kept for replay", () => {
  const { predictor } = playOverNetwork(playPattern, 200, 6, 6);
  // ~up + down ticks in flight, plus up to one snapshot interval.
  assert.ok(predictor.pendingCount <= 6 + 6 + SNAPSHOT_EVERY_TICKS + 1, `pending ${predictor.pendingCount}`);
});

// The predictor as it was before it reused buffers: a clone per tick and per replayed
// sample. The faster one must produce exactly the same states.
class ClonePredictor {
  state: GameState | null = null;
  prev: GameState | null = null;
  private pending: InputFrame[] = [];
  private seq = 0;
  constructor(private localId: string) {}
  tick(input: TankInput): void {
    const frame = { seq: ++this.seq, ...input };
    this.pending.push(frame);
    if (!this.state) return;
    this.prev = cloneState(this.state);
    this.advance(this.state, frame);
  }
  reconcile(server: GameState, ack: number): void {
    this.pending = this.pending.filter((f) => f.seq > ack);
    const state = cloneState(server);
    let prev = cloneState(state);
    for (const frame of this.pending) {
      prev = cloneState(state);
      this.advance(state, frame);
    }
    this.prev = prev;
    this.state = state;
  }
  private advance(state: GameState, frame: TankInput): void {
    const inputs: Record<string, TankInput> = {};
    for (const t of state.tanks) inputs[t.id] = t.id === this.localId ? frame : { held: t.held, pressed: false };
    step(state, map, inputs, config);
  }
}

test("reusing buffers doesn't change what prediction shows", () => {
  const server = createState(map);
  addTank(server, map, "me", "red");
  addTank(server, map, "other", "blue");
  const queue = new InputQueue();
  const fast = new Predictor("me", config);
  const slow = new ClonePredictor("me");
  fast.reconcile(server, 0);
  slow.reconcile(server, 0);
  const inFlight: { at: number; frame: InputFrame }[] = [];
  let compared = 0;
  for (let t = 0; t < 900; t++) {
    const input = playPattern(t);
    const { frame } = fast.tick(input);
    slow.tick(input);
    inFlight.push({ at: t + 5, frame });
    queue.push(inFlight.filter((m) => m.at === t).map((m) => m.frame));
    // The other player walks and taps on their own rhythm.
    step(server, map, { me: queue.next(), other: playPattern(t + 45) }, config);
    if (server.tick % SNAPSHOT_EVERY_TICKS === 0) {
      const snap = cloneState(server);
      fast.reconcile(snap, queue.ack);
      slow.reconcile(snap, queue.ack);
      assert.deepEqual(snap, server, "reconcile must not change the server state");
    }
    assert.deepEqual(fast.state, slow.state, `state differs at tick ${t}`);
    assert.deepEqual(fast.prev, slow.prev, `prev differs at tick ${t}`);
    compared++;
  }
  assert.equal(compared, 900);
});

// A jittery uplink: in-order delivery with random delays (a seeded LCG, so the test is
// repeatable) and a long stall every 2 s, then the backlog arrives at once. The server
// runs its tick as on the real server; every shot the shooter saw on screen must leave the
// server along exactly the same heading.
function jitteryShots(seed: number) {
  let r = seed >>> 0;
  const rand = () => ((r = (Math.imul(r, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const server = createState(map);
  addTank(server, map, "me", "red");
  addTank(server, map, "other", "blue");
  server.powerBoxes = []; // no flares: only aimed shots
  const queue = new InputQueue();
  const predictor = new Predictor("me", config);
  predictor.reconcile(cloneState(server), 0);
  const inFlight: { at: number; frame: InputFrame }[] = [];
  const snaps: { at: number; state: GameState; ack: number }[] = [];
  const predicted: number[] = [];
  const fired: number[] = [];
  const applied: number[] = [];
  let lastArrive = 0;
  let pressesWithAim = 0;
  let presses = 0;
  for (let t = 0; t < 3600; t++) {
    for (const s of snaps.filter((s) => s.at === t)) predictor.reconcile(s.state, s.ack);
    // Taps at ~8/s with random gaps, and now and then a walk.
    const phase = t % 300;
    const input: TankInput = phase > 200 && phase < 260 ? { held: true, pressed: phase === 201 } : { held: false, pressed: rand() < 0.13 };
    const { frame, events } = predictor.tick(input);
    if (frame.pressed) {
      presses++;
      if (frame.aim !== undefined) pressesWithAim++;
    }
    const me = predictor.state!.tanks.find((x) => x.id === "me")!;
    if (events.some((e) => e.type === "fire" && e.tankId === "me")) predicted.push(me.angle);
    const stall = t % 120 >= 100 ? 120 - (t % 120) : 0; // 20 ticks (333 ms) of nothing
    const arrive = Math.max(lastArrive, t + 2 + Math.floor(rand() * rand() * 12) + stall);
    lastArrive = arrive;
    inFlight.push({ at: arrive, frame });

    const arrived = inFlight.filter((m) => m.at === t).map((m) => m.frame);
    queue.push(arrived);
    const before = queue.ack;
    const mine = queue.next();
    for (let i = 0; i < mine.length; i++) applied.push(before + 1 + i);
    // Every bullet as it is fired (one fired next to a wall is gone by the end of the tick).
    const bullets = server.bullets;
    bullets.push = (...items) => {
      for (const b of items) if (b.owner === "me") fired.push(Math.atan2(b.vy, b.vx));
      return Array.prototype.push.apply(bullets, items);
    };
    step(server, map, { me: mine, other: { held: false, pressed: t % 50 === 0 } }, config);
    if (server.tick % SNAPSHOT_EVERY_TICKS === 0) snaps.push({ at: t + 4, state: cloneState(server), ack: queue.ack });
  }
  return { predicted, fired, applied, queue, presses, pressesWithAim };
}

test("over a jittery, stalling uplink every shot leaves the server along the heading the shooter saw", () => {
  for (const seed of [1, 2, 3]) {
    const { predicted, fired, applied, queue, presses, pressesWithAim } = jitteryShots(seed);
    assert.deepEqual(applied, Array.from({ length: applied.length }, (_, i) => i + 1), "every sample once, in order");
    assert.equal(queue.dropped, 0);
    assert.ok(presses > 100 && pressesWithAim === presses, `aim on ${pressesWithAim} of ${presses} presses`);
    assert.ok(fired.length > 30, `${fired.length} shots`); // the magazine limits them
    // The first shots may come before the first snapshot told the client where it really is.
    const n = Math.min(predicted.length, fired.length);
    let differ = 0;
    for (let i = 0; i < n; i++) {
      let d = Math.abs(predicted[i]! - fired[i]!) % (2 * Math.PI);
      if (d > Math.PI) d = 2 * Math.PI - d;
      if (d > 1e-9) differ++;
    }
    assert.equal(differ, 0, `seed ${seed}: ${differ} of ${n} shots in a different direction`);
    assert.ok(Math.abs(predicted.length - fired.length) <= 1, `predicted ${predicted.length}, fired ${fired.length}`);
  }
});
