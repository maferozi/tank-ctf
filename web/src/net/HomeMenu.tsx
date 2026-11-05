"use client";

import { normalizeRoomCode, roundMaps, type MatchRounds } from "@tank/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Icon } from "./Icon";
import { Logo } from "./Logo";
import { MapPicker } from "./MapPicker";
import { PlayerFields, usePlayerSetup } from "./PlayerSetup";
import { createRoom } from "./session";

export function HomeMenu() {
  const router = useRouter();
  const setup = usePlayerSetup();
  const [code, setCode] = useState("");
  const [rounds, setRoundCount] = useState<MatchRounds>(1);
  const [maps, setMaps] = useState<string[]>(() => roundMaps(1));
  // Changing the number of rounds keeps the maps already picked and fills the rest.
  const setRounds = (r: MatchRounds) => {
    setRoundCount(r);
    setMaps((current) => roundMaps(r, current));
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    setBusy(true);
    setError("");
    try {
      const session = await createRoom({ name: setup.name, team: setup.team, rounds, maps });
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
      <header className="hero">
        <Logo />
        <p className="tagline">One button. Steal their flag, bring it home.</p>
      </header>
      <div className="home-grid">
        <section className="panel create">
          <h2>New room</h2>
          <PlayerFields setup={setup} />
          <MatchPicker rounds={rounds} onChange={setRounds} />
          <MapPicker maps={maps} onChange={setMaps} />
          <button type="button" className="button big" disabled={busy} onClick={create}>
            {!busy && <Icon name="play" />}
            {busy ? "Creating…" : "Create room"}
          </button>
        </section>
        <div className="side">
          <section className="panel">
            <h2>Join a friend</h2>
            <form className="join-row" onSubmit={join}>
              <input
                value={code}
                placeholder="CODE"
                aria-label="Room code"
                maxLength={4}
                autoCapitalize="characters"
                onChange={(e) => setCode(e.target.value.toUpperCase())}
              />
              <button type="submit" className="button blue" disabled={busy}>
                Join
              </button>
            </form>
            {error && <p className="error">{error}</p>}
          </section>
          <Link href="/play" className="panel practice-tile">
            <span className="practice-icon" aria-hidden>
              <Icon name="target" />
            </span>
            <span className="practice-text">
              <span className="practice-title">Practice solo</span>
              <span className="hint">Learn the button on practice targets.</span>
            </span>
            <Icon name="play" className="practice-go" />
          </Link>
          <HowTo />
        </div>
      </div>
    </main>
  );
}

// The controls in three lines, for first-timers.
function HowTo() {
  return (
    <section className="panel how">
      <h2>How to play</h2>
      <dl>
        <dt>Tap</dt>
        <dd>Shoot, and turn the other way</dd>
        <dt>Hold</dt>
        <dd>Walk where you face</dd>
        <dt>Tap fast</dt>
        <dd>Spray shots in a fan</dd>
      </dl>
    </section>
  );
}

// Single match (one round) or a tournament of 5 or 7 rounds, 2 points per round won.
function MatchPicker({ rounds, onChange }: { rounds: MatchRounds; onChange: (r: MatchRounds) => void }) {
  const tournament = rounds > 1;
  return (
    <div className="field">
      <span className="field-label">Match</span>
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
