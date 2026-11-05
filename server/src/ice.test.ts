import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { relayKind, turnRestCredential, validIceUrl, voiceConfig } from "./ice";

const VARS = ["CLOUDFLARE_TURN_KEY_ID", "CLOUDFLARE_TURN_API_TOKEN", "TURN_URLS", "TURN_SECRET", "TURN_USERNAME", "TURN_CREDENTIAL"];

function withEnv(values: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const saved = VARS.map((k) => [k, process.env[k]] as const);
  for (const k of VARS) delete process.env[k];
  Object.assign(process.env, values);
  return fn().finally(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test("coturn REST credential: expiring username, HMAC-SHA1 of it as the password", () => {
  const now = 1_800_000_000_000;
  const { username, credential } = turnRestCredential("s3cret", "abc-DEF_1", now, 3600);
  assert.equal(username, `${1_800_000_000 + 3600}:abc-DEF_1`);
  assert.equal(credential, createHmac("sha1", "s3cret").update(username).digest("base64"));
  // Odd characters in the id are dropped (coturn splits the username on ':').
  assert.match(turnRestCredential("s", "a:b c", now).username, /^\d+:abc$/);
});

test("ICE URLs: only stun:/turn:/turns: ones are kept", () => {
  assert.ok(validIceUrl("turn:turn.example.com:3478?transport=udp"));
  assert.ok(validIceUrl("turns:turn.example.com:5349?transport=tcp"));
  assert.ok(validIceUrl("stun:stun.l.google.com:19302"));
  assert.ok(!validIceUrl("turn.example.com:3478"));
  assert.ok(!validIceUrl("https://turn.example.com"));
  assert.ok(!validIceUrl(""));
});

test("no relay configured: STUN only", () =>
  withEnv({}, async () => {
    const config = await voiceConfig("p1");
    assert.equal(config.relay, null);
    assert.ok(config.iceServers.every((s) => !s.username && !s.credential));
  }));

test("a fixed TURN username/password is never handed out", () =>
  withEnv({ TURN_URLS: "turn:t.example.com:3478", TURN_USERNAME: "user", TURN_CREDENTIAL: "pass" }, async () => {
    assert.equal(relayKind(), null);
    const json = JSON.stringify(await voiceConfig("p1"));
    assert.ok(!json.includes("pass") && !json.includes('"user"'), "static credentials stay on the server");
  }));

test("self-hosted TURN: per-client, expiring credentials; the secret stays on the server", () =>
  withEnv({ TURN_URLS: "turn:t.example.com:3478, t.example.com:3479 ,turns:t.example.com:5349", TURN_SECRET: "topsecret" }, async () => {
    assert.equal(relayKind(), "turn");
    const a = await voiceConfig("alice");
    const b = await voiceConfig("bob");
    assert.equal(a.relay, "turn");
    const turnA = a.iceServers.find((s) => s.username)!;
    const turnB = b.iceServers.find((s) => s.username)!;
    assert.deepEqual(turnA.urls, ["turn:t.example.com:3478", "turns:t.example.com:5349"], "the URL without a scheme is dropped");
    assert.match(turnA.username!, /^\d+:alice$/);
    assert.notEqual(turnA.credential, turnB.credential, "each client gets its own credential");
    const expiry = Number(turnA.username!.split(":")[0]);
    const inHours = (expiry * 1000 - Date.now()) / 3600_000;
    assert.ok(inHours > 23 && inHours <= 24, "it expires in a day");
    assert.ok(a.refreshMs < (expiry * 1000 - Date.now()), "clients ask again before it expires");
    assert.ok(!JSON.stringify(a).includes("topsecret"));
  }));
