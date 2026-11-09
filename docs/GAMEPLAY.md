# Gameplay reference

Everything here is implemented in `shared/src/` and covered by `shared/src/sim.test.ts`.
All numbers are in `shared/src/constants.ts`; change them there, not in the code.
Turning, walking, bullets, ammo and crates follow measurements of the original game: see
[ORIGINAL.md](ORIGINAL.md).

## The one button
| Action | Result |
|---|---|
| Nothing pressed | The soldier turns in place (`SPIN_SPEED`, 1.29π rad/s, one turn in 1.55 s), counter-clockwise at first. |
| Any press | Fires one bullet immediately and reverses the turning direction. The heading holds still while the button is down and for `SPIN_PAUSE_MS` (60 ms) after. |
| A press that can't fire | Inside the bounce guard (`FIRE_COOLDOWN_MS`): nothing happens, the gun keeps turning the same way. With an empty magazine: a dry click, no shot, but the turn still reverses so you can keep aiming. |
| Keep holding for `DEFAULT_HOLD_MS` (100 ms) | Walks forward, exactly the way you were facing when you pressed, until released: starts at `DRIVE_START` (half) of `DRIVE_SPEED` (186 px/s) and reaches full speed after `DRIVE_RAMP_MS` (0.4 s). Releasing never fires. A normal finger tap (up to ~90 ms) never walks. |
| Tap quickly (spray) | Shots less than `RAPID_FIRE_MS` (250 ms) apart are one burst. Each follows the gun as it wobbles back and forth, so the burst fans out like the original's, but never more than `RAPID_FIRE_WOBBLE` (12°) either side of the burst's first shot, so uneven tapping can't make it creep sideways. Wobble 0 would snap every burst shot onto one line. |

Input bounce guard: shots closer than `FIRE_COOLDOWN_MS` (66 ms, 4 ticks) don't fire. It is well
under the original's ~10 taps a second, so every real spray tap fires. A second finger tapping
while the first is still down counts as a tap too.

## Ammo
- `MAX_AMMO` = 6 rounds, one back every `RELOAD_MS` (1.5 s), shown as dots under your soldier.
  With 0 rounds a tap still turns you but doesn't fire. Respawning refills the magazine.
- `UNLIMITED_AMMO` (off) removes the magazine, like the original: no dots, only the fire cooldown
  limits shots (about 10 a second).

## Bullets
- Speed `BULLET_SPEED` (620 px/s), range `BULLET_RANGE` (410 px, about 10 tiles), then they drop.
- A bullet hits a soldier anywhere along the stretch it flew that tick (not only where it
  ended), so at 10 px a tick it can't skip past the edge of a soldier.
- Online, a shot is checked against enemies where the shooter's screen showed them when they
  fired (others are drawn a little in the past), up to `MAX_REWIND_TICKS` (250 ms) back. So if
  it looked like a hit, it is one; on high ping a victim can occasionally fall just after
  reaching cover.
- They stop on walls, crates, desks, beds and power boxes. They fly over water and bushes.
  Teammates can't hurt each other.
- Crates never break (`CRATE_BREAKS` off): they are solid cover you push into a lane to block it.
  With `CRATE_BREAKS` on, a bullet breaks the crate it hits: splinters, and the crate is gone until the
  next round. Desks, beds and power boxes never break. Every press fires first, so walking straight
  at a crate in range breaks it; a crate still gets shoved when you bump into it from the side.
- One hit kills, unless the target has a shield (see power-ups). Respawn after `RESPAWN_MS` (8 s) on your
  team's respawn square; the body lies where it fell until then. A soldier who just respawned
  can't be hurt for `SPAWN_SHIELD_MS` (2 s): a faint blinking bubble, bullets stop on it.
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
- Each team's flag stands at its base, a team-coloured ring around the flag stand
  (`r` / `b` in the map legend). The ring is drawn at exactly `BASE_RADIUS` (20 px) and the flag
  inside `FLAG_RADIUS` (6 px), so what you see is what counts.
- Touch the enemy flag to pick it up: your centre within `TANK_RADIUS` + `FLAG_RADIUS` (20 px)
  of it, so your body has to reach the flag itself, not just pass near it. It rides on your back.
  Carriers walk at `CARRIER_SPEED` (0.8×) of their speed: 0.8× normally, 1.6 × 0.8 = 1.28×
  with the speed power.
- Carry it home to win the round: your centre within `BASE_RADIUS` (20 px) of your own flag
  stand, i.e. standing on the stand. The respawn square doesn't count. A "RED WINS" / "BLUE WINS" banner shows,
  everything freezes, and after `ROUND_RESTART_MS` (6 s) a fresh round starts: everyone back on
  their respawn square, flags home, crates and power boxes reset.
- Shoot the carrier and the flag drops where they fall. An enemy can grab it again; one of its
  own team touching it sends it home. Left alone it goes home after `FLAG_RETURN_MS` (15 s),
  shown by a ring that empties around it.
- Your own flag at home can't be picked up by your team. You can only score while your own
  flag is home: if the other team holds yours, get it back first (shoot their carrier, then
  touch your dropped flag).

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
Soldiers, crates, desks, beds and power boxes never overlap. Two bodies pushing each other move together at a
speed set by their weights:

| Body | Weight |
|---|---|
| Walking soldier | `TANK_MASS` = 1 |
| Standing soldier (brakes on) | 1 × `IDLE_TANK_BRAKE` = 2 |
| Fallen soldier (until respawn) | `BODY_MASS` = 2 |
| Crate / power box, once sliding | `CRATE_MASS` = 3 |
| Crate / power box, at rest | 3 × `CRATE_STATIC` = 6, loosening over `CRATE_BREAKAWAY_MS` (0.6 s) |
| Desk (Office, Classroom), once sliding | `DESK_MASS` = 4 |
| Desk, at rest | 4 × `CRATE_STATIC` = 8, loosening the same way |
| Bed (Classroom), once sliding | `BED_MASS` = 6 |
| Bed, at rest | 6 × `CRATE_STATIC` = 12, loosening the same way |

So you shove a standing soldier at ⅓ speed, two soldiers walking head-on stall, and a crate
starts slow then slides at about 47 px/s. A desk (`DESK_SIZE` 34 px, one tile) slides at about
37 px/s. A bed (`BED_SIZE` 108 px on a 2 × 2 tile spot, leaving 12 px gaps between neighbours, too narrow for a soldier: go round or push them apart) slides at about 27 px/s; pushing a bed into the
bed next to it pushes both, so packed rows barely move. Walls never move; whatever a wall blocks
pushes back on the pusher.

**Blocks turn like real furniture.** Crates, desks, beds and solid power boxes have an angle
(every map starts them square, angle 0) and turn when pushed off-centre, so beds and desks end
up tilted after a shove, as in the original:

- Push the middle of a face and the block goes straight, without turning.
- Push near a corner and it moves *and* turns: it swings round and slides off at an angle. Each
  tick a push that moves the block by *d* at a point *r* from its centre turns it by
  `BLOCK_TURN` (1) × (*r* × *d*) / half-size² radians, at most `BLOCK_MAX_TURN` (0.06 rad,
  about 3.4°) per push. Through the centre that is 0; at a corner it is largest.
- Heavier and bigger blocks turn less: *d* already shrinks with weight (the table above), and
  the half-size² grows with size. Walking into a crate 2 px from its corner turns it about
  30° in the first second and about 50° by the time you slip off its corner; a bed pushed at
  the same spot turns about 19° in that first second.
- Blocks never spin on their own: no push, no turn. There is no spin carried between ticks.
- Chains work the same way: a bed pushed off-centre into the next bed turns it too. Blocks,
  soldiers and walls never overlap.
- Walls: a block never goes into a wall or water, and never turns into one. A tilted block
  pushed against a wall is pushed back where its corner touches, so it turns flat against the
  wall.
- Bullets stop on the block's real (turned) shape.

**Grip.** Walking into the middle of a face you grip it like friction: sideways walking up to
`PUSH_GRIP` (0.6) times the forward walking is cancelled, so a heading up to about 31° off the
face still pushes it straight and you stay behind it. The grip fades towards the face's ends
(none at a corner), so pushing near a corner you slide towards it as the block turns, swing it
round and slip off. Steeper headings slide along the face, and a soldier who only clips a corner
glances off. Standing beside a corner (your centre past the face's edge) you are not gripped:
you slip past the corner instead of sticking to it.

## Power-up boxes
- Purple "?" boxes. Touch one (walk into it) to get a random power; shooting it does nothing.
- One power at a time. With a power active, boxes are solid and push like crates.
- Boxes are **not on the map when a round starts**. Each appears after a random
  `POWER_START_MIN_MS`..`POWER_START_MAX_MS` (5–15 s), and after being taken comes back to its
  home spot after a random `POWER_RESPAWN_MIN_MS`..`POWER_RESPAWN_MAX_MS` (15–30 s). Nobody can
  time them. A hidden box isn't drawn and pops in with a ring.
- Every map has 2–4 boxes, each more than 4 tiles from both flag stands, so a carrier can't
  grab a shield on the way home without a detour.
- Dying clears your power.

| Power | Effect | Lasts |
|---|---|---|
| Shield | Stops `SHIELD_HITS` (5) bullets. The bubble shows the hits left as 5 segments; each hit sparks, the last one shatters it, and the next bullet kills. Blinks in the last 2 s. | `SHIELD_MS` 10 s or 5 hits, whichever comes first |
| Speed | Walk at `SPEED_BOOST` 1.6×. | `SPEED_MS` 14 s |
| Flare | 4 bullets (front, back, left, right) every `FLARE_INTERVAL_MS` 2 s, no ammo used. 7 bursts. | `FLARE_MS` 14 s |

Random rolls use a seeded generator stored in the game state, so the server and every client
roll the same. The server (and solo practice) picks a fresh seed for every match, so box
timings and kinds differ from game to game.

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
| Shield breaks (last hit) | Glassy crash. |
| Power picked up | Rising notes, different for shield, speed and flare. |
| Flag taken | Rising two notes when your team takes theirs; a three-note alarm when they take yours. |
| Flag dropped / returned | Falling two notes / bright chime. |
| Round won / lost | Fanfare / falling minor phrase. |
| New round | Beep, beep, higher beep. |

## Maps
All maps are 26 × 18 tiles (40 px each, 1040 × 720 px), the original's ~1.41:1 shape, so they
fill a phone held sideways. They are defined as text in `shared/src/maps.ts` (Arena is in
`map.ts`). Legend: `#` wall, `.` floor, `1`/`2` red/blue respawn square (a 2 × 2 block),
`X` crate, `P` power box, `r`/`b` red/blue flag stand, `T` bed (each 2 × 2 block is one bed),
`D` desk, `~` water, `,` wood floor, `*` bush.

- **Desks** are one-tile furniture: heavy, pushable, they stop bullets and never break.
- **Bushes** are decoration only: you walk through them and bullets fly over them.
- **Water** blocks walking and sliding bodies, but bullets fly over it.

| Map | Theme | Layout |
|---|---|---|
| Arena | Stone | The classic practice arena, now mirrored. Each flag behind a 5 × 2 wall facing the middle, so attackers go round the top or bottom. Cover blocks, 8 crates, 2 power boxes in the open centre. |
| Crossfire | Stone | Open middle around a 2 × 2 pillar. Each flag in a U of walls that opens towards its own back wall: no straight shot from the middle, but chasers can follow a carrier in. Power boxes beside the pillar. |
| Fortress | Stone | A walled band around each flag with 2-tile doors top and bottom and an open front; rooms behind it with doors and gaps, no dead ends. Crates by the doors to push in as barricades. 4 power boxes in the top and bottom lanes. |
| Canyon | Stone | Three long lanes split by long walls, joined in the middle. Flags at the ends of the middle lane behind edge stubs, with a crate for defenders. Power boxes in the middle lane, 7 tiles from each flag. |
| Classroom | Wood | 22 movable beds in rows with one-tile aisles, an open centre with the 2 power boxes. Flags on the left and right edges by the teacher's desks. Respawn squares in opposite corners behind a short wall. |
| Garden | Grass | A wooden house split by a 2-wide centre wall, each team's flag against it in the upper room (three ways in). Pool along the top with a walled island of bushes. The bottom grass strip is the only route between the sides. |
| Crossroads | Tiles | Plus- and T-shaped walls, notches on every edge, a long centre bar. Each team's flag and respawn square in opposite corners of the same side. Power boxes above and below the centre block. |
| Office | Office | Orange office floor with white washroom corridors along the top and bottom (respawn squares in their corner closets). Each flag in front of a cluster of 8 desks around a crate, in a pocket made by an L wall. |
| Open Field | Grass | Open grass with 2 big blocks and 2 small pillars. Small wooden bases with corner posts on the left and right edges hold the flags; respawn squares in wooden alcoves in opposite corners; bushes in two corners. |

Classroom, Garden, Crossroads, Office and Open Field recreate the layouts of the original app's
capture-the-flag maps (a grid laid over frames of the original) in our own art.

Practice any map solo with `/play?map=<id>` (ids: `arena`, `crossfire`, `fortress`, `canyon`,
`classroom`, `garden`, `crossroads`, `office`, `field`).

Every map is exactly fair: Blue's side is Red's mirrored (Arena, Crossfire, Fortress, Canyon,
Garden) or turned half a turn (Classroom, Crossroads, Office, Open Field). With 18 rows there is
no centre row, so on the half-turn maps the two flags sit one row apart.
`shared/src/maps.test.ts` checks every map: right size, nothing inside walls or water, every
spawn can reach both flags and every power box, respawn squares clear of walls, more than 3
tiles from their own flag and more than 6 from the enemy's, cover (wall, desk, bed or crate)
within 3 tiles of each flag stand, 2–4 power boxes each more than 4 tiles from both flags, no
reachable dead ends, nothing starting on top of anything else, and the symmetry.

When creating a room you pick a map for each round (tap a round, then a map; tapping maps in
order fills the rounds in order). Rounds you don't change cycle through the maps. The join page
shows each round's map, the scoreboard shows the current one, and the round banner names the
next.
