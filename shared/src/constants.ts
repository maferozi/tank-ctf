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
// Crates "stick" at first: they start CRATE_STATIC times heavier and loosen up to
// CRATE_MASS after being pushed for CRATE_BREAKAWAY_MS.
export const CRATE_STATIC = 2;
export const CRATE_BREAKAWAY_MS = 600;
// Beds (Classroom): big movable blocks, 2 x 2 tiles, twice a crate's weight. They stick and
// loosen like crates.
export const BED_SIZE = 76; // px, square; leaves a 4 px gap between beds placed side by side
export const BED_MASS = 6;
export const SPIN_SPEED = Math.PI * 1.2; // rad/s while not driving
// After each press the tank holds its heading this long before spinning the other way,
// so rapid tapping keeps the barrel wobbling around one line instead of sweeping.
export const SPIN_PAUSE_MS = 60;
// A press this soon after the previous one fires along the previous shot's heading
// (the barrel snaps back), so rapid tapping fires in one straight line. 0 disables it.
export const RAPID_FIRE_MS = 250;
export const DRIVE_SPEED = 160; // px/s

export const BULLET_SPEED = 440; // px/s
export const BULLET_RADIUS = 4;
export const BULLET_RANGE = 320; // px travelled before the bullet drops
export const BULLET_FADE = 80; // last px of range drawn fading out
// Shorter than a fast double tap, so every real tap fires; only stops input bounce.
export const FIRE_COOLDOWN_MS = 100;
export const MAX_AMMO = 6;
export const RELOAD_MS = 1500; // one round back every RELOAD_MS while below MAX_AMMO

export const RESPAWN_MS = 2000;

// Falling. A soldier shot while walking keeps sliding forward and falls face-first; a
// standing soldier is knocked back a little by the bullet. Either way the body slows down.
export const BODY_FRICTION = 420; // px/s² a sliding body loses (walking speed slides ~30 px)
export const HIT_KNOCKBACK = 70; // px/s a bullet gives a standing soldier as they fall

// Capture the flag. Each team's flag stands at its base. An enemy who touches it carries
// it; carrying it into their own base wins the round.
export const FLAG_RADIUS = 10; // touching distance is this plus TANK_RADIUS
export const BASE_RADIUS = 34; // a carrier this close to their own flag stand scores
export const CARRIER_SPEED = 0.8; // walking speed multiplier while carrying a flag
export const FLAG_RETURN_MS = 15000; // a dropped flag left alone goes home after this
export const ROUND_RESTART_MS = 6000; // win banner, then a fresh round
export const MATCH_RESTART_MS = 10000; // after the last round: final banner, then a new match
export const ROUND_POINTS = 2; // a tournament team gets this for each round it wins

// Power-up boxes: touch one to get a random power. A tank holds one power at a time.
export const POWER_BOX_SIZE = 26; // px, square
export const POWER_RESPAWN_MS = 12000; // box comes back this long after it is taken
export const SHIELD_MS = 14000; // blocks every bullet while active
export const SPEED_MS = 14000;
export const SPEED_BOOST = 1.6; // drive speed multiplier
export const FLARE_MS = 14000;
export const FLARE_INTERVAL_MS = 2000; // one burst of 4 bullets (front, back, left, right) per interval
