# The original game, measured

How the soldier combat in "2 3 4 Player Games" behaves, measured frame by frame from two screen
recordings (2 Nov 2026). The recordings are kept locally in `reference/` (git-ignored):

- A 2 v 2 match over 5 stages: Garden, Office, Crossroads, Open field, Classroom (237 s).
- A single-player warm-up on an open field, shooting into open space for range (60 s).

Both are 848 × 402 at about 34–36 frames a second, WhatsApp-compressed. Times were taken from each
frame's own timestamp, not the frame count, because the frame rate is uneven.

## Scale
Video pixels are converted to our units with **1 tile (40 px) ≈ 20.6 video px, a factor of about
1.9**:

- The original's floor checker cells are ~10.3 video px; walls are 2 cells thick; the playfield is
  ~52 × 37 cells, so ~26 × 18.5 tiles of 2 cells. Ours are 28 × 18.
- Cross-check: the soldier body is ~16 video px across; × 1.9 gives a radius of ~15 px (ours 14).

Numbers in our units carry about ±5% from this factor. Ratios between two measurements don't.

## Measurements

| Rule | Original | How it was measured | Confidence |
|---|---|---|---|
| Turn speed | One full turn in 1.555 s (±0.01): 231°/s, 1.29π rad/s | Gun pointing straight up at 3 consecutive turns, 30 fps strip | High |
| Turn direction at rest | Counter-clockwise on screen | Same strip | High |
| Tap | Fires and reverses the turn | Zoomed strip of a single tap | High |
| Hold | Walks straight the way it faces, no turning | Several walks | High |
| Walk speed | 97–102 video px/s → ~186 px/s | Clean 0.8 s straight walk (75.9 px in 0.782 s), plus 173 straight 0.4 s windows in the warm-up | High |
| Walk start | Speeds up: ~50–80 video px/s at first, full speed after ~0.4 s | Distance after each walk start in the warm-up | Medium (the press itself isn't visible) |
| Bullet speed | ~330 video px/s (10.8 px per game frame) → ~620 px/s | Pixel tracking of ~40 bullets in both videos | High |
| Bullet range | 205–225 video px (~0.66 s), then bursts into bits in open air → ~410 px, ~10 tiles | 4 bullets that burst in open grass, nothing to hit | High |
| Recoil | None. The shooter never moves backwards | Body position along the shot direction for 10 shots | High |
| Rapid fire | ~10 shots/s; each shot 5–12° off the last as the gun wobbles back and forth | 12-shot burst tracked shot by shot | High |
| Ammo | At least 12 shots in a row without stopping; no ammo shown anywhere | Same burst; zoomed HUD and soldier | Medium |
| Respawn | ~8 s; a ring shows around the soldier at the spawn square for a few seconds | One clear death | Medium |
| Bodies | Lie where they fell until respawn | Several deaths | High |
| Crates | Break into dust when shot | One clear case | High that they break; hits needed unknown |
| Desks / chairs | Pushable, block bullets | Office stage | High |
| Bushes | Bullets fly over them | Warm-up | High |
| Bullet look | Small ball with a light streak behind it; bursts into bits on walls and at the end of its range | Zoomed strips | High |
| Burst power | Bullets in 8 directions, ~3.2 s apart; the soldier flashes | Two bursts | Medium |

## Not measured
- Hold time before walking, and any pause after a tap: needs a recording with "Show taps" on.
- How many hits break a crate or kill a soldier; power-up durations; pushing weights.

## Implemented (2 Nov 2026)
`shared/src/constants.ts`, pending Asad's playtest:

| Constant | Was | Now |
|---|---|---|
| `SPIN_SPEED` | 1.2π | 1.29π |
| Turn direction at rest | Clockwise | Counter-clockwise (`spinDir` starts at -1) |
| `DRIVE_SPEED` | 160 | 186 |
| Walk start | Full speed at once | `DRIVE_START` 0.5 of full, rising to full over `DRIVE_RAMP_MS` 400 |
| `BULLET_SPEED` | 440 | 620 |
| `BULLET_RANGE` | 320 | 410 |
| `RAPID_FIRE_MS` | 250 (snap back to one line) | 0 (shots follow the wobbling gun, so they fan out) |
| `UNLIMITED_AMMO` | — (6 rounds, 1.5 s reload) | true; set false to bring the magazine back |
| `CRATE_BREAKS` | — | true: one bullet breaks a crate (beds don't break) |

Not changed: respawn (already 8 s), recoil (none in either), map sizes and layouts (next step).
