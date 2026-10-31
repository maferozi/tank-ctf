"use client";

import { canStart, type Roster, type Team } from "@tank/shared";
import { RoundMaps } from "./MapPicker";
import { RoomChip } from "./RoomChip";
import type { Session } from "./session";

const TEAM_NAME: Record<Team, string> = { red: "Red", blue: "Blue" };
const other = (team: Team): Team => (team === "red" ? "blue" : "red");

// Before a match: both teams side by side. Anyone can switch their own team; the host
// (★) can move other players and starts the match once each team has someone in it.
export function Lobby({ session, roster, code, onLeave }: { session: Session; roster: Roster; code: string; onLeave: () => void }) {
  const me = session.room.sessionId;
  const isHost = roster.hostId === me;
  const myTeam = roster.players.find((p) => p.id === me)?.team;
  const host = roster.players.find((p) => p.id === roster.hostId);
  const ready = canStart(roster);

  return (
    <main className="home lobby">
      <h1>Room {code}</h1>
      <RoomChip code={code} players={roster.players.length} />
      <p>{roster.rounds > 1 ? `Tournament · ${roster.rounds} rounds` : "Single match"}</p>
      <RoundMaps maps={roster.maps} />

      <div className="lobby-teams">
        {(["red", "blue"] as const).map((team) => {
          const players = roster.players.filter((p) => p.team === team);
          return (
            <section key={team} className={`lobby-team ${team}`}>
              <h2>
                {TEAM_NAME[team]} <span className="team-count">{players.length}</span>
              </h2>
              <ul>
                {players.map((p) => (
                  <li key={p.id} className={p.id === me ? "me" : undefined}>
                    <span className="lobby-name">
                      {p.id === roster.hostId && <span title="Host">★ </span>}
                      {p.name}
                      {p.id === me && " (you)"}
                      {p.away && <span className="away"> · away</span>}
                    </span>
                    {isHost && p.id !== me && (
                      <button type="button" className="move" onClick={() => session.movePlayer(p.id, other(team))}>
                        → {TEAM_NAME[other(team)]}
                      </button>
                    )}
                  </li>
                ))}
                {players.length === 0 && <li className="empty">No one yet</li>}
              </ul>
              {myTeam !== team && (
                <button type="button" className="button secondary" onClick={() => session.setTeam(team)}>
                  Join {TEAM_NAME[team]}
                </button>
              )}
            </section>
          );
        })}
      </div>

      <div className="menu">
        {isHost ? (
          <button type="button" className="button" disabled={!ready} onClick={() => session.start()}>
            {ready ? "Start match" : "Needs a player on each team"}
          </button>
        ) : (
          <p className="hint">Waiting for {host?.name ?? "the host"} to start the match…</p>
        )}
        <button type="button" className="quiet-link link-button" onClick={onLeave}>
          Leave room
        </button>
      </div>
    </main>
  );
}
