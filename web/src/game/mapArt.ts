import { BASE_RADIUS, SPAWN_PAD_SIZE, SPAWN_PAD_SPREAD, TILE, createFlags, type Flag, type GameMap, type MapTheme, type Team, type TileKind } from "@tank/shared";
import { INK, TEAM, hash } from "./art/common";

// The still parts of a map: floor, walls, water, bushes, respawn squares and flag stands, in
// the original's top-down cartoon style (dark slate walls with a coloured rim, bright floors).
// They never change during a round, so each map is drawn once into an offscreen canvas and
// copied onto the screen every frame.

interface Palette {
  floor: string;
  floorAlt: string; // second floor colour (checker tiles, slab seams, grass blobs)
  rim: string; // the coloured rim round every wall
}

const PALETTES: Record<MapTheme, Palette> = {
  arena: { floor: "#e9dec6", floorAlt: "#dccfb2", rim: "#f2a93b" },
  wood: { floor: "#d99a5b", floorAlt: "#c98a4d", rim: "#e7b073" },
  grass: { floor: "#45b653", floorAlt: "#5cc768", rim: "#d9a066" },
  tiles: { floor: "#acd6d6", floorAlt: "#98c6c8", rim: "#f27c22" },
  office: { floor: "#d8783f", floorAlt: "#c96a33", rim: "#f27c22" },
};
const SLATE = "#464a56"; // wall tops
const SLATE_LIGHT = "#555a68";
const RIM = 5; // rim width, map px
const PLANK = { base: "#d9a066", seam: "rgba(96, 52, 18, 0.32)", grain: "rgba(120, 66, 24, 0.12)" };
const WATER = { fill: "#58c0ea", deep: "rgba(20, 80, 140, 0.28)", ripple: "rgba(255, 255, 255, 0.6)" };
const WASHROOM = { floor: "#f3f6f9", grout: "#dbe2ea" };
const BUSH = { edge: "#2b8a45", fill: "#66d06e", light: "#8fe58f", shadow: "rgba(10, 40, 20, 0.2)" };

const ART_SCALE = 2; // offscreen resolution: crisp on high-density screens
const cache = new Map<string, HTMLCanvasElement>();

// Copies the map's still layer onto the context (already scaled to map pixels). Map previews
// pass a lower `scale` so the picker doesn't keep nine full-size maps in memory.
export function drawMapLayer(ctx: CanvasRenderingContext2D, map: GameMap, scale = ART_SCALE): void {
  const key = `${map.id}@${scale}`;
  let art = cache.get(key);
  if (!art) {
    art = document.createElement("canvas");
    art.width = Math.ceil(map.width * scale);
    art.height = Math.ceil(map.height * scale);
    const g = art.getContext("2d")!;
    g.scale(scale, scale);
    paintMap(g, map);
    cache.set(key, art);
  }
  ctx.drawImage(art, 0, 0, map.width, map.height);
}

function paintMap(ctx: CanvasRenderingContext2D, map: GameMap): void {
  const pal = PALETTES[map.theme] ?? PALETTES.arena;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.fillStyle = pal.floor;
  ctx.fillRect(0, 0, map.width, map.height);
  forEachTile(map, (kind, c, r) => {
    if (kind === "floor") paintFloor(ctx, map, pal, c, r);
    if (kind === "wood") paintPlanks(ctx, c, r);
  });
  if (map.theme === "grass") paintGrassBlobs(ctx, map, pal);
  paintWater(ctx, map);
  for (const team of ["red", "blue"] as const) paintPad(ctx, team, map.pads[team]);
  paintBushes(ctx, map);
  paintWalls(ctx, map, pal);
  for (const flag of createFlags(map)) drawBase(ctx, flag);
}

function forEachTile(map: GameMap, fn: (kind: TileKind, c: number, r: number) => void): void {
  for (let r = 0; r < map.rows; r++) for (let c = 0; c < map.cols; c++) fn(map.tiles[r * map.cols + c]!, c, r);
}

function kindAt(map: GameMap, c: number, r: number): TileKind | "outside" {
  if (c < 0 || r < 0 || c >= map.cols || r >= map.rows) return "outside";
  return map.tiles[r * map.cols + c]!;
}

function isWall(map: GameMap, c: number, r: number): boolean {
  const k = kindAt(map, c, r);
  return k === "wall" || k === "outside";
}

// The office's washrooms: white tile strips along the top and bottom, behind the long walls.
function isWashroom(map: GameMap, r: number): boolean {
  return map.theme === "office" && (r <= 2 || r >= map.rows - 3);
}

function paintFloor(ctx: CanvasRenderingContext2D, map: GameMap, pal: Palette, c: number, r: number): void {
  const x = c * TILE;
  const y = r * TILE;
  const h = TILE / 2;
  switch (map.theme) {
    case "wood":
      return paintPlanks(ctx, c, r);
    case "tiles":
      // Small checker, two cells per tile each way, as in the original.
      ctx.fillStyle = pal.floorAlt;
      ctx.fillRect(x, y, h, h);
      ctx.fillRect(x + h, y + h, h, h);
      return;
    case "office":
      if (isWashroom(map, r)) {
        ctx.fillStyle = WASHROOM.floor;
        ctx.fillRect(x, y, TILE, TILE);
        ctx.fillStyle = WASHROOM.grout;
        ctx.fillRect(x, y, TILE, 1.5);
        ctx.fillRect(x, y + h, TILE, 1.5);
        ctx.fillRect(x, y, 1.5, TILE);
        ctx.fillRect(x + h, y, 1.5, TILE);
        return;
      }
      // Large terracotta tiles with a soft grout line and a slight shade per tile.
      ctx.fillStyle = hash(c, r, 1) > 0.5 ? "rgba(255, 255, 255, 0.025)" : "rgba(0, 0, 0, 0.015)";
      ctx.fillRect(x, y, TILE, TILE);
      ctx.fillStyle = pal.floorAlt;
      ctx.fillRect(x, y, TILE, 1.5);
      ctx.fillRect(x, y, 1.5, TILE);
      return;
    case "grass": {
      // Little tufts of darker blades.
      if (hash(c, r, 3) < 0.45) {
        const gx = x + 8 + hash(c, r, 4) * (TILE - 16);
        const gy = y + 10 + hash(c, r, 5) * (TILE - 16);
        ctx.strokeStyle = "rgba(20, 90, 40, 0.45)";
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(gx - 3, gy - 4);
        ctx.lineTo(gx - 1, gy);
        ctx.lineTo(gx, gy - 5);
        ctx.lineTo(gx + 1.5, gy);
        ctx.lineTo(gx + 3.5, gy - 3.5);
        ctx.stroke();
      }
      if (hash(c, r, 6) < 0.06) {
        // A pebble
        ctx.fillStyle = "#c9d2d6";
        ctx.strokeStyle = "rgba(27, 32, 51, 0.5)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(x + 12 + hash(c, r, 7) * 16, y + 12 + hash(c, r, 8) * 16, 3, 2.2, 0.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      return;
    }
    default: {
      // Arena: stone slabs with a lit top-left and shaded bottom-right edge.
      ctx.fillStyle = hash(c, r, 2) > 0.5 ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.02)";
      ctx.fillRect(x, y, TILE, TILE);
      ctx.fillStyle = "rgba(255, 255, 255, 0.45)";
      ctx.fillRect(x + 1, y + 1, TILE - 2, 1.5);
      ctx.fillRect(x + 1, y + 1, 1.5, TILE - 2);
      ctx.fillStyle = pal.floorAlt;
      ctx.fillRect(x, y + TILE - 1.5, TILE, 1.5);
      ctx.fillRect(x + TILE - 1.5, y, 1.5, TILE);
    }
  }
}

// Wooden planks running left to right, each with its own shade, staggered joints and grain.
function paintPlanks(ctx: CanvasRenderingContext2D, c: number, r: number): void {
  const x = c * TILE;
  const y = r * TILE;
  const ph = TILE / 4;
  ctx.fillStyle = PLANK.base;
  ctx.fillRect(x, y, TILE, TILE);
  for (let i = 0; i < 4; i++) {
    const py = y + i * ph;
    const row = r * 4 + i;
    // Each plank row has a joint at its own offset; planks either side of it differ in shade.
    const joint = ((row * 29) % 80) - 20; // px from this tile's left, may be off-tile
    for (let seg = 0; seg < 2; seg++) {
      const sx0 = seg === 0 ? x : x + Math.max(0, Math.min(TILE, joint));
      const sx1 = seg === 0 ? x + Math.max(0, Math.min(TILE, joint)) : x + TILE;
      if (sx1 <= sx0) continue;
      const shade = hash(Math.floor((c * TILE + (seg === 0 ? -1 : 1) * 40 - joint) / 80), row, 11);
      ctx.fillStyle = shade > 0.5 ? `rgba(255, 235, 200, ${(shade - 0.5) * 0.22})` : `rgba(90, 45, 10, ${(0.5 - shade) * 0.16})`;
      ctx.fillRect(sx0, py, sx1 - sx0, ph);
    }
    ctx.fillStyle = PLANK.grain;
    ctx.fillRect(x, py + 3 + hash(c, row, 12) * 3, TILE, 0.8);
    ctx.fillStyle = PLANK.seam;
    ctx.fillRect(x, py, TILE, 1.2);
    if (joint > 0 && joint < TILE) ctx.fillRect(x + joint, py, 1.2, ph);
  }
}

// Soft lighter patches over the grass, like the original's bush shadows, clipped to grass.
function paintGrassBlobs(ctx: CanvasRenderingContext2D, map: GameMap, pal: Palette): void {
  ctx.save();
  ctx.beginPath();
  forEachTile(map, (kind, c, r) => {
    if (kind === "floor") ctx.rect(c * TILE, r * TILE, TILE, TILE);
  });
  ctx.clip();
  ctx.fillStyle = pal.floorAlt;
  ctx.globalAlpha = 0.3;
  for (let k = 0; k < 9; k++) {
    const cx = hash(k, 1, 21) * map.width;
    const cy = hash(k, 2, 22) * map.height;
    const rad = 26 + hash(k, 3, 23) * 34;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.arc(cx + rad * 0.7, cy + rad * 0.2, rad * 0.7, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function paintWater(ctx: CanvasRenderingContext2D, map: GameMap): void {
  forEachTile(map, (kind, c, r) => {
    if (kind !== "water") return;
    const x = c * TILE;
    const y = r * TILE;
    ctx.fillStyle = WATER.fill;
    ctx.fillRect(x, y, TILE, TILE);
    // Deeper shade along banks, strongest under the top bank.
    ctx.fillStyle = WATER.deep;
    if (kindAt(map, c, r - 1) !== "water") ctx.fillRect(x, y, TILE, 9);
    if (kindAt(map, c - 1, r) !== "water") ctx.fillRect(x, y, 5, TILE);
    if (kindAt(map, c + 1, r) !== "water") ctx.fillRect(x + TILE - 5, y, 5, TILE);
    ctx.strokeStyle = WATER.ripple;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const [dx, dy] of [
      [6, 14],
      [20, 30],
    ] as const) {
      const wx = x + dx + hash(c, r, dx) * 8;
      ctx.moveTo(wx, y + dy);
      ctx.quadraticCurveTo(wx + 4, y + dy - 3.5, wx + 8, y + dy);
      ctx.quadraticCurveTo(wx + 12, y + dy + 3.5, wx + 16, y + dy);
    }
    ctx.stroke();
    // A light bank where water meets floor.
    ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
    const sides: [TileKind | "outside", number, number, number, number][] = [
      [kindAt(map, c, r - 1), x, y, TILE, 2],
      [kindAt(map, c, r + 1), x, y + TILE - 2, TILE, 2],
      [kindAt(map, c - 1, r), x, y, 2, TILE],
      [kindAt(map, c + 1, r), x + TILE - 2, y, 2, TILE],
    ];
    for (const [k, sx, sy, sw, sh] of sides) if (k === "floor" || k === "wood") ctx.fillRect(sx, sy, sw, sh);
  });
}

// Bushes: soft round clumps that merge with their neighbours, with a dark green edge. They
// are only decoration (soldiers walk through them, bullets fly over), so they live here.
function paintBushes(ctx: CanvasRenderingContext2D, map: GameMap): void {
  if (map.bushes.length === 0) return;
  const lobes = (dx: number, dy: number, grow: number) => {
    ctx.beginPath();
    for (const b of map.bushes) {
      const k = Math.round(b.x * 7 + b.y * 13);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + hash(k, i, 31);
        const d = i === 0 ? 0 : 9;
        const rad = (i === 0 ? 14 : 10 + hash(k, i, 32) * 3) + grow;
        const lx = b.x + Math.cos(a) * d + dx;
        const ly = b.y + Math.sin(a) * d + dy;
        ctx.moveTo(lx + rad, ly);
        ctx.arc(lx, ly, rad, 0, Math.PI * 2);
      }
    }
  };
  lobes(3, 5, 0);
  ctx.fillStyle = BUSH.shadow;
  ctx.fill();
  lobes(0, 0, 2);
  ctx.fillStyle = BUSH.edge;
  ctx.fill();
  lobes(0, 0, 0);
  ctx.fillStyle = BUSH.fill;
  ctx.fill();
  lobes(-2, -2.5, -5);
  ctx.fillStyle = BUSH.light;
  ctx.globalAlpha = 0.7;
  ctx.fill();
  ctx.globalAlpha = 1;
  // Leafy texture: short darker arcs scattered over each clump.
  ctx.strokeStyle = "rgba(25, 110, 50, 0.4)";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  for (const b of map.bushes) {
    const k = Math.round(b.x * 3 + b.y * 5);
    for (let i = 0; i < 3; i++) {
      const lx = b.x - 10 + hash(k, i, 33) * 20;
      const ly = b.y - 8 + hash(k, i, 34) * 18;
      const a = hash(k, i, 35) * Math.PI * 2;
      ctx.moveTo(lx + Math.cos(a) * 3.5, ly + Math.sin(a) * 3.5);
      ctx.arc(lx, ly, 3.5, a, a + 1.6);
    }
  }
  ctx.stroke();
}

// Walls: dark slate tops with a coloured rim on every side that faces the floor, an ink line
// at the edge, and a soft shadow cast down and to the right.
function paintWalls(ctx: CanvasRenderingContext2D, map: GameMap, pal: Palette): void {
  const wallPath = (dx: number, dy: number) => {
    ctx.beginPath();
    forEachTile(map, (kind, c, r) => {
      if (kind === "wall") ctx.rect(c * TILE + dx, r * TILE + dy, TILE, TILE);
    });
  };
  wallPath(4, 6);
  ctx.fillStyle = "rgba(10, 14, 30, 0.2)";
  ctx.fill();
  wallPath(0, 0);
  ctx.fillStyle = SLATE;
  ctx.fill();

  forEachTile(map, (kind, c, r) => {
    if (kind !== "wall") return;
    const x = c * TILE;
    const y = r * TILE;
    const open = { up: !isWall(map, c, r - 1), down: !isWall(map, c, r + 1), left: !isWall(map, c - 1, r), right: !isWall(map, c + 1, r) };
    // Faint sheen on the slate next to the rim facing up, so blocks read as raised.
    if (open.up) {
      ctx.fillStyle = SLATE_LIGHT;
      ctx.fillRect(x, y + RIM, TILE, 4);
    }
    ctx.fillStyle = pal.rim;
    if (open.up) ctx.fillRect(x, y, TILE, RIM);
    if (open.down) ctx.fillRect(x, y + TILE - RIM, TILE, RIM);
    if (open.left) ctx.fillRect(x, y, RIM, TILE);
    if (open.right) ctx.fillRect(x + TILE - RIM, y, RIM, TILE);
    // Inside corners: both neighbours are wall but the diagonal is open.
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as const) {
      if (isWall(map, c + sx, r) && isWall(map, c, r + sy) && !isWall(map, c + sx, r + sy)) {
        ctx.fillRect(sx < 0 ? x : x + TILE - RIM, sy < 0 ? y : y + TILE - RIM, RIM, RIM);
      }
    }
    // A darker line where the rim meets the slate, and the ink edge facing the floor.
    ctx.fillStyle = "rgba(0, 0, 0, 0.28)";
    if (open.up) ctx.fillRect(x + (open.left ? RIM : 0), y + RIM, TILE - (open.left ? RIM : 0) - (open.right ? RIM : 0), 1);
    if (open.down) ctx.fillRect(x + (open.left ? RIM : 0), y + TILE - RIM - 1, TILE - (open.left ? RIM : 0) - (open.right ? RIM : 0), 1);
    if (open.left) ctx.fillRect(x + RIM, y + (open.up ? RIM : 0), 1, TILE - (open.up ? RIM : 0) - (open.down ? RIM : 0));
    if (open.right) ctx.fillRect(x + TILE - RIM - 1, y + (open.up ? RIM : 0), 1, TILE - (open.up ? RIM : 0) - (open.down ? RIM : 0));
    ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
    if (open.up) ctx.fillRect(x, y + 1.5, TILE, 1.2);
    ctx.fillStyle = INK;
    if (open.up) ctx.fillRect(x, y, TILE, 1.5);
    if (open.down) ctx.fillRect(x, y + TILE - 1.5, TILE, 1.5);
    if (open.left) ctx.fillRect(x, y, 1.5, TILE);
    if (open.right) ctx.fillRect(x + TILE - 1.5, y, 1.5, TILE);
  });
}

// A team's respawn square: a tinted pad in the team colour with an ink edge, the four spawn
// spots, and an arrow pointing the way soldiers face when they appear.
function paintPad(ctx: CanvasRenderingContext2D, team: Team, pad: { x: number; y: number }): void {
  const color = TEAM[team];
  const h = SPAWN_PAD_SIZE / 2 - 3;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.roundRect(pad.x - h, pad.y - h, h * 2, h * 2, 9);
  ctx.stroke();
  ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
  ctx.fill();
  ctx.fillStyle = color.glow;
  ctx.fill();
  ctx.strokeStyle = color.body;
  ctx.lineWidth = 3.5;
  ctx.stroke();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.roundRect(pad.x - h + 5, pad.y - h + 5, h * 2 - 10, h * 2 - 10, 5);
  ctx.stroke();
  const d = SPAWN_PAD_SPREAD;
  for (const [dx, dy] of [
    [-d, -d],
    [d, -d],
    [-d, d],
    [d, d],
  ] as const) {
    ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
    ctx.beginPath();
    ctx.arc(pad.x + dx, pad.y + dy, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color.body;
    ctx.beginPath();
    ctx.arc(pad.x + dx, pad.y + dy, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  const dir = team === "red" ? 1 : -1;
  ctx.fillStyle = color.body;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(pad.x + dir * 7, pad.y);
  ctx.lineTo(pad.x - dir * 4, pad.y - 7);
  ctx.lineTo(pad.x - dir * 4, pad.y + 7);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

// A team's flag stand: a light stone disc whose team-coloured ring ends exactly at
// BASE_RADIUS (a carrier whose centre gets inside it scores), with the socket the flag
// stands in. Painted into the map layer; exported for anything that wants one on its own.
export function drawBase(ctx: CanvasRenderingContext2D, flag: Flag): void {
  const color = TEAM[flag.team];
  const x = flag.homeX;
  const y = flag.homeY;
  ctx.fillStyle = "rgba(10, 14, 30, 0.22)";
  ctx.beginPath();
  ctx.arc(x + 2, y + 3.5, BASE_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.arc(x, y, BASE_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = color.body;
  ctx.beginPath();
  ctx.arc(x, y, BASE_RADIUS - 1.5, 0, Math.PI * 2);
  ctx.fill();
  const stone = ctx.createRadialGradient(x - 4, y - 5, 1, x, y, BASE_RADIUS - 5);
  stone.addColorStop(0, "#ffffff");
  stone.addColorStop(1, "#cfd7e3");
  ctx.fillStyle = stone;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(x, y, BASE_RADIUS - 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  // Team dot in the middle, where the flag stands.
  ctx.fillStyle = color.glow;
  ctx.beginPath();
  ctx.arc(x, y, 8, 0, Math.PI * 2);
  ctx.fill();
}
