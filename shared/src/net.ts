import type { Team } from "./map";
import type { GameEvent, GameState, TankInput } from "./sim";

// Messages between the web client and the game server.

export const ROOM_NAME = "game";
export const MAX_PLAYERS = 8;
export const SNAPSHOT_EVERY_TICKS = 2; // 60 Hz sim, 30 Hz snapshots
export const MAX_NAME_LENGTH = 16;

export const MSG = {
  input: "input", // client -> server: TankInput, sent when the button changes
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

export type InputMessage = TankInput;

export interface Snapshot {
  state: Omit<GameState, "events">;
  events: GameEvent[]; // everything that happened since the previous snapshot
}

export interface Player {
  id: string; // Colyseus sessionId, also the tank id
  name: string;
  team: Team;
}

export interface Roster {
  players: Player[];
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
