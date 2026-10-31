"use client";

import { MAX_NAME_LENGTH, type Team } from "@tank/shared";
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

export function PlayerFields({ setup }: { setup: ReturnType<typeof usePlayerSetup> }) {
  return (
    <>
      <label className="field">
        <span>Your name</span>
        <input
          value={setup.name}
          maxLength={MAX_NAME_LENGTH}
          placeholder="Player"
          autoComplete="nickname"
          onChange={(e) => setup.setName(e.target.value)}
        />
      </label>
      <div className="field">
        <span>Team</span>
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
              {t === "red" ? "Red" : "Blue"}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
