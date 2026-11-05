import { createHmac } from "node:crypto";
import type { IceServer, VoiceConfig } from "@tank/shared";

// ICE servers for voice chat, handed to every client (MSG.voiceConfig). Built from env:
// - STUN, always (finds each player's public address; enough for most home networks).
// - Cloudflare TURN when CLOUDFLARE_TURN_KEY_ID and CLOUDFLARE_TURN_API_TOKEN are set:
//   short-lived credentials, fetched once and shared by everyone until they near expiry.
// - Otherwise a self-hosted TURN (coturn) when TURN_URLS and TURN_SECRET are set. coturn
//   runs with use-auth-secret and static-auth-secret=TURN_SECRET ("TURN REST API"); each
//   client gets its own credential that expires after a day, made from the secret here.
//   The secret itself never leaves the server. (A fixed username/password would be handed
//   to anyone who joins a room and work forever, an open relay, so that isn't supported.)
// TURN relays the audio for players whose networks block direct connections. Secrets are
// never logged; the Cloudflare token is only sent to Cloudflare.

const STUN: IceServer[] = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] }];

const CLOUDFLARE_TTL_S = 86_400; // credentials live a day
const REFRESH_AFTER_MS = 12 * 3600_000; // fetch new ones when half of that is gone
const CLIENT_REFRESH_MS = 6 * 3600_000; // clients ask again this often
const RETRY_AFTER_FAILURE_MS = 60_000;
const SELF_HOSTED_TTL_S = 86_400; // per-client coturn credentials live a day
const FETCH_TIMEOUT_MS = 5000;

interface Cached {
  servers: IceServer[];
  fetchedAt: number;
}
let cached: Cached | null = null;
let inFlight: Promise<IceServer[] | null> | null = null;
let failedAt = -Infinity;

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

let warnedStatic = false;

export function relayKind(): VoiceConfig["relay"] {
  if (env("CLOUDFLARE_TURN_KEY_ID") && env("CLOUDFLARE_TURN_API_TOKEN")) return "cloudflare";
  if (turnUrls().length > 0 && env("TURN_SECRET")) return "turn";
  if (!warnedStatic && (env("TURN_USERNAME") || env("TURN_CREDENTIAL"))) {
    warnedStatic = true;
    console.warn("voice: TURN_USERNAME/TURN_CREDENTIAL are not used (they would be handed to every player); set TURN_SECRET, see docs/VOICE.md");
  }
  return null;
}

// Browsers refuse the whole config (RTCPeerConnection throws) if one URL is malformed, so
// anything that isn't a stun:, turn: or turns: URL is dropped.
export function validIceUrl(url: string): boolean {
  return /^(stun|stuns|turn|turns):[^\s]+$/i.test(url);
}

function turnUrls(): string[] {
  return env("TURN_URLS")
    .split(",")
    .map((u) => u.trim())
    .filter(validIceUrl);
}

// coturn's TURN REST API credential: username "<expiry unix seconds>:<id>", password
// base64(HMAC-SHA1(secret, username)). coturn checks the HMAC and the expiry itself.
export function turnRestCredential(secret: string, id: string, nowMs: number, ttlS = SELF_HOSTED_TTL_S): { username: string; credential: string } {
  const expiry = Math.floor(nowMs / 1000) + ttlS;
  const username = `${expiry}:${id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "player"}`;
  const credential = createHmac("sha1", secret).update(username).digest("base64");
  return { username, credential };
}

// `clientId` names the player in a self-hosted TURN credential (shows up in coturn's logs).
export async function voiceConfig(clientId = "player"): Promise<VoiceConfig> {
  const relay = relayKind();
  if (relay === "turn") {
    return {
      iceServers: [...STUN, { urls: turnUrls(), ...turnRestCredential(env("TURN_SECRET"), clientId, Date.now()) }],
      relay,
      refreshMs: CLIENT_REFRESH_MS,
    };
  }
  if (relay === "cloudflare") {
    const turn = await cloudflareServers();
    if (turn) return { iceServers: [...STUN, ...turn], relay, refreshMs: CLIENT_REFRESH_MS };
    // Cloudflare unreachable: STUN only for now, and the client asks again soon.
    return { iceServers: STUN, relay: null, refreshMs: RETRY_AFTER_FAILURE_MS };
  }
  return { iceServers: STUN, relay: null, refreshMs: CLIENT_REFRESH_MS };
}

async function cloudflareServers(): Promise<IceServer[] | null> {
  const now = Date.now();
  if (cached && now - cached.fetchedAt < REFRESH_AFTER_MS) return cached.servers;
  if (now - failedAt < RETRY_AFTER_FAILURE_MS) return cached?.servers ?? null;
  inFlight ??= fetchCloudflare().finally(() => (inFlight = null));
  return inFlight;
}

async function fetchCloudflare(): Promise<IceServer[] | null> {
  const keyId = env("CLOUDFLARE_TURN_KEY_ID");
  const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${env("CLOUDFLARE_TURN_API_TOKEN")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: CLOUDFLARE_TTL_S }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { iceServers?: unknown };
    const servers = cleanServers(body.iceServers);
    if (servers.length === 0) throw new Error("no iceServers in the response");
    cached = { servers, fetchedAt: Date.now() };
    console.log(`voice: Cloudflare TURN credentials ready (${servers.length} server entries)`);
    return servers;
  } catch (err) {
    failedAt = Date.now();
    console.warn(`voice: Cloudflare TURN credentials failed (${(err as Error).message}); using STUN only for now`);
    return cached?.servers ?? null;
  }
}

// Cloudflare answers with one object or a list. URLs on port 53 are dropped: browsers
// time out on them (Cloudflare's own advice).
function cleanServers(raw: unknown): IceServer[] {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out: IceServer[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const { urls, username, credential } = item as Record<string, unknown>;
    const all = (Array.isArray(urls) ? urls : [urls]).filter((u): u is string => typeof u === "string");
    const kept = all.filter((u) => validIceUrl(u) && !/:53(\?|$)/.test(u));
    if (kept.length === 0) continue;
    const server: IceServer = { urls: kept };
    if (typeof username === "string") server.username = username;
    if (typeof credential === "string") server.credential = credential;
    out.push(server);
  }
  return out;
}
