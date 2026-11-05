// Multiplayer load test against a running server: `npm run loadtest -w server`.
// PLAYERS bots join one room and tap / walk at random for SECONDS, then it reports
// snapshot rate and jitter, server tick rate, press-to-shot latency, message size (deltas,
// keyframes, and what full snapshots would cost), and whether all players saw the same game.
// Bots also ask for a keyframe now and then, so the comparison checks states rebuilt from
// deltas against keyframes, field for field.
//
// Env: SERVER_URL (default ws://localhost:2567), PLAYERS (8), SECONDS (20).
import { Client, type Room } from "@colyseus/sdk";
import { MAX_PLAYERS, MSG, ROOM_NAME, SnapshotDecoder, TICK_MS, type Snapshot, type SnapshotMessage } from "@tank/shared";
import { pack } from "msgpackr";
import { BotButton } from "./botButton";

const url = process.env.SERVER_URL ?? "ws://localhost:2567";
const PLAYERS = Number(process.env.PLAYERS ?? 8);
const SECONDS = Number(process.env.SECONDS ?? 20);
const PRESS_TIMEOUT_MS = 1000;
const KEYFRAME_REQUEST_MS = [800, 2500]; // each bot asks for a keyframe this often

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (min: number, max: number) => min + Math.random() * (max - min);

interface BotStats {
  intervals: number[]; // ms between snapshot arrivals
  pressLatencies: number[]; // ms from sending a tap to seeing its shot in a snapshot
  pressTimeouts: number;
  firstTick?: { tick: number; at: number };
  lastTick?: { tick: number; at: number };
  deltaBytes: number[]; // msgpack size of each message as sent
  keyBytes: number[];
  fullBytes: number[]; // what a full snapshot would have been (sampled)
  decodeFailures: number;
  tickHashes: Map<number, string>; // for comparing what different players saw
}

class Bot {
  stats: BotStats = {
    intervals: [],
    pressLatencies: [],
    pressTimeouts: 0,
    deltaBytes: [],
    keyBytes: [],
    fullBytes: [],
    decodeFailures: 0,
    tickHashes: new Map(),
  };
  private decoder = new SnapshotDecoder();
  private nextKeyRequest = performance.now() + rand(KEYFRAME_REQUEST_MS[0]!, KEYFRAME_REQUEST_MS[1]!);
  private lastArrival = 0;
  private pendingPressAt: number | null = null;
  private ammo = 6;
  private holdingUntil = 0;
  private nextActionAt = performance.now() + rand(200, 800);
  private button: BotButton;

  constructor(public room: Room) {
    this.button = new BotButton(room);
    room.onMessage(MSG.roster, () => {});
    room.onMessage(MSG.voiceConfig, () => {});
    room.onMessage(MSG.snapshot, (msg: SnapshotMessage) => this.onMessage(msg));
  }

  private onMessage(msg: SnapshotMessage) {
    (msg.full ? this.stats.keyBytes : this.stats.deltaBytes).push(pack(msg).length);
    const snap = this.decoder.decode(msg);
    if (!snap) {
      this.stats.decodeFailures++;
      this.room.send(MSG.keyframe);
      return;
    }
    this.onSnapshot(snap);
  }

  private onSnapshot(snap: Snapshot) {
    const now = performance.now();
    if (this.lastArrival) this.stats.intervals.push(now - this.lastArrival);
    this.lastArrival = now;
    const mark = { tick: snap.state.tick, at: now };
    this.stats.firstTick ??= mark;
    this.stats.lastTick = mark;
    if (snap.state.tick % 30 === 0) this.stats.fullBytes.push(pack({ full: snap.state, events: snap.events, acks: snap.acks }).length);
    this.stats.tickHashes.set(snap.state.tick, JSON.stringify(snap.state));
    const me = snap.state.tanks.find((t) => t.id === this.room.sessionId);
    if (me) this.ammo = me.ammo;
    if (this.pendingPressAt !== null) {
      if (snap.events.some((e) => e.type === "fire" && e.tankId === this.room.sessionId)) {
        this.stats.pressLatencies.push(now - this.pendingPressAt);
        this.pendingPressAt = null;
      } else if (now - this.pendingPressAt > PRESS_TIMEOUT_MS) {
        this.stats.pressTimeouts++;
        this.pendingPressAt = null;
      }
    }
  }

  // Random play: short taps (measured) and walks of 0.2-0.9 s.
  act(now: number) {
    if (now >= this.nextKeyRequest) {
      this.room.send(MSG.keyframe);
      this.nextKeyRequest = now + rand(KEYFRAME_REQUEST_MS[0]!, KEYFRAME_REQUEST_MS[1]!);
    }
    this.decide(now);
    this.button.flush(now);
  }

  private decide(now: number) {
    if (this.holdingUntil) {
      if (now >= this.holdingUntil) {
        this.button.hold(false);
        this.holdingUntil = 0;
        this.nextActionAt = now + rand(250, 800);
      }
      return;
    }
    if (now < this.nextActionAt) return;
    if (Math.random() < 0.5 && this.ammo > 0 && this.pendingPressAt === null) {
      this.button.tap();
      this.pendingPressAt = now;
      this.nextActionAt = now + rand(250, 800);
    } else {
      this.button.hold(true);
      this.holdingUntil = now + rand(200, 900);
    }
  }
}

function pct(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}
const f = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : "-");

const first = await new Client(url).create(ROOM_NAME, { name: "Bot1", team: "red" });
const bots = [new Bot(first)];
for (let i = 2; i <= PLAYERS; i++) {
  const room = await new Client(url).joinById(first.roomId, { name: `Bot${i}`, team: i % 2 ? "red" : "blue" });
  bots.push(new Bot(room));
}
// Rooms start in the lobby; the first bot is the host and starts the match.
first.send(MSG.start);
await sleep(300);
console.log(`room ${first.roomId}: ${bots.length} bots joined, playing for ${SECONDS} s against ${url}`);

// With a full room, one more player must be turned away.
const roomFull = bots.length >= MAX_PLAYERS;
let extraRejected = false;
if (roomFull) {
  try {
    const extra = await new Client(url).joinById(first.roomId, { name: "Extra", team: "red" });
    extra.onMessage(MSG.roster, () => {});
    extra.onMessage(MSG.voiceConfig, () => {});
    extra.onMessage(MSG.snapshot, () => {});
    await extra.leave();
  } catch {
    extraRejected = true;
  }
}

const end = performance.now() + SECONDS * 1000;
while (performance.now() < end) {
  const now = performance.now();
  for (const bot of bots) bot.act(now);
  await sleep(20);
}
await Promise.all(bots.map((b) => b.room.leave()));

// Report
const all = (pick: (s: BotStats) => number[]) => bots.flatMap((b) => pick(b.stats));
const intervals = all((s) => s.intervals);
const latencies = all((s) => s.pressLatencies);
const deltaBytes = all((s) => s.deltaBytes);
const keyBytes = all((s) => s.keyBytes);
const fullBytes = all((s) => s.fullBytes);
const decodeFailures = bots.reduce((n, b) => n + b.stats.decodeFailures, 0);
const tickRates = bots.map((b) => {
  const { firstTick: a, lastTick: z } = b.stats;
  return a && z ? ((z.tick - a.tick) * 1000) / (z.at - a.at) : NaN;
});
const snapRates = bots.map((b) => (b.stats.intervals.length * 1000) / (SECONDS * 1000));
const timeouts = bots.reduce((n, b) => n + b.stats.pressTimeouts, 0);

// Every player should see exactly the same state for each tick.
let compared = 0;
let mismatched = 0;
const reference = bots[0]!.stats.tickHashes;
for (const bot of bots.slice(1)) {
  for (const [tick, hash] of bot.stats.tickHashes) {
    const ref = reference.get(tick);
    if (ref === undefined) continue;
    compared++;
    if (ref !== hash) mismatched++;
  }
}
const avg = (v: number[]) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
const sentBytes = avg([...deltaBytes, ...keyBytes]);
const kb = (n: number) => `${(n / 1024).toFixed(2)} KB`;

console.log(`
Players:             ${bots.length} joined${roomFull ? `, extra player ${extraRejected ? "rejected (room full)" : "NOT rejected"}` : ""}
Server ticks:        ${f(Math.min(...tickRates))}-${f(Math.max(...tickRates))} per second (target ${f(1000 / TICK_MS)})
Snapshots:           ${f(Math.min(...snapRates))}-${f(Math.max(...snapRates))} per second per player (target 30)
Snapshot gaps:       median ${f(pct(intervals, 50))} ms, p95 ${f(pct(intervals, 95))} ms, p99 ${f(pct(intervals, 99))} ms, max ${f(Math.max(...intervals))} ms
Press -> shot seen:  median ${f(pct(latencies, 50))} ms, p95 ${f(pct(latencies, 95))} ms, max ${f(Math.max(...latencies))} ms (${latencies.length} taps, ${timeouts} without a shot)
Snapshot size:       ~${kb(sentBytes)} on average, so ~${((sentBytes * 30) / 1024).toFixed(1)} KB/s down per player
                     deltas ${kb(avg(deltaBytes))} (${deltaBytes.length}), keyframes ${kb(avg(keyBytes))} (${keyBytes.length}), full state would be ${kb(avg(fullBytes))}
Deltas that failed:  ${decodeFailures}
Same game for all:   ${compared} tick states compared, ${mismatched} differed
`);
process.exit(mismatched > 0 || decodeFailures > 0 || (roomFull && !extraRejected) ? 1 : 0);
