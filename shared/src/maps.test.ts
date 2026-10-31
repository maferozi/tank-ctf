import assert from "node:assert/strict";
import { test } from "node:test";
import { CRATE_SIZE, POWER_BOX_SIZE, TANK_RADIUS, TILE } from "./constants";
import { boxHitsWall, circleHitsWall, isWallAt, type GameMap } from "./map";
import { MAPS } from "./maps";

const tileOf = (p: { x: number; y: number }) => ({ c: Math.floor(p.x / TILE), r: Math.floor(p.y / TILE) });

// Floor tiles reachable from a start tile (crates can be pushed, so they count as floor).
function reachable(map: GameMap, start: { c: number; r: number }): Set<string> {
  const seen = new Set([`${start.c},${start.r}`]);
  const queue = [start];
  while (queue.length) {
    const { c, r } = queue.shift()!;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const n = { c: c + dc, r: r + dr };
      const key = `${n.c},${n.r}`;
      if (seen.has(key) || isWallAt(map, n.c, n.r)) continue;
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
    for (const s of [...map.spawns.red, ...map.spawns.blue]) assert.equal(circleHitsWall(map, s.x, s.y, TANK_RADIUS), false);
    for (const c of map.crates) assert.equal(boxHitsWall(map, c.x, c.y, CRATE_SIZE / 2), false);
    for (const p of map.powerBoxes) assert.equal(boxHitsWall(map, p.x, p.y, POWER_BOX_SIZE / 2), false);
  });

  test(`${map.name}: every spawn can reach both flags and every power box`, () => {
    const targets = [map.flags.red!, map.flags.blue!, ...map.powerBoxes].map(tileOf);
    for (const spawn of [...map.spawns.red, ...map.spawns.blue]) {
      const area = reachable(map, tileOf(spawn));
      for (const t of targets) assert.ok(area.has(`${t.c},${t.r}`), `tile ${t.c},${t.r} unreachable from spawn`);
    }
  });
}

test("the mirrored maps are exactly fair: Blue's half is Red's, flipped", () => {
  for (const map of MAPS.filter((m) => m.id !== "arena")) {
    const flip = (p: { x: number; y: number }) => ({ x: map.width - p.x, y: p.y });
    assert.deepEqual(flip(map.flags.red!), map.flags.blue, `${map.name} flags`);
    const blueSpawns = map.spawns.blue.map((s) => `${s.x},${s.y}`).sort();
    assert.deepEqual(map.spawns.red.map(flip).map((s) => `${s.x},${s.y}`).sort(), blueSpawns, `${map.name} spawns`);
  }
});
