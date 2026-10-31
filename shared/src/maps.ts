import { DEFAULT_MAP, parseMap, type GameMap } from "./map";

// All playable maps. Every map is 28 x 18 tiles, so the screen layout never changes
// between rounds. Legend as in map.ts: '#' wall, '.' floor, 'R'/'B' spawns, 'X' crate,
// 'P' power box, 'r'/'b' flag stands.

// The new maps are drawn as Red's (left) half only and mirrored for Blue, so both sides
// are exactly fair.
function mirrored(leftHalf: readonly string[]): string[] {
  const swap: Record<string, string> = { R: "B", B: "R", r: "b", b: "r" };
  return leftHalf.map((row) => row + [...row].reverse().map((ch) => swap[ch] ?? ch).join(""));
}

// Open middle with cover blocks; each base sits in a U of walls that opens towards its
// own spawns.
const CROSSFIRE = mirrored([
  "##############",
  "#.............",
  "#.RR..........",
  "#.RR...##.....",
  "#......##...X.",
  "#.............",
  "#...####......",
  "#......#....P.",
  "#.r....#......",
  "#......#......",
  "#...####......",
  "#.............",
  "#......##...X.",
  "#.RR...##.....",
  "#.RR..........",
  "#.............",
  "#.............",
  "##############",
]);

// Walled-in bases with narrow doors; crates near the doors can be pushed in as barricades.
const FORTRESS = mirrored([
  "##############",
  "#.............",
  "#.RR....#.....",
  "#.RR....#..P..",
  "#.......#.....",
  "#####.###.....",
  "#.........X...",
  "#..#..........",
  "#.r#....##....",
  "#..#....##....",
  "#..X..........",
  "#####.###.....",
  "#.......#.....",
  "#.RR....#..P..",
  "#.RR....#.....",
  "#.............",
  "#.............",
  "##############",
]);

// Three long lanes split by walls, joined in the middle and at the ends.
const CANYON = mirrored([
  "##############",
  "#.RR..........",
  "#.RR..........",
  "#....########.",
  "#.........X...",
  "#.............",
  "###.....#####.",
  "#.............",
  "#.r.......P...",
  "#.............",
  "#.............",
  "###.....#####.",
  "#.............",
  "#.........X...",
  "#....########.",
  "#.RR..........",
  "#.RR..........",
  "##############",
]);

export const MAPS: readonly GameMap[] = [
  DEFAULT_MAP,
  parseMap(CROSSFIRE, "crossfire", "Crossfire"),
  parseMap(FORTRESS, "fortress", "Fortress"),
  parseMap(CANYON, "canyon", "Canyon"),
];

const BY_ID = new Map(MAPS.map((m) => [m.id, m]));

export function isMapId(id: unknown): id is string {
  return typeof id === "string" && BY_ID.has(id);
}

// Unknown ids fall back to the default map rather than crashing a room.
export function getMap(id: string): GameMap {
  return BY_ID.get(id) ?? DEFAULT_MAP;
}
