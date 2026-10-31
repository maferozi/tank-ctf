import type { Team } from "./map";
import type { MatchRounds } from "./match";
import type { InputFrame } from "./prediction";
import type { GameEvent, GameState } from "./sim";

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
} as const;

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

export interface Snapshot {
  state: Omit<GameState, "events">;
  events: GameEvent[]; // everything that happened since the previous snapshot
  acks: Record<string, number>; // per player: seq of the last input sample applied
}

export interface Player {
  id: string; // Colyseus sessionId, also the tank id
  name: string;
  team: Team;
}

export interface Roster {
  players: Player[];
}

// GET {server}/rooms/CODE: who is in a room, so the join form can show the teams before
// joining. 404 if there is no such room.
export interface RoomInfo {
  code: string;
  players: Player[];
  maxPlayers: number;
  rounds: MatchRounds;
  maps: string[]; // map id per round
}

// What a room publishes in its listing metadata (read by GET /rooms/CODE).
export interface RoomMetadata extends Roster {
  rounds: MatchRounds;
  maps: string[];
}

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
