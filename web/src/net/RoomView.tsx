"use client";

import { normalizeRoomCode, type RoomInfo } from "@tank/shared";
import Link from "next/link";
import { useEffect, useReducer, useState, type FormEvent } from "react";
import { GameScreen } from "@/game/GameScreen";
import { createOnlineDriver } from "@/game/onlineDriver";
import { PlayerFields, usePlayerSetup } from "./PlayerSetup";
import { fetchRoomInfo, joinRoom, releaseSession, sessionFor, type Session } from "./session";

const ROOM_INFO_REFRESH_MS = 2000;

// /room/CODE: plays the room if we're already connected (we just created it), otherwise
// asks for a name and team first (someone opened an invite link).
export function RoomView({ rawCode }: { rawCode: string }) {
  const code = normalizeRoomCode(rawCode);
  const [session, setSession] = useState<Session | null>(null);
  const [checked, setChecked] = useState(false);
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    setSession(sessionFor(code));
    setChecked(true);
    return releaseSession;
  }, [code]);

  useEffect(() => session?.subscribe(rerender), [session]);

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

  return (
    <GameScreen makeDriver={() => createOnlineDriver(session)}>
      <RoomChip code={code} players={session.roster.length} />
      {session.left && (
        <div className="overlay">
          <p>Disconnected from the room.</p>
          <Link className="button" href="/">
            Back to start
          </Link>
        </div>
      )}
    </GameScreen>
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

// Room code and player count in the corner. Tap to share the invite link.
function RoomChip({ code, players }: { code: string; players: number }) {
  const [copied, setCopied] = useState(false);

  async function share() {
    const url = `${location.origin}/room/${code}`;
    try {
      if (navigator.share) await navigator.share({ title: "Tank CTF", text: `Join my game: ${code}`, url });
      else {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    } catch {
      // Share sheet dismissed or clipboard blocked: nothing to do.
    }
  }

  return (
    <button type="button" className="room-chip" onClick={share}>
      {copied ? "Link copied" : `${code} · ${players} ${players === 1 ? "player" : "players"}`}
    </button>
  );
}
