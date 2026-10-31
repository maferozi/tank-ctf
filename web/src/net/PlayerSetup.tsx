"use client";

import { MAX_NAME_LENGTH, type Player, type Team } from "@tank/shared";
import { useEffect, useState } from "react";

const NAME_KEY = "tank-ctf:name";
const TEAM_KEY = "tank-ctf:team";

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode or blocked storage: just don't remember it.
  }
}

// Name and team, remembered on this device between visits.
export function usePlayerSetup() {
  const [name, setName] = useState("");
  const [team, setTeam] = useState<Team>("red");
  useEffect(() => {
    setName(load(NAME_KEY) ?? "");
    if (load(TEAM_KEY) === "blue") setTeam("blue");
  }, []);
  return {
    name,
    team,
    setName(value: string) {
      setName(value);
      save(NAME_KEY, value);
    },
    setTeam(value: Team) {
      setTeam(value);
      save(TEAM_KEY, value);
    },
  };
}

// With `players` (joining an existing room), each team button also lists who is already
// on that team, so you can see the teams and pick one in the same place.
export function PlayerFields({ setup, players }: { setup: ReturnType<typeof usePlayerSetup>; players?: Player[] }) {
  return (
    <>
      <label className="field">
        <span className="field-label">Your name</span>
        <input
          value={setup.name}
          maxLength={MAX_NAME_LENGTH}
          placeholder="Player"
          autoComplete="nickname"
          onChange={(e) => setup.setName(e.target.value)}
        />
      </label>
      <div className="field">
        <span className="field-label">Team</span>
        <div className="team-pick" role="radiogroup" aria-label="Team">
          {(["red", "blue"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={setup.team === t}
              className={`team-option ${t}`}
              onClick={() => setup.setTeam(t)}
            >
              <span className="team-name">{t === "red" ? "Red" : "Blue"}</span>
              {players && <TeamList players={players.filter((p) => p.team === t)} />}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

function TeamList({ players }: { players: Player[] }) {
  return (
    <span className="team-list">
      <span className="team-count">
        {players.length} {players.length === 1 ? "player" : "players"}
      </span>
      {players.map((p) => (
        <span key={p.id} className="team-member">
          {p.name}
        </span>
      ))}
    </span>
  );
}
