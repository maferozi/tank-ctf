"use client";

import { useState } from "react";
import { Icon } from "./Icon";

// Share the invite link (share sheet on phones, clipboard elsewhere).
function useShare(code: string) {
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
  return { copied, share };
}

// Room code and player count over the game. Tap to share the invite link.
export function RoomChip({ code, players }: { code: string; players: number }) {
  const { copied, share } = useShare(code);
  const label = copied ? "Link copied" : `Room ${code}, ${players} ${players === 1 ? "player" : "players"}. Share invite link`;
  return (
    <>
      <button type="button" className="chip room-chip" onClick={share} aria-label={label}>
        {copied ? (
          "Link copied"
        ) : (
          <>
            <span className="room-chip-code">{code}</span>
            <Icon name="people" />
            {players}
          </>
        )}
      </button>
      {/* Announces the copy: a focused button's label change isn't always read out. */}
      <span aria-live="polite" style={VISUALLY_HIDDEN}>
        {copied ? "Link copied" : ""}
      </span>
    </>
  );
}

const VISUALLY_HIDDEN = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
} as const;

// Lobby header: the room code as big letter tiles, tap to share.
export function RoomCode({ code }: { code: string }) {
  const { copied, share } = useShare(code);
  return (
    <div className="room-code">
      <span className="eyebrow">Room code</span>
      <h1 className="code-tiles" aria-label={`Room ${code}`}>
        {code.split("").map((ch, i) => (
          <span key={i} className="code-tile">
            {ch}
          </span>
        ))}
      </h1>
      <button type="button" className="button small secondary" onClick={share}>
        <Icon name="share" />
        {copied ? "Link copied" : "Invite friends"}
      </button>
    </div>
  );
}
