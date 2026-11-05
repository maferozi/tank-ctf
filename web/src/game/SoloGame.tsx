"use client";

import Link from "next/link";
import { Icon } from "@/net/Icon";
import { GameScreen } from "./GameScreen";
import { createSoloDriver } from "./soloDriver";

const TARGETS = 3; // spinning blue soldiers to practise on

// `mapId` comes from /play?map=<id>; unknown ids fall back to the default map.
export function SoloGame({ mapId }: { mapId?: string }) {
  return (
    <GameScreen makeDriver={() => createSoloDriver(TARGETS, mapId)}>
      <Link href="/" className="chip">
        <Icon name="back" />
        Menu
      </Link>
    </GameScreen>
  );
}
