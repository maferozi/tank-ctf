// Fixed simulation rate. The client and (later) the server step the same sim at this rate.
export const TICK_HZ = 60;
export const TICK_MS = 1000 / TICK_HZ;

export const TILE = 40;

// One-button control: every press fires and flips the spin direction;
// keeping it held for holdMs drives forward.
export const DEFAULT_HOLD_MS = 60;
export const MIN_HOLD_MS = 30;
export const MAX_HOLD_MS = 250;

export const TANK_RADIUS = 14;

// Weights. When bodies push each other they move together at a speed set by their
// weights (a light pusher against a heavy body barely moves it).
export const TANK_MASS = 1;
export const IDLE_TANK_BRAKE = 2; // an idle tank has its brakes on: counts as 2x heavier
export const BODY_MASS = 2; // a fallen soldier: solid and pushable until they respawn
export const CRATE_SIZE = 32; // px, square
export const CRATE_MASS = 3;
// Off: crates are solid cover that players push into lanes to block them, so shooting them
// must not destroy them. On: one bullet breaks a crate, as in the original (beds, desks never).
export const CRATE_BREAKS = false;
// Crates "stick" at first: they start CRATE_STATIC times heavier and loosen up to
// CRATE_MASS after being pushed for CRATE_BREAKAWAY_MS.
export const CRATE_STATIC = 2;
export const CRATE_BREAKAWAY_MS = 600;
// Beds (Classroom): big movable blocks, 2 x 2 tiles, twice a crate's weight. They stick and
// loosen like crates.
export const BED_SIZE = 76; // px, square; leaves a 4 px gap between beds placed side by side
export const BED_MASS = 6;
// Desks (Office): one-tile furniture, a bit bigger and heavier than a crate. They stick and
// loosen like crates, stop bullets and never break.
export const DESK_SIZE = 34; // px, square
export const DESK_MASS = 4;
// A soldier walking into a crate, desk, bed or power box pushes it straight along the face
// it hits (picked from the walking heading), so it can't skid off sideways. The soldier also
// grips that face: sideways walking of up to PUSH_GRIP times the forward walking is cancelled
// (like friction), so walking a little off-axis still pushes straight instead of sliding around
// the box. Only steeper headings slide along the face.
export const PUSH_GRIP = 0.6; // grips headings up to ~31 degrees off the face's axis
// Measured from the original (docs/ORIGINAL.md): one full turn in 1.555 s.
export const SPIN_SPEED = Math.PI * 1.29; // rad/s while not driving
// After each press the tank holds its heading this long before spinning the other way,
// so rapid tapping keeps the barrel wobbling around one line instead of sweeping.
export const SPIN_PAUSE_MS = 60;
// A press this soon after the previous one fires along the previous shot's heading
// (the barrel snaps back), so rapid tapping fires in one straight line. 0 disables it:
// shots then follow the wobbling gun and fan out a little, as in the original.
export const RAPID_FIRE_MS = 0;
export const DRIVE_SPEED = 186; // px/s, full walking speed
// Walking starts at DRIVE_START of full speed and reaches full speed after DRIVE_RAMP_MS.
export const DRIVE_START = 0.5;
export const DRIVE_RAMP_MS = 400;

export const BULLET_SPEED = 620; // px/s
export const BULLET_RADIUS = 4;
export const BULLET_RANGE = 410; // px travelled before the bullet drops
export const BULLET_FADE = 80; // last px of range drawn fading out
// Shorter than a fast double tap, so every real tap fires; only stops input bounce.
export const FIRE_COOLDOWN_MS = 100;
// Off (players' call, 5 Nov 2026): a 6-round magazine that reloads one round at a time, so
// you can't spray forever. The original never runs dry; set true for that.
export const UNLIMITED_AMMO = false;
export const MAX_AMMO = 6;
export const RELOAD_MS = 1500; // one round back every RELOAD_MS while below MAX_AMMO

export const RESPAWN_MS = 8000;

// Falling. A soldier shot while walking keeps sliding forward and falls face-first; a
// standing soldier is knocked back a little by the bullet. Either way the body slows down.
export const BODY_FRICTION = 420; // px/s² a sliding body loses (walking speed slides ~30 px)
export const HIT_KNOCKBACK = 70; // px/s a bullet gives a standing soldier as they fall

// Capture the flag. Each team's flag stands at its base. An enemy who touches it carries
// it; carrying it into their own base wins the round.
// Both are small so it only happens when the soldier visibly reaches the flag or the stand:
// touching a flag needs the soldier's edge to reach the flag pole's cloth (6 px), and scoring
// needs the carrier's centre within 20 px of the stand's centre, i.e. standing on the stand
// (the soldier's body, 14 px, then covers the stand's middle).
export const FLAG_RADIUS = 6; // touching distance is this plus TANK_RADIUS
export const BASE_RADIUS = 20; // a carrier whose centre is this close to their own flag stand scores
// Each team's respawn square: 2 x 2 tiles. Soldiers start each round and respawn on one of
// its four spots, SPAWN_PAD_SPREAD px from its centre along each axis.
export const SPAWN_PAD_SIZE = 80;
export const SPAWN_PAD_SPREAD = 20;
export const CARRIER_SPEED = 0.8; // walking speed multiplier while carrying a flag
export const FLAG_RETURN_MS = 15000; // a dropped flag left alone goes home after this
export const ROUND_RESTART_MS = 6000; // win banner, then a fresh round
export const MATCH_RESTART_MS = 10000; // after the last round: final banner, then a new match
export const ROUND_POINTS = 2; // a tournament team gets this for each round it wins

// Power-up boxes: touch one to get a random power. A tank holds one power at a time.
// Boxes are not on the map when a round starts; each appears after a random delay, and after
// being taken comes back after another random delay, so nobody can time them.
export const POWER_BOX_SIZE = 26; // px, square
export const POWER_START_MIN_MS = 5000; // first appearance in a round
export const POWER_START_MAX_MS = 15000;
export const POWER_RESPAWN_MIN_MS = 15000; // back this long after it is taken
export const POWER_RESPAWN_MAX_MS = 30000;
// The longest a box can be away. Kept for drawing code that shows a countdown.
export const POWER_RESPAWN_MS = POWER_RESPAWN_MAX_MS;
// A shield stops SHIELD_HITS bullets or lasts SHIELD_MS, whichever runs out first, so a
// shielded flag carrier can still be brought down by a team that focuses fire.
export const SHIELD_MS = 10000;
export const SHIELD_HITS = 3;
export const SPEED_MS = 14000;
export const SPEED_BOOST = 1.6; // drive speed multiplier
export const FLARE_MS = 14000;
export const FLARE_INTERVAL_MS = 2000; // one burst of 4 bullets (front, back, left, right) per interval
