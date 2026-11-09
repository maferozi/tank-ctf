"use client";

import { canStart, type Roster, type Team } from "@tank/shared";
import { Icon } from "./Icon";
import { MicChip, ShareChip, useVoice } from "./MicChip";
import { RoundMaps } from "./MapPicker";
import { RoomCode } from "./RoomChip";
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
  const voice = useVoice(session.voice);

  return (
    <main className="home lobby">
      <div className="lobby-mic">
        <MicChip voice={voice} />
        <ShareChip voice={voice} />
      </div>
      <RoomCode code={code} />
      <section className="panel match-info">
        <span className="eyebrow">{roster.rounds > 1 ? `${roster.rounds}-round tournament` : "Single match"}</span>
        <RoundMaps maps={roster.maps} />
      </section>

      <div className="lobby-teams">
        <span className="versus" aria-hidden>
          VS
        </span>
        {(["red", "blue"] as const).map((team) => {
          const players = roster.players.filter((p) => p.team === team);
          return (
            <section key={team} className={`lobby-team ${team}`}>
              <h2>
                {TEAM_NAME[team]} team <span className="team-count">{players.length}</span>
              </h2>
              <ul>
                {players.map((p) => (
                  <li
                    key={p.id}
                    className={[p.id === me && "me", voice.speaking.has(p.id) && "speaking"].filter(Boolean).join(" ") || undefined}
                  >
                    <span className="lobby-name">
                      <span className="avatar" aria-hidden>
                        {p.name.trim().charAt(0).toUpperCase() || "?"}
                      </span>
                      {p.id === roster.hostId && (
                        <span className="host-star" title="Host">
                          ★
                        </span>
                      )}
                      <span className="lobby-player">{p.name}</span>
                      {p.id === me && <span className="you">you</span>}
                      {p.away && <span className="away">away</span>}
                    </span>
                    {isHost && p.id !== me && (
                      <button type="button" className="move" onClick={() => session.movePlayer(p.id, other(team))}>
                        → {TEAM_NAME[other(team)]}
                      </button>
                    )}
                  </li>
                ))}
                {players.length === 0 && <li className="empty">Waiting for players</li>}
              </ul>
              {myTeam !== team && (
                <button type="button" className={`button small ${team}`} onClick={() => session.setTeam(team)}>
                  Join {TEAM_NAME[team]}
                </button>
              )}
            </section>
          );
        })}
      </div>

      <div className="lobby-actions">
        {isHost ? (
          <button type="button" className="button big" disabled={!ready} onClick={() => session.start()}>
            {ready && <Icon name="play" />}
            {ready ? "Start match" : "Needs a player on each team"}
          </button>
        ) : (
          <p className="hint waiting">
            <span className="spinner small" aria-hidden />
            Waiting for {host?.name ?? "the host"} to start…
          </p>
        )}
        <button type="button" className="quiet-link link-button" onClick={onLeave}>
          Leave room
        </button>
      </div>
    </main>
  );
}
