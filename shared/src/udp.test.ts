import assert from "node:assert/strict";
import { test } from "node:test";
import { getMap } from "./maps";
import { SNAPSHOT_EVERY_TICKS, cloneDeep, type SnapshotState } from "./net";
import { InputQueue, type InputFrame } from "./prediction";
import { addTank, createMatchState, step, type GameEvent, type GameState, type TankInput } from "./sim";
import {
  InputSender,
  SnapshotFeed,
  SnapshotHistory,
  UDP_HISTORY_SNAPSHOTS,
  UdpSnapshotDecoder,
  buildDown,
  decodeDown,
  decodeUp,
  encodeDown,
  encodeUp,
  newPeerState,
  notePeerAck,
  parseRtcSignal,
  type DownMessage,
  type UpMessage,
} from "./udp";

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function snapshotOf(state: GameState): SnapshotState {
  const { events: _events, ...rest } = state;
  return cloneDeep(rest);
}

test("up messages round trip, with aim and seen on presses only", () => {
  const samples: InputFrame[] = [
    { seq: 41, held: false, pressed: false },
    { seq: 42, held: true, pressed: true, aim: 1.2345678901234, seen: 300 },
    { seq: 43, held: true, pressed: false },
    { seq: 44, held: false, pressed: true, seen: 302 },
  ];
  const back = decodeUp(encodeUp({ ack: 120, epoch: 3, samples }));
  assert.deepEqual(back, { ack: 120, epoch: 3, samples });
  assert.deepEqual(decodeUp(encodeUp({ ack: -1, epoch: 0, samples: [] })), { ack: -1, epoch: 0, samples: [] });
});

test("malformed messages decode to null instead of throwing", () => {
  for (const junk of [new Uint8Array([]), new Uint8Array([0xc1]), new Uint8Array([1, 2, 3]), encodeDown({ epoch: 1, tick: 2, ev: [], acks: {} })]) {
    assert.equal(decodeUp(junk), null);
  }
  assert.equal(decodeDown(encodeUp({ ack: 1, epoch: 1, samples: [] })), null);
  assert.equal(decodeDown(new Uint8Array([0xc1])), null);
  assert.equal(parseRtcSignal({ kind: "offer", id: -1, sdp: "x" }), null);
  assert.equal(parseRtcSignal({ kind: "cand", id: 1, candidate: 5, mid: "0" }), null);
  assert.equal(parseRtcSignal("hello"), null);
  assert.deepEqual(parseRtcSignal({ kind: "answer", id: 2, sdp: "v=0", extra: 1 }), { kind: "answer", id: 2, sdp: "v=0" });
});

test("down messages round trip, keyframe and delta", () => {
  const state = snapshotOf(createMatchState(1, ["arena"]));
  const key: DownMessage = { epoch: 2, tick: state.tick, full: state, ev: [[0, [{ type: "fire", tankId: "a", x: 1.5, y: 2 }]]], acks: { a: 7 } };
  assert.deepEqual(decodeDown(encodeDown(key)), key);
  const delta: DownMessage = { epoch: 2, tick: 4, base: 2, delta: [3, 4], ev: [], acks: {} };
  assert.deepEqual(decodeDown(encodeDown(delta)), delta);
});

interface NetOptions {
  loss: number; // each direction
  delayMs: number;
  jitterMs: number;
  seconds: number;
  seed: number;
  newMatchAt?: number; // ms: start a new match (ticks start over)
  blackoutDown?: [number, number]; // ms window where every down message is lost
}

// A server and one client over a simulated lossy, reordering link, with the real sim, the
// real codec (msgpack) and the real InputQueue. Checks every decoded state against what the
// server sent, and that every sample of the client's button reaches the server with no gap.
function simulate(opts: NetOptions) {
  const rand = lcg(opts.seed);
  const netRand = lcg(opts.seed * 7 + 1);
  const newMatch = (mapId: string) => {
    const s = createMatchState(1, [mapId]);
    ["me", "b", "c", "d"].forEach((id, i) => addTank(s, getMap(s.mapId), id, i % 2 ? "blue" : "red"));
    return s;
  };
  let state = newMatch("arena");
  const hist = new SnapshotHistory();
  hist.reset(); // the first match is epoch 1
  const peer = newPeerState();
  const queue = new InputQueue();
  const sentStates = new Map<string, SnapshotState>(); // "epoch:tick" -> state as sent
  const serverEvents = new Map<number, GameEvent[]>([[1, []]]); // per epoch, in order
  const clientEvents = new Map<number, GameEvent[]>();
  let pending: GameEvent[] = [];
  const decoder = new UdpSnapshotDecoder();
  const feed = new SnapshotFeed();
  const sender = new InputSender();
  let seq = 0;
  let held = false;
  let newestQueued = 0;
  let gaps = 0;
  let pressesSent = 0;
  let pressesApplied = 0;
  const pressSeqs = new Set<number>();
  let delivered = 0;
  let sentDown = 0;
  let downBytes = 0;
  let maxDeltaBytes = 0;
  let keyframes = 0;
  let longestSilence = 0;
  let lastDelivered = 0;
  const inFlight: { at: number; dir: "up" | "down"; bytes: Uint8Array }[] = [];
  const send = (now: number, dir: "up" | "down", bytes: Uint8Array) => {
    if (dir === "down" && opts.blackoutDown && now >= opts.blackoutDown[0] && now < opts.blackoutDown[1]) return;
    if (netRand() < opts.loss) return;
    inFlight.push({ at: now + opts.delayMs + netRand() * opts.jitterMs, dir, bytes });
  };
  const TICK = 1000 / 60;
  for (let n = 0; n * TICK < opts.seconds * 1000; n++) {
    const now = n * TICK;
    // Deliver what has arrived, in arrival order (not send order).
    inFlight.sort((a, b) => a.at - b.at);
    while (inFlight.length && inFlight[0]!.at <= now) {
      const m = inFlight.shift()!;
      if (m.dir === "up") {
        const up = decodeUp(m.bytes)!;
        notePeerAck(peer, up);
        const fresh = up.samples.filter((f) => f.seq > newestQueued);
        if (fresh.length && fresh[0]!.seq !== newestQueued + 1) gaps++;
        if (fresh.length) newestQueued = fresh[fresh.length - 1]!.seq;
        queue.push(up.samples);
      } else {
        const d = decoder.decode(decodeDown(m.bytes)!);
        if (!d) continue;
        assert.deepEqual(d.state, sentStates.get(`${d.epoch}:${d.state.tick}`), `decoded state ${d.state.tick} differs`);
        const snap = feed.accept(d.epoch, d.state, d.groups, d.acks);
        if (!snap) continue;
        if (!clientEvents.has(d.epoch)) clientEvents.set(d.epoch, []);
        clientEvents.get(d.epoch)!.push(...snap.events);
        sender.ack(snap.acks.me ?? 0);
        delivered++;
        longestSilence = Math.max(longestSilence, now - lastDelivered);
        lastDelivered = now;
      }
    }
    // Client: one button sample per tick, sent with everything unacked and its ack.
    if (rand() < 0.08) held = !held;
    const frame: InputFrame = { seq: ++seq, held, pressed: rand() < 0.05 };
    if (frame.pressed) {
      pressesSent++;
      pressSeqs.add(frame.seq);
    }
    sender.push([frame]);
    send(now, "up", encodeUp({ ack: decoder.newest, epoch: decoder.epoch, samples: sender.recent() } satisfies UpMessage));
    // Server tick.
    if (opts.newMatchAt !== undefined && now >= opts.newMatchAt && hist.epoch === 1) {
      state = newMatch("fortress");
      hist.reset();
      serverEvents.set(hist.epoch, []);
      pending = [];
    }
    const mine = queue.next();
    for (const s of mine) if (s.pressed) pressesApplied++;
    const inputs: Record<string, TankInput | TankInput[]> = { me: mine };
    for (const id of ["b", "c", "d"]) inputs[id] = { held: rand() < 0.5, pressed: rand() < 0.06 };
    step(state, getMap(state.mapId), inputs, { holdMs: 60 });
    serverEvents.get(hist.epoch)!.push(...state.events);
    pending.push(...state.events);
    if (state.tick % SNAPSHOT_EVERY_TICKS !== 0) continue;
    const snap = snapshotOf(state);
    sentStates.set(`${hist.epoch}:${snap.tick}`, snap);
    hist.push(snap, pending);
    pending = [];
    const msg = buildDown(hist, peer, { me: queue.ack }, now)!;
    const bytes = encodeDown(msg);
    if (msg.full) keyframes++;
    else maxDeltaBytes = Math.max(maxDeltaBytes, bytes.length);
    downBytes += bytes.length;
    sentDown++;
    send(now, "down", bytes);
  }
  // Presses the server should have applied by now: those up to its ack.
  let pressesDue = 0;
  for (const s of pressSeqs) if (s <= queue.ack) pressesDue++;
  return { delivered, sentDown, keyframes, downBytes, maxDeltaBytes, longestSilence, decoder, feed, serverEvents, clientEvents, gaps, pressesSent, pressesDue, pressesApplied, queue, seq };
}

// The client's events are the server's, in order, up to the last snapshot it got.
function assertEventsExactlyOnce(r: ReturnType<typeof simulate>) {
  for (const [epoch, got] of r.clientEvents) {
    const all = r.serverEvents.get(epoch)!;
    assert.deepEqual(got, all.slice(0, got.length), `epoch ${epoch}: events differ`);
    assert.ok(got.length > all.length - 40, `epoch ${epoch}: only ${got.length} of ${all.length} events`);
  }
}

test("over a clean link every snapshot is a delta against an acked base", () => {
  const r = simulate({ loss: 0, delayMs: 40, jitterMs: 0, seconds: 10, seed: 1 });
  assert.equal(r.decoder.skipped, 0);
  assert.equal(r.keyframes, 1, "one keyframe to start");
  assert.ok(r.delivered >= r.sentDown - 4);
  assert.equal(r.gaps, 0);
  assert.equal(r.pressesApplied, r.pressesDue);
  assertEventsExactlyOnce(r);
});

test("random loss and reordering: exact states, events once, no input gaps, nothing stalls", () => {
  for (const [loss, seed] of [[0.01, 2], [0.03, 3], [0.05, 4], [0.1, 5], [0.2, 6]] as const) {
    const r = simulate({ loss, delayMs: 40, jitterMs: 30, seconds: 20, seed });
    assert.equal(r.decoder.failures, 0, `loss ${loss}: a delta failed`);
    assert.equal(r.gaps, 0, `loss ${loss}: input samples were lost`);
    assert.equal(r.queue.dropped, 0);
    assert.equal(r.pressesApplied, r.pressesDue, `loss ${loss}: taps lost`);
    assertEventsExactlyOnce(r);
    // Lost snapshots are skipped, not waited for: what arrives is decoded.
    assert.ok(r.delivered > r.sentDown * (1 - loss) * 0.85, `loss ${loss}: ${r.delivered} of ${r.sentDown} delivered`);
    assert.ok(r.decoder.noBase < r.sentDown * 0.02, `loss ${loss}: ${r.decoder.noBase} without a base`);
    assert.ok(r.keyframes <= 3, `loss ${loss}: ${r.keyframes} keyframes`);
    assert.ok(r.longestSilence < 400, `loss ${loss}: ${r.longestSilence} ms without a snapshot`);
  }
});

test("deltas stay well under one UDP packet", () => {
  const r = simulate({ loss: 0.03, delayMs: 60, jitterMs: 20, seconds: 20, seed: 9 });
  const avg = r.downBytes / r.sentDown;
  assert.ok(avg < 900, `average ${avg.toFixed(0)} B`);
  assert.ok(r.maxDeltaBytes < 1600, `largest delta ${r.maxDeltaBytes} B`);
});

test("a new match (ticks start over) resyncs with one keyframe", () => {
  const r = simulate({ loss: 0.05, delayMs: 40, jitterMs: 30, seconds: 12, seed: 11, newMatchAt: 6000 });
  assert.equal(r.decoder.epoch, 2);
  assert.equal(r.decoder.failures, 0);
  assert.ok(r.keyframes <= 4, `${r.keyframes} keyframes`);
  assertEventsExactlyOnce(r);
  assert.ok(r.clientEvents.get(2)!.length > 0, "events of the new match arrive");
});

test("a long downlink blackout recovers with a keyframe once the acked base is too old", () => {
  const r = simulate({ loss: 0, delayMs: 40, jitterMs: 0, seconds: 10, seed: 12, blackoutDown: [3000, 6000] });
  assert.ok(r.keyframes >= 2, "the client's ack fell out of the server's history");
  assert.equal(r.decoder.failures, 0);
  assert.ok(r.longestSilence < 3200);
  assert.equal(r.gaps, 0);
});

test("the decoder skips a delta whose base it lacks and recovers on the next keyframe", () => {
  const base = snapshotOf(createMatchState(1, ["arena"]));
  const hist = new SnapshotHistory();
  hist.reset();
  const states: SnapshotState[] = [];
  let s = createMatchState(1, ["arena"]);
  addTank(s, getMap(s.mapId), "a", "red");
  for (let i = 0; i < 12; i++) {
    step(s, getMap(s.mapId), { a: { held: true, pressed: i === 0 } }, { holdMs: 60 });
    if (s.tick % 2 === 0) states.push(snapshotOf(s));
  }
  void base;
  for (const st of states) hist.push(st, []);
  const peer = newPeerState();
  const dec = new UdpSnapshotDecoder();
  const msgAt = (i: number, ack: number, now: number) => {
    peer.ack = ack;
    peer.ackEpoch = ack >= 0 ? 1 : -1;
    const h = new SnapshotHistory();
    h.reset();
    for (const st of states.slice(0, i + 1)) h.push(st, []);
    return buildDown(h, peer, {}, now)!;
  };
  const key = msgAt(0, -1, 0);
  assert.ok(key.full, "no ack: keyframe");
  const d1 = msgAt(1, -1, 10);
  assert.equal(d1.base, states[0]!.tick, "right after a keyframe: delta against it");
  // The keyframe was lost: the delta is skipped, not applied to anything.
  assert.equal(dec.decode(d1), null);
  assert.equal(dec.noBase, 1);
  const key2 = msgAt(2, -1, 300);
  assert.ok(key2.full, "no ack after UDP_KEY_RESEND_MS: a new keyframe");
  assert.ok(dec.decode(key2));
  const d3 = msgAt(4, states[2]!.tick, 320);
  assert.equal(d3.base, states[2]!.tick, "acked: delta against the ack");
  assert.deepEqual(dec.decode(d3)?.state, states[4]);
  // Late and duplicate messages are skipped.
  assert.equal(dec.decode(msgAt(3, states[2]!.tick, 330)), null);
  assert.equal(dec.decode(d3), null);
  assert.equal(dec.stale, 2);
  void s;
  s = createMatchState(1);
});

test("the feed passes every snapshot and event once across both paths", () => {
  const feed = new SnapshotFeed();
  const st = (tick: number) => ({ tick }) as unknown as SnapshotState;
  const e = (n: number): GameEvent => ({ type: "fire", tankId: String(n), x: 0, y: 0 });
  // WebSocket snapshots: events of each since the previous one.
  assert.deepEqual(feed.accept(1, st(2), [[2, [e(1)]]], {})?.events, [e(1)]);
  assert.deepEqual(feed.accept(1, st(4), [[4, [e(2)]]], {})?.events, [e(2)]);
  // Switched to the channel: the first message carries groups since an older ack.
  assert.deepEqual(feed.accept(1, st(8), [[2, [e(1)]], [4, [e(2)]], [6, [e(3)]], [8, [e(4)]]], {})?.events, [e(3), e(4)]);
  // A late WebSocket snapshot is dropped whole.
  assert.equal(feed.accept(1, st(6), [[6, [e(3)]]], {}), null);
  // A new match starts the ticks over.
  assert.deepEqual(feed.accept(2, st(2), [[2, [e(9)]]], {})?.events, [e(9)]);
  assert.equal(feed.accept(1, st(10), [], {}), null, "a message from the old match");
});

test("the server's history keeps UDP_HISTORY_SNAPSHOTS states and their events", () => {
  const hist = new SnapshotHistory(4);
  hist.reset();
  const st = (tick: number) => ({ tick }) as unknown as SnapshotState;
  for (let t = 2; t <= 12; t += 2) hist.push(st(t), [{ type: "fire", tankId: String(t), x: 0, y: 0 }]);
  assert.equal(hist.get(4), undefined);
  assert.ok(hist.get(6));
  assert.deepEqual(hist.eventsAfter(8).map((g) => g[0]), [10, 12]);
  assert.deepEqual(hist.eventsAfter(-1).map((g) => g[0]), [6, 8, 10, 12]);
  assert.ok(UDP_HISTORY_SNAPSHOTS >= 60);
});

test("a burst of more unacked samples than one message holds still sends them all", async () => {
  const { ClientNet } = await import("./clientNet");
  const ws: InputFrame[][] = [];
  const sent: UpMessage[] = [];
  const net = new ClientNet({ sendInputWs: (f) => ws.push(f), requestKeyframeWs: () => {}, myId: () => "me" }, () => 0);
  net.channelOpened({ send: (b) => sent.push(decodeUp(b)!) });
  const frames: InputFrame[] = [];
  for (let seq = 1; seq <= 100; seq++) frames.push({ seq, held: false, pressed: seq === 1 });
  sent.length = 0;
  net.sendInput(frames);
  const seqs = new Set(sent.flatMap((m) => m.samples.map((s) => s.seq)));
  assert.equal(seqs.size, 100, "every sample went out");
  assert.ok(sent.some((m) => m.samples.some((s) => s.seq === 1 && s.pressed)), "the oldest one, a tap, too");
  assert.equal(ws.length, 0, "nothing over the WebSocket while on the channel");
  // Back to the WebSocket: everything unacked goes again there.
  net.channelClosed();
  assert.deepEqual(ws.flat().map((f) => f.seq), frames.map((f) => f.seq));
});
