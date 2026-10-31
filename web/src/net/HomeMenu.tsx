"use client";

import { normalizeRoomCode, type MatchRounds } from "@tank/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { PlayerFields, usePlayerSetup } from "./PlayerSetup";
import { createRoom } from "./session";

export function HomeMenu() {
  const router = useRouter();
  const setup = usePlayerSetup();
  const [code, setCode] = useState("");
  const [rounds, setRounds] = useState<MatchRounds>(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    setBusy(true);
    setError("");
    try {
      const session = await createRoom({ name: setup.name, team: setup.team, rounds });
      router.push(`/room/${session.room.roomId}`);
    } catch {
      setError("Couldn't reach the game server. Is it running?");
      setBusy(false);
    }
  }

  function join(e: FormEvent) {
    e.preventDefault();
    const normalized = normalizeRoomCode(code);
    if (!normalized) {
      setError("Room codes are 4 letters, like KQTR.");
      return;
    }
    router.push(`/room/${normalized}`);
  }

  return (
    <main className="home">
      <h1>TANK CTF</h1>
      <p>One button. Tap to shoot, hold to walk.</p>
      <div className="menu">
        <PlayerFields setup={setup} />
        <MatchPicker rounds={rounds} onChange={setRounds} />
        <button type="button" className="button" disabled={busy} onClick={create}>
          {busy ? "Creating…" : "Create room"}
        </button>
        <form className="join-row" onSubmit={join}>
          <input
            value={code}
            placeholder="Room code"
            aria-label="Room code"
            maxLength={4}
            autoCapitalize="characters"
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
          <button type="submit" className="button secondary" disabled={busy}>
            Join
          </button>
        </form>
        {error && <p className="error">{error}</p>}
        <Link href="/play" className="quiet-link">
          Practice solo
        </Link>
      </div>
    </main>
  );
}

// Single match (one round) or a tournament of 5 or 7 rounds, 2 points per round won.
function MatchPicker({ rounds, onChange }: { rounds: MatchRounds; onChange: (r: MatchRounds) => void }) {
  const tournament = rounds > 1;
  return (
    <div className="field">
      <span>Match</span>
      <div className="segmented" role="radiogroup" aria-label="Match type">
        <button type="button" role="radio" aria-checked={!tournament} onClick={() => onChange(1)}>
          Single match
        </button>
        <button type="button" role="radio" aria-checked={tournament} onClick={() => onChange(tournament ? rounds : 5)}>
          Tournament
        </button>
      </div>
      {tournament && (
        <div className="segmented" role="radiogroup" aria-label="Rounds">
          {([5, 7] as const).map((r) => (
            <button key={r} type="button" role="radio" aria-checked={rounds === r} onClick={() => onChange(r)}>
              {r} rounds
            </button>
          ))}
        </div>
      )}
      {tournament && <small className="hint">2 points per round won. All rounds are played; most points wins.</small>}
    </div>
  );
}
