"use client";

import { useEffect, useSyncExternalStore } from "react";
import { Icon } from "./Icon";
import type { VoiceChat } from "./voice";

// Re-renders the caller whenever voice state changes (mic, mute, who is speaking).
export function useVoice(voice: VoiceChat): VoiceChat {
  useSyncExternalStore(voice.subscribe, () => voice.version, () => 0);
  return voice;
}

type ChipState = "unavailable" | "tap" | "off" | "connecting" | "on" | "muted" | "blocked";

function chipState(voice: VoiceChat): ChipState {
  if (voice.unavailable) return "unavailable";
  if (voice.needsTap) return "tap";
  if (voice.mic === "blocked") return "blocked";
  if (voice.mic === "idle") return "off";
  if (voice.mic === "starting" || voice.connecting) return "connecting";
  return voice.muted ? "muted" : "on";
}

const LABEL: Record<ChipState, string> = {
  unavailable: "No voice",
  tap: "Tap to hear",
  off: "Mic off",
  connecting: "Connecting",
  on: "Mic on",
  muted: "Muted",
  blocked: "Mic blocked",
};

// CSS class per state ("unavailable" looks like "blocked", "tap" pulses like "connecting").
const LOOK: Record<ChipState, string> = {
  unavailable: "blocked",
  tap: "connecting",
  off: "off",
  connecting: "connecting",
  on: "on",
  muted: "muted",
  blocked: "blocked",
};

// Voice chat chip: mute / unmute (open mic), with the mic's state. In a match it shows
// only the icon, to keep the game screen clean. The first tap anywhere in the room turns
// the mic on; that tap also shows a one-time "use headphones" hint under the chip.
export function MicChip({ voice, compact = false }: { voice: VoiceChat; compact?: boolean }) {
  useVoice(voice);
  const state = chipState(voice);
  const talking = voice.speaking.has(voice.selfId) && state === "on";
  // The hint counts as seen (and starts its timer) once it is really on screen.
  useEffect(() => {
    if (voice.showHint) voice.hintShown();
  }, [voice, voice.showHint]);
  const title =
    state === "unavailable"
      ? `${voice.unavailable}. The game works as usual.`
      : state === "tap"
        ? "Tap anywhere to hear the others"
        : state === "blocked"
      ? `${voice.micError || "Mic blocked"}. Tap to try again; you can still hear your team.`
      : state === "off"
        ? "Turn on your mic"
        : state === "muted"
          ? "Muted. Tap to talk"
          : state === "connecting"
            ? voice.muted
              ? "Connecting voice (muted)"
              : "Connecting voice"
            : "Mic on. Tap to mute";

  // (Every tap on the chip also resumes playback: see onGesture in voice.ts.)
  function onClick() {
    if (state === "unavailable") return;
    if (state === "tap") {
      if (voice.mic === "idle") voice.start();
      return;
    }
    if (state === "blocked") voice.retryMic();
    else if (state === "off") voice.start();
    else voice.setMuted(!voice.muted);
  }

  return (
    <span className="mic-wrap">
      <button
        type="button"
        className={`chip mic-chip ${LOOK[state]}${talking ? " talking" : ""}${compact ? " icon-chip" : ""}`}
        aria-pressed={state === "on" || (state === "connecting" && !voice.muted)}
        aria-label={title}
        title={title}
        onClick={onClick}
      >
        <Icon name={state === "on" || (state === "connecting" && !voice.muted) ? "mic" : "micOff"} />
        {!compact && <span>{LABEL[state]}</span>}
      </button>
      {voice.showHint && (
        <span className="mic-hint" role="status">
          <Icon name="headphones" />
          Use headphones to avoid echo
          <button type="button" aria-label="Dismiss" onClick={() => voice.dismissHint()}>
            <Icon name="close" />
          </button>
        </span>
      )}
    </span>
  );
}

