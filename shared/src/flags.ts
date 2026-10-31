import { BASE_RADIUS, FLAG_RADIUS, FLAG_RETURN_MS, TANK_RADIUS, TICK_MS } from "./constants";
import type { GameMap, Team } from "./map";
import { winRound } from "./match";
import type { GameState, Tank } from "./sim";

// Capture the flag. Each team's flag stands at its home. An enemy who touches it carries
// it; if the carrier is shot the flag drops where they fell. A teammate who touches their
// own dropped flag sends it home, and a flag left lying returns by itself after
// FLAG_RETURN_MS. A carrier who reaches their own team's base wins the round: the team's
// scoring pad on maps that have one, otherwise the team's flag stand.

export interface Flag {
  team: Team; // whose flag it is
  x: number;
  y: number;
  homeX: number;
  homeY: number;
  baseX: number; // where this team scores (its pad, or its flag stand)
  baseY: number;
  carrier: string | null; // tank id
  atHome: boolean;
  returnMs: number; // while dropped: time until it goes home by itself
}

export function createFlags(map: GameMap): Flag[] {
  return (["red", "blue"] as const).flatMap((team) => {
    const stand = map.flags[team];
    if (!stand) return [];
    const base = map.bases[team] ?? stand;
    return [
      {
        team,
        x: stand.x,
        y: stand.y,
        homeX: stand.x,
        homeY: stand.y,
        baseX: base.x,
        baseY: base.y,
        carrier: null,
        atHome: true,
        returnMs: 0,
      },
    ];
  });
}

export function isCarrying(state: GameState, tankId: string): boolean {
  return state.flags.some((f) => f.carrier === tankId);
}

// Called when a soldier dies or leaves: whatever flag they carry falls where they were.
export function dropFlagOf(state: GameState, tank: Tank): void {
  for (const flag of state.flags) {
    if (flag.carrier !== tank.id) continue;
    flag.carrier = null;
    flag.x = tank.x;
    flag.y = tank.y;
    flag.returnMs = FLAG_RETURN_MS;
    state.events.push({ type: "flag", action: "dropped", team: flag.team, tankId: tank.id, x: flag.x, y: flag.y });
  }
}

function sendHome(state: GameState, flag: Flag, byTankId: string): void {
  flag.carrier = null;
  flag.x = flag.homeX;
  flag.y = flag.homeY;
  flag.atHome = true;
  flag.returnMs = 0;
  state.events.push({ type: "flag", action: "returned", team: flag.team, tankId: byTankId, x: flag.x, y: flag.y });
}

// Once per tick, after everyone has moved and bullets have hit.
export function tickFlags(state: GameState): void {
  const touchR = TANK_RADIUS + FLAG_RADIUS;
  for (const flag of state.flags) {
    if (flag.carrier) {
      const carrier = state.tanks.find((t) => t.id === flag.carrier);
      if (!carrier || !carrier.alive) {
        // Left the game (deaths drop the flag in the bullet code already).
        flag.carrier = null;
        flag.returnMs = FLAG_RETURN_MS;
        continue;
      }
      flag.x = carrier.x;
      flag.y = carrier.y;
      const base = state.flags.find((f) => f.team === carrier.team);
      if (base && (carrier.x - base.baseX) ** 2 + (carrier.y - base.baseY) ** 2 <= BASE_RADIUS * BASE_RADIUS) {
        winRound(state, carrier.team);
        state.events.push({ type: "capture", team: carrier.team, tankId: carrier.id, x: carrier.x, y: carrier.y });
        return;
      }
      continue;
    }

    if (!flag.atHome) {
      flag.returnMs -= TICK_MS;
      if (flag.returnMs <= 0) {
        sendHome(state, flag, "");
        continue;
      }
    }
    const toucher = state.tanks.find(
      (t) => t.alive && (t.x - flag.x) ** 2 + (t.y - flag.y) ** 2 <= touchR * touchR && (t.team !== flag.team || !flag.atHome),
    );
    if (!toucher) continue;
    if (toucher.team !== flag.team) {
      flag.carrier = toucher.id;
      flag.atHome = false;
      flag.x = toucher.x;
      flag.y = toucher.y;
      state.events.push({ type: "flag", action: "taken", team: flag.team, tankId: toucher.id, x: flag.x, y: flag.y });
    } else {
      sendHome(state, flag, toucher.id);
    }
  }
}
