"use client";

import { useState } from "react";

// Room code and player count. Tap to share the invite link.
export function RoomChip({ code, players }: { code: string; players: number }) {
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
    <button type="button" className="room-chip" onClick={share}>
      {copied ? "Link copied" : `${code} · ${players} ${players === 1 ? "player" : "players"}`}
    </button>
  );
}
