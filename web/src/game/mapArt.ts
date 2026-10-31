import { BASE_RADIUS, TILE, type Flag, type GameMap, type MapTheme, type Team, type TileKind } from "@tank/shared";

// The still parts of a map: floor, walls, water and spawn zones, in a light style.
// They never change during a round, so each map is drawn once into an offscreen canvas
// and copied onto the screen every frame.

interface Palette {
  floor: string;
  floorAlt: string; // second floor colour (planks, checker tiles, grass blades)
  wall: string; // front face of a wall block (the side facing down the screen)
  wallTop: string; // top face
  wallEdge: string; // outline where a wall meets the floor
}

// Walls are drawn as raised blocks: a top face, a darker front face, an ink outline.
const INK = "#1c2546";
const PALETTES: Record<MapTheme, Palette> = {
  arena: { floor: "#f3e7cc", floorAlt: "#eadab8", wall: "#2c7a70", wallTop: "#4fb3a4", wallEdge: INK },
  wood: { floor: "#d9a066", floorAlt: "#c98f57", wall: "#454b63", wallTop: "#737c9c", wallEdge: INK },
  grass: { floor: "#6bbb5d", floorAlt: "#5fae52", wall: "#5b4a3e", wallTop: "#a3876f", wallEdge: INK },
  tiles: { floor: "#bad7db", floorAlt: "#aacdd2", wall: "#7a3f2a", wallTop: "#e2774a", wallEdge: INK },
};
const WALL_FRONT = 9; // height of the front face, in map pixels

const WOOD = { floor: "#d39a5e", seam: "rgba(110, 60, 20, 0.22)" };
const WATER = { fill: "#9ed3e4", wave: "rgba(255, 255, 255, 0.55)", edge: "#7fbcd0" };

const TEAM: Record<Team, { body: string; dark: string; zone: string }> = {
  red: { body: "#e5484d", dark: "#a8262b", zone: "rgba(229, 72, 77, 0.14)" },
  blue: { body: "#2f80ed", dark: "#1a5aa8", zone: "rgba(47, 128, 237, 0.14)" },
};

const ART_SCALE = 2; // offscreen resolution: crisp on high-density screens
const cache = new Map<string, HTMLCanvasElement>();

// Copies the map's still layer onto the context (already scaled to map pixels).
export function drawMapLayer(ctx: CanvasRenderingContext2D, map: GameMap): void {
  let art = cache.get(map.id);
  if (!art) {
    art = document.createElement("canvas");
    art.width = map.width * ART_SCALE;
    art.height = map.height * ART_SCALE;
    const g = art.getContext("2d")!;
    g.scale(ART_SCALE, ART_SCALE);
    paintMap(g, map);
    cache.set(map.id, art);
  }
  ctx.drawImage(art, 0, 0, map.width, map.height);
}

function paintMap(ctx: CanvasRenderingContext2D, map: GameMap): void {
  const pal = PALETTES[map.theme];
  ctx.fillStyle = pal.floor;
  ctx.fillRect(0, 0, map.width, map.height);
  forEachTile(map, (kind, c, r) => {
    if (kind === "floor") paintFloor(ctx, map.theme, pal, c, r);
    if (kind === "wood") paintWood(ctx, c, r);
    if (kind === "water") paintWater(ctx, map, c, r);
  });
  for (const team of ["red", "blue"] as const) {
    ctx.fillStyle = TEAM[team].zone;
    for (const s of map.spawns[team]) ctx.fillRect(s.x - TILE / 2, s.y - TILE / 2, TILE, TILE);
  }
  forEachTile(map, (kind, c, r) => {
    if (kind === "wall") paintWall(ctx, map, pal, c, r);
  });
}

function forEachTile(map: GameMap, fn: (kind: TileKind, c: number, r: number) => void): void {
  for (let r = 0; r < map.rows; r++) for (let c = 0; c < map.cols; c++) fn(map.tiles[r * map.cols + c]!, c, r);
}

function kindAt(map: GameMap, c: number, r: number): TileKind | "outside" {
  if (c < 0 || r < 0 || c >= map.cols || r >= map.rows) return "outside";
  return map.tiles[r * map.cols + c]!;
}

// Small deterministic noise so grass and planks look the same on every screen.
function hash(c: number, r: number, k: number): number {
  let h = (c * 374761393 + r * 668265263 + k * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function paintFloor(ctx: CanvasRenderingContext2D, theme: MapTheme, pal: Palette, c: number, r: number): void {
  const x = c * TILE;
  const y = r * TILE;
  if (theme === "wood") return paintWood(ctx, c, r);
  if (theme === "tiles") {
    // Checker of half tiles.
    ctx.fillStyle = pal.floorAlt;
    const h = TILE / 2;
    ctx.fillRect(x, y, h, h);
    ctx.fillRect(x + h, y + h, h, h);
    return;
  }
  if (theme === "grass") {
    ctx.fillStyle = pal.floorAlt;
    for (let k = 0; k < 4; k++) {
      const gx = x + hash(c, r, k) * TILE;
      const gy = y + hash(c, r, k + 9) * TILE;
      ctx.fillRect(gx, gy, 2, 5);
      ctx.fillRect(gx + 3, gy + 1, 2, 4);
    }
    return;
  }
  // Arena: faint grid.
  ctx.strokeStyle = pal.floorAlt;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, TILE - 1, TILE - 1);
}

// Planks running left to right, with staggered seams.
function paintWood(ctx: CanvasRenderingContext2D, c: number, r: number): void {
  const x = c * TILE;
  const y = r * TILE;
  ctx.fillStyle = WOOD.floor;
  ctx.fillRect(x, y, TILE, TILE);
  ctx.strokeStyle = WOOD.seam;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const py = y + i * (TILE / 4);
    ctx.moveTo(x, py + 0.5);
    ctx.lineTo(x + TILE, py + 0.5);
    const seam = x + ((i * 17 + c * 23) % TILE);
    ctx.moveTo(seam + 0.5, py);
    ctx.lineTo(seam + 0.5, py + TILE / 4);
  }
  ctx.stroke();
}

function paintWater(ctx: CanvasRenderingContext2D, map: GameMap, c: number, r: number): void {
  const x = c * TILE;
  const y = r * TILE;
  ctx.fillStyle = WATER.fill;
  ctx.fillRect(x, y, TILE, TILE);
  ctx.strokeStyle = WATER.wave;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (const [dx, dy] of [
    [6, 12],
    [22, 28],
  ] as const) {
    const wx = x + dx + hash(c, r, dx) * 6;
    ctx.moveTo(wx, y + dy);
    ctx.quadraticCurveTo(wx + 4, y + dy - 3, wx + 8, y + dy);
  }
  ctx.stroke();
  edges(ctx, map, c, r, (k) => k !== "water", WATER.edge, 3);
}

function paintWall(ctx: CanvasRenderingContext2D, map: GameMap, pal: Palette, c: number, r: number): void {
  const x = c * TILE;
  const y = r * TILE;
  ctx.fillStyle = pal.wallTop;
  ctx.fillRect(x, y, TILE, TILE);
  const below = kindAt(map, c, r + 1);
  if (below !== "wall" && below !== "outside") {
    ctx.fillStyle = pal.wall;
    ctx.fillRect(x, y + TILE - WALL_FRONT, TILE, WALL_FRONT);
    // Soft shadow the block casts on the floor below.
    ctx.fillStyle = "rgba(28, 37, 70, 0.16)";
    ctx.fillRect(x, y + TILE, TILE, 6);
  }
  if (kindAt(map, c, r - 1) !== "wall") {
    ctx.fillStyle = "rgba(255, 255, 255, 0.25)";
    ctx.fillRect(x, y, TILE, 4);
  }
  edges(ctx, map, c, r, (k) => k !== "wall" && k !== "outside", pal.wallEdge, 2.5);
}

// Outline the sides of a tile that face a different kind of tile.
function edges(
  ctx: CanvasRenderingContext2D,
  map: GameMap,
  c: number,
  r: number,
  differs: (k: TileKind | "outside") => boolean,
  color: string,
  width: number,
): void {
  const x = c * TILE;
  const y = r * TILE;
  ctx.fillStyle = color;
  if (differs(kindAt(map, c, r - 1))) ctx.fillRect(x, y, TILE, width);
  if (differs(kindAt(map, c, r + 1))) ctx.fillRect(x, y + TILE - width, TILE, width);
  if (differs(kindAt(map, c - 1, r))) ctx.fillRect(x, y, width, TILE);
  if (differs(kindAt(map, c + 1, r))) ctx.fillRect(x + TILE - width, y, width, TILE);
}

// Where a team scores: a square pad in the team colour. Flags stand on a round plinth;
// on maps without pads the pad sits under the team's own flag stand.
export function drawBase(ctx: CanvasRenderingContext2D, flag: Flag): void {
  const color = TEAM[flag.team];
  const size = BASE_RADIUS * 1.5;
  const h = size / 2;
  ctx.fillStyle = color.body;
  ctx.strokeStyle = color.dark;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(flag.baseX - h, flag.baseY - h, size, size, 6);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
  ctx.beginPath();
  ctx.roundRect(flag.baseX - h + 7, flag.baseY - h + 7, size - 14, size - 14, 4);
  ctx.fill();
  ctx.fillStyle = color.body;
  ctx.beginPath();
  ctx.moveTo(flag.baseX, flag.baseY - 8);
  ctx.lineTo(flag.baseX + 8, flag.baseY);
  ctx.lineTo(flag.baseX, flag.baseY + 8);
  ctx.lineTo(flag.baseX - 8, flag.baseY);
  ctx.closePath();
  ctx.fill();

  // The flag's round plinth (where it returns to).
  ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
  ctx.strokeStyle = "rgba(60, 70, 85, 0.45)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(flag.homeX, flag.homeY, 13, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}
