import { boxHitsSolid, circleHitsSolid, type GameMap } from "./map";

// Anything that takes up space and can be pushed: tanks (circles) and crates (squares).
export interface Body {
  pos: { x: number; y: number }; // the tank or crate itself; moved in place
  shape: "circle" | "box";
  size: number; // radius for a circle, half-width for a box
  mass: number;
  // A walking soldier's heading (unit vector). It pushes boxes straight along the face it
  // walks into (see pushFace) instead of along the nearest-point normal.
  heading?: { x: number; y: number };
}

export interface Contact {
  nx: number; // unit normal pointing from body a to body b
  ny: number;
  depth: number; // how far they overlap along the normal
}

const PASSES = 4; // repeat so chains (tank -> crate -> crate) settle

// Pushes overlapping bodies apart. Each side gives up a share of the overlap equal
// to the other side's weight fraction, which is what makes two bodies pushing each
// other move together at (m_a * v_a - m_b * v_b) / (m_a + m_b). So a tank shoving an
// equal tank moves at half speed, a heavy crate barely moves, and equal tanks driving
// head-on stall. Walls never move: whatever a wall blocks goes to the other body.
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
        const movedA = shove(a, map, -c.nx * c.depth * shareA, -c.ny * c.depth * shareA);
        const movedB = shove(b, map, c.nx * c.depth * (1 - shareA), c.ny * c.depth * (1 - shareA));
        left -= movedA + movedB;
        if (left > 1e-6) left -= shove(a, map, -c.nx * left, -c.ny * left);
        if (left > 1e-6) shove(b, map, c.nx * left, c.ny * left);
        if (movedA > 1e-6) onPush?.(a);
        if (movedB > 1e-6) onPush?.(b);
      }
    }
    if (!any) break;
  }
}

// Moves a body by (dx, dy), axis by axis so it slides along walls.
// Returns how far it actually moved along the requested direction.
export function shove(body: Body, map: GameMap, dx: number, dy: number): number {
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return 0;
  const p = body.pos;
  const x0 = p.x;
  const y0 = p.y;
  if (!hitsWall(body, map, p.x + dx, p.y)) p.x += dx;
  if (!hitsWall(body, map, p.x, p.y + dy)) p.y += dy;
  return ((p.x - x0) * dx + (p.y - y0) * dy) / len;
}

function hitsWall(body: Body, map: GameMap, x: number, y: number): boolean {
  // Water blocks bodies on the ground; only bullets (checked elsewhere) fly over it.
  return body.shape === "circle" ? circleHitsSolid(map, x, y, body.size) : boxHitsSolid(map, x, y, body.size);
}

export function contact(a: Body, b: Body): Contact | null {
  if (a.shape === "circle" && b.shape === "circle") return circleCircle(a, b);
  if (a.shape === "box" && b.shape === "box") return boxBox(a, b);
  if (a.shape === "circle") return walkerBox(a, b);
  const c = walkerBox(b, a);
  return c && { nx: -c.nx, ny: -c.ny, depth: c.depth };
}

function walkerBox(circle: Body, box: Body): Contact | null {
  const c = circleBox(circle, box);
  if (!c || !circle.heading) return c;
  return pushFace(circle, box, circle.heading.x, circle.heading.y) ?? c;
}

// How far off the face's centre line (beyond the box's half-width, as a share of the
// walker's radius) a walker still pushes the face square on rather than glancing off the corner.
const FACE_BAND = 0.5;

// A circle walking along (hx, hy) into a box pushes the face across its heading's main axis,
// straight along that axis, as long as its centre is in front of that face and no further
// off the face's centre line than half the box plus FACE_BAND of its radius. Hitting near a
// corner this way still moves the box straight forward instead of spinning the contact
// normal around the corner (which pushed boxes sideways and let the walker slide round them).
// Returns null when the circle isn't touching the box or is outside that band.
export function pushFace(circle: Body, box: Body, hx: number, hy: number): Contact | null {
  if (!circleBox(circle, box)) return null;
  const alongX = Math.abs(hx) >= Math.abs(hy);
  const s = sign(alongX ? hx : hy);
  const ahead = s * (alongX ? box.pos.x - circle.pos.x : box.pos.y - circle.pos.y);
  const off = Math.abs(alongX ? box.pos.y - circle.pos.y : box.pos.x - circle.pos.x);
  // Centre already past the face plane, or beside the box rather than in front of it.
  if (ahead < box.size || off > box.size + circle.size * FACE_BAND) return null;
  const depth = circle.size + box.size - ahead;
  if (depth <= 0) return null;
  return alongX ? { nx: s, ny: 0, depth } : { nx: 0, ny: s, depth };
}

function circleCircle(a: Body, b: Body): Contact | null {
  const dx = b.pos.x - a.pos.x;
  const dy = b.pos.y - a.pos.y;
  const d = Math.hypot(dx, dy);
  const min = a.size + b.size;
  if (d >= min) return null;
  // Exactly stacked bodies (e.g. same spawn point) split along x.
  return d > 1e-6 ? { nx: dx / d, ny: dy / d, depth: min - d } : { nx: 1, ny: 0, depth: min };
}

function boxBox(a: Body, b: Body): Contact | null {
  const dx = b.pos.x - a.pos.x;
  const dy = b.pos.y - a.pos.y;
  const ox = a.size + b.size - Math.abs(dx);
  const oy = a.size + b.size - Math.abs(dy);
  if (ox <= 0 || oy <= 0) return null;
  // Separate along the axis with the least overlap.
  return ox < oy ? { nx: sign(dx), ny: 0, depth: ox } : { nx: 0, ny: sign(dy), depth: oy };
}

// Normal points from the circle to the box.
function circleBox(circle: Body, box: Body): Contact | null {
  const cx = circle.pos.x;
  const cy = circle.pos.y;
  const h = box.size;
  const qx = Math.max(box.pos.x - h, Math.min(cx, box.pos.x + h));
  const qy = Math.max(box.pos.y - h, Math.min(cy, box.pos.y + h));
  const dx = qx - cx;
  const dy = qy - cy;
  const d = Math.hypot(dx, dy);
  if (d > 1e-6) {
    if (d >= circle.size) return null;
    return { nx: dx / d, ny: dy / d, depth: circle.size - d };
  }
  // Centre is inside the box: push out along the nearest face.
  const px = h - Math.abs(cx - box.pos.x);
  const py = h - Math.abs(cy - box.pos.y);
  return px < py
    ? { nx: sign(box.pos.x - cx), ny: 0, depth: px + circle.size }
    : { nx: 0, ny: sign(box.pos.y - cy), depth: py + circle.size };
}

function sign(v: number): number {
  return v < 0 ? -1 : 1;
}
