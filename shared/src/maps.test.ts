import assert from "node:assert/strict";
import { test } from "node:test";
import { BED_SIZE, CRATE_SIZE, DESK_SIZE, SPAWN_PAD_SIZE, POWER_BOX_SIZE, TANK_RADIUS, TILE } from "./constants";
import { boxHitsSolid, circleHitsSolid, isBlockedAt, isWallAt, type GameMap } from "./map";
import { MAPS } from "./maps";

const tileOf = (p: { x: number; y: number }) => ({ c: Math.floor(p.x / TILE), r: Math.floor(p.y / TILE) });

// Tiles a soldier can walk to from a start tile: not through walls or water (crates, beds
// and desks can be pushed and bushes are walked through, so they count as floor).
function reachable(map: GameMap, start: { c: number; r: number }): Set<string> {
  const seen = new Set([`${start.c},${start.r}`]);
  const queue = [start];
  while (queue.length) {
    const { c, r } = queue.shift()!;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const n = { c: c + dc, r: r + dr };
      const key = `${n.c},${n.r}`;
      if (seen.has(key) || isBlockedAt(map, n.c, n.r)) continue;
      seen.add(key);
      queue.push(n);
    }
  }
  return seen;
}

test("map ids are unique", () => {
  assert.equal(new Set(MAPS.map((m) => m.id)).size, MAPS.length);
});

for (const map of MAPS) {
  test(`${map.name}: same size as every other map`, () => {
    assert.deepEqual([map.cols, map.rows], [26, 18], "the screen layout assumes 26 x 18");
    assert.deepEqual([map.width, map.height], [26 * TILE, 18 * TILE]);
  });

  test(`${map.name}: has spawns and a flag for each team, nothing inside walls`, () => {
    assert.ok(map.spawns.red.length >= 4 && map.spawns.blue.length >= 4);
    assert.ok(map.flags.red && map.flags.blue);
    for (const s of [...map.spawns.red, ...map.spawns.blue]) assert.equal(circleHitsSolid(map, s.x, s.y, TANK_RADIUS), false);
    for (const c of map.crates) assert.equal(boxHitsSolid(map, c.x, c.y, CRATE_SIZE / 2), false);
    for (const p of map.powerBoxes) assert.equal(boxHitsSolid(map, p.x, p.y, POWER_BOX_SIZE / 2), false);
    for (const b of map.beds) assert.equal(boxHitsSolid(map, b.x, b.y, BED_SIZE / 2), false);
    for (const d of map.desks) assert.equal(boxHitsSolid(map, d.x, d.y, DESK_SIZE / 2), false);
    for (const b of map.bushes) {
      const { c, r } = tileOf(b);
      assert.equal(isWallAt(map, c, r), false, "a bush is decoration: it never sits on a wall");
    }
  });

  test(`${map.name}: crates, beds, desks, power boxes, spawns and flags start apart`, () => {
    const boxes = [
      ...map.crates.map((p) => ({ ...p, h: CRATE_SIZE / 2 })),
      ...map.beds.map((p) => ({ ...p, h: BED_SIZE / 2 })),
      ...map.desks.map((p) => ({ ...p, h: DESK_SIZE / 2 })),
      ...map.powerBoxes.map((p) => ({ ...p, h: POWER_BOX_SIZE / 2 })),
    ];
    const points = [...map.spawns.red, ...map.spawns.blue, map.flags.red!, map.flags.blue!];
    boxes.forEach((a, i) => {
      for (const b of boxes.slice(i + 1)) {
        const apart = Math.abs(a.x - b.x) >= a.h + b.h || Math.abs(a.y - b.y) >= a.h + b.h;
        assert.ok(apart, `boxes overlap at (${a.x}, ${a.y}) and (${b.x}, ${b.y})`);
      }
      for (const p of points) {
        const apart = Math.abs(a.x - p.x) >= a.h + TANK_RADIUS || Math.abs(a.y - p.y) >= a.h + TANK_RADIUS;
        assert.ok(apart, `box at (${a.x}, ${a.y}) covers a spawn or flag at (${p.x}, ${p.y})`);
      }
    });
  });

  test(`${map.name}: each respawn square is clear of walls and water, away from its flag`, () => {
    for (const team of ["red", "blue"] as const) {
      const pad = map.pads[team];
      assert.equal(boxHitsSolid(map, pad.x, pad.y, SPAWN_PAD_SIZE / 2), false);
      const flag = map.flags[team]!;
      assert.ok(Math.hypot(flag.x - pad.x, flag.y - pad.y) > 3 * TILE, "respawning right on the flag");
    }
  });

  test(`${map.name}: every spawn can reach both flags and every power box`, () => {
    const targets = [map.flags.red!, map.flags.blue!, ...map.powerBoxes].map(tileOf);
    for (const spawn of [...map.spawns.red, ...map.spawns.blue]) {
      const area = reachable(map, tileOf(spawn));
      for (const t of targets) assert.ok(area.has(`${t.c},${t.r}`), `tile ${t.c},${t.r} unreachable from spawn`);
    }
  });

  test(`${map.name}: each respawn square is away from the enemy flag too`, () => {
    for (const [team, enemy] of [["red", "blue"], ["blue", "red"]] as const) {
      const pad = map.pads[team];
      const flag = map.flags[enemy]!;
      assert.ok(Math.hypot(flag.x - pad.x, flag.y - pad.y) > 6 * TILE, `${team} respawns next to the ${enemy} flag`);
    }
  });

  // Players asked for this: a carrier who reaches home must still be shootable, and
  // defenders need something to hide behind. Cover is an inner wall, desk, bed or crate
  // within 3 tiles of the stand (the outer wall doesn't count).
  test(`${map.name}: each flag stand has cover close by`, () => {
    for (const team of ["red", "blue"] as const) {
      const flag = map.flags[team]!;
      const near = (p: { x: number; y: number }) => Math.hypot(p.x - flag.x, p.y - flag.y) <= 3 * TILE;
      let cover = [...map.crates, ...map.beds, ...map.desks].some(near);
      for (let r = 1; r < map.rows - 1 && !cover; r++) {
        for (let c = 1; c < map.cols - 1 && !cover; c++) {
          if (isWallAt(map, c, r) && near({ x: (c + 0.5) * TILE, y: (r + 0.5) * TILE })) cover = true;
        }
      }
      assert.ok(cover, `${team} flag stand has no cover within 3 tiles`);
    }
  });

  test(`${map.name}: power boxes are in contested ground, not next to a flag stand`, () => {
    assert.ok(map.powerBoxes.length >= 2 && map.powerBoxes.length <= 4, `${map.powerBoxes.length} power boxes`);
    for (const p of map.powerBoxes) {
      for (const team of ["red", "blue"] as const) {
        const flag = map.flags[team]!;
        assert.ok(Math.hypot(p.x - flag.x, p.y - flag.y) > 4 * TILE, `power box at (${p.x}, ${p.y}) is next to the ${team} flag`);
      }
    }
  });

  // A soldier turns all the time, so a one-tile pocket with a single way out is a trap.
  // (Walled-off scenery, like Garden's island, can't be reached and doesn't count.)
  test(`${map.name}: no dead-end floor tiles walled in on three sides`, () => {
    for (const key of reachable(map, tileOf(map.spawns.red[0]!))) {
      const [c, r] = key.split(",").map(Number) as [number, number];
      const open = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dc, dr]) => !isBlockedAt(map, c + dc!, r + dr!));
      assert.ok(open.length >= 2, `tile ${c},${r} is a dead end`);
    }
  });
}

test("the new maps are exactly fair: Blue's side is Red's, mirrored or rotated", () => {
  for (const map of MAPS.filter((m) => m.id !== "arena")) {
    // Mirrored left-right, or rotated half a turn around the centre.
    const mirror = (p: { x: number; y: number }) => ({ x: map.width - p.x, y: p.y });
    const rotate = (p: { x: number; y: number }) => ({ x: map.width - p.x, y: map.height - p.y });
    const key = (ps: { x: number; y: number }[]) => ps.map((p) => `${p.x},${p.y}`).sort();
    const fairUnder = (flip: typeof mirror) =>
      JSON.stringify(flip(map.flags.red!)) === JSON.stringify(map.flags.blue) &&
      JSON.stringify(key(map.spawns.red.map(flip))) === JSON.stringify(key(map.spawns.blue)) &&
      JSON.stringify(flip(map.pads.red)) === JSON.stringify(map.pads.blue);
    assert.ok(fairUnder(mirror) || fairUnder(rotate), `${map.name} is not symmetric`);
    // Crates, beds, desks, power boxes and bushes are placed the same way for both teams.
    const flip = fairUnder(mirror) ? mirror : rotate;
    for (const objects of [map.crates, map.beds, map.desks, map.powerBoxes, map.bushes]) {
      assert.deepEqual(key(objects.map(flip)), key(objects), `${map.name} objects are not symmetric`);
    }
  }
});

test("the new maps' walls and water are symmetric too", () => {
  for (const map of MAPS.filter((m) => m.id !== "arena")) {
    const at = (c: number, r: number) => map.tiles[r * map.cols + c];
    let mirror = true;
    let rotate = true;
    for (let r = 0; r < map.rows; r++) {
      for (let c = 0; c < map.cols; c++) {
        if (at(c, r) !== at(map.cols - 1 - c, r)) mirror = false;
        if (at(c, r) !== at(map.cols - 1 - c, map.rows - 1 - r)) rotate = false;
      }
    }
    assert.ok(mirror || rotate, `${map.name} walls are not symmetric`);
  }
});
