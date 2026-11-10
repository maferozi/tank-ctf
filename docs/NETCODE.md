# Netcode and test results

## How it works
- The server runs the shared sim at 60 Hz. Each client samples its button once per sim tick,
  numbers the sample (`seq`) and sends it (batched per frame, a few bytes each).
- The server keeps a small queue of samples per player (`InputQueue`, `shared/src/prediction.ts`)
  and applies **every sample exactly once, in order**, never making one up or skipping one
  (see "Exact input sequence" below). It normally holds about 2 samples to ride out jitter.
- Every 2nd tick (30 Hz) the server broadcasts a snapshot: the game state, the events since
  the last one, and per player the `ack` (last sample applied).
- **Inputs and snapshots travel over a UDP channel** (a WebRTC data channel to the game
  server) when the browser can open one, and over the room's WebSocket otherwise. See "UDP
  game channel" below; the rest of this section describes the WebSocket path.
- **Snapshots are keyframes plus deltas** (`shared/src/net.ts`). A keyframe is the full state.
  The server sends one to a player when they join or reconnect or ask for one, to everyone when
  a match starts or the map changes, and to everyone every 60 snapshots (2 s). Every other
  snapshot is a lossless delta against the previous one, worked out once and broadcast to
  everyone except players waiting for a keyframe.
  - The codec doesn't know the state's shape, so new fields (`shieldHits`, desks) need no codec
    change. Object fields are sent as `[index, value]` pairs by key position; arrays whose items
    all have a unique `id` (or `team`, for flags) are diffed by id, with additions, removals and
    a new order only when it changed (the sim depends on array order). Any other array, or an
    object whose keys changed, is sent whole.
  - A delta names the base tick it applies to. `SnapshotDecoder` returns null when it doesn't
    fit what the client has, and the client asks for a keyframe (`MSG.keyframe`). WebSocket
    delivery is ordered, so no acks are needed. A client that loses its base misses 1–2
    snapshots while it waits.
  - The client decodes in `web/src/net/session.ts` (`session.onSnapshot`), so the delta chain
    survives page navigation; listeners must use it rather than raw room messages.
- **Your own soldier is predicted** (`Predictor`): the client runs the shared sim ahead with
  your own samples, so turning, walking and shooting show on the next frame. When a snapshot
  arrives it restarts from the server state and replays the samples the server hasn't applied
  yet. Small disagreements glide into place over ~100 ms; big ones (respawn) snap.
- Your bullets, crates and power boxes come from the same prediction, so they line up with you.
- **Other players** are drawn a smoothing delay behind the newest snapshot, blending between the
  two around that time, so they move smoothly even when packets arrive unevenly. **The delay
  adapts**: it starts at 130 ms and aims for clamp(66 + 2 × p95 snapshot lateness, 70..200 ms)
  over the last 90 snapshots, where lateness is each arrival offset minus the best seen. It grows
  at 0.2 ms per ms and shrinks at 0.05 ms per ms, so others never jump. A tick going backwards
  (new match) restarts the timeline. The best-seen offset creeps up 0.5 ms per snapshot; after a
  server stall (sim time falls behind real time for good) that is too slow, so 10 starved frames
  in a row re-baseline it to the best of the last second of snapshots and restart the lateness
  window.
- Server events are kept for the next drawn frame, at most 64; in a hidden tab they are
  dropped, so coming back doesn't replay a minute of shots and kills at once.
- `InputQueue` skips malformed input frames, so one bad message can't crash the server.
- Allocation: the predictor copies into one reused buffer (`copyInto`) instead of cloning every
  tick, `Blender` (`web/src/game/blend.ts`) reuses its output, and the online driver reuses its
  display state. Frame states are therefore only valid until the next `driver.frame()` call.

- **Voice chat** shares the room connection only for signaling (`MSG.voice`, a few small
  messages per voice connection, rate-limited) and the ICE config (`MSG.voiceConfig`). Audio is
  peer to peer and never touches the game server or the frame loop. Colyseus' default 4 KB
  WebSocket message limit is raised to 20 KB for SDPs. See `docs/VOICE.md`.

## Testing it
- `npm run loadtest -w server` (server running): bots tap and walk at random and the script
  reports tick rate, snapshot jitter, press-to-shot time (as the server and other players see
  it), snapshot size and whether all players saw identical state. Env: `SERVER_URL`,
  `PLAYERS` (8), `SECONDS` (20).
- Server env: `TICK_STATS=1` logs tick cost; `COLYSEUS_LATENCY=<ms>` simulates a round trip.
- The load test records every message's real size, samples what the full state would cost,
  makes each bot ask for keyframes at random (every 0.8–2.5 s), and compares states rebuilt
  from deltas against each other, so "same game for all" also checks the delta codec.
- Browser, dev only: `?server=ws://localhost:2571` points a tab at another game server, and
  `window.__net` shows frames, starved frames, prediction corrections, samples in flight,
  `delayMs`, `jitterP95Ms`, `keyframes`, `deltas`, `keyframeRequests`, `offsetResets`,
  `transport` ("udp" or "ws"), `udpSnapshots`, `udpSkipped`, `udpKeyframes`, `fallbacks`,
  `missedSnapshots` and `stressed`. `?udp=0` keeps a tab on the WebSocket.
- `TRANSPORT=udp` makes the load test and smoke bots use the UDP channel (node-datachannel in
  place of the browser). `UDP_LOSS` (0..1), `UDP_DELAY_MS` and `UDP_JITTER_MS` drop and delay
  the channel's messages on the sending side: set them on the bots for the way up and on the
  server for the way down.

## Results, 31 Oct 2026 (MacBook; server, bots and browser on the same machine)

### Before prediction (commit 9cf5592)
| | Same machine | 100 ms round trip |
|---|---|---|
| Server ticks/s, tick cost | 60.0, ~0.3 ms (max 1.9) | 60.2, same |
| Snapshots per player, gaps | 30/s, p99 49 ms | 30/s, p99 49 ms |
| Press → shot (server) | 18 ms median | 121 ms median |
| **Press → you see your soldier react** | **~120 ms** | **~220 ms** |
| Same state for all players | 0 of 4,207 ticks differed | 0 of 4,248 differed |

### With prediction
| | Same machine | 100 ms round trip |
|---|---|---|
| **Tap → your soldier visibly reacts** (browser, 10 taps) | **median 5 ms, max 8 ms** | **median 7–12 ms, max 18 ms** |
| Hold → walking (includes the 60 ms hold threshold) | 66 ms | — |
| Press → shot as others/server see it (8 bots) | median 25 ms, p95 43 ms | median 126 ms, p95 144 ms |
| Prediction corrections | 0 | 4 of 339 snapshots, largest 5.7 px (eased) |
| Other players' smoothness (browser) | 0 starved frames | 0 of 1,354 frames starved |
| Server ticks/s, tick cost | 60.0 | 60.0, ~0.5 ms (max 1.8) |
| Same state for all players | 0 of 4,200 differed | 0 of 4,249 differed |
| Taps lost | 0 | 0 |
| Snapshot size | ~2.8 KB, ~83 KB/s per player | same |

Your own controls now feel instant whatever the ping. What remains is physics: other players
see your actions after about half the round trip plus a tick or two, and you see them ~100 ms
behind (the smoothing buffer). That is normal for online games and hard to notice in play.

## Results, 5 Nov 2026: delta snapshots (same machine, 8 bots, 15 s)
| | Full snapshots (before) | Keyframes + deltas |
|---|---|---|
| Snapshot size, average | ~3.2 KB | **~0.62 KB** (deltas 0.53 KB, keyframes 3.18 KB) |
| Down per player | ~96 KB/s | **~18.7 KB/s** |
| Server ticks/s, tick cost | 60.0 | 60.0; ~0.5–0.7 ms average |
| Snapshot gaps | p99 48 ms | median 33.4 ms, p95 36.6 ms, p99 50.1 ms |
| Press → shot as others see it | — | median 25 ms, p95 46 ms (77 taps, 0 lost) |
| Deltas that failed to apply | — | 0 |
| Same state for all players | 0 of 3,213 differed | 0 of 3,213 differed |

Measured with the 26 × 18 maps, desks and the new power-up rules in place. The adaptive delay
has not been measured on a real network or phone yet.

## Results, 9 Nov 2026: server CPU (Docker, 8 bots, heavy fire, 30 s)
The deployed game server runs on Render Free, which gets about a tenth of a CPU. Reproduced
with Docker (`--cpus` and `--memory=512m`, node 22), old code (`main`) against the new code:

| Server CPU | Old code: gaps > 100 ms, longest | New code: gaps > 100 ms, longest |
|---|---|---|
| 0.1 (Render Free) | 192, 361 ms | 292, 310 ms |
| 0.5 | 35, 484 ms | **0, 53 ms** (p99 40 ms) |
| 1 | 0, 57 ms | (0.5 already passes) |

At 0.1 CPU neither version keeps 60 Hz: Node's garbage collection and any burst of work are
spread over 10 ms slices per 100 ms, so the server stalls for 100-300 ms and other players
freeze. That can't be fixed in code; the server needs at least half a CPU. With that, the new
code is smooth.

Client side (all servers): when a snapshot is late, other soldiers and bullets carry on along
their last motion for up to 120 ms (`EXTRAPOLATE_MS`, `Blender` with `extrapolate`), stopping
short of walls, instead of freezing; fallen soldiers, crates, boxes and flags hold still.
`window.__net` counts `extrapolated` frames and `maxExtrapolationMs`.

Input buffer (server): the depth adapts per player, checked every second: running dry twice or
more adds a sample (up to 8), never running low takes one away (down to 2). Press → shot as
others see it: median 34 ms locally (29 ms before the change). How samples are applied changed
on 9 Nov 2026, see below.

Round restarts: while the server state shows a round as over, or the predicted and server
states are on different rounds or maps, the whole frame is drawn from the server state.
Before, prediction reset the round on its own and the screen mixed the next round's map and
spawn with the old banner for a round trip (the flicker at every round restart). Measured in a
virtual-time harness over 45 round ends at 100-250 ms ping: mixed frames 351-606 ms before, 0
after.

## Lag compensation and nearby players (9 Nov 2026)
- **Hits as the shooter saw them.** A press sample carries `seen`: the server tick the client
  draws the others at (before 9 Nov: `view`, an offset from the predicted tick). The bullet
  keeps the difference (`Bullet.rewind`, at most `MAX_REWIND_TICKS` = 30, 500 ms; was 15), and
  every hit check against an enemy uses where that enemy was that many ticks ago: the server
  keeps the last 30 ticks of positions
  (`GameRoom.positions`, passed to `step()` as `SimConfig.rewind`); a client's prediction
  looks the same positions up in the snapshots it is drawing from. Before, others were drawn
  ~100-200 ms in the past but hits used present positions: a walking soldier is ~28 px away
  from where you see them after 150 ms, more than the 16 px hit radius, so bullets passed
  through soldiers on screen and kills happened where nothing was drawn.
- **Swept bullet hits:** the bullet's whole path in a tick is tested against soldiers.
- **Nearby players drawn in the present:** within 90 px of you, another soldier slides from its
  interpolated (past) position to where your prediction has it now, fully once you touch, so
  collisions and shoves look like collisions instead of walking through each other.
- Checked: sim tests (a lagged shot hits where the shooter saw the enemy and misses without
  rewind; junk `view` values clamped; an edge graze between ticks hits), smoke, and an 8-bot
  heavy-fire load test at 150 ms latency (0 of 2,569 states differed, 0 gaps over 100 ms).

## Exact input sequence and aim (9 Nov 2026)
Problem: online, shots often left the server in a different direction than the shooter's
screen showed ("the bullet passes over the enemy"). When a player's sample hadn't arrived the
server made one up (button as before) and advanced the soldier a tick the client never
simulated (still turning, 3.9 degrees a tick), then dropped samples to catch up. So the server
and the shooter's prediction ran the soldier through different sample sequences and every
press landed at a different heading.

- **Every sample exactly once, in order.** `InputQueue.next()` returns 0..2 samples for the
  tick and `step()` takes, per player, one sample or a list (`TickInputs`): each sample in the
  list is one update of that soldier (turn, walk, fire, cooldown, reload, power timers,
  respawn countdown). With no sample the list is empty and the soldier is **frozen** for the
  tick; bullets, other players and the world go on, and a frozen soldier can still be pushed
  and shot. When the backlog is more than the target depth plus one, two samples are applied in
  one tick, so it drains without dropping anything; a bullet fired by the first of the two also
  gets the second's move, as on the shooter's screen. Bursts (`RAPID_FIRE_MS`) count the
  soldier's own samples (`Tank.sincePressTicks`), not world ticks. Only past `MAX_INPUT_QUEUE`
  (30 samples, 500 ms) are old samples dropped, as a last resort (`InputQueue.dropped`; taps
  are kept, `lostPresses` counts any merged). A player who dropped out gets an idle button
  each tick so their timers and respawn keep going. Solo, bots and the client's prediction
  pass one sample per tick as before.
- **Aim travels with the press.** The `Predictor` puts the heading its prediction fired along
  on every press sample (`aim`, radians). The sim fires along it, and turns the soldier to it,
  when it is within `AIM_TOLERANCE` (15 degrees) of the soldier's heading on the server;
  anything else is ignored. With exact sequences the two already match; this is the safety net.
- **Lag compensation window and target.** A press now carries `seen`, the server tick the
  shooter's screen drew the others at (`onlineDriver`), instead of an offset from the predicted
  tick: the server may apply the press on a different tick than the client predicted (queue
  depth, frozen ticks), so an offset pointed at the wrong past. The sim rewinds to
  `tick - seen`, clamped to 0..`MAX_REWIND_TICKS` (30 ticks, 500 ms; was 15); the server keeps
  that many ticks of positions. Bullets hit within `TANK_HIT_RADIUS` (`TANK_RADIUS` + 2 = 14 px,
  the drawn body) + the bullet's 4 px.

Measured with a simulation of the real client and server input path (60 fps client, server
timer jitter, 10 seeds x 96 taps per scenario, 10 taps/s):

| Scenario | Shots in a different direction, before → after | Bullets that vanished (predicted, not fired) | Server-only bullets | Own heading jumps on reconcile |
|---|---|---|---|---|
| Steady 20 ms | 0.3% → **0%** | 0 → 0 | 0 → 0 | 9 → **0** |
| Mobile, 50 ms + exp(20 ms) jitter | 22.3% (median 3.9°, max 19.4°) → **0%** | 0 → 0 | 1 → 0 | 755 → **0** |
| 30–200 ms jitter | 22.3% (max 19.4°) → **0%** | 1 → 0 | 1 → 0 | 725 → **0** |
| 200 ms upload stall every 2 s | 24.7% (median 31°, max 42.6°) → **0%** | 18 → **0** | 11 → 0 | 1,889 → **0** |
| Server stall 80 ms every 1.5 s | 1.6% → **0%** | 0 → 0 | 0 → 0 | 462 → **0** |
| 12 taps/s, mobile jitter | 20.1% → **0%** | 8 → **0** | 1 → 0 | 747 → **0** |
| Overflow: 1 s upload stall every 5 s | 12.9% (median 101°) → 1.6% (3.9°) | 23 → 49 | 55 → 35 | 2,831 → 104 |

The last row is beyond the 30-sample cap on purpose: samples are dropped there, so the
soldier's timers drift; aim keeps most headings right. The 8-bot heavy-fire load test is
unchanged locally (press → shot median 35 ms, 77 taps, 0 without a shot, 0 of 3,213 states
differed) and through a lossy link (40 ms each way, 1% of packets held 250 ms) old and new code
measure the same (press → shot median ~107–125 ms; 1–3 taps without a shot per run either way,
probably from events in deltas that failed to apply and bots reading their ammo late; not investigated).
Update 10 Nov: those failed deltas and lost taps came from the test proxy, not the game (see
"UDP game channel").

## UDP game channel (10 Nov 2026)
Problem: on a WebSocket (TCP) one lost packet holds up everything sent after it until it is
resent (head-of-line blocking). Measured with a proxy that models that (40 ms each way, a lost
packet resent after 250 ms): at 1% loss other players froze in 4% of frames (up to 350 ms), at
3% in 12% (up to 1.1 s), and taps reached the server up to 1 s late. At 0% loss everything was
perfect. UDP has no such coupling: a lost packet is just lost, and the next one is on time.

**Design**
- **Channel.** After joining, the client says `hello` (`MSG.rtc`); the server
  (`server/src/udp.ts`, node-datachannel) creates one peer connection for that client and a
  data channel `game`, **unordered, no retransmits**, and makes the offer; the browser
  (`web/src/net/udp.ts`, owned by the session like voice) answers. Signaling (`RtcSignal`:
  offer, answer, ICE candidates, close, each tagged with the connection's id) goes over the
  room's WebSocket, rate-limited. The server learns its public address with STUN
  (`stun:stun.l.google.com:19302`), and with `PUBLIC_IP` set it also offers every host
  candidate with that address (for a 1:1 NAT like EC2 if STUN is blocked). Ports:
  `UDP_PORT_MIN`-`UDP_PORT_MAX` (default 40000-40100). Every WebRTC call is guarded; a failure
  only closes that client's channel, and if the native module doesn't load, everyone stays on
  the WebSocket. Channels close on leave, drop and reconnect (the client asks for a new one).
- **Which path.** The client sends inputs on the channel as soon as it opens. The server sends a
  client's snapshots on the channel while it has heard from it there within 1 s
  (`UDP_IDLE_MS`; clients send at least every 200 ms, servers ping every 250 ms when there are
  no snapshots), and the WebSocket then carries no snapshots for that client. Roster, lobby and
  voice signaling always stay on the WebSocket. The client falls back to the WebSocket if it
  has no `RTCPeerConnection`, the channel isn't open within 5 s, it closes or fails, or nothing
  arrives on it for 1.5 s; it tries again after 10 s, 30 s, 60 s and 120 s. Coming back, the
  server sends a WebSocket keyframe with every event since the client's last ack there.
- **Up (client → server), every frame with samples** (`shared/src/udp.ts`, `encodeUp`): all
  samples the server hasn't acked yet (up to 60, i.e. 1 s; normally 8-15), as one byte each
  plus aim/seen on presses, and `ack` = the newest snapshot tick the client has decoded. Any
  one message that arrives is enough; `InputQueue` already ignores samples it has. Measured: no
  sample ever missing, at any loss.
- **Down (server → client), 30 Hz** (`buildDown`): the server keeps 2 s of snapshot states and
  their events (`SnapshotHistory`). Each client gets a delta against the newest snapshot it
  acked (clients with the same ack share one diff). With no usable ack (new, from another
  match, older than 2 s) it gets a keyframe, then deltas against that keyframe for up to 250 ms
  while the ack is on its way, then another keyframe. Every message names its base tick and
  match (`epoch`, bumped every match, since ticks start over).
- **Client decoding** (`UdpSnapshotDecoder`): a ring of the last 90 decoded states (more than
  the server keeps); a message whose base is in the ring is decoded, anything else (base gone,
  older than what we have, duplicate) is skipped and counted. Nothing ever waits for a missing
  message: the next one is against an acked base the client still has. WebSocket states go into
  the ring too, so switching to the channel needs no keyframe.
- **Events are never lost:** each message carries every event group (events by snapshot tick)
  after the client's ack, so a lost message's events come with the next one;
  `SnapshotFeed` passes on each tick and event once, in order, whichever path brought it.
- **Prediction is unchanged:** snapshots still carry `acks`, and `session.onSnapshot` gives
  `onlineDriver` the same `Snapshot` as before. Both clients use `ClientNet`
  (`shared/src/clientNet.ts`): the browser session and the test bots (`server/src/botNet.ts`).
  Switching either way keeps every unacked sample and resends it on the new path, so no tap is
  lost (smoke test: a tap at the moment of each switch fires).
- **Sizes:** deltas against acked bases are ~0.65 KB (a bit more than consecutive deltas,
  0.52 KB, since the base is a round trip old), under one packet; the largest seen in tests
  ~1.6 KB at 10% loss. Keyframes (~2.8 KB, 3 packets) only go out at the start, on a new
  map, and after a long outage.
- **Game stress for voice:** `onlineDriver` checks every second the share of snapshots that
  never arrived and the snapshot lateness (p95). Over 5% or 60 ms it calls
  `voice.setGameStress(true)` (voice then stops sending your mic); after 3 calm seconds (under 2% and 30 ms),
  `false`.
- Unit tests (`shared/src/udp.test.ts`): message round trips and junk; the real sim, codec and
  `InputQueue` over a simulated link with 1-20% loss and reordering (exact states, events once
  and in order, no input gaps, taps all applied, nothing stalls); a new match; a 3 s downlink
  blackout; a delta without its base skipped then keyframe recovery; the feed across paths.

**Why deltas "failed to apply" through the lossy proxy, even over TCP.** They didn't fail in
the game: the test proxy (`lossyproxy.mjs`) reordered TCP data. It scheduled one `setTimeout`
per chunk, and Node fires timers with different durations but the same deadline out of order;
in a test it delivered 7% (1% loss) to 28% (3% loss) of chunks out of order. Real TCP never does
that. Reordered snapshots broke the delta chain (324 / 870 / 1,702 failed deltas at 1 / 3 / 5%),
and reordered input messages made `InputQueue` drop samples as old, which is where the "taps
without a shot" came from. A FIFO version of the proxy (same delays, in order) gives 0 failed
deltas and 0 taps without a shot. The UDP scheme doesn't depend on order or delivery at all.

**Results, 10 Nov 2026** (same machine; 6 bots, 20 s each, heavy fire, 40 ms one way; UDP with
`UDP_LOSS` both ways and the WebSocket still going through the TCP proxy for signaling and the
roster; WebSocket through the FIFO TCP proxy with 250 ms retransmission; "old proxy" is the
reordering one the earlier numbers came from). Others frozen = 60 fps replay of each bot's
snapshot arrivals through the adaptive delay. Tap → applied = from a tap's sample until a
snapshot shows the server applied it (ack). Press → shot is longer-tailed on every path
because bots tap on stale ammo counts and then wait for the reload.

| Loss | Path | Others frozen (% of frames) | Longest freeze | Freezes > 100 ms | Snapshot gaps > 100 ms | Tap → applied, median / p95 / max | Press → shot, median / p95 | Taps without a shot | Snapshots not shown | Deltas failed | Same game for all |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 0% | UDP channel | **0.0%** | **0 ms** | 0 | 0 | 116 / 138 / 305 ms | 115 / 174 ms | 0 of 47 | 0 (0.0%; 0 without base) | 0 | 0 of 3030 differed |
| 0% | WebSocket (TCP) | 0.0% | 0 ms | 0 | 0 | 117 / 137 / 320 ms | 113 / 173 ms | 0 of 56 | 0 (0.0%) | 0 | 0 of 3030 differed |
| 0% | WebSocket, old proxy | 0.0% | 0 ms | 0 | 0 | 117 / 138 / 299 ms | 114 / 214 ms | 0 of 49 | 0 (0.0%) | 0 | 0 of 3030 differed |
| 1% | UDP channel | **0.0%** | **0 ms** | 0 | 0 | 119 / 140 / 321 ms | 119 / 405 ms | 0 of 60 | 36 (1.0%; 0 without base) | 0 | 0 of 2987 differed |
| 1% | WebSocket (TCP) | 3.9% | 450 ms | 18 | 31 | 146 / 334 / 582 ms | 122 / 282 ms | 0 of 49 | 0 (0.0%) | 0 | 0 of 3018 differed |
| 1% | WebSocket, old proxy | 9.5% | 600 ms | 38 | 43 | 152 / 389 / 657 ms | 118 / 279 ms | 2 of 53 | 364 (10.0%) | 364 | 0 of 2411 differed |
| 3% | UDP channel | **0.1%** | **33 ms** | 0 | 2 | 123 / 146 / 294 ms | 116 / 371 ms | 0 of 52 | 118 (3.2%; 0 without base) | 0 | 0 of 2835 differed |
| 3% | WebSocket (TCP) | 10.5% | 650 ms | 39 | 111 | 253 / 540 / 835 ms | 141 / 349 ms | 0 of 41 | 0 (0.0%) | 0 | 0 of 3020 differed |
| 3% | WebSocket, old proxy | 24.7% | 1283 ms | 80 | 117 | 251 / 757 / 1237 ms | 158 / 910 ms | 4 of 35 | 1023 (28.2%) | 1030 | 0 of 1683 differed |
| 5% | UDP channel | **0.3%** | **50 ms** | 0 | 8 | 123 / 156 / 286 ms | 114 / 389 ms | 0 of 51 | 172 (4.7%; 0 without base) | 0 | 0 of 2754 differed |
| 5% | WebSocket (TCP) | 21.8% | 1667 ms | 77 | 187 | 380 / 1134 / 2197 ms | 171 / 472 ms | 0 of 42 | 0 (0.0%) | 0 | 0 of 3021 differed |
| 5% | WebSocket, old proxy | 36.6% | 2550 ms | 101 | 145 | 366 / 995 / 1853 ms | 325 / 877 ms | 11 of 33 | 1462 (40.8%) | 1470 | 0 of 1178 differed |

All 6 bots opened the channel and stayed on it in every UDP run (0 fallbacks), with 6-8
keyframes per run in total and ~640-690 B per channel message (keepalives included).

On UDP up to 5% loss no frame froze for more than 100 ms (longest 50 ms), every tap fired and
reached the server as fast as with no loss (p95 138 → 156 ms, i.e. one-way delay plus the input
buffer), and snapshots that didn't arrive were simply skipped (0 without a base, 0 failed
deltas). The WebSocket at the same loss froze others for up to 0.45 / 0.65 / 1.7 s (1 / 3 / 5%)
and held taps up to 0.6 / 0.8 / 2.2 s. The "Press → shot" p95 of ~400 ms on UDP is the bots'
stale-ammo effect, not lateness (their taps are all applied within ~0.3 s).

Server cost (8 bots, heavy fire, same machine): tick average ~0.8 ms on UDP against ~0.6 ms with
everyone on the WebSocket (each client's delta is against its own ack; clients with the same
ack share one), max 2-3 ms, 60 ticks/s, 0 of 3,423 states differed.

Also checked: `npm run smoke -w server` with `TRANSPORT=ws` and `TRANSPORT=udp` (the latter
falls back to the WebSocket and back mid-match, with a tap at each switch firing and every tick
once, in order), and real Chrome (Playwright): a tab plays over the channel (`__net.transport`
"udp"), and a tab without `RTCPeerConnection` plays the same match on the WebSocket.

## Possible later improvements
1. Measure the adaptive delay on the deployed server and a real phone; tune its floor (70 ms)
   and the 2 × p95 margin from that.
2. `copyInto` allocates less but costs more CPU than V8's spread clone (~7 µs vs ~0.5 µs per
   state here). If prediction shows up in phone profiles, go back to cloning `prev` each tick
   (one line in `Predictor.tick`).
3. If shoving other players feels rubbery, predict their buttons better (currently assumed
   unchanged since the last snapshot).
