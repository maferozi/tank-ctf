// Fixed simulation rate. The client and (later) the server step the same sim at this rate.
export const TICK_HZ = 60;
export const TICK_MS = 1000 / TICK_HZ;

export const TILE = 40;

// One-button control: every press fires and flips the spin direction;
// keeping it held for holdMs drives forward.
// 100, not 60: a normal finger tap lasts 30-90 ms and mouse clicks and Space up to ~100 ms,
// and with 60 a fast spray kept turning into short walks that froze the fan into one line.
export const DEFAULT_HOLD_MS = 100;
export const MIN_HOLD_MS = 30;
export const MAX_HOLD_MS = 250;

// Collision size of a soldier. 12 (was 14) matches the drawn body, so soldiers fit the gaps
// they look like they fit (players' report: narrow aisles felt blocked).
export const TANK_RADIUS = 12;

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
// A soldier walking into the face of a crate, desk, bed or power box grips it like friction:
// sideways walking of up to PUSH_GRIP times the forward walking is cancelled, so walking a
// little off-axis into the middle of a face pushes it on instead of sliding along the face.
// The grip fades towards the face's ends (none at a corner), so a soldier pushing near a
// corner slides towards it as the block turns, swings it round and slips off.
export const PUSH_GRIP = 0.6; // in the middle of a face: grips headings up to ~31 degrees off
// Blocks turn when pushed off-centre, like real furniture. Each tick a push that moves a block
// by d at a point r from its centre turns it by BLOCK_TURN * (r x d) / half^2 radians
// (half = half its size): nothing through the centre, most at a corner. d already shrinks with
// weight and half^2 grows with size, so heavy, big blocks turn less. Walking into a crate near
// its corner turns it about 30 degrees in the first second and about 50 by the time the
// soldier slips off its corner; a bed turns about 19 degrees in that first second. Blocks never
// spin on their own: no push, no turn.
export const BLOCK_TURN = 1;
export const BLOCK_MAX_TURN = 0.06; // rad per push, at most (about 3.4 degrees)
// Measured from the original (docs/ORIGINAL.md): one full turn in 1.555 s.
export const SPIN_SPEED = Math.PI * 1.29; // rad/s while not driving
// After each press the tank holds its heading this long before spinning the other way,
// so rapid tapping keeps the barrel wobbling around one line instead of sweeping.
export const SPIN_PAUSE_MS = 60;
// Spraying: a shot this soon after the previous one belongs to the same burst. It follows
// the wobbling gun, so the burst fans out like the original's, but never more than
// RAPID_FIRE_WOBBLE from the burst's first shot, so uneven tapping can't make it creep
// sideways. A wobble of 0 snaps every burst shot onto one straight line; RAPID_FIRE_MS 0
// turns bursts off (every shot goes where the gun points).
export const RAPID_FIRE_MS = 250;
export const RAPID_FIRE_WOBBLE = (12 * Math.PI) / 180; // radians either side
export const DRIVE_SPEED = 186; // px/s, full walking speed
// Walking starts at DRIVE_START of full speed and reaches full speed after DRIVE_RAMP_MS.
export const DRIVE_START = 0.5;
export const DRIVE_RAMP_MS = 400;

export const BULLET_SPEED = 620; // px/s
export const BULLET_RADIUS = 4;
export const BULLET_RANGE = 410; // px travelled before the bullet drops
export const BULLET_FADE = 80; // last px of range drawn fading out
// Only stops input bounce: well under the original's ~10 taps/s (100 ms apart), so every
// real spray tap fires. At 100 it equalled that gap and dropped a quarter of real taps.
export const FIRE_COOLDOWN_MS = 66; // 4 ticks
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
// touching a flag needs the soldier's edge to reach the flag (8 px), so the centres are 20 px
// apart, and scoring needs the carrier's centre within 20 px of the stand's centre, i.e.
// standing on the stand (the soldier's body, 12 px, then covers the stand's middle).
export const FLAG_RADIUS = 8; // touching distance is this plus TANK_RADIUS
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
export const SHIELD_HITS = 5; // players' call (9 Nov 2026), was 3
// Spawn protection: a soldier who just respawned can't be hurt for this long, so nobody is
// shot the moment they appear on the respawn square.
export const SPAWN_SHIELD_MS = 2000;
export const SPEED_MS = 14000;
export const SPEED_BOOST = 1.6; // drive speed multiplier
export const FLARE_MS = 14000;
export const FLARE_INTERVAL_MS = 2000; // one burst of 4 bullets (front, back, left, right) per interval
