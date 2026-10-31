import { TILE } from "./constants";

export type Team = "red" | "blue";

export interface Spawn {
  x: number;
  y: number;
  angle: number;
}

export interface GameMap {
  id: string;
  name: string;
  cols: number;
  rows: number;
  width: number;
  height: number;
  walls: boolean[]; // row-major, cols * rows
  spawns: Record<Team, Spawn[]>;
  crates: { x: number; y: number }[]; // starting centres of movable crates
  powerBoxes: { x: number; y: number }[]; // power-up box spots
  flags: Partial<Record<Team, { x: number; y: number }>>; // flag stands (team bases)
}

// '#' wall, '.' floor, 'R' red spawn, 'B' blue spawn, 'X' movable crate, 'P' power-up box,
// 'r' / 'b' red / blue flag stand (the team's base).
const ARENA = [
  "############################",
  "#.............P............#",
  "#.RR....................BB.#",
  "#.RR.....#........#.....BB.#",
  "#........#...XX...#........#",
  "#....##..#...##...#..##....#",
  "#....##.......##.....##....#",
  "#.......X..........X.......#",
  "#...#######..P...#######.b.#",
  "#.r.#######......#######...#",
  "#.......X..........X.......#",
  "#....##.....##.......##....#",
  "#....##..#...##...#..##....#",
  "#........#...XX...#........#",
  "#.RR.....#........#.....BB.#",
  "#.RR....................BB.#",
  "#.............P............#",
  "############################",
];

export function parseMap(rows: readonly string[], id = "custom", name = "Custom"): GameMap {
  const cols = rows[0]?.length ?? 0;
  const walls: boolean[] = [];
  const spawns: Record<Team, Spawn[]> = { red: [], blue: [] };
  const crates: { x: number; y: number }[] = [];
  const powerBoxes: { x: number; y: number }[] = [];
  const flags: GameMap["flags"] = {};
  rows.forEach((row, r) => {
    if (row.length !== cols) throw new Error(`map row ${r} has length ${row.length}, expected ${cols}`);
    for (let c = 0; c < cols; c++) {
      const ch = row[c];
      walls.push(ch === "#");
      const x = (c + 0.5) * TILE;
      const y = (r + 0.5) * TILE;
      // Red faces right (towards blue), blue faces left.
      if (ch === "R") spawns.red.push({ x, y, angle: 0 });
      if (ch === "B") spawns.blue.push({ x, y, angle: Math.PI });
      if (ch === "X") crates.push({ x, y });
      if (ch === "P") powerBoxes.push({ x, y });
      if (ch === "r") flags.red = { x, y };
      if (ch === "b") flags.blue = { x, y };
    }
  });
  return {
    id,
    name,
    cols,
    rows: rows.length,
    width: cols * TILE,
    height: rows.length * TILE,
    walls,
    spawns,
    crates,
    powerBoxes,
    flags,
  };
}

export const DEFAULT_MAP = parseMap(ARENA, "arena", "Arena");

export function isWallAt(map: GameMap, col: number, row: number): boolean {
  if (col < 0 || row < 0 || col >= map.cols || row >= map.rows) return true;
  return map.walls[row * map.cols + col] ?? true;
}

// True if a square centred at (x, y) with half-size `half` overlaps any wall tile.
export function boxHitsWall(map: GameMap, x: number, y: number, half: number): boolean {
  const eps = 1e-9; // touching a tile edge is not overlapping it
  const c0 = Math.floor((x - half + eps) / TILE);
  const c1 = Math.floor((x + half - eps) / TILE);
  const r0 = Math.floor((y - half + eps) / TILE);
  const r1 = Math.floor((y + half - eps) / TILE);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (isWallAt(map, c, r)) return true;
    }
  }
  return false;
}

// True if a circle at (x, y) overlaps any wall tile.
export function circleHitsWall(map: GameMap, x: number, y: number, radius: number): boolean {
  const c0 = Math.floor((x - radius) / TILE);
  const c1 = Math.floor((x + radius) / TILE);
  const r0 = Math.floor((y - radius) / TILE);
  const r1 = Math.floor((y + radius) / TILE);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (!isWallAt(map, c, r)) continue;
      // Closest point on the tile to the circle centre.
      const nx = Math.max(c * TILE, Math.min(x, (c + 1) * TILE));
      const ny = Math.max(r * TILE, Math.min(y, (r + 1) * TILE));
      const dx = x - nx;
      const dy = y - ny;
      if (dx * dx + dy * dy < radius * radius) return true;
    }
  }
  return false;
}
