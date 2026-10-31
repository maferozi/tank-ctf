import { SPAWN_PAD_SPREAD, TILE } from "./constants";

export type Team = "red" | "blue";

export interface Spawn {
  x: number;
  y: number;
  angle: number;
}

// How a map is drawn (floor and wall art). Gameplay is the same for every theme.
export type MapTheme = "arena" | "wood" | "grass" | "tiles";

// What each tile is, for drawing: wall, water, wood floor (e.g. inside a house on a grass
// map) or plain floor.
export type TileKind = "wall" | "water" | "wood" | "floor";

export interface GameMap {
  id: string;
  name: string;
  theme: MapTheme;
  cols: number;
  rows: number;
  width: number;
  height: number;
  tiles: TileKind[]; // row-major, cols * rows
  walls: boolean[]; // blocks walking and bullets
  water: boolean[]; // blocks walking only: bullets fly over it
  spawns: Record<Team, Spawn[]>; // the four spots on each team's respawn square
  crates: { x: number; y: number }[]; // starting centres of movable crates
  beds: { x: number; y: number }[]; // starting centres of beds (big movable blocks)
  powerBoxes: { x: number; y: number }[]; // power-up box spots
  flags: Partial<Record<Team, { x: number; y: number }>>; // flag stands
  // Centre of each team's respawn square (2 x 2 tiles). Teams score at their own flag stand.
  pads: Record<Team, { x: number; y: number }>;
}

// '#' wall, '.' floor, 'X' movable crate, 'P' power-up box, 'r' / 'b' red / blue flag stand,
// '1' / '2' red / blue respawn square (a 2 x 2 block), 'T' bed (each 2 x 2 block of T is
// one bed), '~' water (blocks walking, not bullets), ',' wood floor.
const ARENA = [
  "############################",
  "#.............P............#",
  "#.11....................22.#",
  "#.11.....#........#.....22.#",
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
  "#........#........#........#",
  "#..........................#",
  "#.............P............#",
  "############################",
];

export function parseMap(rows: readonly string[], id = "custom", name = "Custom", theme: MapTheme = "arena"): GameMap {
  const cols = rows[0]?.length ?? 0;
  const tiles: TileKind[] = [];
  const walls: boolean[] = [];
  const water: boolean[] = [];
  const padTiles: Record<Team, { x: number; y: number }[]> = { red: [], blue: [] };
  const spawns: Record<Team, Spawn[]> = { red: [], blue: [] };
  const crates: { x: number; y: number }[] = [];
  const beds: { x: number; y: number }[] = [];
  const powerBoxes: { x: number; y: number }[] = [];
  const flags: GameMap["flags"] = {};
  rows.forEach((row, r) => {
    if (row.length !== cols) throw new Error(`map row ${r} has length ${row.length}, expected ${cols}`);
    for (let c = 0; c < cols; c++) {
      const ch = row[c];
      const kind: TileKind = ch === "#" ? "wall" : ch === "~" ? "water" : ch === "," ? "wood" : "floor";
      tiles.push(kind);
      walls.push(kind === "wall");
      water.push(kind === "water");
      const x = (c + 0.5) * TILE;
      const y = (r + 0.5) * TILE;
      if (ch === "X") crates.push({ x, y });
      if (ch === "P") powerBoxes.push({ x, y });
      if (ch === "r") flags.red = { x, y };
      if (ch === "b") flags.blue = { x, y };
      if (ch === "1") padTiles.red.push({ x, y });
      if (ch === "2") padTiles.blue.push({ x, y });
    }
  });
  // Respawn squares: one 2 x 2 block per team, with a spawn spot in each quarter.
  // Red faces right (towards blue), blue faces left.
  const pads = {} as GameMap["pads"];
  for (const team of ["red", "blue"] as const) {
    const t = padTiles[team];
    const xs = new Set(t.map((p) => p.x));
    const ys = new Set(t.map((p) => p.y));
    if (t.length !== 4 || xs.size !== 2 || ys.size !== 2) {
      throw new Error(`map ${id}: ${team} needs one 2 x 2 respawn square (${team === "red" ? "1" : "2"})`);
    }
    const pad = { x: t.reduce((a, p) => a + p.x, 0) / 4, y: t.reduce((a, p) => a + p.y, 0) / 4 };
    pads[team] = pad;
    const angle = team === "red" ? 0 : Math.PI;
    const d = SPAWN_PAD_SPREAD;
    for (const [dx, dy] of [
      [-d, -d],
      [d, d],
      [d, -d],
      [-d, d],
    ] as const) {
      spawns[team].push({ x: pad.x + dx, y: pad.y + dy, angle });
    }
  }
  // Beds: pair up T tiles into 2 x 2 blocks, left to right and top to bottom.
  const claimed = new Set<string>();
  rows.forEach((row, r) => {
    for (let c = 0; c < cols; c++) {
      if (row[c] !== "T" || claimed.has(`${c},${r}`)) continue;
      const block = [
        [c, r],
        [c + 1, r],
        [c, r + 1],
        [c + 1, r + 1],
      ] as const;
      if (!block.every(([bc, br]) => rows[br]?.[bc] === "T" && !claimed.has(`${bc},${br}`))) {
        throw new Error(`map ${id}: bed at row ${r}, col ${c} is not a 2 x 2 block of T`);
      }
      for (const [bc, br] of block) claimed.add(`${bc},${br}`);
      beds.push({ x: (c + 1) * TILE, y: (r + 1) * TILE });
    }
  });
  // Tiles holding an object (crate, flag, respawn square...) have no floor of their own: give
  // them the floor most of their neighbours have, so a crate in a wooden room sits on wood.
  const objects = new Set(["X", "P", "r", "b", "1", "2", "T"]);
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
    beds,
    powerBoxes,
    flags,
    pads,
  };
}

export const DEFAULT_MAP = parseMap(ARENA, "arena", "Arena");

// Stops bullets (and walking): walls and everything outside the map.
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
