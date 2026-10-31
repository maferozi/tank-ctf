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

// The next three recreate layouts from the original app's capture-the-flag mini game in
// our own art. They are generated with exact symmetry (Red's half rotated or mirrored for
// Blue). Here each team scores on its square pad ('1' / '2'), not at its flag.

// Wooden floor with a 5 x 5 grid of desks (centre one missing). Flags on the left and
// right edges, scoring pads in opposite corners behind a short wall.
const CLASSROOM = [
  "############################",
  "#............P.........#...#",
  "#......TT.TT.TT.TT.TT..#.2.#",
  "#......TT.TT.TT.TT.TT..#...#",
  "#.RR...................#...#",
  "#......TT.TT.TT.TT.TT......#",
  "#....X.TT.TT.TT.TT.TT...BB.#",
  "#..........................#",
  "#.r....TT.TT.P..TT.TT......#",
  "#......TT.TT..P.TT.TT....b.#",
  "#..........................#",
  "#.RR...TT.TT.TT.TT.TT.X....#",
  "#......TT.TT.TT.TT.TT......#",
  "#...#...................BB.#",
  "#...#..TT.TT.TT.TT.TT......#",
  "#.1.#..TT.TT.TT.TT.TT......#",
  "#...#.........P............#",
  "############################",
];

// Grass outside, a house with one wooden room per team and doors in the outer walls, a
// pool along the top that blocks walking but not bullets. Pads in the top corners.
const GARDEN = [
  "############################",
  "#.1.....~~~~~~~~~~~~.....2.#",
  "#.......~~~~~~~~~~~~.......#",
  "#.......~~~~~~~~~~~~.......#",
  "#.....################.....#",
  "#......,,,,,,##,,,,,,......#",
  "#......,R,R,,##,,B,B,......#",
  "#.....#,,,,,,##,,,,,,#.....#",
  "#.....#,R,Xr,##,bX,B,#.....#",
  "#..P..#,,,,,,##,,,,,,#..P..#",
  "#.....#####,,##,,#####.....#",
  "#.....#,,,,,,##,,,,,,#.....#",
  "#......,,R,,,##,,,B,,......#",
  "#......,,,,,,##,,,,,,......#",
  "#.....#,,,,,,,,,,,,,,#.....#",
  "#.....################.....#",
  "#.X......................X.#",
  "############################",
];

// Light tiles with plus-shaped walls, notches along the edges and a block in the centre.
// Each team's flag and scoring pad sit in opposite corners.
const CROSSROADS = [
  "############################",
  "#.r..#....#..............2.#",
  "#...R.................X....#",
  "#.R..R.......P.............#",
  "#..R..#...#..........#.....#",
  "##...###..##........###....#",
  "#.....#...#.......X..#.....#",
  "#............##............#",
  "#.........########.........#",
  "#.........########.........#",
  "#............##............#",
  "#.....#..X.......#...#.....#",
  "#....###........##..###...##",
  "#.....#..........#...#..B..#",
  "#.............P.......B..B.#",
  "#....X.................B...#",
  "#.1..............#....#..b.#",
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
