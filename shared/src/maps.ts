import { DEFAULT_MAP, parseMap, type GameMap } from "./map";

// All playable maps. Every map is 28 x 18 tiles, so the screen layout never changes
// between rounds. Legend as in map.ts: '#' wall, '.' floor, '1'/'2' respawn squares (2 x 2),
// 'X' crate, 'P' power box, 'r'/'b' flag stands.

// The new maps are drawn as Red's (left) half only and mirrored for Blue, so both sides
// are exactly fair.
function mirrored(leftHalf: readonly string[]): string[] {
  const swap: Record<string, string> = { "1": "2", "2": "1", r: "b", b: "r" };
  return leftHalf.map((row) => row + [...row].reverse().map((ch) => swap[ch] ?? ch).join(""));
}

// Open middle with cover blocks; each flag sits in a U of walls that opens towards its
// own team's side.
const CROSSFIRE = mirrored([
  "##############",
  "#.............",
  "#.11..........",
  "#.11...##.....",
  "#......##...X.",
  "#.............",
  "#...####......",
  "#......#....P.",
  "#.r....#......",
  "#......#......",
  "#...####......",
  "#.............",
  "#......##...X.",
  "#......##.....",
  "#.............",
  "#.............",
  "#.............",
  "##############",
]);

// Walled-in bases with narrow doors; crates near the doors can be pushed in as barricades.
const FORTRESS = mirrored([
  "##############",
  "#.............",
  "#.11....#.....",
  "#.11....#..P..",
  "#.......#.....",
  "#####.###.....",
  "#.........X...",
  "#..#..........",
  "#.r#....##....",
  "#..#....##....",
  "#..X..........",
  "#####.###.....",
  "#.......#.....",
  "#.......#..P..",
  "#.......#.....",
  "#.............",
  "#.............",
  "##############",
]);

// Three long lanes split by walls, joined in the middle and at the ends.
const CANYON = mirrored([
  "##############",
  "#.11..........",
  "#.11..........",
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
  "#.............",
  "#.............",
  "##############",
]);

// The next three recreate layouts from the original app's capture-the-flag mini game in
// our own art. They are generated with exact symmetry (Red's half rotated or mirrored for
// Blue). Their respawn squares sit in the corners, far from the flags.

// Wooden floor packed with beds (2 x 2 tiles each, heavier than crates), with narrow aisles
// between the rows: push beds aside to cut through. Flags on the left and right edges,
// respawn squares in opposite corners behind a short wall.
const CLASSROOM = [
  "############################",
  "#............P.........#...#",
  "#......TTTTTTTTTTTTTT..#22.#",
  "#......TTTTTTTTTTTTTT..#22.#",
  "#......................#...#",
  "#.....TTTTTT..TTTTTT.......#",
  "#....XTTTTTT..TTTTTT.......#",
  "#..........................#",
  "#.r....TTTT..P...TTTT......#",
  "#......TTTT...P..TTTT....b.#",
  "#..........................#",
  "#.......TTTTTT..TTTTTTX....#",
  "#.......TTTTTT..TTTTTT.....#",
  "#...#......................#",
  "#.11#..TTTTTTTTTTTTTT......#",
  "#.11#..TTTTTTTTTTTTTT......#",
  "#...#.........P............#",
  "############################",
];

// Grass outside, a house with one wooden room per team and doors in the outer walls, a
// pool along the top that blocks walking but not bullets. Respawn squares in the top corners.
const GARDEN = [
  "############################",
  "#.11....~~~~~~~~~~~~....22.#",
  "#.11....~~~~~~~~~~~~....22.#",
  "#.......~~~~~~~~~~~~.......#",
  "#.....################.....#",
  "#......,,,,,,##,,,,,,......#",
  "#......,,,,,,##,,,,,,......#",
  "#.....#,,,,,,##,,,,,,#.....#",
  "#.....#,,,Xr,##,bX,,,#.....#",
  "#..P..#,,,,,,##,,,,,,#..P..#",
  "#.....#####,,##,,#####.....#",
  "#.....#,,,,,,##,,,,,,#.....#",
  "#......,,,,,,##,,,,,,......#",
  "#......,,,,,,##,,,,,,......#",
  "#.....#,,,,,,,,,,,,,,#.....#",
  "#.....################.....#",
  "#.X......................X.#",
  "############################",
];

// Light tiles with plus-shaped walls, notches along the edges and a block in the centre.
// Each team's flag and respawn square sit in opposite corners.
const CROSSROADS = [
  "############################",
  "#.r..#....#.............22.#",
  "#.....................X.22.#",
  "#............P.............#",
  "#.....#...#..........#.....#",
  "##...###..##........###....#",
  "#.....#...#.......X..#.....#",
  "#............##............#",
  "#.........########.........#",
  "#.........########.........#",
  "#............##............#",
  "#.....#..X.......#...#.....#",
  "#....###........##..###...##",
  "#.....#..........#...#.....#",
  "#.............P............#",
  "#.11.X.....................#",
  "#.11.............#....#..b.#",
  "############################",
];

export const MAPS: readonly GameMap[] = [
  DEFAULT_MAP,
  parseMap(CROSSFIRE, "crossfire", "Crossfire"),
  parseMap(FORTRESS, "fortress", "Fortress"),
  parseMap(CANYON, "canyon", "Canyon"),
  parseMap(CLASSROOM, "classroom", "Classroom", "wood"),
  parseMap(GARDEN, "garden", "Garden", "grass"),
  parseMap(CROSSROADS, "crossroads", "Crossroads", "tiles"),
];

const BY_ID = new Map(MAPS.map((m) => [m.id, m]));

export function isMapId(id: unknown): id is string {
  return typeof id === "string" && BY_ID.has(id);
}

// Unknown ids fall back to the default map rather than crashing a room.
export function getMap(id: string): GameMap {
  return BY_ID.get(id) ?? DEFAULT_MAP;
}
