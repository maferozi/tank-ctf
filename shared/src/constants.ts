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
export const CRATE_SIZE = 32; // px, square
export const CRATE_MASS = 3;
// Crates "stick" at first: they start CRATE_STATIC times heavier and loosen up to
// CRATE_MASS after being pushed for CRATE_BREAKAWAY_MS.
export const CRATE_STATIC = 2;
export const CRATE_BREAKAWAY_MS = 600;
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

// Power-up boxes: touch one to get a random power. A tank holds one power at a time.
export const POWER_BOX_SIZE = 26; // px, square
export const POWER_RESPAWN_MS = 12000; // box comes back this long after it is taken
export const SHIELD_MS = 14000; // blocks every bullet while active
export const SPEED_MS = 14000;
export const SPEED_BOOST = 1.6; // drive speed multiplier
export const FLARE_MS = 14000;
export const FLARE_INTERVAL_MS = 2000; // one burst of 4 bullets (front, back, left, right) per interval
