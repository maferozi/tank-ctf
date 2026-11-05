import assert from "node:assert/strict";
import { test } from "node:test";
import type { Player, Roster } from "./net";
import {
  MAX_VOICE_MESSAGE_BYTES,
  RateLimiter,
  VOICE_BURST,
  VOICE_CONFIG_BURST,
  VOICE_CONFIG_PER_SECOND,
  VOICE_MAX_BITRATE,
  VOICE_PER_SECOND,
  canVoice,
  isPolite,
  parseVoiceMessage,
  tuneOpusSdp,
  voiceGroup,
  voicePeers,
} from "./voice";

const player = (id: string, team: "red" | "blue", away = false): Player => ({ id, name: id, team, away });
const roster = (phase: Roster["phase"], players: Player[]) => ({ phase, players });
const people = [player("a", "red"), player("b", "blue"), player("c", "blue"), player("d", "red")];

test("lobby: everyone in the room is in one voice group", () => {
  const r = roster("lobby", people);
  assert.equal(voiceGroup(r, "a"), voiceGroup(r, "b"));
  assert.deepEqual(voicePeers(r, "a"), ["b", "c", "d"]);
  assert.ok(canVoice(r, "a", "b"));
});

test("match: only your own team", () => {
  const r = roster("playing", people);
  assert.equal(voiceGroup(r, "a"), "red");
  assert.equal(voiceGroup(r, "b"), "blue");
  assert.deepEqual(voicePeers(r, "a"), ["d"]);
  assert.deepEqual(voicePeers(r, "c"), ["b"]);
  assert.ok(!canVoice(r, "a", "b"), "red can't reach blue");
  assert.ok(canVoice(r, "b", "c"));
});

test("strangers, yourself and away players", () => {
  const r = roster("lobby", [...people, player("e", "red", true)]);
  assert.equal(voiceGroup(r, "zz"), null);
  assert.ok(!canVoice(r, "a", "zz"), "not in the room");
  assert.ok(!canVoice(r, "zz", "a"));
  assert.ok(!canVoice(r, "a", "a"), "not yourself");
  assert.deepEqual(voicePeers(r, "a"), ["b", "c", "d"], "away players wait until they are back");
  assert.ok(canVoice(r, "a", "e"), "the relay rule itself ignores away (the server checks the connection)");
  assert.deepEqual(voicePeers(r, "zz"), []);
});

test("group change: lobby -> match drops the other team, back to lobby adds them", () => {
  const lobby = voicePeers(roster("lobby", people), "b");
  const match = voicePeers(roster("playing", people), "b");
  assert.deepEqual(lobby, ["a", "c", "d"]);
  assert.deepEqual(match, ["c"]);
  assert.deepEqual(lobby.filter((id) => !match.includes(id)), ["a", "d"], "disconnected when the match starts");
});

test("exactly one polite side per pair", () => {
  for (const [x, y] of [["a", "b"], ["AbC", "aBc"], ["q1", "q2"]] as const) {
    assert.notEqual(isPolite(x, y), isPolite(y, x));
  }
});

test("parseVoiceMessage keeps good messages and drops bad ones", () => {
  const ok = parseVoiceMessage({ to: "b", from: "forged", kind: "offer", data: { epoch: 1, sdp: "v=0" } });
  assert.deepEqual(ok, { to: "b", kind: "offer", data: { epoch: 1, sdp: "v=0" } }, "from is not taken from the client");
  assert.equal(parseVoiceMessage(null), null);
  assert.equal(parseVoiceMessage({ to: "b", kind: "shout", data: { epoch: 1 } }), null, "unknown kind");
  assert.equal(parseVoiceMessage({ to: 5, kind: "bye", data: { epoch: 1 } }), null, "bad target");
  assert.equal(parseVoiceMessage({ to: "", kind: "bye", data: { epoch: 1 } }), null);
  assert.equal(parseVoiceMessage({ to: "b", kind: "bye", data: [] }), null, "data must be an object");
  assert.equal(parseVoiceMessage({ to: "b", kind: "bye", data: {} }), null, "needs an epoch");
  assert.equal(parseVoiceMessage({ to: "b", kind: "offer", data: { epoch: 1, sdp: 7 } }), null);
  const big = "x".repeat(MAX_VOICE_MESSAGE_BYTES);
  assert.equal(parseVoiceMessage({ to: "b", kind: "offer", data: { epoch: 1, sdp: big } }), null, "oversized");
});

test("rate limiter: a burst, then a steady rate", () => {
  const limit = new RateLimiter(5, 10);
  let passed = 0;
  for (let i = 0; i < 20; i++) if (limit.take(1000)) passed++;
  assert.equal(passed, 5, "burst");
  assert.ok(!limit.take(1050), "half a token after 50 ms");
  assert.ok(limit.take(1100), "one token after 100 ms");
  let later = 0;
  for (let i = 0; i < 20; i++) if (limit.take(10_000)) later++;
  assert.equal(later, 5, "refills up to the burst, not beyond");
});

test("voice limits: room to connect to 7 players at once, config requests kept rare", () => {
  // Joining a full lobby: per peer an offer or answer plus up to ~30 trickled candidates
  // (host, srflx and relay over udp/tcp/tls) must fit in one burst, or answers get dropped.
  assert.ok(VOICE_BURST >= 7 * (1 + 30) + 50, `burst ${VOICE_BURST}`);
  assert.ok(VOICE_PER_SECOND >= 30);
  // Config: a few at once (join, reconnects), then about one every 10 s at most.
  const limit = new RateLimiter(VOICE_CONFIG_BURST, VOICE_CONFIG_PER_SECOND);
  let passed = 0;
  for (let i = 0; i < 30; i++) if (limit.take(0)) passed++;
  assert.equal(passed, VOICE_CONFIG_BURST);
  let minute = 0;
  for (let t = 1000; t <= 60_000; t += 1000) if (limit.take(t)) minute++;
  assert.ok(minute <= 6, `at most ~6 a minute after the burst, got ${minute}`);
});

test("tuneOpusSdp sets speech settings on the Opus fmtp line only", () => {
  const sdp = [
    "v=0",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111 0",
    "a=rtpmap:111 opus/48000/2",
    "a=fmtp:111 minptime=10;useinbandfec=0;stereo=1",
    "a=rtpmap:0 PCMU/8000",
    "",
  ].join("\r\n");
  const out = tuneOpusSdp(sdp);
  assert.match(out, new RegExp(`a=fmtp:111 minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0;usedtx=1;maxaveragebitrate=${VOICE_MAX_BITRATE}\\r\\n`));
  assert.match(out, /a=rtpmap:0 PCMU\/8000/);
  const bare = tuneOpusSdp("m=audio 9 RTP 109\na=rtpmap:109 opus/48000/2\n");
  assert.match(bare, /a=rtpmap:109 opus\/48000\/2\na=fmtp:109 stereo=0;.*usedtx=1/, "adds an fmtp line when there is none");
  assert.equal(tuneOpusSdp("m=audio 9 RTP 0\na=rtpmap:0 PCMU/8000\n"), "m=audio 9 RTP 0\na=rtpmap:0 PCMU/8000\n", "no Opus: unchanged");
});
