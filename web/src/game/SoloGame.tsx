"use client";

import Link from "next/link";
import { GameScreen } from "./GameScreen";
import { createSoloDriver } from "./soloDriver";

const TARGETS = 3; // spinning blue soldiers to practise on

// `mapId` comes from /play?map=<id>; unknown ids fall back to the default map.
export function SoloGame({ mapId }: { mapId?: string }) {
  return (
    <GameScreen makeDriver={() => createSoloDriver(TARGETS, mapId)}>
      <div className="game-chips">
        <Link href="/" className="room-chip">
          Menu
        </Link>
      </div>
    </GameScreen>
  );
}
