import { DEFAULT_MAP, parseMap, type GameMap } from "./map";

// All playable maps. Every map is 26 x 18 tiles (1040 x 720 px, the original's ~1.41:1
// shape), so the screen layout never changes between rounds. Legend as in map.ts: '#' wall,
// '.' floor, ',' wood floor, '~' water, '1'/'2' respawn squares (2 x 2), 'X' crate, 'T' bed
// (2 x 2), 'D' desk, '*' bush, 'P' power box, 'r'/'b' flag stands.
//
// Layout rules every map follows (checked in maps.test.ts):
// - Exactly fair: Blue's side is Red's, mirrored left-right or turned half a turn.
// - Each flag stand has cover close by, and more than one way in, so a carrier who reaches
//   home can still be shot by someone who followed them.
// - Power boxes sit in contested ground with cover nearby, never next to a flag stand.
// - Respawn squares are away from both flags; everything is reachable from both.

const SWAP: Record<string, string> = { "1": "2", "2": "1", r: "b", b: "r" };
const swapTeams = (row: string) => [...row].map((ch) => SWAP[ch] ?? ch).join("");

// Drawn as Red's (left) half only; Blue's half is the mirror image.
function mirrored(leftHalf: readonly string[]): string[] {
  return leftHalf.map((row) => row + swapTeams([...row].reverse().join("")));
}

// Drawn as the top half only (rows 0-8); the bottom half is the top turned half a turn, so
// Red's top-left corner becomes Blue's bottom-right.
function rotated(topHalf: readonly string[]): string[] {
  const bottom = [...topHalf].reverse().map((row) => swapTeams([...row].reverse().join("")));
  return [...topHalf, ...bottom];
}

// Open middle with cover blocks and a pillar in the centre. Each flag sits in a U of walls
// that opens towards its own back wall: no straight shot at it from the middle, but chasers
// can follow a carrier in round the top or bottom of the U.
const CROSSFIRE = mirrored([
  "#############",
  "#............",
  "#.11.........",
  "#.11...##....",
  "#......##..X.",
  "#............",
  "#...####.....",
  "#......#...P.",
  "#.r....#....#",
  "#......#....#",
  "#...####.....",
  "#............",
  "#......##..X.",
  "#......##....",
  "#............",
  "#..##........",
  "#............",
  "#############",
]);

// Walled bands around each flag with two-tile doors top and bottom and an open front, so
// the flag can be defended from several sides and attacked from several too. The respawn
// room and the bottom room each have a door into the band and a way out to the middle.
// Crates by the doors can be pushed in as barricades.
const FORTRESS = mirrored([
  "#############",
  "#............",
  "#.11....#.P..",
  "#.11....#....",
  "#.......#....",
  "####..###....",
  "#..........X.",
  "#..#.........",
  "#.r#....##...",
  "#..#....##...",
  "#............",
  "#..X.........",
  "####..###....",
  "#.......#....",
  "#.......#.P..",
  "#.......#....",
  "#............",
  "#############",
]);

// Three long lanes split by walls, joined at the ends and through gaps in the middle. The
// flags sit at the ends of the wide middle lane, behind short stubs and a crate.
const CANYON = mirrored([
  "#############",
  "#.11.........",
  "#.11.........",
  "#....#######.",
  "#.........X..",
  "#............",
  "###....####..",
  "#............",
  "#.r......P...",
  "#....X.......",
  "#............",
  "###....####..",
  "#............",
  "#.........X..",
  "#....#######.",
  "#............",
  "#............",
  "#############",
]);

// The next five recreate the stages of the original app's capture-the-flag mini game
// (docs/ORIGINAL.md) in our own art, as closely as the grid allows.

// Wooden floor with 22 beds (2 x 2 tiles each, heavier than crates) in five columns with
// narrow aisles; push beds aside to cut through. The middle column is open in the centre,
// where the power boxes are. Flags on the left and right edges by the teacher's desks,
// respawn squares in opposite corners behind a short wall.
const CLASSROOM = rotated([
  "##########################",
  "#.....................#22#",
  "#.....TT.TT.TT.TT.TT..#22#",
  "#.....TT.TT.TT.TT.TT.....#",
  "#........................#",
  "#.....TT.TT....TT.TT.....#",
  "#DD...TT.TT.P..TT.TT.....#",
  "#........................#",
  "#..r..TT.TT....TT.TT.....#",
]);

// Grass outside and a wooden house in the middle, split down the centre: one upper room per
// team holds its flag, with a side door, a gap down to a lower room, and the pool behind it
// (bullets fly over water). The lower rooms lead out through doors to the strip along the
// bottom, the only way between the two sides. Respawn squares in the top corners, crates and
// bushes in the bottom corners.
const GARDEN = mirrored([
  "#############",
  "#.11...#~~~~~",
  "#.11...#~~###",
  "#......#~~#**",
  "#.....##,,###",
  "#.....#,,,,,#",
  "#.....#,,X,,#",
  "#.....,,,,,,#",
  "#.....,,,,,r#",
  "#.....####,,#",
  "#..P..#,,,,,#",
  "#.....#,,,,,#",
  "#.....#,,,###",
  "#.....#,,,,,#",
  "#.....####,,#",
  "#X**.....P...",
  "#.**.........",
  "#############",
]);

// Light tiles with rows of plus-shaped walls, notches along the edges and a long bar with a
// block across the centre. Each team's flag and respawn square sit in opposite corners on the
// same side, so defenders run the length of their edge and attackers cross the middle.
const CROSSROADS = rotated([
  "##########################",
  "#....#....#....#....#..22#",
  "#.r..................X.22#",
  "#....#....#....#....#....#",
  "##..####.##....##.####..##",
  "#....#....#....#....#....#",
  "#...........P........X...#",
  "#....#.....####.....#....#",
  "#....################....#",
]);

// Orange office floor between two white washroom strips (top and bottom, entered at both
// ends). Two L-shaped walls split the floor into a pocket per team; each team's flag sits in
// front of a cluster of desks (pushable, bullet-proof cover) with a crate in its middle.
// Respawn squares in washroom corners, opposite each other.
const OFFICE = rotated([
  "##########################",
  "#11#.....................#",
  "#11#.....................#",
  "#......################..#",
  "#...........P............#",
  "#....D.D.D...............#",
  "#..r.......#.............#",
  "#....D.X.D.#..#######...##",
  "#..........#..#.D.D.D....#",
]);

// Grass with four wall blocks across the middle, two small wooden bases on the left and right
// edges with posts at their front corners, and bushes. Respawn squares in wooden alcoves in
// opposite corners.
const FIELD = rotated([
  "##########################",
  "#.....................#22#",
  "#.....................#22#",
  "#.**........###..........#",
  "#.**........###..........#",
  "#........................#",
  "#,,,#....................#",
  "#,,,,......#.........#,,,#",
  "#,r,,..........P.....,,,,#",
]);

export const MAPS: readonly GameMap[] = [
  DEFAULT_MAP,
  parseMap(CROSSFIRE, "crossfire", "Crossfire"),
  parseMap(FORTRESS, "fortress", "Fortress"),
  parseMap(CANYON, "canyon", "Canyon"),
  parseMap(CLASSROOM, "classroom", "Classroom", "wood"),
  parseMap(GARDEN, "garden", "Garden", "grass"),
  parseMap(CROSSROADS, "crossroads", "Crossroads", "tiles"),
  parseMap(OFFICE, "office", "Office", "office"),
  parseMap(FIELD, "field", "Open Field", "grass"),
];

const BY_ID = new Map(MAPS.map((m) => [m.id, m]));

export function isMapId(id: unknown): id is string {
  return typeof id === "string" && BY_ID.has(id);
}

// Unknown ids fall back to the default map rather than crashing a room.
export function getMap(id: string): GameMap {
  return BY_ID.get(id) ?? DEFAULT_MAP;
}
