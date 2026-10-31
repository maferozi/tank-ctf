// End-to-end check against a running server: `npm run smoke -w server`.
// Two bots create and join a room, then tap, hold and leave.
import assert from "node:assert/strict";
import { Client } from "@colyseus/sdk";
import { MSG, ROOM_NAME, type RoomInfo, type Roster, type Snapshot } from "@tank/shared";

const url = process.env.SERVER_URL ?? "ws://localhost:2567";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ann = await new Client(url).create(ROOM_NAME, { name: "Ann", team: "red" });
assert.match(ann.roomId, /^[A-Z]{4}$/, "room id should be a 4-letter code");
const annRosters: Roster[] = [];
ann.onMessage(MSG.roster, (r: Roster) => annRosters.push(r));
ann.onMessage(MSG.snapshot, () => {});

const bob = await new Client(url).joinById(ann.roomId, { name: "Bob", team: "blue" });
const snaps: Snapshot[] = [];
bob.onMessage(MSG.snapshot, (s: Snapshot) => snaps.push(s));
const bobRosters: Roster[] = [];
bob.onMessage(MSG.roster, (r: Roster) => bobRosters.push(r));
bob.send(MSG.ready);
await sleep(1000);

const rate = snaps.length;
assert.ok(rate >= 25 && rate <= 35, `expected ~30 snapshots/s, got ${rate}`);
assert.deepEqual(annRosters.at(-1)?.players.map((p) => `${p.name}:${p.team}`).sort(), ["Ann:red", "Bob:blue"]);
assert.equal(bobRosters.at(-1)?.players.length, 2, "a joining player gets the roster after saying ready");

// The join form reads the teams over HTTP before joining.
const http = url.replace(/^ws/, "http");
const infoRes = await fetch(`${http}/rooms/${ann.roomId}`);
assert.equal(infoRes.status, 200);
assert.equal(infoRes.headers.get("access-control-allow-origin"), "*", "browsers on another port must be allowed to read it");
const info = (await infoRes.json()) as RoomInfo;
assert.deepEqual(info.players.map((p) => `${p.name}:${p.team}`).sort(), ["Ann:red", "Bob:blue"]);
const missing = await fetch(`${http}/rooms/ZZZZ`);
assert.equal(missing.status, 404);

const annTank = () => snaps.at(-1)!.state.tanks.find((t) => t.id === ann.sessionId)!;
assert.ok(annTank(), "Ann's soldier should be in Bob's snapshots");

// Tap: down and up in the same message still fires.
const before = snaps.length;
ann.send(MSG.input, { held: false, pressed: true });
await sleep(200);
const fired = snaps.slice(before).some((s) => s.events.some((e) => e.type === "fire" && e.tankId === ann.sessionId));
assert.ok(fired, "a tap should fire");

// Hold to walk, then release.
const start = { x: annTank().x, y: annTank().y };
ann.send(MSG.input, { held: true, pressed: false });
await sleep(600);
ann.send(MSG.input, { held: false, pressed: false });
await sleep(100);
const moved = Math.hypot(annTank().x - start.x, annTank().y - start.y);
assert.ok(moved > 30, `holding should walk, moved ${moved.toFixed(1)} px`);

await bob.leave();
await sleep(200);
assert.deepEqual(annRosters.at(-1)?.players.map((p) => p.name), ["Ann"]);
await ann.leave();

console.log(`smoke ok: room ${ann.roomId}, ${rate} snapshots/s, room info lists both teams, tap fired, walked ${moved.toFixed(0)} px, leave updated roster`);
process.exit(0);
