"use client";

import { useState } from "react";

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
  return (
    <button type="button" className="room-chip" onClick={share}>
      {copied ? "Link copied" : `${code}, ${players} ${players === 1 ? "player" : "players"}`}
    </button>
  );
}

// Lobby header: the room code as big letter tiles, tap to share.
export function RoomCode({ code }: { code: string }) {
  const { copied, share } = useShare(code);
  return (
    <div className="room-code">
      <h1 className="code-tiles" aria-label={`Room ${code}`}>
        {code.split("").map((ch, i) => (
          <span key={i} className="code-tile">
            {ch}
          </span>
        ))}
      </h1>
      <button type="button" className="button small secondary" onClick={share}>
        {copied ? "Link copied" : "Share invite link"}
      </button>
    </div>
  );
}
