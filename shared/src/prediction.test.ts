import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_MAP } from "./map";
import { SNAPSHOT_EVERY_TICKS } from "./net";
import { InputQueue, MAX_INPUT_QUEUE, Predictor, TARGET_INPUT_QUEUE, type InputFrame } from "./prediction";
import { addTank, cloneState, createState, step, type GameState, type TankInput } from "./sim";

const map = DEFAULT_MAP;
const config = { holdMs: 60 };

test("input queue applies one sample per tick and acks it", () => {
  const q = new InputQueue();
  q.push([
    { seq: 1, held: true, pressed: true },
    { seq: 2, held: true, pressed: false },
  ]);
  assert.deepEqual(q.next(), { held: true, pressed: true });
  assert.equal(q.ack, 1);
  assert.deepEqual(q.next(), { held: true, pressed: false });
  assert.equal(q.ack, 2);
  // Nothing queued: keep the button as it was, ack unchanged.
  assert.deepEqual(q.next(), { held: true, pressed: false });
  assert.equal(q.ack, 2);
});

test("input queue skips malformed frames instead of throwing", () => {
  const q = new InputQueue();
  const bad = [null, 1, "x", undefined, { seq: 1, held: true, pressed: true }] as unknown as InputFrame[];
  assert.doesNotThrow(() => q.push(bad));
  assert.equal(q.length, 1);
  assert.deepEqual(q.next(), { held: true, pressed: true });
});

test("a backlog drains back to the target depth, one extra sample per tick, keeping taps", () => {
  const q = new InputQueue();
  const frames: InputFrame[] = [];
  for (let s = 1; s <= MAX_INPUT_QUEUE; s++) frames.push({ seq: s, held: false, pressed: s === 2 });
  q.push(frames);
  let fired = 0;
  // Net one sample fewer per tick: 6 queued reaches the target of 2 after 4 ticks.
  for (let tick = 0; tick < MAX_INPUT_QUEUE - TARGET_INPUT_QUEUE; tick++) {
    if (q.next().pressed) fired++;
    // A steady client adds one sample per tick.
    q.push([{ seq: MAX_INPUT_QUEUE + 1 + tick, held: false, pressed: false }]);
  }
  assert.equal(q.length, TARGET_INPUT_QUEUE);
  assert.equal(fired, 1, "the tap in the backlog still fires exactly once");
});

test("input queue ignores duplicates and old samples", () => {
  const q = new InputQueue();
  q.push([{ seq: 5, held: true, pressed: true }]);
  q.push([
    { seq: 5, held: false, pressed: false },
    { seq: 3, held: false, pressed: false },
  ]);
  q.next();
  assert.deepEqual(q.next(), { held: true, pressed: false }, "only seq 5 was queued");
});

test("input queue overflow drops old samples but never loses a tap", () => {
  const q = new InputQueue();
  const frames: InputFrame[] = [{ seq: 1, held: false, pressed: true }];
  for (let s = 2; s <= MAX_INPUT_QUEUE + 3; s++) frames.push({ seq: s, held: false, pressed: false });
  q.push(frames);
  assert.equal(q.next().pressed, true, "the merged-away tap must still fire");
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
