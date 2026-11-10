import { getMap } from "./maps";
import { cloneState, step, type GameEvent, type GameState, type SimConfig, type TankInput } from "./sim";

// Client prediction. The client samples its button once per sim tick and numbers each
// sample (`seq`). The server applies every sample exactly once, in order, and reports the
// last one it applied (`ack`) in every snapshot. The client then rebuilds the present from
// the server state by replaying the samples the server hasn't applied yet, so your own
// soldier reacts on the very next frame instead of a round trip later. Because the server
// never invents or skips a sample, your soldier goes through exactly the same updates there
// as on your screen, and every shot leaves along the heading you saw.

export interface InputFrame extends TankInput {
  seq: number;
}

// Server side: samples wait in a small buffer per player so network jitter doesn't starve
// the sim. Its depth adapts to the player's connection, checked once a second: running dry
// twice or more in that second adds a sample of depth; never running low takes one away.
// A deeper buffer only delays how others see you; your own soldier is predicted on screen.
export const TARGET_INPUT_QUEUE = 2; // starting and smallest depth
export const MAX_TARGET_INPUT_QUEUE = 8; // ~133 ms: deeper than that a player is just lagging
export const CALM_TICKS = 60; // the adapting window: 1 s
const STARVES_TO_GROW = 2; // one stray late packet isn't worth a deeper buffer
// At most this many samples of one player are applied in one server tick (draining a backlog).
export const MAX_SAMPLES_PER_TICK = 2;
// Hard cap (a client whose clock runs fast, or a burst after a very long stall): beyond it
// old samples are dropped, the only time a sample is ever skipped (counted in `dropped`).
export const MAX_INPUT_QUEUE = 30;

export class InputQueue {
  private queue: InputFrame[] = [];
  private lastQueued = 0;
  private lastHeld = false; // held state of the last sample applied (or dropped)
  private windowTicks = 0;
  private windowStarves = 0;
  private windowMin = Infinity; // smallest backlog seen in this window
  target = TARGET_INPUT_QUEUE; // current depth to keep
  ack = 0; // seq of the last sample applied
  dropped = 0; // samples skipped at the hard cap (should stay 0)
  lostPresses = 0; // taps folded into another tap at the hard cap (should stay 0)

  push(frames: readonly InputFrame[]): void {
    for (const f of frames) {
      if (!f || typeof f !== "object") continue; // malformed client message: never crash the room
      if (!Number.isInteger(f.seq) || f.seq <= this.lastQueued) continue; // duplicate or out of order
      const frame: InputFrame = { seq: f.seq, held: f.held === true, pressed: f.pressed === true };
      if (frame.pressed) {
        // Checked again by the sim (tolerance, rewind window).
        if (typeof f.aim === "number" && Number.isFinite(f.aim)) frame.aim = f.aim;
        if (typeof f.seen === "number" && Number.isFinite(f.seen)) frame.seen = f.seen;
      }
      this.queue.push(frame);
      this.lastQueued = f.seq;
    }
    while (this.queue.length > MAX_INPUT_QUEUE) this.dropOne();
  }

  // The samples to apply this tick, in order: usually one; none when this player's next
  // sample hasn't arrived (their soldier waits for it); two when a backlog has built up
  // beyond the target depth (plus one sample of slack, so it doesn't drain and starve in
  // turn), so a burst of late packets drains without dropping anything.
  next(): TankInput[] {
    this.windowMin = Math.min(this.windowMin, this.queue.length);
    const take = this.queue.length > this.target + 1 ? MAX_SAMPLES_PER_TICK : Math.min(1, this.queue.length);
    if (take === 0) this.windowStarves++;
    if (++this.windowTicks >= CALM_TICKS) this.adapt();
    const out: TankInput[] = [];
    for (let i = 0; i < take; i++) {
      const f = this.queue.shift()!;
      this.ack = f.seq;
      this.lastHeld = f.held;
      out.push(toInput(f));
    }
    return out;
  }

  private adapt(): void {
    if (this.windowStarves >= STARVES_TO_GROW) this.target = Math.min(MAX_TARGET_INPUT_QUEUE, this.target + 1);
    else if (this.windowStarves === 0 && this.windowMin >= 2) this.target = Math.max(TARGET_INPUT_QUEUE, this.target - 1);
    this.windowTicks = this.windowStarves = 0;
    this.windowMin = Infinity;
  }

  get length(): number {
    return this.queue.length;
  }

  // Last resort at the hard cap: removes one waiting sample. It picks one that changes
  // nothing (no tap, no press or release) so a tap or its spin reversal survives; if every
  // sample matters, the oldest is folded into the next. Never merges two taps unless both
  // are lost anyway (counted in lostPresses).
  private dropOne(): void {
    this.dropped++;
    let prevHeld = this.lastHeld;
    for (let i = 0; i < this.queue.length; i++) {
      const f = this.queue[i]!;
      if (!f.pressed && f.held === prevHeld) {
        this.queue.splice(i, 1);
        return;
      }
      prevHeld = f.held;
    }
    const dropped = this.queue.shift()!;
    const pressed = dropped.pressed || (dropped.held && !this.lastHeld);
    this.lastHeld = dropped.held;
    const into = this.queue[0];
    if (!pressed || !into) return;
    if (into.pressed) {
      this.lostPresses++;
      return;
    }
    into.pressed = true;
    if (dropped.aim !== undefined) into.aim = dropped.aim;
    if (dropped.seen !== undefined) into.seen = dropped.seen;
  }
}

function toInput(f: InputFrame): TankInput {
  const input: TankInput = { held: f.held, pressed: f.pressed };
  if (f.aim !== undefined) input.aim = f.aim;
  if (f.seen !== undefined) input.seen = f.seen;
  return input;
}

// Bound the replay if acks stop arriving (2 s of samples).
const MAX_PENDING = 120;

// Client side: owns the predicted present. Other players are assumed to keep their button
// as last seen, which is right most of the time and corrected by the next snapshot.
// This runs every tick on phones, so it avoids garbage: `prev` is one buffer that is
// copied into, and a snapshot costs a single clone of the server state.
export class Predictor {
  state: GameState | null = null; // predicted present (after the latest local sample)
  prev: GameState | null = null; // one tick earlier, for smooth drawing between ticks
  private pending: InputFrame[] = [];
  private seq = 0;
  private inputs: Record<string, TankInput> = {}; // reused for every step

  constructor(
    private localId: string,
    private config: SimConfig,
  ) {}

  // One local tick: number the sample, advance the prediction, and return the sample to
  // send plus what happened on this tick (for effects like your muzzle flash).
  // A press is sent with the heading it fired along here (`aim`), so the server fires
  // along the same line; `input.seen` (the server tick of the others as drawn) is passed on.
  tick(input: TankInput): { frame: InputFrame; events: GameEvent[] } {
    const frame: InputFrame = { seq: ++this.seq, held: input.held, pressed: input.pressed };
    if (input.pressed && input.seen !== undefined) frame.seen = input.seen;
    this.pending.push(frame);
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    if (!this.state) return { frame, events: [] };
    this.prev = copyInto(this.prev, this.state);
    this.advance(this.state, frame);
    if (frame.pressed) {
      for (const t of this.state.tanks) if (t.id === this.localId && t.alive) frame.aim = t.angle;
    }
    return { frame, events: this.state.events };
  }

  // A new server state where our samples up to `ack` were applied: start from it and
  // replay the rest. `server` is not changed.
  reconcile(server: GameState, ack: number): void {
    let drop = 0;
    while (drop < this.pending.length && this.pending[drop]!.seq <= ack) drop++;
    if (drop) this.pending.splice(0, drop);
    const state = cloneState(server);
    const last = this.pending.length - 1;
    for (let i = 0; i < last; i++) this.advance(state, this.pending[i]!);
    this.prev = copyInto(this.prev, state);
    if (last >= 0) this.advance(state, this.pending[last]!);
    this.state = state;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  private advance(state: GameState, frame: InputFrame): void {
    const inputs = this.inputs;
    for (const t of state.tanks) {
      if (t.id === this.localId) {
        inputs[t.id] = frame;
      } else {
        const input = (inputs[t.id] ??= { held: false, pressed: false });
        input.held = t.held;
        input.pressed = false;
      }
    }
    step(state, getMap(state.mapId), inputs, this.config); // the map can change between rounds
  }
}

// Makes `dst` a deep copy of `src` (plain data), reusing dst's objects and arrays where
// they have the same keys, and returns it. Only for states that are drawn, not stepped.
export function copyInto<T>(dst: T | null, src: T): T {
  return copyValue(dst, src) as T;
}

type Obj = Record<string, unknown>;

function copyValue(dst: unknown, src: unknown): unknown {
  if (typeof src !== "object" || src === null) return src;
  if (Array.isArray(src)) {
    const out: unknown[] = Array.isArray(dst) ? dst : [];
    out.length = src.length;
    for (let i = 0; i < src.length; i++) out[i] = copyValue(out[i], src[i]);
    return out;
  }
  const from = src as Obj;
  const to = dst as Obj;
  const reuse = typeof dst === "object" && dst !== null && !Array.isArray(dst);
  // Flat objects (soldiers, bullets, crates...) are the common case: Object.assign is
  // far faster than copying key by key.
  if (reuse && isFlatWithSameKeys(to, from)) return Object.assign(to, from);
  const out: Obj = reuse && sameKeys(to, from) ? to : {};
  for (const k in from) out[k] = copyValue(out[k], from[k]);
  return out;
}

function isFlatWithSameKeys(a: Obj, b: Obj): boolean {
  let n = 0;
  for (const k in b) {
    const v = b[k];
    if ((typeof v === "object" && v !== null) || !(k in a)) return false;
    n++;
  }
  for (const _k in a) n--;
  return n === 0;
}

function sameKeys(a: Obj, b: Obj): boolean {
  let n = 0;
  for (const k in a) {
    if (!(k in b)) return false;
    n++;
  }
  for (const _k in b) n--;
  return n === 0;
}
