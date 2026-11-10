// Multiplayer load test against a running server: `npm run loadtest -w server`.
// PLAYERS bots join one room and tap / walk at random for SECONDS, then it reports
// snapshot rate and jitter, server tick rate, press-to-shot latency, message size (deltas,
// keyframes, and what full snapshots would cost), and whether all players saw the same game.
// Bots also ask for a keyframe now and then, so the comparison checks states rebuilt from
// deltas against keyframes, field for field.
//
// Env: SERVER_URL (default ws://localhost:2567), PLAYERS (8), SECONDS (20),
// FIRE=heavy (bots tap every 60-140 ms between short walks, so many bullets fly),
// REPORT_JSON=<file> (also write the numbers as JSON).
// It also reports freezes: per bot the longest snapshot gap and gaps over 100 / 200 ms,
// and replays each bot's snapshot arrivals through the client's smoothing timeline (the
// old fixed 100 ms delay and the current adaptive one) to count frames where other players
// would stand still. Works against old servers that send `{ state }` snapshots too.
// TRANSPORT=udp: bots use the UDP game channel (see botNet.ts), with UDP_LOSS / UDP_DELAY_MS /
// UDP_JITTER_MS shaping what they send (start the server with the same values for the other
// direction). The report then counts channel messages skipped instead of failed deltas.
import { Client, type Room } from "@colyseus/sdk";
import { MAX_PLAYERS, MSG, ROOM_NAME, TICK_MS, type Snapshot, type SnapshotMessage } from "@tank/shared";
import { writeFileSync } from "node:fs";
import { pack } from "msgpackr";
import { BotButton } from "./botButton";
import { BotNet, TRANSPORT } from "./botNet";

const url = process.env.SERVER_URL ?? "ws://localhost:2567";
const PLAYERS = Number(process.env.PLAYERS ?? 8);
const SECONDS = Number(process.env.SECONDS ?? 20);
const PRESS_TIMEOUT_MS = 1000;
const KEYFRAME_REQUEST_MS = [800, 2500]; // each bot asks for a keyframe this often
const HEAVY_FIRE = process.env.FIRE === "heavy";
const REPORT_JSON = process.env.REPORT_JSON;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (min: number, max: number) => min + Math.random() * (max - min);

interface BotStats {
  intervals: number[]; // ms between snapshot arrivals
  pressLatencies: number[]; // ms from sending a tap to seeing its shot in a snapshot
  pressTimeouts: number;
  tapApplied: number[]; // ms from a tap's sample to a snapshot acking it (the server applied it)
  firstTick?: { tick: number; at: number };
  lastTick?: { tick: number; at: number };
  deltaBytes: number[]; // msgpack size of each message as sent
  keyBytes: number[];
  fullBytes: number[]; // what a full snapshot would have been (sampled)
  decodeFailures: number;
  udpBytes: number;
  udpMessages: number;
  tickHashes: Map<number, string>; // for comparing what different players saw
  arrivals: { at: number; tick: number }[]; // every decoded snapshot, for the timeline replay
  maxBullets: number;
}

class Bot {
  stats: BotStats = {
    intervals: [],
    pressLatencies: [],
    pressTimeouts: 0,
    tapApplied: [],
    deltaBytes: [],
    keyBytes: [],
    fullBytes: [],
    decodeFailures: 0,
    udpBytes: 0,
    udpMessages: 0,
    tickHashes: new Map(),
    arrivals: [],
    maxBullets: 0,
  };
  readonly link: BotNet;
  private nextKeyRequest = performance.now() + rand(KEYFRAME_REQUEST_MS[0]!, KEYFRAME_REQUEST_MS[1]!);
  private lastArrival = 0;
  private pendingPressAt: number | null = null;
  private ammo = 6;
  private holdingUntil = 0;
  private nextActionAt = performance.now() + rand(200, 800);
  private button: BotButton;
  private legacy = false; // old server: plain `{ state, events, acks }` snapshots, no keyframe requests

  constructor(public room: Room) {
    this.link = new BotNet(room);
    this.button = new BotButton(this.link);
    room.onMessage(MSG.roster, () => {});
    room.onMessage(MSG.voiceConfig, () => {});
    // Sizes as sent over the WebSocket; decoding happens in BotNet (shared ClientNet).
    room.onMessage(MSG.snapshot, (msg: SnapshotMessage | Snapshot) => {
      if ("state" in msg) {
        this.legacy = true;
        this.stats.keyBytes.push(pack(msg).length);
        this.onSnapshot(msg);
        return;
      }
      (msg.full ? this.stats.keyBytes : this.stats.deltaBytes).push(pack(msg).length);
    });
    this.link.onSnapshot((snap) => this.onSnapshot(snap));
  }

  // Skipped channel messages (no base, late) on UDP; deltas that failed on the WebSocket.
  collect() {
    const n = this.link.net;
    this.stats.decodeFailures = n.wsDecoder.failures + n.udpDecoder.failures;
    this.stats.udpBytes = n.stats.bytesIn;
    this.stats.udpMessages = n.stats.udpIn;
  }

  stopped = false;

  private onSnapshot(snap: Snapshot) {
    if (this.stopped) return;
    const now = performance.now();
    if (this.lastArrival) this.stats.intervals.push(now - this.lastArrival);
    this.lastArrival = now;
    const mark = { tick: snap.state.tick, at: now };
    this.stats.firstTick ??= mark;
    this.stats.lastTick = mark;
    this.stats.arrivals.push(mark);
    this.stats.maxBullets = Math.max(this.stats.maxBullets, snap.state.bullets.length);
    if (snap.state.tick % 30 === 0) this.stats.fullBytes.push(pack({ full: snap.state, events: snap.events, acks: snap.acks }).length);
    this.stats.tickHashes.set(snap.state.tick, JSON.stringify(snap.state));
    const ack = snap.acks[this.room.sessionId] ?? 0;
    const taps = this.button.taps;
    while (taps.length && taps[0]!.seq <= ack) this.stats.tapApplied.push(now - taps.shift()!.at);
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
    if (now >= this.nextKeyRequest && !this.legacy && this.link.net.transport === "ws") {
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
        this.nextActionAt = HEAVY_FIRE ? now + rand(40, 120) : now + rand(250, 800);
      }
      return;
    }
    if (now < this.nextActionAt) return;
    if (HEAVY_FIRE) {
      // Tap fast (the sim ignores taps without ammo), with short walks in between.
      if (Math.random() < 0.7) {
        this.button.tap();
        if (this.pendingPressAt === null && this.ammo > 0) this.pendingPressAt = now;
        this.nextActionAt = now + rand(60, 140);
      } else {
        this.button.hold(true);
        this.holdingUntil = now + rand(150, 450);
      }
      return;
    }
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

// Replays snapshot arrivals through the client's smoothing timeline (web/src/game/onlineDriver.ts)
// at 60 frames/s and counts frames with no newer snapshot to blend towards: other players
// stand still on those. `adaptive: false` is the old client (fixed 100 ms, offset creep only);
// `adaptive: true` is the current one (delay 70-200 ms from the lateness p95, offset re-baseline).
interface TimelineResult {
  frames: number;
  starved: number;
  longestFreezeMs: number; // longest run of starved frames
  freezesOver100: number; // runs of starved frames longer than 100 ms
  avgDelayMs: number;
  maxDelayMs: number;
}
function replayTimeline(arrivals: { at: number; tick: number }[], adaptive: boolean): TimelineResult {
  const FRAME_MS = 1000 / 60;
  let clockOffset: number | null = null;
  let delayMs = adaptive ? 130 : 100;
  let target = delayMs;
  const lateness: number[] = [];
  let sinceJitter = 0;
  const offsets: number[] = [];
  let starvedStreak = 0;
  const serverTimes: number[] = [];
  let i = 0;
  const res: TimelineResult = { frames: 0, starved: 0, longestFreezeMs: 0, freezesOver100: 0, avgDelayMs: 0, maxDelayMs: 0 };
  let runMs = 0;
  let delaySum = 0;
  const endRun = () => {
    res.longestFreezeMs = Math.max(res.longestFreezeMs, runMs);
    if (runMs > 100) res.freezesOver100++;
    runMs = 0;
  };
  if (arrivals.length < 2) return res;
  for (let now = arrivals[0]!.at; now <= arrivals[arrivals.length - 1]!.at; now += FRAME_MS) {
    while (i < arrivals.length && arrivals[i]!.at <= now) {
      const { at, tick } = arrivals[i++]!;
      const serverMs = tick * TICK_MS;
      if (serverTimes.length && serverMs <= serverTimes[serverTimes.length - 1]!) {
        serverTimes.length = 0;
        clockOffset = null;
        offsets.length = 0;
      }
      const sample = at - serverMs;
      offsets.push(sample);
      if (offsets.length > 30) offsets.shift();
      clockOffset = clockOffset === null ? sample : Math.min(sample, clockOffset + 0.5);
      serverTimes.push(serverMs);
      if (serverTimes.length > 60) serverTimes.shift();
      if (adaptive) {
        lateness.push(sample - clockOffset);
        if (lateness.length > 90) lateness.shift();
        if (++sinceJitter >= 10) {
          sinceJitter = 0;
          const sorted = [...lateness].sort((a, b) => a - b);
          const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
          target = Math.min(200, Math.max(70, 66 + 2 * p95));
        }
      }
    }
    if (adaptive) {
      if (delayMs < target) delayMs = Math.min(target, delayMs + FRAME_MS * 0.2);
      else if (delayMs > target) delayMs = Math.max(target, delayMs - FRAME_MS * 0.05);
      if (starvedStreak >= 10) {
        const best = Math.min(...offsets);
        if (clockOffset !== null && best > clockOffset + 1) {
          clockOffset = best;
          lateness.length = 0;
        }
      }
    }
    if (clockOffset === null) continue;
    const t = now - clockOffset - delayMs;
    const starved = !serverTimes.some((ms) => ms > t);
    res.frames++;
    delaySum += delayMs;
    res.maxDelayMs = Math.max(res.maxDelayMs, delayMs);
    if (starved) {
      res.starved++;
      starvedStreak++;
      runMs += FRAME_MS;
    } else {
      starvedStreak = 0;
      endRun();
    }
  }
  endRun();
  res.avgDelayMs = delaySum / Math.max(1, res.frames);
  return res;
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
// TRANSPORT=udp: wait for every bot's channel before starting.
const onUdp = (await Promise.all(bots.map((b) => b.link.waitOpen()))).filter(Boolean).length;
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
// Stop measuring before tearing down (closing the channels sends the last snapshots over the WebSocket).
for (const b of bots) b.stopped = true;
const stillOnUdp = bots.filter((b) => b.link.net.transport === "udp").length;
const fallbacks = bots.reduce((n, b) => n + b.link.net.stats.fallbacks, 0);
const udpSkips = bots.map((b) => ({ noBase: b.link.net.udpDecoder.noBase, stale: b.link.net.udpDecoder.stale, keyframes: b.link.net.udpDecoder.keyframes, deltas: b.link.net.udpDecoder.deltas }));
const keyframeRequests = bots.reduce((n, b) => n + b.link.net.wsDecoder.failures, 0);
for (const b of bots) b.collect();
bots.forEach((b) => b.link.dispose());
await Promise.all(bots.map((b) => b.room.leave()));

// Report
const all = (pick: (s: BotStats) => number[]) => bots.flatMap((b) => pick(b.stats));
const intervals = all((s) => s.intervals);
const latencies = all((s) => s.pressLatencies);
const tapApplied = all((s) => s.tapApplied);
const deltaBytes = all((s) => s.deltaBytes);
const keyBytes = all((s) => s.keyBytes);
const fullBytes = all((s) => s.fullBytes);
const decodeFailures = bots.reduce((n, b) => n + b.stats.decodeFailures, 0);
// Snapshots a bot never got to use (lost, skipped or late), from the ticks it did get.
const notShown = bots.reduce((n, b) => {
  const a = b.stats.arrivals;
  let missing = 0;
  for (let i = 1; i < a.length; i++) if (a[i]!.tick > a[i - 1]!.tick) missing += Math.max(0, (a[i]!.tick - a[i - 1]!.tick) / 2 - 1);
  return n + missing;
}, 0);
const shown = bots.reduce((n, b) => n + b.stats.arrivals.length, 0);
const udpBytes = bots.reduce((n, b) => n + b.stats.udpBytes, 0);
const udpMessages = bots.reduce((n, b) => n + b.stats.udpMessages, 0);
const sumUdp = (k: "noBase" | "stale" | "keyframes" | "deltas") => udpSkips.reduce((n, u) => n + u[k], 0);
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

// Freezes: what one player sees of the others.
const perBot = bots.map((b, n) => {
  const iv = b.stats.intervals;
  return {
    bot: n + 1,
    median: pct(iv, 50),
    p95: pct(iv, 95),
    p99: pct(iv, 99),
    max: iv.length ? Math.max(...iv) : NaN,
    over100: iv.filter((g) => g > 100).length,
    over200: iv.filter((g) => g > 200).length,
    fixed100: replayTimeline(b.stats.arrivals, false),
    adaptive: replayTimeline(b.stats.arrivals, true),
  };
});
const sum = (pick: (b: (typeof perBot)[number]) => number) => perBot.reduce((n, b) => n + pick(b), 0);
const maxOf = (pick: (b: (typeof perBot)[number]) => number) => Math.max(...perBot.map(pick));
const starvedPct = (pick: (b: (typeof perBot)[number]) => TimelineResult) =>
  (100 * sum((b) => pick(b).starved)) / Math.max(1, sum((b) => pick(b).frames));
const maxBullets = Math.max(...bots.map((b) => b.stats.maxBullets));

console.log(`
Players:             ${bots.length} joined${roomFull ? `, extra player ${extraRejected ? "rejected (room full)" : "NOT rejected"}` : ""}
Server ticks:        ${f(Math.min(...tickRates))}-${f(Math.max(...tickRates))} per second (target ${f(1000 / TICK_MS)})
Snapshots:           ${f(Math.min(...snapRates))}-${f(Math.max(...snapRates))} per second per player (target 30)
Snapshot gaps:       median ${f(pct(intervals, 50))} ms, p95 ${f(pct(intervals, 95))} ms, p99 ${f(pct(intervals, 99))} ms, max ${f(Math.max(...intervals))} ms
Press -> shot seen:  median ${f(pct(latencies, 50))} ms, p95 ${f(pct(latencies, 95))} ms, max ${f(Math.max(...latencies))} ms (${latencies.length} taps, ${timeouts} without a shot)
Tap -> applied seen: median ${f(pct(tapApplied, 50))} ms, p95 ${f(pct(tapApplied, 95))} ms, max ${f(Math.max(...tapApplied))} ms (${tapApplied.length} taps; until a snapshot acks the tap's sample)
Snapshot size:       ${TRANSPORT === "udp" ? `channel ~${kb(udpBytes / Math.max(1, udpMessages))} per message (keepalives included); WebSocket:` : ""} ~${kb(sentBytes)} on average, so ~${((sentBytes * 30) / 1024).toFixed(1)} KB/s down per player
                     deltas ${kb(avg(deltaBytes))} (${deltaBytes.length}), keyframes ${kb(avg(keyBytes))} (${keyBytes.length}), full state would be ${kb(avg(fullBytes))}
Transport:           ${TRANSPORT}${TRANSPORT === "udp" ? `: ${onUdp}/${bots.length} channels opened, ${stillOnUdp} still on it at the end, ${fallbacks} fallbacks to WebSocket` : ""}
Snapshots not shown: ${notShown} of ${notShown + shown} (${f((100 * notShown) / Math.max(1, notShown + shown))}%: lost, skipped or late)
Deltas that failed:  ${decodeFailures}${TRANSPORT === "udp" ? `; channel: ${sumUdp("keyframes")} keyframes + ${sumUdp("deltas")} deltas decoded, skipped ${sumUdp("noBase")} without base + ${sumUdp("stale")} late, avg ${f(udpBytes / Math.max(1, udpMessages))} B per message` : `; keyframe requests after a failed delta: ${keyframeRequests}`}
Same game for all:   ${compared} tick states compared, ${mismatched} differed
Mode:                ${HEAVY_FIRE ? "heavy fire" : "normal"}, up to ${maxBullets} bullets in flight
Gaps > 100 / 200 ms: ${sum((b) => b.over100)} / ${sum((b) => b.over200)} (all bots), longest ${f(maxOf((b) => b.max))} ms
Others frozen (60 fps replay): fixed 100 ms delay ${f(starvedPct((b) => b.fixed100))}% of frames, longest ${f(maxOf((b) => b.fixed100.longestFreezeMs))} ms, ${sum((b) => b.fixed100.freezesOver100)} freezes > 100 ms
                     adaptive delay ${f(starvedPct((b) => b.adaptive))}% of frames, longest ${f(maxOf((b) => b.adaptive.longestFreezeMs))} ms, ${sum((b) => b.adaptive.freezesOver100)} freezes > 100 ms, delay avg ${f(avg(perBot.map((b) => b.adaptive.avgDelayMs)))} ms
Per bot gaps (ms):   ${perBot.map((b) => `#${b.bot} med ${f(b.median)} p95 ${f(b.p95)} p99 ${f(b.p99)} max ${f(b.max)} >100:${b.over100} >200:${b.over200}`).join("\n                     ")}
`);
if (REPORT_JSON) {
  writeFileSync(
    REPORT_JSON,
    JSON.stringify(
      {
        mode: HEAVY_FIRE ? "heavy" : "normal",
        players: bots.length,
        seconds: SECONDS,
        tickRate: { min: Math.min(...tickRates), max: Math.max(...tickRates) },
        snapRate: { min: Math.min(...snapRates), max: Math.max(...snapRates) },
        gaps: { median: pct(intervals, 50), p95: pct(intervals, 95), p99: pct(intervals, 99), max: Math.max(...intervals) },
        over100: sum((b) => b.over100),
        over200: sum((b) => b.over200),
        press: { median: pct(latencies, 50), p95: pct(latencies, 95), n: latencies.length, timeouts },
        tapApplied: { median: pct(tapApplied, 50), p95: pct(tapApplied, 95), max: Math.max(...tapApplied), n: tapApplied.length },
        bytes: { avg: sentBytes, delta: avg(deltaBytes), key: avg(keyBytes), full: avg(fullBytes) },
        maxBullets,
        decodeFailures,
        transport: TRANSPORT,
        onUdp,
        stillOnUdp,
        fallbacks,
        notShown,
        shown,
        udp: { keyframes: sumUdp("keyframes"), deltas: sumUdp("deltas"), noBase: sumUdp("noBase"), stale: sumUdp("stale"), avgBytes: udpBytes / Math.max(1, udpMessages) },
        compared,
        mismatched,
        fixed100: { starvedPct: starvedPct((b) => b.fixed100), longest: maxOf((b) => b.fixed100.longestFreezeMs), over100: sum((b) => b.fixed100.freezesOver100) },
        adaptive: {
          starvedPct: starvedPct((b) => b.adaptive),
          longest: maxOf((b) => b.adaptive.longestFreezeMs),
          over100: sum((b) => b.adaptive.freezesOver100),
          avgDelay: avg(perBot.map((b) => b.adaptive.avgDelayMs)),
          maxDelay: maxOf((b) => b.adaptive.maxDelayMs),
        },
        perBot,
      },
      null,
      1,
    ),
  );
}
process.exit(mismatched > 0 || decodeFailures > 0 || (roomFull && !extraRejected) ? 1 : 0);
