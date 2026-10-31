# Gameplay reference

Everything here is implemented in `shared/src/` and covered by `shared/src/sim.test.ts`.
All numbers are in `shared/src/constants.ts`; change them there, not in the code.

## The one button
| Action | Result |
|---|---|
| Nothing pressed | The soldier turns in place (`SPIN_SPEED`, 1.2π rad/s). |
| Any press | Fires one bullet immediately and reverses the turning direction. The heading then holds still for `SPIN_PAUSE_MS` (60 ms). |
| Keep holding for `DEFAULT_HOLD_MS` (60 ms) | Walks forward at `DRIVE_SPEED` (160 px/s) until released. Releasing never fires. |
| Tap again within `RAPID_FIRE_MS` (250 ms) | The gun snaps back to the first shot's heading, so rapid tapping fires in one straight line. |

Input bounce guard: shots closer than `FIRE_COOLDOWN_MS` (100 ms) don't fire.

## Ammo
- `MAX_AMMO` = 6 rounds. One round comes back every `RELOAD_MS` (1.5 s) while below full.
- With 0 rounds a tap still turns you but doesn't fire. Respawning refills the magazine.

## Bullets
- Speed `BULLET_SPEED` (440 px/s), range `BULLET_RANGE` (320 px), then they drop.
- They stop on walls, crates and power boxes. Teammates can't hurt each other.
- One hit kills, unless the target has a shield. Respawn after `RESPAWN_MS` (2 s); the body lies
  where it fell until then.
- A fallen body is cover for its own team: it stops the other team's bullets until that soldier
  respawns. Teammates' bullets pass straight through it. Bodies are solid and can be pushed (see
  weights below), and the cover moves with them.

## Pushing and weight
Soldiers, crates and power boxes never overlap. Two bodies pushing each other move together at a
speed set by their weights:

| Body | Weight |
|---|---|
| Walking soldier | `TANK_MASS` = 1 |
| Standing soldier (brakes on) | 1 × `IDLE_TANK_BRAKE` = 2 |
| Fallen soldier (until respawn) | `BODY_MASS` = 2 |
| Crate / power box, once sliding | `CRATE_MASS` = 3 |
| Crate / power box, at rest | 3 × `CRATE_STATIC` = 6, loosening over `CRATE_BREAKAWAY_MS` (0.6 s) |

So you shove a standing soldier at ⅓ speed, two soldiers walking head-on stall, and a crate
starts slow then slides at about 40 px/s. Walls never move; whatever a wall blocks pushes back
on the pusher.

## Power-up boxes
- Purple "?" boxes. Touch one (walk into it) to get a random power; shooting it does nothing.
- One power at a time. With a power active, boxes are solid and push like crates.
- A taken box returns to its home spot after `POWER_RESPAWN_MS` (12 s).
- Dying clears your power.

| Power | Effect | Lasts |
|---|---|---|
| Shield | Blocks every bullet. Blinks in the last 2 s. | `SHIELD_MS` 14 s |
| Speed | Walk at `SPEED_BOOST` 1.6×. | `SPEED_MS` 14 s |
| Flare | 4 bullets (front, back, left, right) every `FLARE_INTERVAL_MS` 2 s, no ammo used. 7 bursts. | `FLARE_MS` 14 s |

Random rolls use a seeded generator stored in the game state, so the server and every client
roll the same.

## Map
`shared/src/map.ts`, a 28×18 tile grid (40 px tiles). Legend: `#` wall, `.` floor,
`R`/`B` red/blue spawn, `X` crate, `P` power box. The current arena is a placeholder until the
CTF rules exist.
