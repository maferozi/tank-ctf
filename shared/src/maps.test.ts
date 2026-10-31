import assert from "node:assert/strict";
import { test } from "node:test";
import { CRATE_SIZE, POWER_BOX_SIZE, TANK_RADIUS, TILE } from "./constants";
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
  });

  test(`${map.name}: every spawn can reach both flags, both scoring spots and every power box`, () => {
    const bases = [map.bases.red ?? map.flags.red!, map.bases.blue ?? map.flags.blue!];
    const targets = [map.flags.red!, map.flags.blue!, ...bases, ...map.powerBoxes].map(tileOf);
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
      JSON.stringify(map.bases.red && flip(map.bases.red)) === JSON.stringify(map.bases.blue);
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
