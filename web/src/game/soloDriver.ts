import {
  DEFAULT_HOLD_MS,
  DEFAULT_MAP,
  TICK_MS,
  addTank,
  cloneState,
  createState,
  getMap,
  step,
  type GameEvent,
} from "@tank/shared";
import type { Driver } from "./driver";

const MAX_FRAME_MS = 250; // avoid a spiral of catch-up ticks after a tab switch

// Solo practice: runs the sim in the browser against spinning blue targets, on any map.
export function createSoloDriver(targets: number, mapId = DEFAULT_MAP.id): Driver {
  const map = getMap(mapId);
  const localId = "you";
  const state = createState(map);
  addTank(state, map, localId, "red");
  for (let i = 0; i < targets; i++) addTank(state, map, `target-${i}`, "blue");
  // Dev-only hook so the sim can be inspected from the browser console.
  if (process.env.NODE_ENV !== "production") (window as unknown as { __tank?: unknown }).__tank = state;

  let prev = cloneState(state);
  let acc = 0;
  let last: number | null = null;

  return {
    map,
    localId,
    names: new Map(),
    frame(now, button) {
      acc += Math.min(now - (last ?? now), MAX_FRAME_MS);
      last = now;
      const events: GameEvent[] = [];
      while (acc >= TICK_MS) {
        prev = cloneState(state);
        step(state, getMap(state.mapId), { [localId]: button.consume() }, { holdMs: DEFAULT_HOLD_MS });
        events.push(...state.events);
        acc -= TICK_MS;
      }
      return { prev, curr: state, alpha: acc / TICK_MS, events };
    },
    dispose() {},
  };
}
