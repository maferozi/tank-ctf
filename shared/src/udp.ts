import { pack, unpack } from "msgpackr";
import { applyStateDelta, diffState, type Snapshot, type SnapshotState, type StateDelta } from "./net";
import type { InputFrame } from "./prediction";
import type { GameEvent } from "./sim";

// ---- The UDP game channel (see docs/NETCODE.md, "UDP game channel") ----
// Inputs and snapshots can travel over a WebRTC data channel between each browser and the
// game server, unordered and without retransmits (UDP-like), so one lost packet never holds
// up the ones behind it the way it does on the WebSocket (TCP). Everything else (roster,
// lobby, voice signaling) stays on the WebSocket, and so do inputs and snapshots whenever
// the channel isn't open.
//
// Because any message may be lost, duplicated or reordered:
// - Up (client -> server): every message carries all the input samples the server hasn't
//   acked yet (at most UDP_MAX_SAMPLES), and the newest snapshot tick the client has decoded
//   (`ack`). The server's InputQueue ignores samples it already has.
// - Down (server -> client): every snapshot is a delta against the newest snapshot the client
//   acked (the server keeps UDP_HISTORY_SNAPSHOTS of them), or a keyframe when it has no
//   usable ack. Each message names its base tick; the client keeps a ring of recent decoded
//   states, decodes any message whose base it still has and skips the rest. Nothing waits for
//   a lost message.
// - Events (shots, kills, flags...) go out grouped by snapshot tick, every group since the
//   client's ack, so they arrive as long as any later message does; the client drops groups
//   for ticks it has already had (SnapshotFeed).

export const UDP_CHANNEL_LABEL = "game";
export const UDP_HISTORY_SNAPSHOTS = 60; // server: 2 s of snapshot states and events
export const UDP_CLIENT_RING = 90; // client: decoded states kept as bases (more than the server's)
export const UDP_MAX_SAMPLES = 60; // unacked input samples per up message (1 s)
// Server: while a client hasn't acked anything usable, snapshots are deltas against the
// last keyframe sent to it, and a new keyframe goes out this often until an ack arrives.
export const UDP_KEY_RESEND_MS = 250;
// Server: no message from a client's channel for this long and its snapshots go back to the
// WebSocket. Clients send at least every UDP_KEEPALIVE_MS (inputs, or an ack on its own).
export const UDP_IDLE_MS = 1000;
export const UDP_KEEPALIVE_MS = 200;
// Client: the channel has this long to open, else the game stays on the WebSocket.
export const UDP_OPEN_TIMEOUT_MS = 5000;
// Client: on the channel but nothing came over it for this long while the WebSocket still
// delivers snapshots: the channel is dead, go back to the WebSocket.
export const UDP_SILENT_MS = 1500;

// Snapshot events, grouped by the tick of the snapshot they were first sent with.
export type EventGroup = [tick: number, events: GameEvent[]];

// ---- Signaling (over the room's WebSocket, MSG.rtc) ----
// client -> server: `hello` asks for a channel (the server makes the offer); `answer` and
// `cand` complete it; `close` says the client stopped using it.
// server -> client: `offer`, `cand`, and `close` when the server gives up on it.
// `id` numbers the server's connections, so messages for an old one are ignored.
export type RtcSignal =
  | { kind: "hello" }
  | { kind: "offer"; id: number; sdp: string }
  | { kind: "answer"; id: number; sdp: string }
  | { kind: "cand"; id: number; candidate: string; mid: string }
  | { kind: "close"; id: number };

export const MAX_RTC_SIGNAL_BYTES = 8192;

// Checks a signaling message from the other side; null if it isn't one.
export function parseRtcSignal(raw: unknown): RtcSignal | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const id = m.id;
  const okId = typeof id === "number" && Number.isInteger(id) && id >= 0;
  const str = (v: unknown) => typeof v === "string" && v.length <= MAX_RTC_SIGNAL_BYTES;
  switch (m.kind) {
    case "hello":
      return { kind: "hello" };
    case "offer":
    case "answer":
      return okId && str(m.sdp) ? { kind: m.kind, id: id as number, sdp: m.sdp as string } : null;
    case "cand":
      return okId && str(m.candidate) && str(m.mid) ? { kind: "cand", id: id as number, candidate: m.candidate as string, mid: m.mid as string } : null;
    case "close":
      return okId ? { kind: "close", id: id as number } : null;
    default:
      return null;
  }
}

// ---- Up: inputs and ack ----
export interface UpMessage {
  ack: number; // newest snapshot tick the client has decoded, -1 if none
  epoch: number; // match the ack belongs to (ticks start over every match)
  samples: InputFrame[]; // consecutive seqs, oldest first
}

const UP_TYPE = 1;

// [type, ack, epoch, firstSeq, bits[], extras[]]: bits per sample (1 held, 2 pressed), and
// for pressed samples [index, aim | null, seen | null, ...].
export function encodeUp(msg: UpMessage): Uint8Array {
  const first = msg.samples[0]?.seq ?? 0;
  const bits: number[] = [];
  const extras: (number | null)[] = [];
  msg.samples.forEach((s, i) => {
    bits.push((s.held ? 1 : 0) | (s.pressed ? 2 : 0));
    if (s.pressed && (s.aim !== undefined || s.seen !== undefined)) extras.push(i, s.aim ?? null, s.seen ?? null);
  });
  return pack([UP_TYPE, msg.ack, msg.epoch, first, bits, extras]);
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// null for anything malformed (never throws).
export function decodeUp(bytes: Uint8Array): UpMessage | null {
  let raw: unknown;
  try {
    raw = unpack(bytes);
  } catch {
    return null;
  }
  if (!Array.isArray(raw) || raw[0] !== UP_TYPE) return null;
  const [, ack, epoch, first, bits, extras] = raw as unknown[];
  if (!isInt(ack) || !isInt(epoch) || !isInt(first) || !Array.isArray(bits) || !Array.isArray(extras)) return null;
  if (bits.length > UDP_MAX_SAMPLES) return null;
  const samples: InputFrame[] = [];
  for (let i = 0; i < bits.length; i++) {
    const b = bits[i];
    if (!isInt(b)) return null;
    samples.push({ seq: first + i, held: (b & 1) !== 0, pressed: (b & 2) !== 0 });
  }
  for (let j = 0; j + 2 < extras.length; j += 3) {
    const s = isInt(extras[j]) ? samples[extras[j] as number] : undefined;
    if (!s?.pressed) continue;
    if (isNum(extras[j + 1])) s.aim = extras[j + 1] as number;
    if (isNum(extras[j + 2])) s.seen = extras[j + 2] as number;
  }
  return { ack, epoch, samples };
}

// ---- Down: snapshots ----
export interface DownMessage {
  epoch: number;
  tick: number; // the snapshot's tick
  base?: number; // delta: the tick of the state it applies to
  full?: SnapshotState; // keyframe
  delta?: StateDelta;
  ev: EventGroup[]; // every event group after the client's ack, oldest first
  acks: Record<string, number>; // per player: seq of the last input sample applied
}

export function encodeDown(msg: DownMessage): Uint8Array {
  const out: Record<string, unknown> = { e: msg.epoch, t: msg.tick, v: msg.ev, k: msg.acks };
  if (msg.full) out.f = msg.full;
  else {
    out.b = msg.base;
    out.d = msg.delta;
  }
  return pack(out);
}

// Server -> client while no snapshots flow (lobby): keeps the channel known to be alive.
const PING = pack({ p: 1 });
export function encodePing(): Uint8Array {
  return PING;
}

export function decodeDown(bytes: Uint8Array): DownMessage | null {
  let raw: unknown;
  try {
    raw = unpack(bytes);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (!isInt(m.e) || !isInt(m.t) || !Array.isArray(m.v) || typeof m.k !== "object" || m.k === null) return null;
  const msg: DownMessage = { epoch: m.e, tick: m.t, ev: m.v as EventGroup[], acks: m.k as Record<string, number> };
  if (m.f) msg.full = m.f as SnapshotState;
  else if (isInt(m.b) && Array.isArray(m.d)) {
    msg.base = m.b;
    msg.delta = m.d;
  } else return null;
  return msg;
}

// ---- Server side ----

// The room's recent snapshots (states as sent, events grouped by snapshot tick). States are
// treated as read-only once pushed.
export class SnapshotHistory {
  epoch = 0; // bumped for every new match
  private states = new Map<number, SnapshotState>();
  private groups: EventGroup[] = [];
  latest: SnapshotState | null = null;

  constructor(private size = UDP_HISTORY_SNAPSHOTS) {}

  push(state: SnapshotState, events: GameEvent[]): void {
    this.states.set(state.tick, state);
    this.groups.push([state.tick, events]);
    this.latest = state;
    while (this.groups.length > this.size) this.states.delete(this.groups.shift()![0]);
  }

  // A new match: ticks start over.
  reset(): void {
    this.epoch++;
    this.states.clear();
    this.groups = [];
    this.latest = null;
  }

  get(tick: number): SnapshotState | undefined {
    return this.states.get(tick);
  }

  // Event groups for snapshots after `tick`, oldest first.
  eventsAfter(tick: number): EventGroup[] {
    let i = this.groups.length;
    while (i > 0 && this.groups[i - 1]![0] > tick) i--;
    return this.groups.slice(i);
  }
}

// What the server knows about one client's channel.
export interface UdpPeerState {
  ack: number; // newest snapshot tick the client decoded (-1: none), in ackEpoch
  ackEpoch: number;
  keyTick: number; // last keyframe sent to it (-1: none), in keyEpoch
  keyEpoch: number;
  keyAt: number; // when (ms)
  // Events up to this tick reached the client another way (the WebSocket, before it switched
  // to the channel) or came before its first message, in floorEpoch.
  floor: number;
  floorEpoch: number;
}

export function newPeerState(): UdpPeerState {
  return { ack: -1, ackEpoch: -1, keyTick: -1, keyEpoch: -1, keyAt: -Infinity, floor: -1, floorEpoch: -1 };
}

// Takes the ack from an up message (they may arrive out of order: keep the newest).
export function notePeerAck(peer: UdpPeerState, msg: UpMessage): void {
  if (msg.epoch > peer.ackEpoch || (msg.epoch === peer.ackEpoch && msg.ack > peer.ack)) {
    peer.ack = msg.ack;
    peer.ackEpoch = msg.epoch;
  }
}

// The next snapshot message for one client, against the newest base it is known (or, right
// after a keyframe, likely) to have. `cache` shares deltas between clients with the same base
// for this snapshot. Returns null if there is no snapshot yet.
export function buildDown(
  hist: SnapshotHistory,
  peer: UdpPeerState,
  acks: Record<string, number>,
  now: number,
  cache?: Map<number, StateDelta | null>,
): DownMessage | null {
  const state = hist.latest;
  if (!state) return null;
  const tick = state.tick;
  const epoch = hist.epoch;
  const acked = peer.ackEpoch === epoch && peer.ack >= 0 && peer.ack < tick && hist.get(peer.ack) ? peer.ack : -1;
  let base = acked;
  if (base < 0 && peer.keyEpoch === epoch && now - peer.keyAt < UDP_KEY_RESEND_MS && peer.keyTick < tick && hist.get(peer.keyTick)) {
    base = peer.keyTick;
  }
  let delta: StateDelta | null = null;
  if (base >= 0) {
    const from = hist.get(base)!;
    if (cache?.has(base)) delta = cache.get(base)!;
    else {
      // A new map (next round) or a new shape of state (new rules): keyframe.
      try {
        delta = from.mapId === state.mapId ? diffState(from, state) : null;
      } catch {
        delta = null;
      }
      cache?.set(base, delta);
    }
  }
  // Events from the first snapshot this client was sent in this match (or since it left the
  // WebSocket), until it acks something.
  if (peer.floorEpoch !== epoch) {
    peer.floor = tick - 1;
    peer.floorEpoch = epoch;
  }
  const floor = Math.max(acked, peer.floor);
  const msg: DownMessage = { epoch, tick, ev: hist.eventsAfter(floor), acks };
  if (delta) {
    msg.base = base;
    msg.delta = delta;
  } else {
    msg.full = state;
    peer.keyTick = tick;
    peer.keyEpoch = epoch;
    peer.keyAt = now;
  }
  return msg;
}

// ---- Client side ----

export interface DecodedSnapshot {
  epoch: number;
  state: SnapshotState;
  groups: EventGroup[];
  acks: Record<string, number>;
}

// Turns down messages back into states. Keeps a ring of recent states (by tick) to apply
// deltas to; a message whose base isn't there, or that is older than the newest decoded, is
// skipped (counted), never waited for.
export class UdpSnapshotDecoder {
  private ring = new Map<number, SnapshotState>();
  private ticks: number[] = [];
  epoch = -1;
  newest = -1; // newest decoded tick in `epoch` (the ack sent to the server)
  keyframes = 0;
  deltas = 0;
  noBase = 0; // skipped: base not in the ring
  stale = 0; // skipped: not newer than what we have (late or duplicate)
  failures = 0; // skipped: the delta didn't apply (should stay 0)

  decode(msg: DownMessage): DecodedSnapshot | null {
    if (msg.epoch !== this.epoch) {
      if (msg.epoch < this.epoch) {
        this.stale++;
        return null; // from a match that is over
      }
      this.startEpoch(msg.epoch);
    }
    if (msg.tick <= this.newest) {
      this.stale++;
      return null;
    }
    let state: SnapshotState;
    if (msg.full) {
      state = msg.full;
      this.keyframes++;
    } else {
      const base = msg.base === undefined ? undefined : this.ring.get(msg.base);
      if (!base || !msg.delta) {
        this.noBase++;
        return null;
      }
      try {
        state = applyStateDelta(base, msg.delta);
      } catch {
        this.failures++;
        return null;
      }
      this.deltas++;
    }
    if (state.tick !== msg.tick) {
      this.failures++;
      return null;
    }
    this.remember(msg.epoch, state);
    return { epoch: msg.epoch, state, groups: msg.ev, acks: msg.acks };
  }

  // Also keeps states that arrived another way (the WebSocket), so they can be bases too.
  remember(epoch: number, state: SnapshotState): void {
    if (epoch !== this.epoch) {
      if (epoch < this.epoch) return;
      this.startEpoch(epoch);
    }
    if (state.tick <= this.newest) return;
    this.ring.set(state.tick, state);
    this.ticks.push(state.tick);
    while (this.ticks.length > UDP_CLIENT_RING) this.ring.delete(this.ticks.shift()!);
    this.newest = state.tick;
  }

  get skipped(): number {
    return this.noBase + this.stale + this.failures;
  }

  private startEpoch(epoch: number): void {
    this.epoch = epoch;
    this.ring.clear();
    this.ticks = [];
    this.newest = -1;
  }
}

// Merges snapshots from both paths (WebSocket and channel) into one stream in tick order:
// a snapshot no newer than the last one passed on is dropped, and so are event groups for
// ticks already passed on, so every event comes out exactly once.
export class SnapshotFeed {
  private epoch: number | undefined;
  lastTick = -1;
  dropped = 0;

  accept(epoch: number | undefined, state: SnapshotState, groups: EventGroup[], acks: Record<string, number>): Snapshot | null {
    if (epoch !== undefined && epoch !== this.epoch) {
      if (this.epoch !== undefined && epoch < this.epoch) {
        this.dropped++;
        return null;
      }
      this.epoch = epoch;
      this.lastTick = -1;
    } else if (epoch === undefined && state.tick < this.lastTick) {
      this.lastTick = -1; // an older server without epochs: a new match
    }
    if (state.tick <= this.lastTick) {
      this.dropped++;
      return null;
    }
    const events: GameEvent[] = [];
    for (const [t, list] of groups) if (t > this.lastTick && t <= state.tick) for (const e of list) events.push(e);
    this.lastTick = state.tick;
    return { state, events, acks };
  }
}

// Client side: the input samples the server hasn't acked yet. Every up message carries them
// all (the newest UDP_MAX_SAMPLES), so a lost message costs nothing; switching back to the
// WebSocket sends them again too, and the server ignores the ones it already has.
export class InputSender {
  private frames: InputFrame[] = [];

  push(frames: readonly InputFrame[]): void {
    for (const f of frames) this.frames.push(f);
    if (this.frames.length > 2 * UDP_MAX_SAMPLES) this.frames.splice(0, this.frames.length - 2 * UDP_MAX_SAMPLES);
  }

  ack(seq: number): void {
    let drop = 0;
    while (drop < this.frames.length && this.frames[drop]!.seq <= seq) drop++;
    if (drop) this.frames.splice(0, drop);
  }

  // The newest unacked samples, oldest first (consecutive seqs).
  recent(max = UDP_MAX_SAMPLES): InputFrame[] {
    return this.frames.slice(Math.max(0, this.frames.length - max));
  }

  get unacked(): readonly InputFrame[] {
    return this.frames;
  }

  // A new connection numbers its samples from 1 again.
  clear(): void {
    this.frames = [];
  }
}

// Optional loss and delay for testing the channel without root (UDP_LOSS, UDP_DELAY_MS,
// UDP_JITTER_MS): applied by the sender, per message. `random` is injectable for tests.
export interface LinkShaping {
  loss: number; // 0..1, share of messages dropped
  delayMs: number; // one-way delay added
  jitterMs: number; // plus 0..jitterMs, uniformly (so messages reorder, as on real UDP)
}

export function shapedSend(shaping: LinkShaping | null, send: () => void, random: () => number = Math.random): void {
  if (!shaping || (shaping.loss <= 0 && shaping.delayMs <= 0 && shaping.jitterMs <= 0)) {
    send();
    return;
  }
  if (random() < shaping.loss) return;
  const delay = shaping.delayMs + random() * shaping.jitterMs;
  if (delay <= 0) send();
  else setTimeout(send, delay);
}
