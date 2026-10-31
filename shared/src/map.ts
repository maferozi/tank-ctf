import { TILE } from "./constants";

export type Team = "red" | "blue";

export interface Spawn {
  x: number;
  y: number;
  angle: number;
}

// How a map is drawn (floor and wall art). Gameplay is the same for every theme.
export type MapTheme = "arena" | "wood" | "grass" | "tiles";

// What each tile is, for drawing: wall, desk (a wall drawn as a table), water, wood floor
// (e.g. inside a house on a grass map) or plain floor.
export type TileKind = "wall" | "desk" | "water" | "wood" | "floor";

export interface GameMap {
  id: string;
  name: string;
  theme: MapTheme;
  cols: number;
  rows: number;
  width: number;
  height: number;
  tiles: TileKind[]; // row-major, cols * rows
  walls: boolean[]; // blocks walking and bullets (walls and desks)
  water: boolean[]; // blocks walking only: bullets fly over it
  spawns: Record<Team, Spawn[]>;
  crates: { x: number; y: number }[]; // starting centres of movable crates
  powerBoxes: { x: number; y: number }[]; // power-up box spots
  flags: Partial<Record<Team, { x: number; y: number }>>; // flag stands
  // Where a team scores by bringing the enemy flag. Maps without pads score at the team's
  // own flag stand.
  bases: Partial<Record<Team, { x: number; y: number }>>;
}

// '#' wall, '.' floor, 'R' red spawn, 'B' blue spawn, 'X' movable crate, 'P' power-up box,
// 'r' / 'b' red / blue flag stand, '1' / '2' red / blue scoring pad, 'T' desk (a wall),
// '~' water (blocks walking, not bullets), ',' wood floor.
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

export function parseMap(rows: readonly string[], id = "custom", name = "Custom", theme: MapTheme = "arena"): GameMap {
  const cols = rows[0]?.length ?? 0;
  const tiles: TileKind[] = [];
  const walls: boolean[] = [];
  const water: boolean[] = [];
  const bases: GameMap["bases"] = {};
  const spawns: Record<Team, Spawn[]> = { red: [], blue: [] };
  const crates: { x: number; y: number }[] = [];
  const powerBoxes: { x: number; y: number }[] = [];
  const flags: GameMap["flags"] = {};
  rows.forEach((row, r) => {
    if (row.length !== cols) throw new Error(`map row ${r} has length ${row.length}, expected ${cols}`);
    for (let c = 0; c < cols; c++) {
      const ch = row[c];
      const kind: TileKind = ch === "#" ? "wall" : ch === "T" ? "desk" : ch === "~" ? "water" : ch === "," ? "wood" : "floor";
      tiles.push(kind);
      walls.push(kind === "wall" || kind === "desk");
      water.push(kind === "water");
      const x = (c + 0.5) * TILE;
      const y = (r + 0.5) * TILE;
      // Red faces right (towards blue), blue faces left.
      if (ch === "R") spawns.red.push({ x, y, angle: 0 });
      if (ch === "B") spawns.blue.push({ x, y, angle: Math.PI });
      if (ch === "X") crates.push({ x, y });
      if (ch === "P") powerBoxes.push({ x, y });
      if (ch === "r") flags.red = { x, y };
      if (ch === "b") flags.blue = { x, y };
      if (ch === "1") bases.red = { x, y };
      if (ch === "2") bases.blue = { x, y };
    }
  });
  // Tiles holding an object (spawn, crate, flag, pad...) have no floor of their own: give
  // them the floor most of their neighbours have, so a crate in a wooden room sits on wood.
  const objects = new Set(["R", "B", "X", "P", "r", "b", "1", "2"]);
  rows.forEach((row, r) => {
    for (let c = 0; c < cols; c++) {
      if (!objects.has(row[c]!)) continue;
      const around = [rows[r - 1]?.[c], rows[r + 1]?.[c], row[c - 1], row[c + 1]];
      const wood = around.filter((ch) => ch === ",").length;
      const plain = around.filter((ch) => ch === "." ).length;
      if (wood > plain) tiles[r * cols + c] = "wood";
    }
  });

  return {
    id,
    name,
    theme,
    cols,
    rows: rows.length,
    width: cols * TILE,
    height: rows.length * TILE,
    tiles,
    walls,
    water,
    spawns,
    crates,
    powerBoxes,
    flags,
    bases,
  };
}

export const DEFAULT_MAP = parseMap(ARENA, "arena", "Arena");

// Stops bullets (and walking): walls, desks, and everything outside the map.
export function isWallAt(map: GameMap, col: number, row: number): boolean {
  if (col < 0 || row < 0 || col >= map.cols || row >= map.rows) return true;
  return map.walls[row * map.cols + col] ?? true;
}

// Stops walking and sliding: walls plus water.
export function isBlockedAt(map: GameMap, col: number, row: number): boolean {
  return isWallAt(map, col, row) || map.water[row * map.cols + col] === true;
}

type SolidAt = (map: GameMap, col: number, row: number) => boolean;

// For bodies on the ground (soldiers, crates, power boxes): walls and water.
export function boxHitsSolid(map: GameMap, x: number, y: number, half: number): boolean {
  return boxHitsWall(map, x, y, half, isBlockedAt);
}

export function circleHitsSolid(map: GameMap, x: number, y: number, radius: number): boolean {
  return circleHitsWall(map, x, y, radius, isBlockedAt);
}

// True if a square centred at (x, y) with half-size `half` overlaps any wall tile.
export function boxHitsWall(map: GameMap, x: number, y: number, half: number, solidAt: SolidAt = isWallAt): boolean {
  const eps = 1e-9; // touching a tile edge is not overlapping it
  const c0 = Math.floor((x - half + eps) / TILE);
  const c1 = Math.floor((x + half - eps) / TILE);
  const r0 = Math.floor((y - half + eps) / TILE);
  const r1 = Math.floor((y + half - eps) / TILE);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (solidAt(map, c, r)) return true;
    }
  }
  return false;
}

// True if a circle at (x, y) overlaps any wall tile (bullets use this: water doesn't count).
export function circleHitsWall(map: GameMap, x: number, y: number, radius: number, solidAt: SolidAt = isWallAt): boolean {
  const c0 = Math.floor((x - radius) / TILE);
  const c1 = Math.floor((x + radius) / TILE);
  const r0 = Math.floor((y - radius) / TILE);
  const r1 = Math.floor((y + radius) / TILE);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (!solidAt(map, c, r)) continue;
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
