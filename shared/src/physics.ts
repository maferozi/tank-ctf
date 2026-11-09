import { BLOCK_MAX_TURN, BLOCK_TURN, TILE } from "./constants";
import { boxHitsSolid, circleHitsSolid, isBlockedAt, type GameMap } from "./map";

// Anything that takes up space and can be pushed: soldiers (circles) and blocks (squares:
// crates, desks, beds, solid power boxes). A block can be turned: `pos.angle` (radians,
// 0 = axis-aligned) is its rotation, and pushing it off-centre turns it (see shove).
export interface Body {
  pos: { x: number; y: number; angle?: number }; // the soldier or block itself; moved in place
  shape: "circle" | "box";
  size: number; // radius for a circle, half-width for a box
  mass: number;
}

export interface Contact {
  nx: number; // unit normal pointing from body a to body b
  ny: number;
  depth: number; // how far they overlap along the normal
  px: number; // where they touch (world), for the turning push
  py: number;
}

const PASSES = 4; // repeat so chains (soldier -> bed -> bed) settle
const EPS = 1e-9;

// Pushes overlapping bodies apart. Each side gives up a share of the overlap equal
// to the other side's weight fraction, which is what makes two bodies pushing each
// other move together at (m_a * v_a - m_b * v_b) / (m_a + m_b). So a soldier shoving an
// equal soldier moves at half speed, a heavy crate barely moves, and equal soldiers walking
// head-on stall. Walls never move: whatever a wall blocks goes to the other body. A block
// pushed off-centre also turns (see shove).
// Calls onPush(body) for every body that got moved by a contact this tick.
export function resolveContacts(bodies: Body[], map: GameMap, onPush?: (b: Body) => void): void {
  for (let pass = 0; pass < PASSES; pass++) {
    let any = false;
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i]!;
        const b = bodies[j]!;
        const c = contact(a, b);
        if (!c) continue;
        any = true;
        const shareA = b.mass / (a.mass + b.mass);
        let left = c.depth;
        const movedA = shove(a, map, -c.nx * c.depth * shareA, -c.ny * c.depth * shareA, c.px, c.py);
        const movedB = shove(b, map, c.nx * c.depth * (1 - shareA), c.ny * c.depth * (1 - shareA), c.px, c.py);
        left -= movedA + movedB;
        if (left > 1e-6) left -= shove(a, map, -c.nx * left, -c.ny * left, c.px, c.py);
        if (left > 1e-6) shove(b, map, c.nx * left, c.ny * left, c.px, c.py);
        if (movedA > 1e-6) onPush?.(a);
        if (movedB > 1e-6) onPush?.(b);
      }
    }
    if (!any) break;
  }
}

// Moves a body by (dx, dy), axis by axis so it slides along walls. Returns how far it
// actually moved along the requested direction.
//
// A block pushed at (px, py) also turns, quasi-statically (no spin carried between ticks):
// the push's turning effect about the block's centre, r x d, turns it by
// BLOCK_TURN * (r x d) / half^2 radians. Through the centre r x d is 0 (straight push); at a
// corner it is largest. d is the share of the overlap this block takes, which already shrinks
// with weight, and half^2 makes big blocks turn less again, so beds turn far less than crates.
// Whatever a wall blocks pushes back where the block touches the wall, so a tilted block
// shoved against a wall turns flat against it. A turn that would put the block into a wall is
// halved until it fits, or dropped.
export function shove(body: Body, map: GameMap, dx: number, dy: number, px?: number, py?: number): number {
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return 0;
  const p = body.pos;
  const x0 = p.x;
  const y0 = p.y;
  if (body.shape === "circle") {
    if (!circleHitsSolid(map, p.x + dx, p.y, body.size)) p.x += dx;
    if (!circleHitsSolid(map, p.x, p.y + dy, body.size)) p.y += dy;
    return ((p.x - x0) * dx + (p.y - y0) * dy) / len;
  }

  const h = body.size;
  const angle = p.angle ?? 0;
  let wallTorque = 0;
  if (!blockHitsSolid(map, p.x + dx, p.y, h, angle)) p.x += dx;
  else {
    // The wall pushes back with -dx at the point where the block touches it.
    const w = wallContact(map, p.x + dx, p.y, h, angle, dx, 0);
    wallTorque += (w.y - p.y) * dx;
  }
  if (!blockHitsSolid(map, p.x, p.y + dy, h, angle)) p.y += dy;
  else {
    const w = wallContact(map, p.x, p.y + dy, h, angle, 0, dy);
    wallTorque -= (w.x - p.x) * dy;
  }
  const moved = ((p.x - x0) * dx + (p.y - y0) * dy) / len;

  const pushTorque = px === undefined || py === undefined ? 0 : (px - x0) * dy - (py - y0) * dx;
  let turn = (BLOCK_TURN * (pushTorque + wallTorque)) / (h * h);
  turn = Math.max(-BLOCK_MAX_TURN, Math.min(BLOCK_MAX_TURN, turn));
  if (wallTorque !== 0) {
    // Pressed against a wall it settles flat instead of rocking past it.
    const tilt = angle - Math.round(angle / (Math.PI / 2)) * (Math.PI / 2);
    if (turn * tilt < 0 && Math.abs(turn) > Math.abs(tilt)) turn = -tilt;
  }
  if (Math.abs(turn) > 1e-9) {
    for (let k = 0; k < 3; k++, turn /= 2) {
      const next = wrapPi(angle + turn);
      if (!blockHitsSolid(map, p.x, p.y, h, next)) {
        p.angle = next;
        break;
      }
    }
  }
  return moved;
}

// -π..π
function wrapPi(a: number): number {
  return a - Math.round(a / (Math.PI * 2)) * Math.PI * 2;
}

// True if a square block centred at (x, y), half-size `half`, turned by `angle`, overlaps a
// wall or water tile. Touching a tile edge is not overlapping it.
export function blockHitsSolid(map: GameMap, x: number, y: number, half: number, angle = 0): boolean {
  if (angle === 0) return boxHitsSolid(map, x, y, half);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const spread = Math.abs(c) + Math.abs(s);
  const e = half * spread; // half-size of the block's bounding square
  const c0 = Math.floor((x - e + EPS) / TILE);
  const c1 = Math.floor((x + e - EPS) / TILE);
  const r0 = Math.floor((y - e + EPS) / TILE);
  const r1 = Math.floor((y + e - EPS) / TILE);
  // Every tile in that range overlaps the bounding square; it hits the block unless the
  // block's own axes separate them.
  const reach = half + (TILE / 2) * spread - EPS;
  for (let r = r0; r <= r1; r++) {
    for (let col = c0; col <= c1; col++) {
      if (!isBlockedAt(map, col, r)) continue;
      const tx = (col + 0.5) * TILE - x;
      const ty = (r + 0.5) * TILE - y;
      if (Math.abs(tx * c + ty * s) >= reach) continue;
      if (Math.abs(-tx * s + ty * c) >= reach) continue;
      return true;
    }
  }
  return false;
}

// The four corners of a block, in world space.
function corners(x: number, y: number, h: number, angle: number): [number, number][] {
  const c = Math.cos(angle) * h;
  const s = Math.sin(angle) * h;
  return [
    [x - c + s, y - s - c],
    [x + c + s, y + s - c],
    [x + c - s, y + s + c],
    [x - c - s, y - s + c],
  ];
}

// Where a block at (x, y) (a position that overlaps a wall) touches the wall: the middle of
// its corners inside solid tiles and the wall's outer corners inside it. Pressed flat against
// a wall that is the middle of the face (no turn); a tilted block touches with one corner.
// Falls back to the block's furthest point along (dx, dy).
function wallContact(map: GameMap, x: number, y: number, h: number, angle: number, dx: number, dy: number): { x: number; y: number } {
  let sx = 0;
  let sy = 0;
  let n = 0;
  const pts = corners(x, y, h, angle);
  for (const [cx, cy] of pts) {
    if (isBlockedAt(map, Math.floor(cx / TILE), Math.floor(cy / TILE))) {
      sx += cx;
      sy += cy;
      n++;
    }
  }
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const e = h * (Math.abs(c) + Math.abs(s));
  for (let gy = Math.ceil((y - e) / TILE); gy <= Math.floor((y + e) / TILE); gy++) {
    for (let gx = Math.ceil((x - e) / TILE); gx <= Math.floor((x + e) / TILE); gx++) {
      // A grid point is a corner of the walls when one tile, or two diagonal tiles, of the
      // four around it are solid (a point along a straight wall has two side by side).
      const tl = isBlockedAt(map, gx - 1, gy - 1);
      const tr = isBlockedAt(map, gx, gy - 1);
      const bl = isBlockedAt(map, gx - 1, gy);
      const br = isBlockedAt(map, gx, gy);
      const count = +tl + +tr + +bl + +br;
      if (count !== 1 && !(count === 2 && tl === br)) continue;
      const rx = gx * TILE - x;
      const ry = gy * TILE - y;
      if (Math.abs(rx * c + ry * s) < h && Math.abs(-rx * s + ry * c) < h) {
        sx += gx * TILE;
        sy += gy * TILE;
        n++;
      }
    }
  }
  if (n > 0) return { x: sx / n, y: sy / n };
  // Furthest corners along the push (near-ties averaged, so a flat face gives its middle).
  let best = -Infinity;
  for (const [cx, cy] of pts) best = Math.max(best, cx * dx + cy * dy);
  const len = Math.hypot(dx, dy);
  for (const [cx, cy] of pts) {
    if (cx * dx + cy * dy >= best - 0.5 * len) {
      sx += cx;
      sy += cy;
      n++;
    }
  }
  return { x: sx / n, y: sy / n };
}

export function contact(a: Body, b: Body): Contact | null {
  // Quick reject: further apart than their outer circles.
  const reach = outerRadius(a) + outerRadius(b);
  if (Math.abs(b.pos.x - a.pos.x) >= reach || Math.abs(b.pos.y - a.pos.y) >= reach) return null;
  if (a.shape === "circle" && b.shape === "circle") return circleCircle(a, b);
  if (a.shape === "box" && b.shape === "box") return boxBox(a, b);
  if (a.shape === "circle") return circleBox(a, b);
  const c = circleBox(b, a);
  return c && { ...c, nx: -c.nx, ny: -c.ny };
}

function outerRadius(b: Body): number {
  return b.shape === "circle" ? b.size : b.size * Math.SQRT2;
}

function circleCircle(a: Body, b: Body): Contact | null {
  const dx = b.pos.x - a.pos.x;
  const dy = b.pos.y - a.pos.y;
  const d = Math.hypot(dx, dy);
  const min = a.size + b.size;
  if (d >= min) return null;
  const px = (a.pos.x + b.pos.x) / 2;
  const py = (a.pos.y + b.pos.y) / 2;
  // Exactly stacked bodies (e.g. same spawn point) split along x.
  return d > 1e-6 ? { nx: dx / d, ny: dy / d, depth: min - d, px, py } : { nx: 1, ny: 0, depth: min, px, py };
}

// Separating axes for two turned squares: each one's two edge directions.
function boxBox(a: Body, b: Body): Contact | null {
  const aa = a.pos.angle ?? 0;
  const ba = b.pos.angle ?? 0;
  const dx = b.pos.x - a.pos.x;
  const dy = b.pos.y - a.pos.y;
  const ac = Math.cos(aa);
  const as = Math.sin(aa);
  const bc = Math.cos(ba);
  const bs = Math.sin(ba);
  const axes: [number, number][] = [
    [ac, as],
    [-as, ac],
    [bc, bs],
    [-bs, bc],
  ];
  let best = Infinity;
  let nx = 0;
  let ny = 0;
  for (const [lx, ly] of axes) {
    const ra = a.size * (Math.abs(ac * lx + as * ly) + Math.abs(-as * lx + ac * ly));
    const rb = b.size * (Math.abs(bc * lx + bs * ly) + Math.abs(-bs * lx + bc * ly));
    const d = dx * lx + dy * ly;
    const overlap = ra + rb - Math.abs(d);
    if (overlap <= 0) return null;
    if (overlap < best) {
      best = overlap;
      const s = d < 0 ? -1 : 1;
      nx = lx * s;
      ny = ly * s;
    }
  }
  // Where they touch: the middle of each one's corners that are inside the other.
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const [cx, cy] of corners(b.pos.x, b.pos.y, b.size, ba)) {
    if (inside(cx, cy, a.pos.x, a.pos.y, a.size, ac, as)) {
      sx += cx;
      sy += cy;
      n++;
    }
  }
  for (const [cx, cy] of corners(a.pos.x, a.pos.y, a.size, aa)) {
    if (inside(cx, cy, b.pos.x, b.pos.y, b.size, bc, bs)) {
      sx += cx;
      sy += cy;
      n++;
    }
  }
  const px = n > 0 ? sx / n : (a.pos.x + b.pos.x) / 2;
  const py = n > 0 ? sy / n : (a.pos.y + b.pos.y) / 2;
  return { nx, ny, depth: best, px, py };
}

function inside(x: number, y: number, bx: number, by: number, h: number, c: number, s: number): boolean {
  const rx = x - bx;
  const ry = y - by;
  return Math.abs(rx * c + ry * s) <= h + 1e-6 && Math.abs(-rx * s + ry * c) <= h + 1e-6;
}

// Normal points from the circle to the box; the contact point is the box's nearest point.
function circleBox(circle: Body, box: Body): Contact | null {
  const h = box.size;
  const local = toLocal(box, circle.pos.x, circle.pos.y);
  const lx = local.x;
  const ly = local.y;
  const qx = Math.max(-h, Math.min(lx, h));
  const qy = Math.max(-h, Math.min(ly, h));
  const dx = qx - lx;
  const dy = qy - ly;
  const d = Math.hypot(dx, dy);
  if (d > 1e-6) {
    if (d >= circle.size) return null;
    return fromLocal(box, dx / d, dy / d, circle.size - d, qx, qy);
  }
  // Centre is inside the box: push out along the nearest face.
  const ox = h - Math.abs(lx);
  const oy = h - Math.abs(ly);
  return ox < oy
    ? fromLocal(box, sign(-lx), 0, ox + circle.size, -sign(-lx) * h, ly)
    : fromLocal(box, 0, sign(-ly), oy + circle.size, lx, -sign(-ly) * h);
}

// A world point in a box's own frame (x along its first edge).
export function toLocal(box: Body, x: number, y: number): { x: number; y: number } {
  const a = box.pos.angle ?? 0;
  const rx = x - box.pos.x;
  const ry = y - box.pos.y;
  if (a === 0) return { x: rx, y: ry };
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: rx * c + ry * s, y: -rx * s + ry * c };
}

function fromLocal(box: Body, nx: number, ny: number, depth: number, qx: number, qy: number): Contact {
  const a = box.pos.angle ?? 0;
  if (a === 0) return { nx, ny, depth, px: box.pos.x + qx, py: box.pos.y + qy };
  const c = Math.cos(a);
  const s = Math.sin(a);
  return {
    nx: nx * c - ny * s,
    ny: nx * s + ny * c,
    depth,
    px: box.pos.x + qx * c - qy * s,
    py: box.pos.y + qx * s + qy * c,
  };
}

function sign(v: number): number {
  return v < 0 ? -1 : 1;
}
