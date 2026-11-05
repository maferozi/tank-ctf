import type { GameEvent, GameMap, GameState } from "@tank/shared";
import type { OneButton } from "./input";

// What the game screen draws each animation frame: two states to blend between.
export interface Frame {
  prev: GameState;
  curr: GameState;
  alpha: number; // 0..1 from prev to curr
  events: GameEvent[]; // new since the last frame, for effects
}

// Where frames come from: the local sim (solo practice) or the server (online).
export interface Driver {
  map: GameMap;
  localId: string;
  names: ReadonlyMap<string, string>; // soldier id -> player name, for name tags
  speaking?: ReadonlySet<string>; // voice chat: who is talking (online only; read, never copied)
  // Reads the button and returns what to draw, or null while there is nothing yet.
  frame(nowMs: number, button: OneButton): Frame | null;
  dispose(): void;
}
