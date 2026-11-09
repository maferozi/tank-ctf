"use client";

import { normalizeRoomCode, type RoomInfo } from "@tank/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useReducer, useState, type FormEvent, type ReactNode } from "react";
import { GameScreen } from "@/game/GameScreen";
import { createOnlineDriver } from "@/game/onlineDriver";
import { Icon } from "./Icon";
import { Lobby } from "./Lobby";
import { Logo } from "./Logo";
import { MicChip, ShareChip } from "./MicChip";
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
      <Message title="No such room" text="Room codes are 4 letters, like KQTR.">
        <Link className="button" href="/">
          Back
        </Link>
      </Message>
    );
  }
  if (!checked) return null;
  if (!session) return <JoinForm code={code} onJoined={setSession} />;
  if (session.left) {
    return (
      <Message title={`Room ${code}`} text="Disconnected from the room.">
        <Link className="button" href="/">
          Back to start
        </Link>
      </Message>
    );
  }
  const roster = session.roster;
  if (!roster) {
    return (
      <Message title="Connecting…">
        <span className="spinner" aria-hidden />
      </Message>
    );
  }
  if (roster.phase === "lobby") return <Lobby session={session} roster={roster} code={code} onLeave={leave} />;

  return (
    <GameScreen makeDriver={() => createOnlineDriver(session)}>
      <RoomChip code={code} players={roster.players.length} />
      <MicChip voice={session.voice} compact />
      <ShareChip voice={session.voice} compact />
      <LeaveButton onLeave={leave} />
    </GameScreen>
  );
}

// "Leave" asks once more before leaving, so a stray tap doesn't drop you out of a match.
function LeaveButton({ onLeave }: { onLeave: () => void }) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button type="button" className="chip" onClick={() => setAsking(true)}>
        <Icon name="leave" />
        Leave
      </button>
    );
  }
  return (
    <div className="chip-confirm" role="group" aria-label="Leave match?">
      <span>Leave match?</span>
      <div className="chip-confirm-actions">
        <button type="button" className="yes" onClick={onLeave}>
          Leave
        </button>
        <button type="button" onClick={() => setAsking(false)}>
          Stay
        </button>
      </div>
    </div>
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
      <Message title={`Room ${code}`} text="This room doesn't exist or has closed.">
        <Link className="button" href="/">
          Back to start
        </Link>
      </Message>
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
    <main className="home join-page">
      <Logo small />
      <form className="panel join-panel" onSubmit={submit}>
        <h2>
          Join room <span className="code-inline">{code}</span>
        </h2>
        {info && (
          <div className="match-line">
            <span>{info.rounds > 1 ? `${info.rounds}-round tournament` : "Single match"}</span>
            <RoundMaps maps={info.maps} />
          </div>
        )}
        {info?.phase === "playing" && <p className="hint">A match is on: you'll join your team straight away.</p>}
        <PlayerFields setup={setup} players={info?.players ?? []} />
        <button type="submit" className={`button big ${setup.team}`} disabled={busy || full}>
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

// A centred card for one-line states: connecting, room gone, disconnected.
function Message({ title, text, children }: { title: string; text?: string; children?: ReactNode }) {
  return (
    <main className="home message">
      <div className="panel message-card">
        <h1>{title}</h1>
        {text && <p>{text}</p>}
        {children}
      </div>
    </main>
  );
}
