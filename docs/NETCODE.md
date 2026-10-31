# Netcode and test results

## How it works
- The server runs the shared sim at 60 Hz. Each client samples its button once per sim tick,
  numbers the sample (`seq`) and sends it (batched per frame, a few bytes each).
- The server keeps a small queue of samples per player (`InputQueue`, `shared/src/prediction.ts`)
  and applies exactly one per tick. It normally holds about 2 samples to ride out jitter; a
  bigger backlog is drained one extra sample per tick, and a tap is never lost when samples are
  merged.
- Every 2nd tick (30 Hz) the server broadcasts a snapshot: the full game state, the events since
  the last one, and per player the `ack` (last sample applied).
- **Your own soldier is predicted** (`Predictor`): the client runs the shared sim ahead with
  your own samples, so turning, walking and shooting show on the next frame. When a snapshot
  arrives it restarts from the server state and replays the samples the server hasn't applied
  yet. Small disagreements glide into place over ~100 ms; big ones (respawn) snap.
- Your bullets, crates and power boxes come from the same prediction, so they line up with you.
- **Other players** are drawn `INTERP_DELAY_MS` (100 ms) behind the newest snapshot, blending
  between the two around that time, so they move smoothly even when packets arrive unevenly.

## Testing it
- `npm run loadtest -w server` (server running): bots tap and walk at random and the script
  reports tick rate, snapshot jitter, press-to-shot time (as the server and other players see
  it), snapshot size and whether all players saw identical state. Env: `SERVER_URL`,
  `PLAYERS` (8), `SECONDS` (20).
- Server env: `TICK_STATS=1` logs tick cost; `COLYSEUS_LATENCY=<ms>` simulates a round trip.
- Browser, dev only: `?server=ws://localhost:2571` points a tab at another game server, and
  `window.__net` shows frames, starved frames, prediction corrections and samples in flight.

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

## Possible later improvements
1. Lower the smoothing buffer for other players from 100 ms to ~60–70 ms once real-network
   jitter is measured after deploying (p99 snapshot gap here was ~49 ms).
2. Trim snapshots (round numbers, drop fields that rarely change) if bandwidth matters on
   mobile data. 83 KB/s is fine on Wi-Fi.
3. If shoving other players feels rubbery, predict their buttons better (currently assumed
   unchanged since the last snapshot).
