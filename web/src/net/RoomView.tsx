"use client";

import { normalizeRoomCode, type RoomInfo } from "@tank/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useReducer, useState, type FormEvent } from "react";
import { GameScreen } from "@/game/GameScreen";
import { createOnlineDriver } from "@/game/onlineDriver";
import { Lobby } from "./Lobby";
import { RoomChip } from "./RoomChip";
import { RoundMaps } from "./MapPicker";
import { PlayerFields, usePlayerSetup } from "./PlayerSetup";
import { fetchRoomInfo, joinRoom, rejoinRoom, releaseSession, sessionFor, type Session } from "./session";

const ROOM_INFO_REFRESH_MS = 2000;

// /room/CODE. Already connected (we just created or joined it): the lobby or the match.
// Not connected: take back our seat if this tab was just reloaded, otherwise ask for a
// name and team first (someone opened an invite link).
export function RoomView({ rawCode }: { rawCode: string }) {
  const code = normalizeRoomCode(rawCode);
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [checked, setChecked] = useState(false);
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    let alive = true;
    const live = sessionFor(code);
    if (live) {
      setSession(live);
      setChecked(true);
    } else {
      void rejoinRoom(code).then((rejoined) => {
        if (!alive) return;
        setSession(rejoined);
        setChecked(true);
      });
    }
    return () => {
      alive = false;
      releaseSession();
    };
  }, [code]);

  useEffect(() => session?.subscribe(rerender), [session]);

  async function leave() {
    await session?.leave();
    router.push("/");
  }

  if (!code) {
    return (
      <main className="home">
        <h1>No such room</h1>
        <p>Room codes are 4 letters, like KQTR.</p>
        <Link className="button" href="/">
          Back
        </Link>
      </main>
    );
  }
  if (!checked) return null;
  if (!session) return <JoinForm code={code} onJoined={setSession} />;
  if (session.left) {
    return (
      <main className="home">
        <h1>Room {code}</h1>
        <p>Disconnected from the room.</p>
        <Link className="button" href="/">
          Back to start
        </Link>
      </main>
    );
  }
  const roster = session.roster;
  if (!roster) return <main className="home"><p>Connecting…</p></main>;
  if (roster.phase === "lobby") return <Lobby session={session} roster={roster} code={code} onLeave={leave} />;

  return (
    <GameScreen makeDriver={() => createOnlineDriver(session)}>
      <div className="game-chips">
        <RoomChip code={code} players={roster.players.length} />
        <LeaveButton onLeave={leave} />
      </div>
    </GameScreen>
  );
}

// "Leave" asks once more before leaving, so a stray tap doesn't drop you out of a match.
function LeaveButton({ onLeave }: { onLeave: () => void }) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button type="button" className="room-chip" onClick={() => setAsking(true)}>
        Leave
      </button>
    );
  }
  return (
    <span className="room-chip confirm">
      Leave match?
      <button type="button" onClick={onLeave}>
        Yes
      </button>
      <button type="button" onClick={() => setAsking(false)}>
        No
      </button>
    </span>
  );
}

function JoinForm({ code, onJoined }: { code: string; onJoined: (s: Session) => void }) {
  const setup = usePlayerSetup();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // undefined: still loading; null: no such room.
  const [info, setInfo] = useState<RoomInfo | null | undefined>(undefined);

  // Keep the team lists current while the form is open.
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchRoomInfo(code)
        .then((next) => alive && setInfo(next))
        .catch(() => alive && setError("Couldn't reach the game server. Is it running?"));
    load();
    const timer = setInterval(load, ROOM_INFO_REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [code]);

  if (info === null) {
    return (
      <main className="home">
        <h1>Room {code}</h1>
        <p>This room doesn't exist or has closed.</p>
        <Link className="button" href="/">
          Back to start
        </Link>
      </main>
    );
  }
  const full = info !== undefined && info.players.length >= info.maxPlayers;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      onJoined(await joinRoom(code, { name: setup.name, team: setup.team }));
    } catch {
      setError("Couldn't join. The room may be full or closed.");
      setBusy(false);
    }
  }

  return (
    <main className="home">
      <h1>Room {code}</h1>
      {info && <p>{info.rounds > 1 ? `Tournament · ${info.rounds} rounds` : "Single match"}</p>}
      {info && <RoundMaps maps={info.maps} />}
      {info?.phase === "playing" && <p className="hint">A match is on: you'll join your team straight away.</p>}
      <form className="menu" onSubmit={submit}>
        <PlayerFields setup={setup} players={info?.players ?? []} />
        <button type="submit" className="button" disabled={busy || full}>
          {full ? "Room is full" : busy ? "Joining…" : `Join ${setup.team === "red" ? "Red" : "Blue"}`}
        </button>
        {error && <p className="error">{error}</p>}
        <Link href="/" className="quiet-link">
          Back
        </Link>
      </form>
    </main>
  );
}
