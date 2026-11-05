# Gameplay reference

Everything here is implemented in `shared/src/` and covered by `shared/src/sim.test.ts`.
All numbers are in `shared/src/constants.ts`; change them there, not in the code.
Turning, walking, bullets, ammo and crates follow measurements of the original game: see
[ORIGINAL.md](ORIGINAL.md).

## The one button
| Action | Result |
|---|---|
| Nothing pressed | The soldier turns in place (`SPIN_SPEED`, 1.29π rad/s, one turn in 1.55 s), counter-clockwise at first. |
| Any press | Fires one bullet immediately and reverses the turning direction. The heading then holds still for `SPIN_PAUSE_MS` (60 ms). |
| Keep holding for `DEFAULT_HOLD_MS` (60 ms) | Walks forward until released: starts at `DRIVE_START` (half) of `DRIVE_SPEED` (186 px/s) and reaches full speed after `DRIVE_RAMP_MS` (0.4 s). Releasing never fires. |
| Tap quickly | Each shot follows the gun as it wobbles back and forth, so a burst fans out a few degrees around one line. (`RAPID_FIRE_MS` is 0; set it above 0 to snap every quick shot back onto the first one's line.) |

Input bounce guard: shots closer than `FIRE_COOLDOWN_MS` (100 ms) don't fire.

## Ammo
- Unlimited (`UNLIMITED_AMMO`), like the original: no ammo dots, only the fire cooldown limits
  shots (about 10 a second).
- With `UNLIMITED_AMMO` off: `MAX_AMMO` = 6 rounds, one back every `RELOAD_MS` (1.5 s), shown as
  dots under your soldier. With 0 rounds a tap still turns you but doesn't fire. Respawning
  refills the magazine.

## Bullets
- Speed `BULLET_SPEED` (620 px/s), range `BULLET_RANGE` (410 px, about 10 tiles), then they drop.
- They stop on walls, crates, beds and power boxes. Teammates can't hurt each other.
- A bullet breaks the crate it hits (`CRATE_BREAKS`): splinters, and the crate is gone until the
  next round. Beds and power boxes don't break. Every press fires first, so walking straight
  at a crate in range breaks it; a crate still gets shoved when you bump into it from the side.
- One hit kills, unless the target has a shield. Respawn after `RESPAWN_MS` (8 s) on your
  team's respawn square; the body lies where it fell until then.
- A fallen body is cover for its own team: it stops the other team's bullets until that soldier
  respawns. Teammates' bullets pass straight through it. Bodies are solid and can be pushed (see
  weights below), and the cover moves with them.

## Falling
- Shot while walking: the body keeps sliding forward and falls face-first, slowing by
  `BODY_FRICTION` (420 px/s²), so about 40 px at full walking speed. Walls and crates stop it.
- Shot while standing: knocked back along the bullet's path at `HIT_KNOCKBACK` (70 px/s),
  a few pixels, and falls away from the shooter.

## Capture the flag
- Each team has a **respawn square** (2 × 2 tiles, `SPAWN_PAD_SIZE` 80 px, `1` / `2` in the map
  legend) with four spawn spots. Everyone starts each round there and comes back there after
  dying. With more than four on a team, soldiers sharing a spot get pushed apart.
- Each team's flag stands at its base, a dashed ring (`BASE_RADIUS` 34 px) around the flag
  stand: `r` / `b` in the map legend.
- Touch the enemy flag to pick it up; it rides on your back. Carriers walk at
  `CARRIER_SPEED` (0.8×).
- Carry it into your own base (the ring around your own flag stand) to win the round. The
  respawn square doesn't count. A "RED WINS" / "BLUE WINS" banner shows,
  everything freezes, and after `ROUND_RESTART_MS` (6 s) a fresh round starts: everyone back on
  their respawn square, flags home, crates and power boxes reset.
- Shoot the carrier and the flag drops where they fall. An enemy can grab it again; one of its
  own team touching it sends it home. Left alone it goes home after `FLAG_RETURN_MS` (15 s),
  shown by a ring that empties around it.
- Your own flag at home can't be picked up by your team. Scoring doesn't require your own flag
  to be home.

## Match types
Picked by whoever creates the room (home page → Match). The join page shows it.

| Type | Rounds | How it's won |
|---|---|---|
| Single match | 1 | The first capture wins. "RED WINS", then a new match after `MATCH_RESTART_MS` (10 s). |
| Tournament | 5 or 7 | Each round won is worth `ROUND_POINTS` (2). All rounds are played, even if one team can no longer be caught. After the last round, most points wins: "RED WINS THE TOURNAMENT". |

- Between tournament rounds: "RED WINS ROUND 2" with the score, then the next round after
  `ROUND_RESTART_MS` (6 s). After the last round the final banner shows for 10 s and a new
  tournament of the same length starts.
- A small scoreboard on the top wall shows the round and points (tournaments only).
- Every round ends in a capture and the round counts are odd, so a tournament always has
  exactly one champion.

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
| Bed (Classroom), once sliding | `BED_MASS` = 6 |
| Bed, at rest | 6 × `CRATE_STATIC` = 12, loosening the same way |

So you shove a standing soldier at ⅓ speed, two soldiers walking head-on stall, and a crate
starts slow then slides at about 47 px/s. A bed (`BED_SIZE` 76 px, 2 × 2 tiles) slides at
about 27 px/s; pushing a bed into the bed next to it pushes both, so packed rows barely move. Walls never move; whatever a wall blocks pushes back
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

## Sounds
Synthesized in the browser (`web/src/game/sound.ts`, no audio files). Audio starts on the first
press; the "Sound on / off" button top-right mutes it and is remembered on the device.

| Event | Sound |
|---|---|
| Shot | Short crack. Other players' shots are quieter the farther away they are; everything pans left/right with where it happens. |
| Flare burst | Rising whoosh instead of four shots. |
| Your bullet drops | Soft tick. |
| Someone is shot | Thud and falling groan; a bright two-note confirm if you shot them. |
| You are shot | Low dull hit. |
| Shield blocks a bullet | Metallic ping. |
| Power picked up | Rising notes, different for shield, speed and flare. |
| Flag taken | Rising two notes when your team takes theirs; a three-note alarm when they take yours. |
| Flag dropped / returned | Falling two notes / bright chime. |
| Round won / lost | Fanfare / falling minor phrase. |
| New round | Beep, beep, higher beep. |

## Maps
All maps are 28×18 tiles (40 px each), defined as text in `shared/src/maps.ts` (Arena is in
`map.ts`). Legend: `#` wall, `.` floor, `1`/`2` red/blue respawn square (a 2 × 2 block),
`X` crate, `P` power box, `r`/`b` red/blue flag stand, `T` bed (each 2 × 2 block is one bed),
`~` water, `,` wood floor.

| Map | Layout |
|---|---|
| Arena | The original practice arena, flags on the left and right middle, respawn squares in the top corners. |
| Crossfire | Open middle with cover blocks; each flag in a U of walls. Respawn squares top left and top right. |
| Fortress | Walled-in rooms with narrow doors (respawn squares in the top rooms, flags in the middle ones); crates near the doors can be pushed in as barricades. |
| Canyon | Three long lanes split by walls, joined in the middle and at the ends. Respawn squares at the top ends. |
| Classroom | Wooden floor packed with 30 movable beds in rows, 4 px apart side by side, with one-tile aisles between rows. Push beds aside to cut through. Flags on the left and right edges; respawn squares in opposite corners behind a short wall. |
| Garden | Grass, a house with one wooden room per team and doors in its outer walls, a pool along the top. Respawn squares in the top corners. |
| Crossroads | Light tiles, plus-shaped walls, notches along the edges, a centre block. Each team's flag and respawn square in opposite corners. |

Classroom, Garden and Crossroads recreate the layouts of the original app's capture-the-flag
maps in our own art. **Water** blocks walking and sliding bodies, but bullets fly over it.

Practice any map solo with `/play?map=<id>` (e.g. `/play?map=garden`).

Every map except Arena is exactly fair: Blue's side is Red's mirrored (Crossfire, Fortress,
Canyon, Garden) or rotated half a turn (Classroom, Crossroads). `shared/src/maps.test.ts` checks every map: right size, nothing inside walls or water, every
spawn can reach both flags and every power box, respawn squares clear of walls and away from
the flags, nothing starting on top of anything else, and the symmetry.

When creating a room you pick a map for each round (tap a round, then a map; tapping maps in
order fills the rounds in order). Rounds you don't change cycle through the maps. The join page
shows each round's map, the scoreboard shows the current one, and the round banner names the
next.
