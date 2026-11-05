import type { GameEvent, GameState } from "@tank/shared";
import { POWER_STYLE, type Effect } from "./render";

// Turns the sim's events into short-lived visual effects (muzzle flashes, kill bursts,
// crate splinters, shield sparks, floating labels). Bullets bursting into bits when they
// end is drawn by render.ts itself, so "drop" needs nothing here. Effects for events before
// a "round" event are left out: the new round starts with a clean map (the caller also
// drops older effects, see `startsRound`). Effects copy numbers only, never state objects,
// because the online driver reuses its state objects every frame.
export function effectsForEvents(events: GameEvent[], state: GameState, nowMs: number): Effect[] {
  let effects: Effect[] = [];
  for (const e of events) {
    let tank = null;
    for (const t of state.tanks) if (t.id === e.tankId) tank = t;
    const team = tank?.team ?? "red";
    const base = { x: e.x, y: e.y, bornMs: nowMs, team };
    switch (e.type) {
      case "fire":
        // The flash points from the shooter out through the muzzle (flare bursts go 4 ways).
        effects.push({ ...base, kind: "flash", angle: tank ? Math.atan2(e.y - tank.y, e.x - tank.x) : 0 });
        break;
      case "crateBreak":
        effects.push({ ...base, kind: "splinters" });
        break;
      case "kill":
        effects.push({ ...base, kind: "boom" });
        break;
      case "shieldHit":
        effects.push({ ...base, kind: "spark", color: POWER_STYLE.shield.color });
        break;
      case "shieldBreak":
        // Centred on the soldier, where the bubble was.
        effects.push({ ...base, x: tank?.x ?? e.x, y: tank?.y ?? e.y, kind: "shatter" });
        break;
      case "power": {
        const style = POWER_STYLE[e.kind];
        effects.push({ ...base, kind: "ring", color: style.color });
        effects.push({ ...base, kind: "text", label: style.label, color: style.color });
        break;
      }
      case "flag": {
        const label = { taken: "FLAG TAKEN", dropped: "FLAG DROPPED", returned: "FLAG RETURNED" }[e.action];
        effects.push({ ...base, kind: "text", label, color: e.team === "red" ? "#ff6b6b" : "#5fb4ff" });
        break;
      }
      case "round":
        effects = [];
        break;
    }
  }
  return effects;
}

// True when these events start a new round, so effects still on screen should go.
export function startsRound(events: readonly GameEvent[]): boolean {
  for (const e of events) if (e.type === "round") return true;
  return false;
}
