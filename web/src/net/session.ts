import { Client, type Room } from "@colyseus/sdk";
import { MSG, ROOM_NAME, type CreateOptions, type JoinOptions, type Player, type RoomInfo, type Roster } from "@tank/shared";

// The one live connection to a game room. Kept outside React so it survives the
// navigation from the home page to /room/CODE.
export interface Session {
  room: Room;
  roster: Player[];
  left: boolean; // the connection closed
  subscribe(listener: () => void): () => void; // roster or connection changes
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

function track(room: Room): Session {
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());
  const session: Session = {
    room,
    roster: [],
    left: false,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  room.onMessage(MSG.roster, (roster: Roster) => {
    session.roster = roster.players;
    notify();
  });
  // Snapshots can arrive before the game screen subscribes; ignore those quietly.
  room.onMessage(MSG.snapshot, () => {});
  room.onLeave(() => {
    session.left = true;
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
    current?.room.leave();
    current = null;
    releaseTimer = null;
  }, 200);
}
