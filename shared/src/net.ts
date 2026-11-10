import type { Team } from "./map";
import type { MatchRounds } from "./match";
import type { InputFrame } from "./prediction";
import type { GameEvent, GameState } from "./sim";
import type { EventGroup } from "./udp";

// Messages between the web client and the game server.

export const ROOM_NAME = "game";
export const MAX_PLAYERS = 8;
export const SNAPSHOT_EVERY_TICKS = 2; // 60 Hz sim, 30 Hz snapshots
export const MAX_NAME_LENGTH = 16;

export const MSG = {
  input: "input", // client -> server: InputMessage, every frame (one sample per sim tick)
  snapshot: "snap", // server -> clients: Snapshot
  roster: "roster", // server -> clients: Roster, on every join and leave
  // client -> server, once its listeners are set up: "send me the roster". The roster
  // broadcast during the join arrives before a new client can listen for it.
  ready: "ready",
  // Lobby only (ignored during a match, when teams are locked):
  team: "team", // client -> server: TeamMessage, switch your own team
  move: "move", // host -> server: MoveMessage, put another player on a team
  start: "start", // host -> server: start the match
  shareVoice: "shareVoice", // client -> server: ShareVoiceMessage, your own choice, any time
  // client -> server: "send me a full snapshot", when a delta doesn't fit what it has.
  keyframe: "key",
  // Voice chat signaling (see voice.ts and docs/VOICE.md). Both ways: VoiceMessage. The
  // server relays it only between two players in the same voice group.
  voice: "voice",
  // server -> client: VoiceConfig (ICE servers), on join; client -> server: "send it again".
  voiceConfig: "voiceCfg",
  // UDP game channel signaling, both ways: RtcSignal (see udp.ts and docs/NETCODE.md).
  rtc: "rtc",
} as const;

// Seconds a dropped player's soldier waits for them to reconnect (refresh, network blip).
export const RECONNECT_SECONDS = 30;

export type RoomPhase = "lobby" | "playing";

export interface TeamMessage {
  team: Team;
}

export interface ShareVoiceMessage {
  on: boolean;
}

export interface MoveMessage {
  playerId: string;
  team: Team;
}

export interface JoinOptions {
  name: string;
  team: Team;
}

// The room creator also picks the match type (1 round = single match, 5 or 7 = tournament)
// and a map id for each round.
export interface CreateOptions extends JoinOptions {
  rounds: MatchRounds;
  maps: string[];
}

// Button samples, one per client sim tick, numbered so the server can ack them.
export type InputMessage = InputFrame[];
export const MAX_FRAMES_PER_MESSAGE = 32;

export type SnapshotState = Omit<GameState, "events">;

// A snapshot as the client uses it, after decoding a SnapshotMessage.
export interface Snapshot {
  state: SnapshotState;
  events: GameEvent[]; // everything that happened since the previous snapshot
  acks: Record<string, number>; // per player: seq of the last input sample applied
}

// What actually goes over the wire. A keyframe carries the full state; otherwise only the
// changes since the previous snapshot sent to this client (see "Snapshot deltas" below).
export interface SnapshotMessage {
  full?: SnapshotState; // keyframe
  base?: number; // delta: tick of the snapshot it applies to
  delta?: StateDelta;
  events: GameEvent[];
  acks: Record<string, number>;
  epoch?: number; // the match (ticks start over every match); see udp.ts
  // Only on the first snapshot after a client comes back from the UDP channel: the events
  // since the newest snapshot it acked there, grouped by snapshot tick (replaces `events`).
  ev?: EventGroup[];
}

export interface Player {
  id: string; // Colyseus sessionId, also the tank id
  name: string;
  team: Team;
  away: boolean; // connection dropped; their seat is held for RECONNECT_SECONDS
  // This player chose to let the other team hear them during the match (their own choice,
  // off by default: in a match your voice only goes to your own team).
  shareVoice: boolean;
}

// Everything about the room except the game itself, sent on every change.
export interface Roster {
  players: Player[];
  hostId: string | null; // the room creator; passes to the next player if they leave
  phase: RoomPhase;
  rounds: MatchRounds;
  maps: string[];
}

// The host can start once both teams have someone in them.
export function canStart(roster: Pick<Roster, "players">): boolean {
  return roster.players.some((p) => p.team === "red") && roster.players.some((p) => p.team === "blue");
}

// GET {server}/rooms/CODE: who is in a room, so the join form can show the teams before
// joining. 404 if there is no such room.
export interface RoomInfo {
  code: string;
  players: Player[];
  maxPlayers: number;
  rounds: MatchRounds;
  maps: string[]; // map id per round
  phase: RoomPhase;
}

// What a room publishes in its listing metadata (read by GET /rooms/CODE).
export type RoomMetadata = Roster;

// Room codes: 4 letters, no look-alikes (I/L/O/0/1), easy to read out loud.
const CODE_LETTERS = "ABCDEFGHJKMNPQRSTUVWXYZ";
export const ROOM_CODE_LENGTH = 4;

export function makeRoomCode(random: () => number = Math.random): string {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += CODE_LETTERS[Math.floor(random() * CODE_LETTERS.length)];
  return code;
}

// Upper-cases and strips anything that can't be in a code; "" if it can't be one.
export function normalizeRoomCode(input: string): string {
  const code = input.toUpperCase().replace(/[^A-Z]/g, "");
  return code.length === ROOM_CODE_LENGTH && [...code].every((c) => CODE_LETTERS.includes(c)) ? code : "";
}

export function cleanName(input: unknown): string {
  const name = typeof input === "string" ? input.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH) : "";
  return name || "Player";
}

export function isTeam(value: unknown): value is Team {
  return value === "red" || value === "blue";
}

// ---- Snapshot deltas ----
// Snapshots are mostly the same from one to the next, so after a keyframe the server only
// sends what changed. The client rebuilds the exact server state from it (prediction
// replays from that state, so nothing may be rounded). WebSocket delivery is reliable and
// in order, so a delta always applies to the previous snapshot; if it doesn't (a missed
// keyframe, a reconnect), the client asks for a keyframe.
//
// The codec knows nothing about the game: it walks whatever the state contains, so new
// fields need no changes here.
// - An object's changes are a flat list [index, value, ...], where index is the key's
//   position in the previous object's keys. A negative index (-1 - i) means the value is
//   itself a delta of that nested object or array.
// - Arrays whose items all have a unique `id` (or `team`, for flags) are diffed by that
//   key: removed keys, added items, per-item changes, and the new order only if it isn't
//   the obvious one. Other arrays are sent whole when anything in them changed.
// - Keys holding `undefined` count as absent. An object whose keys changed is sent whole.

export const KEYFRAME_EVERY_SNAPSHOTS = 60; // a full state every 2 s anyway

export type StateDelta = unknown[];

interface ArrayDelta {
  k: string; // the id key
  r?: unknown[]; // ids removed
  a?: unknown[]; // items added, in order
  c?: unknown[]; // [id, change, ...]: change is a delta list, or the whole item
  o?: unknown[]; // the new order of ids, when it isn't "old order minus removed, then added"
}

type Obj = Record<string, unknown>;
const REPLACE = Symbol("replace");
const ID_KEYS = ["id", "team"];

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function keysOf(o: Obj): string[] {
  const keys: string[] = [];
  for (const k in o) if (o[k] !== undefined) keys.push(k);
  return keys;
}

function sameList(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = keysOf(a);
    return sameList(ka, keysOf(b)) && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

// A deep copy of plain data (objects, arrays, primitives).
export function cloneDeep<T>(v: T): T {
  if (Array.isArray(v)) return v.map(cloneDeep) as T;
  if (isObj(v)) {
    const out: Obj = {};
    for (const k in v) out[k] = cloneDeep(v[k]);
    return out as T;
  }
  return v;
}

// The key both arrays' items are identified by, or null if they can't be matched by one.
function idKey(a: readonly unknown[], b: readonly unknown[]): string | null {
  for (const key of ID_KEYS) {
    const seenA = new Set<unknown>();
    const seenB = new Set<unknown>();
    const ok = (list: readonly unknown[], seen: Set<unknown>) =>
      list.every((x) => {
        const id = isObj(x) ? x[key] : undefined;
        if ((typeof id !== "string" && typeof id !== "number") || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    if (ok(a, seenA) && ok(b, seenB)) return key;
  }
  return null;
}

// undefined = no change, REPLACE = send `b` whole, otherwise a delta.
function diffValue(a: unknown, b: unknown): unknown {
  if (Object.is(a, b)) return undefined;
  if (Array.isArray(a) && Array.isArray(b)) return diffArray(a, b);
  if (isObj(a) && isObj(b)) return diffObject(a, b);
  return REPLACE;
}

function diffObject(a: Obj, b: Obj): unknown[] | undefined | typeof REPLACE {
  const keys = keysOf(a);
  if (!sameList(keys, keysOf(b))) return REPLACE;
  let out: unknown[] | undefined;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    const d = diffValue(a[k], b[k]);
    if (d === undefined) continue;
    out ??= [];
    if (d === REPLACE) out.push(i, b[k]);
    else out.push(-1 - i, d);
  }
  return out;
}

function diffArray(a: unknown[], b: unknown[]): ArrayDelta | undefined | typeof REPLACE {
  if (a.length === 0 && b.length === 0) return undefined;
  const key = idKey(a, b);
  if (!key) return deepEqual(a, b) ? undefined : REPLACE;
  const old = new Map<unknown, Obj>();
  for (const x of a as Obj[]) old.set(x[key], x);
  const out: ArrayDelta = { k: key };
  const kept = new Set<unknown>();
  const added: Obj[] = [];
  const changes: unknown[] = [];
  for (const y of b as Obj[]) {
    const id = y[key];
    const x = old.get(id);
    if (!x) {
      added.push(y);
      continue;
    }
    kept.add(id);
    const d = diffObject(x, y);
    if (d === REPLACE) changes.push(id, y);
    else if (d) changes.push(id, d);
  }
  const removed = (a as Obj[]).filter((x) => !kept.has(x[key])).map((x) => x[key]);
  const expected = [...(a as Obj[]).filter((x) => kept.has(x[key])), ...added].map((x) => x[key]);
  const order = (b as Obj[]).map((y) => y[key]);
  if (removed.length) out.r = removed;
  if (added.length) out.a = added;
  if (changes.length) out.c = changes;
  if (!sameList(expected, order)) out.o = order;
  return removed.length || added.length || changes.length || out.o ? out : undefined;
}

function applyObject(base: Obj, delta: unknown[]): Obj {
  if (!Array.isArray(delta) || delta.length % 2 !== 0) throw new Error("bad object delta");
  const keys = keysOf(base);
  const out: Obj = { ...base }; // unchanged children are shared with `base`
  for (let j = 0; j < delta.length; j += 2) {
    const i = delta[j] as number;
    const key = keys[i >= 0 ? i : -1 - i];
    if (!Number.isInteger(i) || key === undefined) throw new Error("bad object delta index");
    out[key] = i >= 0 ? delta[j + 1] : applyNested(base[key], delta[j + 1]);
  }
  return out;
}

function applyNested(base: unknown, delta: unknown): unknown {
  if (Array.isArray(base)) return applyArray(base as Obj[], delta as ArrayDelta);
  if (isObj(base)) return applyObject(base, delta as unknown[]);
  throw new Error("delta for a value that isn't an object or array");
}

function applyArray(base: Obj[], delta: ArrayDelta): Obj[] {
  if (!isObj(delta) || typeof delta.k !== "string") throw new Error("bad array delta");
  const key = delta.k;
  const removed = new Set(delta.r ?? []);
  const changes = new Map<unknown, unknown>();
  const c = delta.c ?? [];
  for (let j = 0; j < c.length; j += 2) changes.set(c[j], c[j + 1]);
  const out: Obj[] = [];
  for (const x of base) {
    const id = x[key];
    if (removed.has(id)) continue;
    const change = changes.get(id);
    if (change === undefined) out.push(x);
    else out.push(Array.isArray(change) ? applyObject(x, change) : (change as Obj));
  }
  for (const y of delta.a ?? []) out.push(y as Obj);
  if (!delta.o) return out;
  const byId = new Map(out.map((x) => [x[key], x]));
  return delta.o.map((id) => {
    const x = byId.get(id);
    if (!x) throw new Error("bad array delta order");
    return x;
  });
}

// The changes from `base` to `next`. Both are left untouched.
export function diffState(base: SnapshotState, next: SnapshotState): StateDelta {
  const d = diffObject(base as unknown as Obj, next as unknown as Obj);
  if (d === REPLACE) throw new Error("snapshot state changed shape");
  return d ?? [];
}

// `base` with `delta` applied, as a new state. `base` is not changed, and parts that
// didn't change are shared with it, so treat decoded states as read-only.
export function applyStateDelta(base: SnapshotState, delta: StateDelta): SnapshotState {
  return applyObject(base as unknown as Obj, delta) as unknown as SnapshotState;
}

// Client side: turns SnapshotMessages back into Snapshots. `decode` returns null when a
// delta doesn't apply to what it has; then ask the server for a keyframe (MSG.keyframe).
export class SnapshotDecoder {
  private last: SnapshotState | null = null;
  keyframes = 0;
  deltas = 0;
  failures = 0;

  decode(msg: SnapshotMessage): Snapshot | null {
    let state: SnapshotState;
    if (msg.full) {
      state = msg.full;
      this.keyframes++;
    } else {
      if (!this.last || msg.base !== this.last.tick || !msg.delta) return this.fail();
      try {
        state = applyStateDelta(this.last, msg.delta);
      } catch {
        return this.fail();
      }
      this.deltas++;
    }
    this.last = state;
    return { state, events: msg.events, acks: msg.acks };
  }

  // Forget the base, e.g. after a reconnect; deltas fail until the next keyframe.
  reset(): void {
    this.last = null;
  }

  private fail(): null {
    this.failures++;
    this.last = null;
    return null;
  }
}
