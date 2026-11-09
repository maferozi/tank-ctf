import { BULLET_RADIUS, TANK_RADIUS, circleHitsSolid, circleHitsWall, copyInto, getMap, type GameMap, type GameState, type Tank } from "@tank/shared";

interface Movable {
  x: number;
  y: number;
}

// Blends two game states (matched by id) into one, t = 0..1. Things only in `b` are taken
// as they are. With `extrapolate`, t may go past 1: living soldiers and bullets carry on the
// way they were going (stopping short of walls), everything else stays as in `b`. The online
// driver uses that for a late snapshot, so others don't freeze. Used by the online driver, which mixes states from different timelines.
// It runs every frame, so it reuses its output: the state it returns (and the blended
// objects in it) are only valid until the next call. Unchanged objects are `b`'s own.
export class Blender {
  private out = {} as GameState;
  private lists = new Map<string, unknown[]>(); // output arrays, per field
  private pools = new Map<string, Movable[]>(); // blended objects, per field and slot
  private byKey = new Map<unknown, Movable>();

  blend(a: GameState, b: GameState, t: number, extrapolate = false): GameState {
    if (a === b || (t >= 1 && !extrapolate) || t === 1) return b;
    const map = t > 1 ? getMap(b.mapId) : null;
    const out = this.out as unknown as Record<string, unknown>;
    for (const k in b) out[k] = (b as unknown as Record<string, unknown>)[k];
    // Don't slide across the map when someone respawns.
    out.tanks = this.list("tanks", a.tanks, b.tanks, t, (x) => x.id, (p, x) => p.alive === x.alive && (!map || x.alive), true, map && ((x, y) => circleHitsSolid(map, x, y, TANK_RADIUS)));
    out.bullets = this.list("bullets", a.bullets, b.bullets, t, (x) => x.id, undefined, false, map && ((x, y) => circleHitsWall(map, x, y, BULLET_RADIUS)));
    const still = Math.min(t, 1); // crates, boxes and flags don't guess ahead
    // Pushed blocks also turn (angle), blended the short way round like soldiers.
    out.crates = this.list("crates", a.crates, b.crates, still, (x) => x.id, undefined, true);
    // A box that just came home must not slide back.
    out.powerBoxes = this.list("powerBoxes", a.powerBoxes, b.powerBoxes, still, (x) => x.id, (p, x) => p.respawnMs <= 0 && x.respawnMs <= 0, true);
    // Carried flags are drawn on their carrier; a flag sent home must not slide back.
    out.flags = this.list("flags", a.flags, b.flags, still, (x) => x.team, (p, x) => p.atHome === x.atHome);
    return this.out;
  }

  private list<T extends Movable>(
    field: string,
    from: readonly T[],
    to: readonly T[],
    t: number,
    key: (x: T) => unknown,
    canBlend: (p: T, x: T) => boolean = () => true,
    angle = false,
    blocked: ((x: number, y: number) => boolean) | null = null, // only when extrapolating
  ): T[] {
    const byKey = this.byKey;
    byKey.clear();
    for (const p of from) byKey.set(key(p), p);
    let out = this.lists.get(field) as T[] | undefined;
    if (!out) this.lists.set(field, (out = []));
    let pool = this.pools.get(field) as T[] | undefined;
    if (!pool) this.pools.set(field, (pool = []));
    out.length = to.length;
    for (let i = 0; i < to.length; i++) {
      const x = to[i]!;
      const p = byKey.get(key(x)) as T | undefined;
      const turned = angle && (p as unknown as Tank)?.angle !== (x as unknown as Tank).angle;
      if (!p || (p.x === x.x && p.y === x.y && !turned) || !canBlend(p, x)) {
        out[i] = x;
        continue;
      }
      const slot = (pool[i] = copyInto(pool[i] ?? null, x));
      slot.x = lerp(p.x, x.x, t);
      slot.y = lerp(p.y, x.y, t);
      if (blocked?.(slot.x, slot.y)) {
        slot.x = x.x;
        slot.y = x.y;
      }
      if (angle) (slot as unknown as Tank).angle = lerpAngle((p as unknown as Tank).angle, (x as unknown as Tank).angle, t);
      out[i] = slot;
    }
    return out;
  }
}

// One-off blend into new objects (allocates; prefer a Blender for per-frame use).
export function blendStates(a: GameState, b: GameState, t: number): GameState {
  const blended = new Blender().blend(a, b, t);
  return blended === b ? b : copyInto(null, blended);
}

export function blendTank(a: Tank, b: Tank, t: number): Tank {
  return { ...b, x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), angle: lerpAngle(a.angle, b.angle, t) };
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
