import { Client, type Room } from "@colyseus/sdk";
import {
  ClientNet,
  MSG,
  ROOM_NAME,
  SnapshotDecoder,
  type CreateOptions,
  type InputFrame,
  type JoinOptions,
  type RoomInfo,
  type Roster,
  type Snapshot,
  type SnapshotMessage,
  type Team,
} from "@tank/shared";
import { createUdpChannel, type UdpChannel } from "./udp";
import { createVoiceChat, type VoiceChat } from "./voice";

// The one live connection to a game room. Kept outside React so it survives the
// navigation from the home page to /room/CODE.
export interface Session {
  room: Room;
  roster: Roster | null; // null until the server's first roster arrives
  left: boolean; // the connection closed for good
  subscribe(listener: () => void): () => void; // roster or connection changes
  // Decoded game snapshots (the server sends deltas; see SnapshotMessage), from the
  // WebSocket or the UDP channel, whichever is carrying them (each tick once, in order).
  onSnapshot(listener: (snap: Snapshot) => void): () => void;
  // Your button samples: over the UDP channel when it is open, else the WebSocket.
  sendInput(frames: InputFrame[]): void;
  decoder: SnapshotDecoder; // WebSocket snapshots, for stats
  net: ClientNet; // both paths (transport, channel stats)
  voice: VoiceChat; // voice chat with the players you can hear (see voice.ts)
  setTeam(team: Team): void; // lobby: switch your own team
  movePlayer(playerId: string, team: Team): void; // lobby, host only
  start(): void; // lobby, host only
  leave(): Promise<void>; // leave on purpose: gives up the seat
}

let current: Session | null = null;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;

const DEV_SERVER_KEY = "tank-ctf:server";

function serverUrl(): string {
  // Dev only: `?server=ws://localhost:2571` points this tab at another game server (e.g. one
  // started with COLYSEUS_LATENCY to feel lag). Remembered for the tab's session.
  if (process.env.NODE_ENV !== "production") {
    const override = new URLSearchParams(location.search).get("server");
    if (override) sessionStorage.setItem(DEV_SERVER_KEY, override);
    const saved = sessionStorage.getItem(DEV_SERVER_KEY);
    if (saved) return saved;
  }
  // Same host as the page, so phones on the same Wi-Fi reach the dev server too.
  const fallback = `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:2567`;
  return process.env.NEXT_PUBLIC_SERVER_URL || fallback;
}

// Who is in a room right now, without joining it. null if the room doesn't exist.
export async function fetchRoomInfo(code: string): Promise<RoomInfo | null> {
  const res = await fetch(`${serverUrl().replace(/^ws/, "http")}/rooms/${code}`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`room info failed: ${res.status}`);
  return (await res.json()) as RoomInfo;
}

// A reload of the page reconnects with this token (kept per tab, per room) and gets the
// same seat and soldier back, as long as it's within RECONNECT_SECONDS.
const tokenKey = (code: string) => `tank-ctf:reconnect:${code}`;

function saveToken(room: Room): void {
  try {
    sessionStorage.setItem(tokenKey(room.roomId), room.reconnectionToken);
  } catch {
    // Storage blocked: a reload just means joining again.
  }
}

function forgetToken(code: string): void {
  try {
    sessionStorage.removeItem(tokenKey(code));
  } catch {
    // Nothing to forget.
  }
}

function track(room: Room): Session {
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());
  let udp: UdpChannel | null = null;
  const net = new ClientNet({
    sendInputWs: (frames) => room.send(MSG.input, frames),
    requestKeyframeWs: () => room.send(MSG.keyframe),
    myId: () => room.sessionId,
    channelDead: (reason) => udp?.dead(reason),
  });
  const voice = createVoiceChat(room);
  const session: Session = {
    room,
    roster: null,
    left: false,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onSnapshot: (listener) => net.onSnapshot(listener),
    sendInput: (frames) => net.sendInput(frames),
    decoder: net.wsDecoder,
    net,
    voice,
    setTeam: (team) => room.send(MSG.team, { team }),
    movePlayer: (playerId, team) => room.send(MSG.move, { playerId, team }),
    start: () => room.send(MSG.start),
    async leave() {
      forgetToken(room.roomId);
      if (current === session) current = null;
      voice.dispose(); // stops the mic and says bye to every voice peer
      udp?.dispose();
      await room.leave(true);
    },
  };
  saveToken(room);
  // The SDK reconnects by itself after a network blip; the token changes when it does.
  room.onReconnect(() => {
    saveToken(room);
    net.reset(); // the server sends a keyframe after a reconnect
    udp?.restart(); // the server closed our channel when the connection dropped
    voice.reconnected();
  });
  room.onMessage(MSG.roster, (roster: Roster) => {
    session.roster = roster;
    notify(); // first: nothing in voice may hold up the room screen
    try {
      voice.setRoster(roster);
    } catch (err) {
      console.warn("voice: roster update failed", err);
    }
  });
  // Decoded here, not in the game screen, so the delta chain is unbroken however long the
  // screen takes to subscribe (snapshots arriving before that are just not shown).
  room.onMessage(MSG.snapshot, (msg: SnapshotMessage) => net.onWsMessage(msg));
  udp = createUdpChannel(room, net);
  room.onLeave(() => {
    session.left = true;
    voice.dispose();
    udp?.dispose();
    forgetToken(room.roomId);
    notify();
  });
  room.send(MSG.ready);
  current?.room.leave();
  current = session;
  return session;
}

export async function createRoom(options: CreateOptions): Promise<Session> {
  return track(await new Client(serverUrl()).create(ROOM_NAME, options));
}

export async function joinRoom(code: string, options: JoinOptions): Promise<Session> {
  return track(await new Client(serverUrl()).joinById(code, options));
}

// After a page reload: take back our seat in this room if it is still being held.
// null if there is nothing to take back (never joined, left, or the hold ran out).
// Concurrent calls share one attempt: a token can only be used once, and React's dev-mode
// double mount would otherwise try twice.
const rejoining = new Map<string, Promise<Session | null>>();

export function rejoinRoom(code: string): Promise<Session | null> {
  let attempt = rejoining.get(code);
  if (!attempt) {
    attempt = tryRejoin(code).finally(() => rejoining.delete(code));
    rejoining.set(code, attempt);
  }
  return attempt;
}

async function tryRejoin(code: string): Promise<Session | null> {
  let token: string | null = null;
  try {
    token = sessionStorage.getItem(tokenKey(code));
  } catch {
    return null;
  }
  if (!token) return null;
  try {
    return track(await new Client(serverUrl()).reconnect(token));
  } catch {
    forgetToken(code);
    return null;
  }
}

// The live session for this room code, if we have one.
export function sessionFor(code: string): Session | null {
  if (releaseTimer) {
    clearTimeout(releaseTimer);
    releaseTimer = null;
  }
  return current && !current.left && current.room.roomId === code ? current : null;
}

// Leave the room when the page goes away. Deferred so React's dev-mode double mount
// (unmount + immediate remount) doesn't drop the connection.
export function releaseSession(): void {
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => {
    void current?.leave();
    current = null;
    releaseTimer = null;
  }, 200);
}
