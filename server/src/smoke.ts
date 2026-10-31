// End-to-end check against a running server: `npm run smoke -w server`.
// Two bots go through the lobby, play, drop and rejoin, and leave.
import assert from "node:assert/strict";
import { Client } from "@colyseus/sdk";
import { MSG, ROOM_NAME, type RoomInfo, type Roster, type Snapshot } from "@tank/shared";
import { BotButton } from "./botButton";

const url = process.env.SERVER_URL ?? "ws://localhost:2567";
const http = url.replace(/^ws/, "http");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Like sleep, but keeps a bot's button samples flowing, as a real client does.
async function play(button: BotButton, ms: number) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    button.flush();
    await sleep(15);
  }
}
const teams = (r: Roster | undefined) => r?.players.map((p) => `${p.name}:${p.team}`).sort();

// Round 1 on the open Arena, so the walking check below doesn't start against a wall.
const picks = ["arena", "fortress", "crossfire", "canyon", "canyon"];
const ann = await new Client(url).create(ROOM_NAME, { name: "Ann", team: "red", rounds: 5, maps: picks });
assert.match(ann.roomId, /^[A-Z]{4}$/, "room id should be a 4-letter code");
const annRosters: Roster[] = [];
ann.onMessage(MSG.roster, (r: Roster) => annRosters.push(r));
ann.onMessage(MSG.snapshot, () => {});
ann.send(MSG.ready);

const bob = await new Client(url).joinById(ann.roomId, { name: "Bob", team: "blue" });
const snaps: Snapshot[] = [];
bob.onMessage(MSG.snapshot, (s: Snapshot) => snaps.push(s));
const bobRosters: Roster[] = [];
bob.onMessage(MSG.roster, (r: Roster) => bobRosters.push(r));
bob.send(MSG.ready);
await sleep(300);

// Lobby: nothing is being played yet.
const lobby = annRosters.at(-1)!;
assert.equal(lobby.phase, "lobby");
assert.equal(lobby.hostId, ann.sessionId, "the creator is the host");
assert.deepEqual(teams(lobby), ["Ann:red", "Bob:blue"]);
assert.equal(bobRosters.at(-1)?.players.length, 2, "a joining player gets the roster after saying ready");
assert.equal(snaps.length, 0, "no game is sent while in the lobby");

// The join page reads the room over HTTP before joining.
const infoRes = await fetch(`${http}/rooms/${ann.roomId}`);
assert.equal(infoRes.status, 200);
assert.equal(infoRes.headers.get("access-control-allow-origin"), "*", "browsers on another port must be allowed to read it");
const info = (await infoRes.json()) as RoomInfo;
assert.deepEqual(info.players.map((p) => `${p.name}:${p.team}`).sort(), ["Ann:red", "Bob:blue"]);
assert.equal(info.rounds, 5, "room info shows the match type the creator picked");
assert.deepEqual(info.maps, picks, "room info lists the map for each round");
assert.equal(info.phase, "lobby");
assert.equal((await fetch(`${http}/rooms/ZZZZ`)).status, 404);

// Players switch their own team; only the host moves others and starts.
bob.send(MSG.team, { team: "red" });
await sleep(150);
assert.deepEqual(teams(annRosters.at(-1)), ["Ann:red", "Bob:red"], "Bob switched himself");
bob.send(MSG.start);
await sleep(150);
assert.equal(annRosters.at(-1)?.phase, "lobby", "only the host can start");
ann.send(MSG.start);
await sleep(150);
assert.equal(annRosters.at(-1)?.phase, "lobby", "can't start with an empty team");
ann.send(MSG.move, { playerId: bob.sessionId, team: "blue" });
await sleep(150);
assert.deepEqual(teams(annRosters.at(-1)), ["Ann:red", "Bob:blue"], "the host moved Bob");
ann.send(MSG.start);
await sleep(1000);
assert.equal(annRosters.at(-1)?.phase, "playing");

const rate = snaps.length;
assert.ok(rate >= 25 && rate <= 35, `expected ~30 snapshots/s, got ${rate}`);
assert.equal(snaps.at(-1)!.state.match.rounds, 5, "the game runs a 5-round tournament");
assert.equal(snaps.at(-1)!.state.mapId, "arena", "round 1 is played on the first pick");
const annTank = () => snaps.at(-1)!.state.tanks.find((t) => t.id === ann.sessionId)!;
assert.ok(annTank(), "Ann's soldier should be in Bob's snapshots");

// Teams are locked during the match.
bob.send(MSG.team, { team: "red" });
await sleep(150);
assert.equal(annRosters.at(-1)?.players.find((p) => p.name === "Bob")?.team, "blue", "no team switching mid-match");

const annButton = new BotButton(ann);
await play(annButton, 200);

// Tap: a single sample with pressed and not held still fires.
const before = snaps.length;
annButton.tap();
await play(annButton, 200);
const fired = snaps.slice(before).some((s) => s.events.some((e) => e.type === "fire" && e.tankId === ann.sessionId));
assert.ok(fired, "a tap should fire");

// Hold to walk, then release.
const start = { x: annTank().x, y: annTank().y };
annButton.hold(true);
await play(annButton, 600);
annButton.hold(false);
await play(annButton, 100);
const moved = Math.hypot(annTank().x - start.x, annTank().y - start.y);
assert.ok(moved > 30, `holding should walk, moved ${moved.toFixed(1)} px`);
const lastAck = snaps.at(-1)!.acks[ann.sessionId] ?? 0;
assert.ok(lastAck > 40, `server should ack Ann's samples, last ack ${lastAck}`);

// Bob's page "refreshes": the connection drops without leaving. His seat and soldier wait.
const bobId = bob.sessionId;
const token = bob.reconnectionToken;
bob.reconnection.enabled = false;
await bob.leave(false);
await sleep(300);
assert.equal(annRosters.at(-1)?.players.find((p) => p.id === bobId)?.away, true, "Bob shows as away");
const annSnaps: Snapshot[] = [];
ann.onMessage(MSG.snapshot, (s: Snapshot) => annSnaps.push(s));
await sleep(100);
assert.ok(annSnaps.at(-1)?.state.tanks.some((t) => t.id === bobId), "Bob's soldier stays in the game");

const bobAgain = await new Client(url).reconnect(token);
bobAgain.onMessage(MSG.roster, () => {});
bobAgain.onMessage(MSG.snapshot, () => {});
await sleep(300);
assert.equal(bobAgain.sessionId, bobId, "rejoined as the same player");
const back = annRosters.at(-1)?.players.find((p) => p.id === bobId);
assert.deepEqual([back?.away, back?.team], [false, "blue"], "back on his team");

// The host leaves: the next player becomes host. Then everyone leaves.
const roomId = ann.roomId;
await ann.leave();
await sleep(200);
const afterAnn = (await (await fetch(`${http}/rooms/${roomId}`)).json()) as RoomInfo;
assert.deepEqual(afterAnn.players.map((p) => p.name), ["Bob"]);
await bobAgain.leave();

console.log(
  `smoke ok: room ${roomId}, lobby (host, team switch, host move, start rules), ${rate} snapshots/s, ` +
    `teams locked in play, tap fired, walked ${moved.toFixed(0)} px, dropped player rejoined as the same soldier`,
);
process.exit(0);
