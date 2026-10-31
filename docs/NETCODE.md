# Netcode and test results

## How it works
- The server runs the shared sim at 60 Hz. Players send only button down/up (a few bytes,
  only when it changes). A press that starts and ends between two ticks still counts.
- Every 2nd tick (30 Hz) the server broadcasts a snapshot: the full game state plus the events
  since the last one.
- Clients draw `INTERP_DELAY_MS` (100 ms) behind the newest snapshot and blend between the two
  around that time, so motion is smooth even when snapshots arrive unevenly.
- No client prediction yet: your own soldier is also shown from snapshots.

## Load test
`npm run loadtest -w server` (with the server running). Env: `SERVER_URL`, `PLAYERS` (8),
`SECONDS` (20). Bots tap and walk at random. Run the server with `TICK_STATS=1` to log tick
timing, and with `COLYSEUS_LATENCY=<ms>` to simulate a round trip.

## Results, 31 Oct 2026 (MacBook, server and clients on the same machine)
8 players, 20 s each run.

| | Same machine | 100 ms simulated round trip |
|---|---|---|
| Server ticks/s | 60.0 | 60.2 |
| Server tick cost | avg 0.25–0.35 ms, max 1.9 ms (of a 16.7 ms budget) | same |
| Snapshots per player | 30.0/s | 30.1–30.6/s |
| Gap between snapshots | median 33.7, p95 35, p99 48.5, max 50 ms | median 33.6, p95 35, max 51 ms |
| Press → shot in a snapshot | median 18 ms, p95 34 ms | median 121 ms, p95 137 ms |
| Taps that never produced a shot | 0 of 80 | 0 of 65 |
| Snapshot size | ~2.7 KB, ~80 KB/s per player | same |
| Players seeing the same state | 4,207 ticks compared, 0 differed | 4,248 compared, 0 differed |
| 9th player | rejected, room full | rejected |

Browser as the 8th player with 7 bots (same machine), 8 s measured:
961 frames at 120 fps (frame time median 8.3 ms, max 9.4 ms), 0 frames that ran out of
snapshots, 2–3 snapshots always buffered ahead of the render time.

## What a player feels
Time from pressing until you see your own soldier react:

| Connection | Server sees it | You see it (+100 ms smoothing buffer) |
|---|---|---|
| Same Wi-Fi / same machine | ~18 ms | ~120 ms |
| Internet, 100 ms round trip | ~121 ms | ~220 ms |

The sync itself is solid: steady 30 Hz, no hitches, identical state for everyone, and the
server is at about 2% load with 8 players. The weak spot is input delay. In a one-button game
you time your tap to the spinning gun, so 120–220 ms of delay will make aiming feel late.

## Planned improvements (in order)
1. Client prediction for your own soldier: run the shared sim locally for your own input and
   correct it when snapshots arrive. Your own turning, walking and shooting would feel instant.
2. Lower the smoothing buffer from 100 ms to ~60–70 ms once real-network jitter is measured
   (p99 snapshot gap here was ~49 ms).
3. Trim snapshots (round numbers, drop fields that rarely change) if bandwidth matters on
   mobile data. 80 KB/s is fine on Wi-Fi.
