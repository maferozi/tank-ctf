"use client";

import { GameScreen } from "./GameScreen";
import { createSoloDriver } from "./soloDriver";

const TARGETS = 3; // spinning blue soldiers to practise on

export function SoloGame() {
  return <GameScreen makeDriver={() => createSoloDriver(TARGETS)} />;
}
