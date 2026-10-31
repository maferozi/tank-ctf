"use client";

import { normalizeRoomCode } from "@tank/shared";
import Link from "next/link";
import { useEffect, useReducer, useState, type FormEvent } from "react";
import { GameScreen } from "@/game/GameScreen";
import { createOnlineDriver } from "@/game/onlineDriver";
import { PlayerFields, usePlayerSetup } from "./PlayerSetup";
import { joinRoom, releaseSession, sessionFor, type Session } from "./session";

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
      <form className="menu" onSubmit={submit}>
        <PlayerFields setup={setup} />
        <button type="submit" className="button" disabled={busy}>
          {busy ? "Joining…" : "Join game"}
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
    <button
      type="button"
      className="room-chip"
      // Keep presses on the chip from also counting as the game button.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={share}
    >
      {copied ? "Link copied" : `${code} · ${players} ${players === 1 ? "player" : "players"}`}
    </button>
  );
}
