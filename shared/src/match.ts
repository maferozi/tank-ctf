import { MATCH_RESTART_MS, ROUND_POINTS, ROUND_RESTART_MS } from "./constants";
import type { Team } from "./map";
import { MAPS, isMapId } from "./maps";
import type { GameState } from "./sim";

// Match types, picked when a room is created:
// - single match: one round, the first capture wins.
// - tournament: 5 or 7 rounds. Each round won is worth ROUND_POINTS; every round is played,
//   and after the last one the team with the most points is the champion. With an odd
//   number of rounds and a winner every round, there is always exactly one champion.
export const MATCH_ROUND_OPTIONS = [1, 5, 7] as const;
export type MatchRounds = (typeof MATCH_ROUND_OPTIONS)[number];

export interface Match {
  rounds: MatchRounds;
  maps: string[]; // map id for each round, picked by the room creator
  round: number; // 1-based, the round being played
  scores: Record<Team, number>;
  champion: Team | null; // set when the last round is won
}

export function createMatch(rounds: MatchRounds = 1, maps?: readonly unknown[]): Match {
  return { rounds, maps: roundMaps(rounds, maps), round: 1, scores: { red: 0, blue: 0 }, champion: null };
}

// One valid map per round. Anything missing or unknown is filled by cycling through all
// maps, so a bad or partial pick never breaks a room.
export function roundMaps(rounds: number, maps?: readonly unknown[]): string[] {
  return Array.from({ length: rounds }, (_, i) => {
    const pick = maps?.[i];
    return isMapId(pick) ? pick : MAPS[i % MAPS.length]!.id;
  });
}

export function isMatchRounds(value: unknown): value is MatchRounds {
  return MATCH_ROUND_OPTIONS.includes(value as MatchRounds);
}

export function isTournament(match: Match): boolean {
  return match.rounds > 1;
}

// A capture: the round goes to `team`. On the last round, the match is decided.
export function winRound(state: GameState, team: Team): void {
  const match = state.match;
  state.winner = team;
  match.scores[team] += ROUND_POINTS;
  if (match.round >= match.rounds) {
    match.champion = match.scores.red > match.scores.blue ? "red" : match.scores.blue > match.scores.red ? "blue" : null;
    state.overMs = MATCH_RESTART_MS;
  } else {
    state.overMs = ROUND_RESTART_MS;
  }
}

// When the banner is done: the next round, or a fresh match after the last one.
export function advanceMatch(state: GameState): void {
  const match = state.match;
  if (match.round >= match.rounds) state.match = createMatch(match.rounds, match.maps);
  else match.round++;
}
