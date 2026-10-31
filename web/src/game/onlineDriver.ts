import {
  DEFAULT_HOLD_MS,
  DEFAULT_MAP,
  MSG,
  Predictor,
  TICK_MS,
  type GameEvent,
  type GameState,
  type InputFrame,
  type InputMessage,
  type Snapshot,
} from "@tank/shared";
import { blendStates } from "./blend";
import type { Driver } from "./driver";
import type { Session } from "@/net/session";

// Other players are drawn this far behind the newest snapshot so there is always a later
// one to blend towards (snapshots come every ~33 ms; this rides out network jitter).
const INTERP_DELAY_MS = 100;
const KEEP_SNAPSHOTS = 60;
const MAX_FRAME_MS = 250; // after a tab switch, don't try to catch up more than this
// Prediction errors are hidden by easing your soldier to the corrected spot over about
// this long. Bigger jumps (respawn, a hard shove) snap instead.
const CORRECTION_MS = 100;
const SNAP_DISTANCE = 48;

interface Timed {
  serverMs: number;
  state: GameState;
}

// Online. Your own soldier, your bullets, crates and power boxes come from local
// prediction (the shared sim run ahead with your own button), so your controls react on
// the next frame. Other players are interpolated from server snapshots.
export function createOnlineDriver(session: Session): Driver {
  const { room } = session;
  const me = room.sessionId;
  const predictor = new Predictor(DEFAULT_MAP, me, { holdMs: DEFAULT_HOLD_MS });
  const snaps: Timed[] = [];
  let serverEvents: GameEvent[] = [];
  let clockOffset: number | null = null; // local time - server sim time, best (lowest) seen
  let acc = 0;
  let last: number | null = null;
  // Visual offset between where your soldier was drawn and where the corrected prediction
  // says it is. It decays to zero, so corrections glide instead of jumping.
  const correction = { x: 0, y: 0 };

  // Dev-only health numbers, readable as window.__net in the browser console.
  const stats = {
    frames: 0,
    starved: 0,
    ahead: 0,
    reconciles: 0,
    corrections: 0,
    maxCorrectionPx: 0,
    pending: 0,
    me: null as { x: number; y: number; spinDir: number; driving: boolean } | null, // as drawn
  };
  if (process.env.NODE_ENV !== "production") (window as unknown as { __net?: unknown }).__net = stats;

  const unsubscribe = room.onMessage(MSG.snapshot, (snap: Snapshot) => {
    const serverMs = snap.state.tick * TICK_MS;
    const sample = performance.now() - serverMs;
    // The fastest-arriving snapshot is closest to the true offset; creep up slowly so
    // clock drift or a route change can't leave us stuck.
    clockOffset = clockOffset === null ? sample : Math.min(sample, clockOffset + 0.5);
    const state: GameState = { ...snap.state, events: [] };
    snaps.push({ serverMs, state });
    if (snaps.length > KEEP_SNAPSHOTS) snaps.shift();
    // Your own shots and drops are already shown by prediction.
    serverEvents.push(...snap.events.filter((e) => !(e.tankId === me && (e.type === "fire" || e.type === "drop"))));

    const before = predictor.state?.tanks.find((t) => t.id === me);
    predictor.reconcile(state, snap.acks[me] ?? 0);
    const after = predictor.state?.tanks.find((t) => t.id === me);
    stats.reconciles++;
    stats.pending = predictor.pendingCount;
    if (before && after && before.alive && after.alive) {
      const dx = before.x - after.x;
      const dy = before.y - after.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 0.01) {
        stats.corrections++;
        stats.maxCorrectionPx = Math.max(stats.maxCorrectionPx, dist);
      }
      if (dist < SNAP_DISTANCE) {
        correction.x += dx;
        correction.y += dy;
      } else {
        correction.x = correction.y = 0;
      }
    } else {
      correction.x = correction.y = 0;
    }
  });

  return {
    map: DEFAULT_MAP,
    localId: me,
    get names() {
      return new Map(session.roster.map((p) => [p.id, p.name]));
    },
    frame(now, button) {
      // Your button, one sample per sim tick, predicted locally and sent to the server.
      const dt = Math.min(now - (last ?? now), MAX_FRAME_MS);
      last = now;
      acc += dt;
      const frames: InputFrame[] = [];
      const events: GameEvent[] = [];
      while (acc >= TICK_MS) {
        const { frame, events: tickEvents } = predictor.tick(button.consume());
        frames.push(frame);
        events.push(...tickEvents.filter((e) => e.tankId === me && (e.type === "fire" || e.type === "drop")));
        acc -= TICK_MS;
      }
      if (frames.length) room.send(MSG.input, frames satisfies InputMessage);
      const decay = Math.exp(-dt / CORRECTION_MS);
      correction.x *= decay;
      correction.y *= decay;

      if (clockOffset === null || snaps.length === 0 || !predictor.state || !predictor.prev) return null;

      // Everyone else: interpolated from snapshots, INTERP_DELAY_MS in the past.
      const t = now - clockOffset - INTERP_DELAY_MS;
      const next = snaps.findIndex((s) => s.serverMs > t);
      stats.frames++;
      if (next === -1) stats.starved++; // nothing newer to blend towards: others would hitch
      stats.ahead = next === -1 ? 0 : snaps.length - next;
      let others: GameState;
      if (next === -1) others = snaps[snaps.length - 1]!.state;
      else if (next === 0) others = snaps[0]!.state;
      else {
        const a = snaps[next - 1]!;
        const b = snaps[next]!;
        others = blendStates(a.state, b.state, (t - a.serverMs) / (b.serverMs - a.serverMs));
      }

      // You: the predicted present, between the last two predicted ticks.
      const predicted = blendStates(predictor.prev, predictor.state, acc / TICK_MS);
      let mine = predicted.tanks.find((x) => x.id === me);
      if (mine) mine = { ...mine, x: mine.x + correction.x, y: mine.y + correction.y };
      stats.me = mine ? { x: mine.x, y: mine.y, spinDir: mine.spinDir, driving: mine.driving } : null;

      const tanks = others.tanks.filter((x) => x.id !== me);
      if (mine) tanks.push(mine);
      const display: GameState = {
        ...predicted,
        tanks,
        bullets: [...others.bullets.filter((b) => b.owner !== me), ...predicted.bullets.filter((b) => b.owner === me)],
        // A flag you carry (or just grabbed) follows your predicted soldier; other flags
        // follow the server, like the players carrying them.
        flags: others.flags.map((f) => {
          const mineToo = predicted.flags.find((p) => p.team === f.team);
          return mineToo && (mineToo.carrier === me || f.carrier === me) ? mineToo : f;
        }),
        // Only the server decides who won, so a mispredicted capture never shows a banner.
        winner: others.winner,
        overMs: others.overMs,
        match: others.match,
      };

      const allEvents = [...events, ...serverEvents];
      serverEvents = [];
      return { prev: display, curr: display, alpha: 1, events: allEvents };
    },
    dispose() {
      unsubscribe();
    },
  };
}
