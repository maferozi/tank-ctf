import {
  DEFAULT_HOLD_MS,
  DEFAULT_MAP,
  MSG,
  Predictor,
  TICK_MS,
  copyInto,
  type Bullet,
  type Flag,
  type GameEvent,
  type GameState,
  type InputFrame,
  type InputMessage,
  type Snapshot,
  type Tank,
} from "@tank/shared";
import { Blender } from "./blend";
import type { Driver } from "./driver";
import type { Session } from "@/net/session";

// Other players are drawn this far behind the newest snapshot so there is always a later
// one to blend towards. It adapts to how unevenly snapshots arrive: one snapshot interval
// and a bit, plus twice the recent lateness (95th percentile), within these bounds.
const INTERP_START_MS = 130;
const INTERP_BASE_MS = 66;
const INTERP_MIN_MS = 70;
const INTERP_MAX_MS = 200;
const JITTER_SAMPLES = 90; // the last 3 s of snapshots
const JITTER_EVERY = 10; // recompute the percentile every this many snapshots
// How fast the delay follows its target, in ms per ms. Growing slows others down for a
// moment (better than a hitch); shrinking speeds them up, so it is done gently.
const DELAY_GROW = 0.2;
const DELAY_SHRINK = 0.05;
const KEEP_SNAPSHOTS = 60;
const MAX_FRAME_MS = 250; // after a tab switch, don't try to catch up more than this
// Prediction errors are hidden by easing your soldier to the corrected spot over about
// this long. Bigger jumps (respawn, a hard shove) snap instead.
const CORRECTION_MS = 100;
const SNAP_DISTANCE = 48;
// Server events wait here until the next frame draws them. Frames stop in a hidden tab
// while snapshots keep coming, so keep only the newest few snapshots' worth: coming back
// must not replay a minute of shots and kills at once.
const MAX_SERVER_EVENTS = 64;
// After a server stall, snapshots arrive later than the clock offset expects for good, and
// the offset only creeps up slowly. If others go this many frames in a row with nothing
// newer to blend towards, re-baseline the offset to the best of the last OFFSET_SAMPLES.
const STARVED_FRAMES_RESET = 10;
const OFFSET_SAMPLES = 30; // the last second of snapshots
// Events your own prediction shows straight away (tankId = you); the server's copies are skipped.
// Longest a late snapshot is bridged by carrying others on along their last motion.
const EXTRAPOLATE_MS = 120;
const PREDICTED_EVENTS = new Set<GameEvent["type"]>(["fire", "drop", "dry", "crateBreak"]);

interface Timed {
  serverMs: number;
  state: GameState;
}

// Online. Your own soldier, your bullets, crates and power boxes come from local
// prediction (the shared sim run ahead with your own button), so your controls react on
// the next frame. Other players are interpolated from server snapshots.
// Cheap phones stutter on garbage collection, so per-frame work reuses its arrays and
// objects; what `frame` returns is only valid until the next call.
export function createOnlineDriver(session: Session): Driver {
  const { room } = session;
  const me = room.sessionId;
  const predictor = new Predictor(me, { holdMs: DEFAULT_HOLD_MS });
  const snaps: Timed[] = [];
  const serverEvents: GameEvent[] = [];
  let clockOffset: number | null = null; // local time - server sim time, best (lowest) seen
  let acc = 0;
  let last: number | null = null;
  // Visual offset between where your soldier was drawn and where the corrected prediction
  // says it is. It decays to zero, so corrections glide instead of jumping.
  const correction = { x: 0, y: 0 };

  // Adaptive smoothing delay: how late each snapshot arrived compared with the fastest.
  let delayMs = INTERP_START_MS;
  let targetDelayMs = INTERP_START_MS;
  const lateness = new Float64Array(JITTER_SAMPLES);
  const sorted = new Float64Array(JITTER_SAMPLES);
  let latenessCount = 0;
  let latenessNext = 0;
  let sinceJitter = 0;
  let jitterP95 = 0;
  const offsets = new Float64Array(OFFSET_SAMPLES);
  let offsetCount = 0;
  let offsetNext = 0;
  let starvedStreak = 0;

  // Reused every frame.
  const othersBlender = new Blender();
  const predictedBlender = new Blender();
  const display = {} as GameState;
  const tanks: Tank[] = [];
  const bullets: Bullet[] = [];
  const flags: Flag[] = [];
  let mineSlot: Tank | null = null;

  // Dev-only health numbers, readable as window.__net in the browser console.
  const stats = {
    frames: 0,
    starved: 0,
    ahead: 0,
    reconciles: 0,
    corrections: 0,
    maxCorrectionPx: 0,
    pending: 0,
    delayMs, // current smoothing delay for other players
    jitterP95Ms: 0, // recent snapshot lateness, 95th percentile
    keyframes: 0,
    deltas: 0,
    keyframeRequests: 0, // deltas that didn't apply (should stay 0)
    offsetResets: 0, // clock re-baselined after a run of starved frames
    extrapolated: 0, // frames where others were carried past the newest snapshot
    maxExtrapolationMs: 0,
    me: { x: 0, y: 0, spinDir: 1, driving: false, shown: false }, // as drawn
  };
  if (process.env.NODE_ENV !== "production") (window as unknown as { __net?: unknown }).__net = stats;

  // Names for the name tags: one Map, kept up to date with the roster.
  const names = new Map<string, string>();
  const updateNames = () => {
    names.clear();
    for (const p of session.roster?.players ?? []) names.set(p.id, p.name);
  };
  updateNames();
  const unsubscribeRoster = session.subscribe(updateNames);

  const unsubscribe = session.onSnapshot((snap: Snapshot) => {
    const serverMs = snap.state.tick * TICK_MS;
    // A new match restarts the server's clock: start over.
    if (snaps.length && serverMs <= snaps[snaps.length - 1]!.serverMs) {
      snaps.length = 0;
      clockOffset = null;
      offsetCount = 0;
    }
    const sample = performance.now() - serverMs;
    offsets[offsetNext] = sample;
    offsetNext = (offsetNext + 1) % OFFSET_SAMPLES;
    offsetCount = Math.min(offsetCount + 1, OFFSET_SAMPLES);
    // The fastest-arriving snapshot is closest to the true offset; creep up slowly so
    // clock drift or a route change can't leave us stuck.
    clockOffset = clockOffset === null ? sample : Math.min(sample, clockOffset + 0.5);
    recordLateness(sample - clockOffset);
    const state: GameState = { ...snap.state, events: [] };
    snaps.push({ serverMs, state });
    if (snaps.length > KEEP_SNAPSHOTS) snaps.shift();
    // Your own shots, drops and broken crates are already shown by prediction.
    if (typeof document !== "undefined" && document.hidden) serverEvents.length = 0; // nobody to show them to
    else for (const e of snap.events) if (!(e.tankId === me && PREDICTED_EVENTS.has(e.type))) serverEvents.push(e);
    if (serverEvents.length > MAX_SERVER_EVENTS) serverEvents.splice(0, serverEvents.length - MAX_SERVER_EVENTS);

    const before = findTank(predictor.state, me);
    const bx = before?.x ?? 0;
    const by = before?.y ?? 0;
    const wasAlive = before?.alive === true;
    predictor.reconcile(state, snap.acks[me] ?? 0);
    const after = findTank(predictor.state, me);
    stats.reconciles++;
    stats.pending = predictor.pendingCount;
    stats.keyframes = session.decoder.keyframes;
    stats.deltas = session.decoder.deltas;
    stats.keyframeRequests = session.decoder.failures;
    if (wasAlive && after && after.alive) {
      const dx = bx - after.x;
      const dy = by - after.y;
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

  function recordLateness(ms: number) {
    lateness[latenessNext] = ms;
    latenessNext = (latenessNext + 1) % JITTER_SAMPLES;
    latenessCount = Math.min(latenessCount + 1, JITTER_SAMPLES);
    if (++sinceJitter < JITTER_EVERY) return;
    sinceJitter = 0;
    const view = sorted.subarray(0, latenessCount);
    view.set(lateness.subarray(0, latenessCount));
    view.sort();
    jitterP95 = view[Math.min(latenessCount - 1, Math.floor(latenessCount * 0.95))]!;
    targetDelayMs = Math.min(INTERP_MAX_MS, Math.max(INTERP_MIN_MS, INTERP_BASE_MS + 2 * jitterP95));
    stats.jitterP95Ms = jitterP95;
  }

  // The best (lowest) offset among the last second of snapshots.
  function recentOffset(): number {
    let best = Infinity;
    for (let i = 0; i < offsetCount; i++) best = Math.min(best, offsets[i]!);
    return best;
  }

  return {
    map: DEFAULT_MAP,
    localId: me,
    names,
    speaking: session.voice.speaking,
    frame(now, button) {
      // Your button, one sample per sim tick, predicted locally and sent to the server.
      const dt = Math.min(now - (last ?? now), MAX_FRAME_MS);
      last = now;
      acc += dt;
      let frames: InputFrame[] | null = null;
      const events: GameEvent[] = [];
      while (acc >= TICK_MS) {
        const { frame, events: tickEvents } = predictor.tick(button.consume());
        (frames ??= []).push(frame);
        for (const e of tickEvents) if (e.tankId === me && PREDICTED_EVENTS.has(e.type)) events.push(e);
        acc -= TICK_MS;
      }
      if (frames) room.send(MSG.input, frames satisfies InputMessage);
      const decay = Math.exp(-dt / CORRECTION_MS);
      correction.x *= decay;
      correction.y *= decay;
      if (delayMs < targetDelayMs) delayMs = Math.min(targetDelayMs, delayMs + dt * DELAY_GROW);
      else if (delayMs > targetDelayMs) delayMs = Math.max(targetDelayMs, delayMs - dt * DELAY_SHRINK);
      stats.delayMs = delayMs;

      if (clockOffset === null || snaps.length === 0 || !predictor.state || !predictor.prev) return null;

      // Starved for a while (the server fell behind real time): jump the offset to what
      // recent snapshots say instead of creeping 15 ms/s. Lateness measured against the old
      // offset was inflated, so start that over too.
      if (starvedStreak >= STARVED_FRAMES_RESET) {
        const best = recentOffset();
        if (best > clockOffset + 1) {
          clockOffset = best;
          latenessCount = latenessNext = 0;
          stats.offsetResets++;
        }
      }

      // Everyone else: interpolated from snapshots, delayMs in the past.
      const t = now - clockOffset - delayMs;
      let next = -1;
      for (let i = 0; i < snaps.length; i++) {
        if (snaps[i]!.serverMs > t) {
          next = i;
          break;
        }
      }
      stats.frames++;
      if (next === -1) stats.starved++; // nothing newer to blend towards: others would hitch
      starvedStreak = next === -1 ? starvedStreak + 1 : 0;
      stats.ahead = next === -1 ? 0 : snaps.length - next;
      let others: GameState;
      if (next === -1 && snaps.length >= 2) {
        // The newest snapshot is late: carry others on along their last motion for a short
        // while instead of freezing them, then hold. The next snapshot takes over from there.
        const a = snaps[snaps.length - 2]!;
        const b = snaps[snaps.length - 1]!;
        const over = Math.min(t - b.serverMs, EXTRAPOLATE_MS);
        if (over > 0 && b.serverMs > a.serverMs) {
          stats.extrapolated++;
          stats.maxExtrapolationMs = Math.max(stats.maxExtrapolationMs, over);
        }
        others = othersBlender.blend(a.state, b.state, 1 + Math.max(0, over) / Math.max(1, b.serverMs - a.serverMs), true);
      } else if (next === -1) others = snaps[snaps.length - 1]!.state;
      else if (next === 0) others = snaps[0]!.state;
      else {
        const a = snaps[next - 1]!;
        const b = snaps[next]!;
        others = othersBlender.blend(a.state, b.state, (t - a.serverMs) / (b.serverMs - a.serverMs));
      }

      // Round over (banner up) or the two timelines on different rounds: draw only what the
      // server sent. Prediction runs ahead and resets the round by itself, so mixing the two
      // here showed the next round's map and spawn under the old banner for a round trip,
      // then flicked back (the "flicker" at every round or match restart). Nothing moves
      // under the banner, so nothing is lost by not predicting.
      if (others.winner !== null || predictor.state.mapId !== others.mapId || predictor.state.match.round !== others.match.round) {
        correction.x = correction.y = 0;
        for (const e of serverEvents) events.push(e);
        serverEvents.length = 0;
        return { prev: others, curr: others, alpha: 1, events };
      }

      // You: the predicted present, between the last two predicted ticks.
      const predicted = predictedBlender.blend(predictor.prev, predictor.state, acc / TICK_MS);
      const predictedMe = findTank(predicted, me);
      let mine: Tank | null = null;
      if (predictedMe) {
        mine = mineSlot = copyInto(mineSlot, predictedMe);
        mine.x += correction.x;
        mine.y += correction.y;
      }
      stats.me.shown = mine !== null;
      if (mine) {
        stats.me.x = mine.x;
        stats.me.y = mine.y;
        stats.me.spinDir = mine.spinDir;
        stats.me.driving = mine.driving;
      }

      tanks.length = 0;
      for (const x of others.tanks) if (x.id !== me) tanks.push(x);
      if (mine) tanks.push(mine);
      bullets.length = 0;
      for (const b of others.bullets) if (b.owner !== me) bullets.push(b);
      for (const b of predicted.bullets) if (b.owner === me) bullets.push(b);
      // A flag you carry (or just grabbed) follows your predicted soldier; other flags
      // follow the server, like the players carrying them.
      flags.length = 0;
      for (const f of others.flags) {
        let mineToo: Flag | undefined;
        for (const p of predicted.flags) if (p.team === f.team) mineToo = p;
        flags.push(mineToo && (mineToo.carrier === me || f.carrier === me) ? mineToo : f);
      }
      Object.assign(display, predicted);
      display.tanks = tanks;
      display.bullets = bullets;
      display.flags = flags;
      // Only the server decides who won, so a mispredicted capture never shows a banner.
      display.winner = others.winner;
      display.overMs = others.overMs;
      display.match = others.match;

      for (const e of serverEvents) events.push(e);
      serverEvents.length = 0;
      return { prev: display, curr: display, alpha: 1, events };
    },
    dispose() {
      unsubscribe();
      unsubscribeRoster();
    },
  };
}

function findTank(state: GameState | null, id: string): Tank | undefined {
  if (state) for (const t of state.tanks) if (t.id === id) return t;
  return undefined;
}
