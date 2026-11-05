# Netcode and test results

## How it works
- The server runs the shared sim at 60 Hz. Each client samples its button once per sim tick,
  numbers the sample (`seq`) and sends it (batched per frame, a few bytes each).
- The server keeps a small queue of samples per player (`InputQueue`, `shared/src/prediction.ts`)
  and applies exactly one per tick. It normally holds about 2 samples to ride out jitter; a
  bigger backlog is drained one extra sample per tick, and a tap is never lost when samples are
  merged.
- Every 2nd tick (30 Hz) the server broadcasts a snapshot: the game state, the events since
  the last one, and per player the `ack` (last sample applied).
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
  `delayMs`, `jitterP95Ms`, `keyframes`, `deltas`, `keyframeRequests` and `offsetResets`.

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

## Possible later improvements
1. Measure the adaptive delay on the deployed server and a real phone; tune its floor (70 ms)
   and the 2 × p95 margin from that.
2. `copyInto` allocates less but costs more CPU than V8's spread clone (~7 µs vs ~0.5 µs per
   state here). If prediction shows up in phone profiles, go back to cloning `prev` each tick
   (one line in `Predictor.tick`).
3. If shoving other players feels rubbery, predict their buttons better (currently assumed
   unchanged since the last snapshot).
