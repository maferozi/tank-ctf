import { getMap } from "./maps";
import { cloneState, step, type GameEvent, type GameState, type SimConfig, type TankInput } from "./sim";

// Client prediction. The client samples its button once per sim tick and numbers each
// sample (`seq`). The server applies exactly one sample per tick per player and reports
// the last one it applied (`ack`) in every snapshot. The client then rebuilds the present
// from the server state by replaying the samples the server hasn't applied yet, so your
// own soldier reacts on the very next frame instead of a round trip later.

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
// Hard cap (a client whose clock runs fast, or a burst after a long stall).
export const MAX_INPUT_QUEUE = 20;

export class InputQueue {
  private queue: InputFrame[] = [];
  private lastQueued = 0;
  private lastHeld = false; // held state of the last sample applied (or dropped)
  private windowTicks = 0;
  private windowStarves = 0;
  private windowMin = Infinity; // smallest backlog seen in this window
  target = TARGET_INPUT_QUEUE; // current depth to keep
  ack = 0; // seq of the last sample applied
  lostPresses = 0; // taps folded into another tap at the hard cap (should stay 0)

  push(frames: readonly InputFrame[]): void {
    for (const f of frames) {
      if (!f || typeof f !== "object") continue; // malformed client message: never crash the room
      if (!Number.isInteger(f.seq) || f.seq <= this.lastQueued) continue; // duplicate or out of order
      const frame: InputFrame = { seq: f.seq, held: f.held === true, pressed: f.pressed === true };
      if (frame.pressed && typeof f.view === "number" && Number.isFinite(f.view)) frame.view = f.view; // clamped by the sim
      this.queue.push(frame);
      this.lastQueued = f.seq;
    }
    while (this.queue.length > MAX_INPUT_QUEUE) this.dropOne(true);
  }

  // The input for this tick. With nothing queued (a late packet), repeat the button as it
  // was, marked stale so it doesn't count as holding longer.
  next(): TankInput {
    // A backlog beyond the target (left by a burst of late packets) would otherwise delay
    // this player for good, since samples arrive exactly as fast as they are used. One
    // sample of slack keeps it from draining and starving in turn.
    if (this.queue.length > this.target + 1) this.dropOne(false);
    this.windowMin = Math.min(this.windowMin, this.queue.length);
    const f = this.queue.shift();
    if (!f) this.windowStarves++;
    if (++this.windowTicks >= CALM_TICKS) this.adapt();
    if (!f) return { held: this.lastHeld, pressed: false, stale: true };
    this.ack = f.seq;
    this.lastHeld = f.held;
    return f.view === undefined ? { held: f.held, pressed: f.pressed } : { held: f.held, pressed: f.pressed, view: f.view };
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

  // Removes one waiting sample. It picks one that changes nothing (no tap, no press or
  // release), so draining never loses a tap or its spin reversal. Only at the hard cap, if
  // every sample matters, the oldest is folded into the next (`force`).
  private dropOne(force: boolean): void {
    let prevHeld = this.lastHeld;
    for (let i = 0; i < this.queue.length; i++) {
      const f = this.queue[i]!;
      if (!f.pressed && f.held === prevHeld) {
        this.queue.splice(i, 1);
        return;
      }
      prevHeld = f.held;
    }
    if (!force) return;
    const dropped = this.queue.shift()!;
    const pressed = dropped.pressed || (dropped.held && !this.lastHeld);
    this.lastHeld = dropped.held;
    const into = this.queue[0];
    if (!pressed || !into) return;
    if (into.pressed) this.lostPresses++;
    into.pressed = true;
    if (dropped.view !== undefined && into.view === undefined) into.view = dropped.view;
  }
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
  private ownInput: TankInput = { held: false, pressed: false };

  constructor(
    private localId: string,
    private config: SimConfig,
  ) {}

  // One local tick: number the sample, advance the prediction, and return the sample to
  // send plus what happened on this tick (for effects like your muzzle flash).
  tick(input: TankInput): { frame: InputFrame; events: GameEvent[] } {
    const frame: InputFrame = { seq: ++this.seq, held: input.held, pressed: input.pressed };
    if (input.pressed && input.view !== undefined) frame.view = input.view;
    this.pending.push(frame);
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    if (!this.state) return { frame, events: [] };
    this.prev = copyInto(this.prev, this.state);
    this.advance(this.state, frame);
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
        this.ownInput.held = frame.held;
        this.ownInput.pressed = frame.pressed;
        inputs[t.id] = this.ownInput;
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
