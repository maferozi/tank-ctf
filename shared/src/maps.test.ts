import assert from "node:assert/strict";
import { test } from "node:test";
import { BED_SIZE, CRATE_SIZE, SPAWN_PAD_SIZE, POWER_BOX_SIZE, TANK_RADIUS, TILE } from "./constants";
import { boxHitsSolid, circleHitsSolid, isBlockedAt, type GameMap } from "./map";
import { MAPS } from "./maps";

const tileOf = (p: { x: number; y: number }) => ({ c: Math.floor(p.x / TILE), r: Math.floor(p.y / TILE) });

// Tiles a soldier can walk to from a start tile: not through walls or water (crates can be
// pushed, so they count as floor).
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
    assert.deepEqual([map.cols, map.rows], [28, 18], "the screen layout assumes 28 x 18");
  });

  test(`${map.name}: has spawns and a flag for each team, nothing inside walls`, () => {
    assert.ok(map.spawns.red.length >= 4 && map.spawns.blue.length >= 4);
    assert.ok(map.flags.red && map.flags.blue);
    for (const s of [...map.spawns.red, ...map.spawns.blue]) assert.equal(circleHitsSolid(map, s.x, s.y, TANK_RADIUS), false);
    for (const c of map.crates) assert.equal(boxHitsSolid(map, c.x, c.y, CRATE_SIZE / 2), false);
    for (const p of map.powerBoxes) assert.equal(boxHitsSolid(map, p.x, p.y, POWER_BOX_SIZE / 2), false);
    for (const b of map.beds) assert.equal(boxHitsSolid(map, b.x, b.y, BED_SIZE / 2), false);
  });

  test(`${map.name}: crates, beds, power boxes, spawns and flags start apart`, () => {
    const boxes = [
      ...map.crates.map((p) => ({ ...p, h: CRATE_SIZE / 2 })),
      ...map.beds.map((p) => ({ ...p, h: BED_SIZE / 2 })),
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
