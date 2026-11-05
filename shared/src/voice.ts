import type { Roster } from "./net";

// Voice chat: peer-to-peer WebRTC audio between players' browsers (see docs/VOICE.md).
// The game server only relays the signaling messages below between two players who may
// hear each other, and hands out the ICE (STUN/TURN) config. It never touches audio.
// Nothing here is part of the game sim.

export type VoiceKind = "offer" | "answer" | "ice" | "bye";
export const VOICE_KINDS: readonly VoiceKind[] = ["offer", "answer", "ice", "bye"];

// An ICE candidate as the browser hands it out (RTCIceCandidateInit, without DOM types).
export interface IceCandidateData {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface VoiceData {
  // Which connection between the two players this belongs to. The impolite side (see
  // isPolite) numbers each fresh connection it starts; the polite side copies the number.
  // Messages for an older connection are ignored, a newer one replaces the old.
  epoch: number;
  sdp?: string; // offer, answer
  candidate?: IceCandidateData | null; // ice (null: end of candidates)
}

// MSG.voice, both ways. The server overwrites `from` with the sender's real id.
export interface VoiceMessage {
  to: string;
  from: string;
  kind: VoiceKind;
  data: VoiceData;
}

// An RTCIceServer, without DOM types.
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

// MSG.voiceConfig, server -> client (sent on join and when asked).
export interface VoiceConfig {
  iceServers: IceServer[];
  // Where TURN relay servers come from, or null when none are configured (most players
  // still connect directly; some strict networks won't).
  relay: "cloudflare" | "turn" | null;
  // Ask again after this long: TURN credentials expire.
  refreshMs: number;
}

// Limits the server enforces on MSG.voice. An audio-only SDP is 2–6 KB.
export const MAX_VOICE_MESSAGE_BYTES = 16 * 1024;
// Per sender: a burst big enough to connect to 7 players at once (an offer or answer and
// up to ~30 ICE candidates each with TURN over udp, tcp and tls), then a steady rate.
export const VOICE_BURST = 300;
export const VOICE_PER_SECOND = 40;
// MSG.voiceConfig requests per player (clients ask every few hours and after a reconnect).
export const VOICE_CONFIG_BURST = 5;
export const VOICE_CONFIG_PER_SECOND = 0.1;

// Speech-tuned Opus: mono, at most this many bits per second.
export const VOICE_MAX_BITRATE = 28_000;

// Who can hear whom: in the lobby everyone in the room, during a match only your own team.
// null if the player isn't in the room.
export function voiceGroup(roster: Pick<Roster, "players" | "phase">, playerId: string): string | null {
  const player = roster.players.find((p) => p.id === playerId);
  if (!player) return null;
  return roster.phase === "lobby" ? "room" : player.team;
}

// May `a` and `b` talk to each other right now? (The server's relay rule.)
export function canVoice(roster: Pick<Roster, "players" | "phase">, a: string, b: string): boolean {
  if (a === b) return false;
  const group = voiceGroup(roster, a);
  return group !== null && group === voiceGroup(roster, b);
}

// Everyone `me` should have a voice connection with, sorted by id. Away players (dropped,
// seat held) are left out until they are back.
export function voicePeers(roster: Pick<Roster, "players" | "phase">, me: string): string[] {
  return roster.players
    .filter((p) => !p.away && canVoice(roster, me, p.id))
    .map((p) => p.id)
    .sort();
}

// Perfect negotiation needs exactly one polite side per pair: the one with the higher id.
// The impolite side starts each connection.
export function isPolite(me: string, other: string): boolean {
  return me > other;
}

// Checks a client's MSG.voice. Returns the message to relay (without `from`, which the
// server fills in), or null to drop it.
export function parseVoiceMessage(raw: unknown): Omit<VoiceMessage, "from"> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { to, kind, data } = raw as Record<string, unknown>;
  if (typeof to !== "string" || to.length === 0 || to.length > 64) return null;
  if (!VOICE_KINDS.includes(kind as VoiceKind)) return null;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.epoch !== "number" || !Number.isFinite(d.epoch)) return null;
  if (d.sdp !== undefined && typeof d.sdp !== "string") return null;
  let size = 0;
  try {
    size = JSON.stringify(data).length;
  } catch {
    return null;
  }
  if (size > MAX_VOICE_MESSAGE_BYTES) return null;
  return { to, kind: kind as VoiceKind, data: data as unknown as VoiceData };
}

// Token bucket: `burst` messages at once, refilled at `perSecond`. The caller passes the
// time, so it is easy to test.
export class RateLimiter {
  private tokens: number;
  private lastMs: number | null = null;

  constructor(
    private readonly burst: number,
    private readonly perSecond: number,
  ) {
    this.tokens = burst;
  }

  take(nowMs: number): boolean {
    if (this.lastMs !== null) this.tokens = Math.min(this.burst, this.tokens + ((nowMs - this.lastMs) / 1000) * this.perSecond);
    this.lastMs = nowMs;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

// Opus settings for speech, written into an SDP's fmtp line for Opus: mono, forward error
// correction (hides lost packets), DTX (next to nothing is sent during silence) and a
// bitrate cap. Each side writes them into its own SDP; they tell the other side how to send.
export function tuneOpusSdp(sdp: string): string {
  const rtpmap = /a=rtpmap:(\d+) opus\/48000(\/2)?/i.exec(sdp);
  if (!rtpmap) return sdp;
  const pt = rtpmap[1]!;
  const want: Record<string, string> = {
    stereo: "0",
    "sprop-stereo": "0",
    useinbandfec: "1",
    usedtx: "1",
    maxaveragebitrate: String(VOICE_MAX_BITRATE),
  };
  const fmtp = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
  const merge = (existing: string) => {
    const params = new Map<string, string>();
    for (const part of existing.split(";")) {
      const [k, v] = part.split("=");
      if (k && k.trim()) params.set(k.trim(), (v ?? "").trim());
    }
    for (const [k, v] of Object.entries(want)) params.set(k, v);
    return [...params].map(([k, v]) => `${k}=${v}`).join(";");
  };
  if (fmtp.test(sdp)) return sdp.replace(fmtp, (_m, params: string) => `a=fmtp:${pt} ${merge(params)}`);
  // No fmtp line yet: add one after the rtpmap.
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
  return sdp.replace(rtpmap[0], `${rtpmap[0]}${eol}a=fmtp:${pt} ${merge("")}`);
}
