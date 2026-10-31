import { DEFAULT_MAP, MSG, TICK_MS, type GameEvent, type GameState, type Snapshot } from "@tank/shared";
import type { Driver } from "./driver";
import type { Session } from "@/net/session";

// Draw this far behind the newest snapshot so there is always a later one to blend
// towards (snapshots come every ~33 ms; this rides out a little network jitter).
const INTERP_DELAY_MS = 100;
const KEEP_SNAPSHOTS = 60;

interface Timed {
  serverMs: number;
  state: GameState;
}

// Online: sends button changes to the server and plays back its snapshots.
// No prediction yet, so your own soldier also shows the server's view (~100 ms + ping).
export function createOnlineDriver(session: Session): Driver {
  const { room } = session;
  const snaps: Timed[] = [];
  let pendingEvents: GameEvent[] = [];
  let clockOffset: number | null = null; // local time - server sim time, best (lowest) seen
  let sentHeld = false;

  const unsubscribe = room.onMessage(MSG.snapshot, (snap: Snapshot) => {
    const serverMs = snap.state.tick * TICK_MS;
    const sample = performance.now() - serverMs;
    // The fastest-arriving snapshot is closest to the true offset; creep up slowly so
    // clock drift or a route change can't leave us stuck.
    clockOffset = clockOffset === null ? sample : Math.min(sample, clockOffset + 0.5);
    snaps.push({ serverMs, state: { ...snap.state, events: [] } });
    if (snaps.length > KEEP_SNAPSHOTS) snaps.shift();
    pendingEvents.push(...snap.events);
  });

  return {
    map: DEFAULT_MAP,
    localId: room.sessionId,
    get names() {
      return new Map(session.roster.map((p) => [p.id, p.name]));
    },
    frame(now, button) {
      const input = button.consume();
      if (input.pressed || input.held !== sentHeld) {
        room.send(MSG.input, input);
        sentHeld = input.held;
      }
      if (clockOffset === null || snaps.length === 0) return null;

      const t = now - clockOffset - INTERP_DELAY_MS;
      const next = snaps.findIndex((s) => s.serverMs > t);
      let prev: Timed;
      let curr: Timed;
      let alpha: number;
      if (next === -1) {
        // Ran past the newest snapshot (late packet): hold the latest state.
        prev = curr = snaps[snaps.length - 1]!;
        alpha = 1;
      } else if (next === 0) {
        prev = curr = snaps[0]!;
        alpha = 0;
      } else {
        prev = snaps[next - 1]!;
        curr = snaps[next]!;
        alpha = (t - prev.serverMs) / (curr.serverMs - prev.serverMs);
      }
      const events = pendingEvents;
      pendingEvents = [];
      return { prev: prev.state, curr: curr.state, alpha, events };
    },
    dispose() {
      unsubscribe();
    },
  };
}
