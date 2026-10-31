import type { GameMap } from "./map";
import { cloneState, step, type GameEvent, type GameState, type SimConfig, type TankInput } from "./sim";

// Client prediction. The client samples its button once per sim tick and numbers each
// sample (`seq`). The server applies exactly one sample per tick per player and reports
// the last one it applied (`ack`) in every snapshot. The client then rebuilds the present
// from the server state by replaying the samples the server hasn't applied yet, so your
// own soldier reacts on the very next frame instead of a round trip later.

export interface InputFrame extends TankInput {
  seq: number;
}

// Server side: at most this many samples wait per player (100 ms at 60 Hz). If a client's
// clock runs fast and the queue grows past it, the oldest samples are merged away.
export const MAX_INPUT_QUEUE = 6;
// Samples normally waiting: enough to ride out network jitter. A backlog beyond this (left
// by a burst of late packets) would otherwise delay that player forever, since samples
// arrive exactly as fast as they are used, so it is drained one extra sample per tick.
export const TARGET_INPUT_QUEUE = 2;

export class InputQueue {
  private queue: InputFrame[] = [];
  private lastQueued = 0;
  private lastHeld = false; // held state of the last sample applied (or merged away)
  ack = 0; // seq of the last sample applied

  push(frames: readonly InputFrame[]): void {
    for (const f of frames) {
      if (!Number.isInteger(f.seq) || f.seq <= this.lastQueued) continue; // duplicate or out of order
      this.queue.push({ seq: f.seq, held: f.held === true, pressed: f.pressed === true });
      this.lastQueued = f.seq;
    }
    while (this.queue.length > MAX_INPUT_QUEUE) this.mergeOldest();
  }

  // The input for this tick. With nothing queued (a late packet), keep the button as it was.
  next(): TankInput {
    if (this.queue.length > TARGET_INPUT_QUEUE) this.mergeOldest();
    const f = this.queue.shift();
    if (!f) return { held: this.lastHeld, pressed: false };
    this.ack = f.seq;
    this.lastHeld = f.held;
    return { held: f.held, pressed: f.pressed };
  }

  get length(): number {
    return this.queue.length;
  }

  // Drop the oldest sample but keep its press, so no tap is ever lost.
  private mergeOldest(): void {
    const dropped = this.queue.shift()!;
    const pressed = dropped.pressed || (dropped.held && !this.lastHeld);
    this.lastHeld = dropped.held;
    if (pressed) this.queue[0]!.pressed = true;
  }
}

// Bound the replay if acks stop arriving (2 s of samples).
const MAX_PENDING = 120;

// Client side: owns the predicted present. Other players are assumed to keep their button
// as last seen, which is right most of the time and corrected by the next snapshot.
export class Predictor {
  state: GameState | null = null; // predicted present (after the latest local sample)
  prev: GameState | null = null; // one tick earlier, for smooth drawing between ticks
  private pending: InputFrame[] = [];
  private seq = 0;

  constructor(
    private map: GameMap,
    private localId: string,
    private config: SimConfig,
  ) {}

  // One local tick: number the sample, advance the prediction, and return the sample to
  // send plus what happened on this tick (for effects like your muzzle flash).
  tick(input: TankInput): { frame: InputFrame; events: GameEvent[] } {
    const frame: InputFrame = { seq: ++this.seq, held: input.held, pressed: input.pressed };
    this.pending.push(frame);
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    if (!this.state) return { frame, events: [] };
    this.prev = cloneState(this.state);
    this.advance(this.state, frame);
    return { frame, events: this.state.events };
  }

  // A new server state where our samples up to `ack` were applied: start from it and
  // replay the rest.
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

  get pendingCount(): number {
    return this.pending.length;
  }

  private advance(state: GameState, frame: InputFrame): void {
    const inputs: Record<string, TankInput> = {};
    for (const t of state.tanks) inputs[t.id] = t.id === this.localId ? frame : { held: t.held, pressed: false };
    step(state, this.map, inputs, this.config);
  }
}
