import { BED_SIZE, BULLET_RADIUS, CRATE_SIZE, DESK_SIZE, POWER_BOX_SIZE, TANK_RADIUS, type PowerKind, type Team } from "@tank/shared";
import { INK, TEAM, font, fontsReady, hash, inked, makeSprite, rrect, type Sprite } from "./common";

// Every sprite the game draws often, painted once into offscreen canvases (per team where
// the colours differ) and copied onto the screen with drawImage. Built lazily on first use,
// because canvases only exist in the browser.

export const POWER_COLOR: Record<PowerKind, string> = {
  shield: "#4fe0ff",
  speed: "#9dff5c",
  flare: "#ffa53d",
};

const GUN_BODY = "#3b4150";
const GUN_BARREL = "#272b35";
const BOOT = "#2b2f3c";
const SKIN = "#f2c391";
const WOOD = { light: "#e0a35e", mid: "#c7843f", dark: "#8b5524", deep: "#5e3818" };

// Gun: the muzzle sits where the sim spawns bullets (TANK_RADIUS + BULLET_RADIUS + 2 ahead).
export const MUZZLE_X = TANK_RADIUS + BULLET_RADIUS + 2;

function lazy<T>(make: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= make());
}

function perTeam<T>(make: (team: Team) => T): (team: Team) => T {
  const red = lazy(() => make("red"));
  const blue = lazy(() => make("blue"));
  return (team) => (team === "red" ? red() : blue());
}

// --- Soldiers ---------------------------------------------------------------------------

// The standing soldier seen from above, facing +x: backpack, round shoulders, arms holding a
// dark rifle that sticks out in front, and a round helmet. Feet are drawn separately so
// they can step while walking.
export const soldierSprite = perTeam((team) => {
  const c = TEAM[team];
  return makeSprite(54, 36, 18, 18, (g) => {
    // Backpack
    rrect(g, -15.5, -7, 8, 14, 3.5);
    inked(g, c.dark, 2);
    // Shoulders: a wide, rounded body across the direction of travel, lit from the top-left.
    const body = g.createLinearGradient(-8, -12, 4, 12);
    body.addColorStop(0, c.light);
    body.addColorStop(0.35, c.body);
    body.addColorStop(1, c.dark);
    g.beginPath();
    g.ellipse(-2.5, 0, 9.5, 13, 0, 0, Math.PI * 2);
    inked(g, body, 2.4);
    // Arms reaching forward to the rifle: an ink stroke under a team-coloured one.
    g.beginPath();
    g.moveTo(-2, 10);
    g.lineTo(6, 4);
    g.moveTo(-2, -10);
    g.lineTo(14, -2.5);
    g.strokeStyle = INK;
    g.lineWidth = 7;
    g.stroke();
    g.strokeStyle = c.body;
    g.lineWidth = 4;
    g.stroke();
    // Rifle along y = 0, the line bullets fly along: stock and body, then the barrel.
    rrect(g, 0, -3.2, 13, 6.4, 2);
    inked(g, GUN_BODY, 1.8);
    rrect(g, 11, -2.3, MUZZLE_X + 3 - 11, 4.6, 1.5);
    inked(g, GUN_BARREL, 1.6);
    g.fillStyle = "rgba(255, 255, 255, 0.28)";
    g.fillRect(12, -1.4, MUZZLE_X - 11, 1.1);
    rrect(g, MUZZLE_X, -2.9, 3.4, 5.8, 1);
    inked(g, GUN_BARREL, 1.4);
    g.fillRect(1.5, -2.2, 9, 1.2);
    // Gloves on the grip and the barrel.
    for (const [hx, hy] of [
      [6.5, 3.2],
      [14.5, -1.8],
    ] as const) {
      g.beginPath();
      g.arc(hx, hy, 2.8, 0, Math.PI * 2);
      inked(g, c.dark, 1.5);
    }
    // Helmet: a glossy dome with a darker band and a highlight.
    const dome = g.createRadialGradient(-4, -3.5, 1, -1.5, 0, 9);
    dome.addColorStop(0, c.light);
    dome.addColorStop(0.45, c.body);
    dome.addColorStop(1, c.dark);
    g.beginPath();
    g.arc(-1.5, 0, 8.4, 0, Math.PI * 2);
    inked(g, dome, 2.4);
    g.beginPath();
    g.arc(-1.5, 0, 5.6, 0, Math.PI * 2);
    g.strokeStyle = "rgba(0, 0, 0, 0.16)";
    g.lineWidth = 1.4;
    g.stroke();
    g.fillStyle = "rgba(255, 255, 255, 0.55)";
    g.beginPath();
    g.ellipse(-4.2, -3.2, 2.6, 1.6, -0.6, 0, Math.PI * 2);
    g.fill();
  });
});

export const bootSprite = lazy(() =>
  makeSprite(12, 9, 6, 4.5, (g) => {
    g.beginPath();
    g.ellipse(0, 0, 4.4, 2.9, 0, 0, Math.PI * 2);
    inked(g, BOOT, 1.4);
  }),
);

// Soft round shadow under soldiers (drawn unrotated, a little down and right).
export const shadowSprite = lazy(() =>
  makeSprite(36, 36, 18, 18, (g) => {
    const grad = g.createRadialGradient(0, 0, 4, 0, 0, 16);
    grad.addColorStop(0, "rgba(10, 14, 30, 0.38)");
    grad.addColorStop(0.7, "rgba(10, 14, 30, 0.2)");
    grad.addColorStop(1, "rgba(10, 14, 30, 0)");
    g.fillStyle = grad;
    g.fillRect(-18, -18, 36, 36);
  }),
);

// A shot soldier lying flat on their back, head towards +x: arms and legs out, helmet knocked
// off beside them, rifle dropped.
export const fallenSprite = perTeam((team) => {
  const c = TEAM[team];
  return makeSprite(48, 48, 24, 24, (g) => {
    // Dropped rifle
    g.save();
    g.translate(-3, 16);
    g.rotate(-0.45);
    rrect(g, -10, -2.6, 10, 5.2, 1.5);
    inked(g, GUN_BODY, 1.5);
    rrect(g, -1, -1.6, 15, 3.2, 1.2);
    inked(g, GUN_BARREL, 1.3);
    g.restore();
    // Legs and boots
    g.beginPath();
    g.moveTo(-4, -3.5);
    g.lineTo(-15, -7);
    g.moveTo(-4, 3.5);
    g.lineTo(-14.5, 8);
    g.strokeStyle = INK;
    g.lineWidth = 8;
    g.stroke();
    g.strokeStyle = c.dark;
    g.lineWidth = 5;
    g.stroke();
    for (const [bx, by, a] of [
      [-16.5, -7.5, 0.3],
      [-16, 8.5, -0.4],
    ] as const) {
      g.beginPath();
      g.ellipse(bx, by, 3.3, 2.6, a, 0, Math.PI * 2);
      inked(g, BOOT, 1.3);
    }
    // Arms flung out
    g.beginPath();
    g.moveTo(3, -7);
    g.lineTo(8, -15.5);
    g.moveTo(3, 7);
    g.lineTo(11, 13.5);
    g.strokeStyle = INK;
    g.lineWidth = 7;
    g.stroke();
    g.strokeStyle = c.body;
    g.lineWidth = 4;
    g.stroke();
    for (const [hx, hy] of [
      [8.5, -16.5],
      [12, 14.5],
    ] as const) {
      g.beginPath();
      g.arc(hx, hy, 2.6, 0, Math.PI * 2);
      inked(g, c.dark, 1.3);
    }
    // Torso
    const torso = g.createLinearGradient(-6, -9, 6, 9);
    torso.addColorStop(0, c.light);
    torso.addColorStop(0.4, c.body);
    torso.addColorStop(1, c.dark);
    g.beginPath();
    g.ellipse(0, 0, 8, 10, 0, 0, Math.PI * 2);
    inked(g, torso, 2.2);
    // Head with crossed-out eyes
    g.beginPath();
    g.arc(10.5, 0, 5, 0, Math.PI * 2);
    inked(g, SKIN, 1.8);
    g.strokeStyle = INK;
    g.lineWidth = 1.1;
    g.beginPath();
    for (const ey of [-2, 2]) {
      g.moveTo(11.2, ey - 1);
      g.lineTo(13.2, ey + 1);
      g.moveTo(13.2, ey - 1);
      g.lineTo(11.2, ey + 1);
    }
    g.stroke();
    // Helmet rolled off to the side
    g.beginPath();
    g.ellipse(17, -10, 6, 5, -0.7, 0, Math.PI * 2);
    inked(g, c.body, 2);
    g.fillStyle = "rgba(255, 255, 255, 0.45)";
    g.beginPath();
    g.ellipse(15.5, -11.5, 2, 1.2, -0.7, 0, Math.PI * 2);
    g.fill();
  });
});

// A cartoon paint splat under a fallen soldier, in the team's light colour (not gory).
export const splatSprite = perTeam((team) => {
  const c = TEAM[team];
  return makeSprite(44, 44, 22, 22, (g) => {
    g.fillStyle = c.light;
    g.globalAlpha = 0.75;
    g.beginPath();
    g.arc(0, 0, 11, 0, Math.PI * 2);
    for (let k = 0; k < 9; k++) {
      const a = (k / 9) * Math.PI * 2 + hash(k, 3, 7) * 0.5;
      const d = 10 + hash(k, 5, 1) * 7;
      const r = 3 + hash(k, 9, 2) * 4;
      g.moveTo(Math.cos(a) * d + r, Math.sin(a) * d);
      g.arc(Math.cos(a) * d, Math.sin(a) * d, r, 0, Math.PI * 2);
    }
    g.fill();
  });
});

// Ring under your own soldier so you find yourself at a glance.
// Marks your own soldier: a thin dashed ring just outside the body (TANK_RADIUS), so it
// shows which one is you without making you look bigger than you are.
export const youRingSprite = perTeam((team) => {
  const c = TEAM[team];
  const r = TANK_RADIUS + 4;
  return makeSprite(2 * r + 6, 2 * r + 6, r + 3, r + 3, (g) => {
    g.strokeStyle = c.glow;
    g.lineWidth = 3;
    g.beginPath();
    g.arc(0, 0, r, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = "rgba(255, 255, 255, 0.85)";
    g.lineWidth = 1.4;
    g.setLineDash([5, 4]);
    g.beginPath();
    g.arc(0, 0, r, 0, Math.PI * 2);
    g.stroke();
  });
});

// Soft round glow of any colour (flare aura, flag carrier, power box halo).
const glows = new Map<string, Sprite>();
export function glowSprite(color: string): Sprite {
  let s = glows.get(color);
  if (!s) {
    s = makeSprite(64, 64, 32, 32, (g) => {
      const grad = g.createRadialGradient(0, 0, 0, 0, 0, 32);
      grad.addColorStop(0, color);
      grad.addColorStop(1, "rgba(0, 0, 0, 0)");
      g.fillStyle = grad;
      g.fillRect(-32, -32, 64, 64);
    }, 1);
    glows.set(color, s);
  }
  return s;
}

export const SHIELD_R = TANK_RADIUS + 9;

// The shield bubble: a clear sphere with a bright rim and a shine on top.
export const shieldSprite = lazy(() =>
  makeSprite(SHIELD_R * 2 + 6, SHIELD_R * 2 + 6, SHIELD_R + 3, SHIELD_R + 3, (g) => {
    const fill = g.createRadialGradient(0, 0, SHIELD_R * 0.4, 0, 0, SHIELD_R);
    fill.addColorStop(0, "rgba(79, 224, 255, 0.04)");
    fill.addColorStop(1, "rgba(79, 224, 255, 0.32)");
    g.fillStyle = fill;
    g.beginPath();
    g.arc(0, 0, SHIELD_R, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "rgba(255, 255, 255, 0.5)";
    g.beginPath();
    g.ellipse(-SHIELD_R * 0.38, -SHIELD_R * 0.5, SHIELD_R * 0.35, SHIELD_R * 0.14, -0.6, 0, Math.PI * 2);
    g.fill();
  }),
);

// --- Bullets ----------------------------------------------------------------------------

export const STREAK_LENGTH = 52; // full length of a bullet's light streak, in map px

// A bright ball with a dark outline and a team-tinted rim, pointing nowhere (it's round).
export const bulletBallSprite = perTeam((team) => {
  const c = TEAM[team];
  const r = BULLET_RADIUS;
  return makeSprite(r * 4, r * 4, r * 2, r * 2, (g) => {
    g.fillStyle = c.glow;
    g.beginPath();
    g.arc(0, 0, r * 1.9, 0, Math.PI * 2);
    g.fill();
    const ball = g.createRadialGradient(-r * 0.35, -r * 0.35, 0.3, 0, 0, r);
    ball.addColorStop(0, "#ffffff");
    ball.addColorStop(0.55, team === "red" ? "#fff2d2" : "#e6f6ff");
    ball.addColorStop(1, c.light);
    g.beginPath();
    g.arc(0, 0, r * 0.9, 0, Math.PI * 2);
    inked(g, ball, 1.2);
  }, 3);
});

// The streak behind a bullet: thin, light, fading towards its tail. Drawn ending at the
// bullet's centre and stretched to the length flown so far.
export const bulletStreakSprite = perTeam((team) => {
  const c = TEAM[team];
  const L = STREAK_LENGTH;
  return makeSprite(L, 8, L, 4, (g) => {
    const grad = g.createLinearGradient(-L, 0, 0, 0);
    grad.addColorStop(0, "rgba(255, 255, 255, 0)");
    grad.addColorStop(0.5, hexAlpha(c.light, 0.6));
    grad.addColorStop(1, "rgba(255, 255, 255, 0.98)");
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(-L, 0);
    g.lineTo(-2, -2.6);
    g.arc(-2, 0, 2.6, -Math.PI / 2, Math.PI / 2);
    g.closePath();
    g.fill();
    const core = g.createLinearGradient(-L * 0.6, 0, 0, 0);
    core.addColorStop(0, "rgba(255, 255, 255, 0)");
    core.addColorStop(1, "rgba(255, 255, 255, 0.95)");
    g.fillStyle = core;
    g.beginPath();
    g.moveTo(-L * 0.6, 0);
    g.lineTo(-1, -1.4);
    g.lineTo(-1, 1.4);
    g.closePath();
    g.fill();
  }, 3);
});

// Muzzle flash, pointing +x from the muzzle.
export const flashSprite = lazy(() =>
  makeSprite(26, 22, 4, 11, (g) => {
    g.fillStyle = "rgba(255, 214, 102, 0.55)";
    g.beginPath();
    g.arc(4, 0, 9, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#ffe8a3";
    g.beginPath();
    g.moveTo(-2, 0);
    g.lineTo(5, -6.5);
    g.lineTo(7, -2);
    g.lineTo(20, 0);
    g.lineTo(7, 2);
    g.lineTo(5, 6.5);
    g.closePath();
    g.fill();
    g.fillStyle = "#ffffff";
    g.beginPath();
    g.ellipse(4, 0, 4.5, 2.6, 0, 0, Math.PI * 2);
    g.fill();
  }),
);

// --- Furniture and boxes ----------------------------------------------------------------

const SHADOW = "rgba(10, 14, 30, 0.22)";

// Blocks (crates, desks, beds, power boxes) can be turned by pushes, so their soft shadow is a
// sprite of its own: the renderer turns it with the block but keeps it offset down-right, the
// way the light falls. Cached per shape.
export interface BlockShadow {
  sprite: Sprite;
  dx: number; // offset from the block's centre, in map pixels
  dy: number;
}
const blockShadows = new Map<string, BlockShadow>();
export function blockShadowSprite(size: number, radius: number, dx: number, dy: number): BlockShadow {
  const key = `${size}/${radius}/${dx}/${dy}`;
  let shadow = blockShadows.get(key);
  if (!shadow) {
    const h = size / 2;
    const sprite = makeSprite(size + 4, size + 4, h + 2, h + 2, (g) => {
      rrect(g, -h, -h, size, size, radius);
      g.fillStyle = SHADOW;
      g.fill();
    });
    blockShadows.set(key, (shadow = { sprite, dx, dy }));
  }
  return shadow;
}
export const crateShadow = lazy(() => blockShadowSprite(CRATE_SIZE, 4, 3, 4));
export const deskShadow = lazy(() => blockShadowSprite(DESK_SIZE, 4, 3, 4));
export const bedShadow = lazy(() => blockShadowSprite(BED_SIZE, 6, 4, 5));
export const powerBoxShadow = lazy(() => blockShadowSprite(POWER_BOX_SIZE, 7, 2, 3.5));

// A wooden crate: light frame, dark inside, one diagonal brace, nails in the corners.
// Its shadow is crateShadow.
export const crateSprite = lazy(() => {
  const h = CRATE_SIZE / 2;
  return makeSprite(CRATE_SIZE + 10, CRATE_SIZE + 10, h + 4, h + 4, (g) => {
    rrect(g, -h, -h, CRATE_SIZE, CRATE_SIZE, 4);
    inked(g, WOOD.mid, 2.4);
    // Lit top edge, shaded bottom edge of the frame.
    g.fillStyle = "rgba(255, 255, 255, 0.28)";
    g.fillRect(-h + 2.5, -h + 2, CRATE_SIZE - 5, 2.2);
    g.fillStyle = "rgba(0, 0, 0, 0.18)";
    g.fillRect(-h + 2.5, h - 4.2, CRATE_SIZE - 5, 2.2);
    const i = h - 6;
    rrect(g, -i, -i, i * 2, i * 2, 2);
    inked(g, WOOD.deep, 1.6);
    g.save();
    g.clip();
    // Planks inside
    g.strokeStyle = "rgba(0, 0, 0, 0.25)";
    g.lineWidth = 1;
    g.beginPath();
    for (let y = -i + i / 2; y < i; y += i / 2) {
      g.moveTo(-i, y);
      g.lineTo(i, y);
    }
    g.stroke();
    // Diagonal brace
    g.beginPath();
    g.moveTo(-i - 2, i + 2);
    g.lineTo(i + 2, -i - 2);
    g.strokeStyle = INK;
    g.lineWidth = 7.5;
    g.stroke();
    g.strokeStyle = WOOD.light;
    g.lineWidth = 5;
    g.stroke();
    g.restore();
    g.fillStyle = INK;
    for (const [nx, ny] of [
      [-h + 3.2, -h + 3.2],
      [h - 3.2, -h + 3.2],
      [-h + 3.2, h - 3.2],
      [h - 3.2, h - 3.2],
    ] as const) {
      g.beginPath();
      g.arc(nx, ny, 1.1, 0, Math.PI * 2);
      g.fill();
    }
  });
});

// An office desk seen from above: a light wooden top with a monitor and papers, and the
// chair tucked in at the front. The whole square (DESK_SIZE) is solid. Shadow: deskShadow.
export const deskSprite = lazy(() => {
  const h = DESK_SIZE / 2;
  return makeSprite(DESK_SIZE + 10, DESK_SIZE + 10, h + 4, h + 4, (g) => {
    // Chair: a round seat with a backrest, peeking out under the desk.
    rrect(g, -8, 2, 16, 14, 5);
    inked(g, "#4a5878", 2);
    rrect(g, -7, 12, 14, 4.5, 2.2);
    inked(g, "#33405c", 1.6);
    // Desk top
    rrect(g, -h, -h, DESK_SIZE, 23, 3.5);
    const top = g.createLinearGradient(0, -h, 0, -h + 23);
    top.addColorStop(0, "#f0c98f");
    top.addColorStop(1, "#d6a463");
    inked(g, top, 2.2);
    g.fillStyle = "rgba(255, 255, 255, 0.3)";
    g.fillRect(-h + 2.5, -h + 2, DESK_SIZE - 5, 1.6);
    // Monitor
    rrect(g, -11, -h + 3.5, 13, 8, 1.8);
    inked(g, "#2d3346", 1.4);
    g.fillStyle = "#7fd4ff";
    g.fillRect(-9.6, -h + 4.9, 10.2, 4.6);
    g.fillStyle = "rgba(255, 255, 255, 0.6)";
    g.fillRect(-9.6, -h + 4.9, 4, 1.4);
    // Papers
    g.save();
    g.translate(8, -h + 10);
    g.rotate(0.18);
    rrect(g, -4, -5, 8, 10, 1);
    inked(g, "#ffffff", 1.2);
    g.fillStyle = "rgba(60, 70, 100, 0.45)";
    g.fillRect(-2.5, -3, 5, 0.9);
    g.fillRect(-2.5, -1, 5, 0.9);
    g.fillRect(-2.5, 1, 3.5, 0.9);
    g.restore();
  });
});

// A classroom bed: green blanket with quilting and a white pillow strip at the foot.
// Shadow: bedShadow.
export const bedSprite = lazy(() => {
  const h = BED_SIZE / 2;
  return makeSprite(BED_SIZE + 12, BED_SIZE + 12, h + 5, h + 5, (g) => {
    rrect(g, -h, -h, BED_SIZE, BED_SIZE, 6);
    const blanket = g.createLinearGradient(-h, -h, h, h);
    blanket.addColorStop(0, "#5bd665");
    blanket.addColorStop(1, "#2f9e3f");
    inked(g, blanket, 2.6);
    g.save();
    g.clip();
    g.strokeStyle = "rgba(255, 255, 255, 0.14)";
    g.lineWidth = 1.5;
    g.beginPath();
    for (let x = -h + 15; x < h; x += 15) {
      g.moveTo(x, -h);
      g.lineTo(x, h - 18);
    }
    g.stroke();
    // Fold at the top
    g.fillStyle = "rgba(255, 255, 255, 0.22)";
    g.fillRect(-h, -h, BED_SIZE, 10);
    g.fillStyle = "rgba(0, 0, 0, 0.12)";
    g.fillRect(-h, -h + 10, BED_SIZE, 2);
    // Sheet and pillows at the foot
    g.fillStyle = "#eef6ee";
    g.fillRect(-h, h - 17, BED_SIZE, 17);
    g.restore();
    g.strokeStyle = INK;
    g.lineWidth = 1.6;
    g.beginPath();
    g.moveTo(-h + 1, h - 17);
    g.lineTo(h - 1, h - 17);
    g.stroke();
    for (const px of [-h + 6, 3]) {
      rrect(g, px, h - 14, h - 9, 10, 4);
      inked(g, "#ffffff", 1.4);
    }
    g.strokeStyle = INK;
    g.lineWidth = 2.6;
    rrect(g, -h, -h, BED_SIZE, BED_SIZE, 6);
    g.stroke();
  });
});

// The power-up box: a glossy violet cube with a white "?". Shadow: powerBoxShadow.
export const powerBoxSprite = lazy(() => {
  const h = POWER_BOX_SIZE / 2;
  return makeSprite(POWER_BOX_SIZE + 10, POWER_BOX_SIZE + 10, h + 4, h + 4, (g) => {
    rrect(g, -h, -h, POWER_BOX_SIZE, POWER_BOX_SIZE, 7);
    const fill = g.createLinearGradient(0, -h, 0, h);
    fill.addColorStop(0, "#c48bff");
    fill.addColorStop(0.5, "#8c47f0");
    fill.addColorStop(1, "#5a22c0");
    inked(g, fill, 2.4);
    // Gloss on the upper half
    rrect(g, -h + 3, -h + 2.5, POWER_BOX_SIZE - 6, h - 1, 5);
    g.fillStyle = "rgba(255, 255, 255, 0.28)";
    g.fill();
    // "?" drawn as strokes, so it doesn't depend on a font.
    const q = new Path2D();
    q.arc(0, -3.2, 4.4, Math.PI * 1.05, Math.PI * 0.42);
    q.lineTo(0.3, 2.6);
    g.strokeStyle = INK;
    g.lineWidth = 6;
    g.stroke(q);
    g.strokeStyle = "#ffffff";
    g.lineWidth = 3.2;
    g.stroke(q);
    g.beginPath();
    g.arc(0.3, 7, 2.3, 0, Math.PI * 2);
    inked(g, "#ffffff", 1.6);
  });
});

// A four-point sparkle (power boxes, pickups).
export const sparkleSprite = lazy(() =>
  makeSprite(12, 12, 6, 6, (g) => {
    g.fillStyle = "#ffffff";
    g.beginPath();
    g.moveTo(0, -5.5);
    g.quadraticCurveTo(0.6, -0.6, 5.5, 0);
    g.quadraticCurveTo(0.6, 0.6, 0, 5.5);
    g.quadraticCurveTo(-0.6, 0.6, -5.5, 0);
    g.quadraticCurveTo(-0.6, -0.6, 0, -5.5);
    g.fill();
  }),
);

// --- Text -------------------------------------------------------------------------------

// Name tags: a dark pill with the name in white (yours in gold). Cached per name.
const tags = new Map<string, Sprite>();
export function nameTagSprite(name: string, isLocal: boolean): Sprite {
  const key = (isLocal ? "1" : "0") + name;
  let s = tags.get(key);
  if (s) return s;
  s = textPill(name, font(9.5, "body", 800), isLocal ? "#ffd34d" : "#ffffff", "rgba(16, 20, 38, 0.62)", isLocal ? "#ffd34d" : null, 2.5);
  if (fontsReady()) {
    if (tags.size > 64) tags.clear();
    tags.set(key, s);
  }
  return s;
}

// Floating effect labels ("SHIELD", "FLAG TAKEN"): bold coloured text with an ink outline.
const labels = new Map<string, Sprite>();
export function labelSprite(text: string, color: string): Sprite {
  const key = color + text;
  let s = labels.get(key);
  if (s) return s;
  const f = font(15);
  const w = measure(text, f) + 14;
  s = makeSprite(w, 26, w / 2, 13, (g) => {
    g.font = f;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.lineWidth = 5;
    g.strokeStyle = INK;
    g.strokeText(text, 0, 1);
    g.fillStyle = color;
    g.fillText(text, 0, 1);
  });
  if (fontsReady()) {
    if (labels.size > 64) labels.clear();
    labels.set(key, s);
  }
  return s;
}

function textPill(text: string, f: string, color: string, bg: string, border: string | null, pad: number): Sprite {
  const tw = measure(text, f);
  const w = tw + pad * 2 + 6;
  const h = 13;
  return makeSprite(w + 2, h + 2, w / 2 + 1, h / 2 + 1, (g) => {
    rrect(g, -w / 2, -h / 2, w, h, h / 2);
    g.fillStyle = bg;
    g.fill();
    if (border) {
      g.strokeStyle = border;
      g.lineWidth = 1;
      g.stroke();
    }
    g.font = f;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = color;
    g.fillText(text, 0, 0.5);
  }, 3);
}

let measurer: CanvasRenderingContext2D | null = null;
function measure(text: string, f: string): number {
  measurer ??= document.createElement("canvas").getContext("2d")!;
  measurer.font = f;
  return measurer.measureText(text).width;
}

// Fonts arrive after the first frames: drop text cached in the fallback font.
if (typeof document !== "undefined" && document.fonts) {
  void document.fonts.ready.then(() => {
    tags.clear();
    labels.clear();
  });
}

function hexAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
