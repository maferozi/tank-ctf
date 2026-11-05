"use client";

import type { Tank } from "@tank/shared";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/net/Icon";
import type { Driver } from "./driver";
import { effectsForEvents, startsRound } from "./effects";
import { OneButton } from "./input";
import { pruneEffects, render, type Effect, type RenderInput } from "./render";
import { isMuted, playEvents, setMuted, unlockAudio } from "./sound";

// Sharper than 2x costs a lot of fill rate on phones for no visible gain.
const MAX_DPR = 2;
// The TAP button's size follows the screen height, within these bounds (CSS px).
const BUTTON_MIN = 84;
const BUTTON_MAX = 136;

// The full-screen game view, laid out like the original's landscape screen: the map fills
// the height, centred, and on touch devices one big round TAP button sits in the
// bottom-left corner (only that button counts). Desktop: click anywhere or Space.
// Phones held upright see a "turn your phone" screen instead of a tiny map.
// `makeDriver` decides where the game comes from (solo sim or the server).
export function GameScreen({ makeDriver, children }: { makeDriver: () => Driver; children?: ReactNode }) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const padRef = useRef<HTMLButtonElement>(null);
  const makeDriverRef = useRef(makeDriver);
  makeDriverRef.current = makeDriver;
  // Phones and tablets get the on-screen button; null until measured on the client.
  const [touch, setTouch] = useState<boolean | null>(null);

  useEffect(() => {
    const query = window.matchMedia("(pointer: coarse)");
    const update = () => setTouch(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const surface = surfaceRef.current;
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (touch === null || !surface || !stage || !canvas || !ctx) return;
    // On touch devices only the pad counts, so stray taps on the map do nothing.
    const padEl = touch ? padRef.current : null;
    if (touch && !padEl) return;

    const driver = makeDriverRef.current();
    const { map } = driver;
    const button = new OneButton(padEl ?? surface);
    // While the rotate screen covers a portrait phone, the game keeps running but isn't drawn.
    const portrait = window.matchMedia("(orientation: portrait)");
    const chipsLeft = surface.querySelector<HTMLElement>(".game-chips.left");
    const chipsRight = surface.querySelector<HTMLElement>(".game-chips.right");
    let effects: Effect[] = [];
    let team = "";
    // Browsers only allow sound after a user gesture: the first press starts the audio.
    window.addEventListener("pointerdown", unlockAudio, true);
    window.addEventListener("keydown", unlockAudio, true);

    // Fit the map inside the stage (the screen minus safe areas). On touch devices the
    // map moves right, and if needed shrinks, so the corner button mostly sits beside it.
    const resize = () => {
      const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
      const pad = getComputedStyle(stage);
      const left = parseFloat(pad.paddingLeft);
      const top = parseFloat(pad.paddingTop);
      const width = Math.max(1, stage.clientWidth - left - parseFloat(pad.paddingRight));
      const height = Math.max(1, stage.clientHeight - top - parseFloat(pad.paddingBottom));
      let scale = Math.max(0.01, Math.min(width / map.width, height / map.height));
      let x = (width - map.width * scale) / 2;
      if (touch) {
        const size = Math.round(Math.max(BUTTON_MIN, Math.min(BUTTON_MAX, height * 0.3)));
        surface.style.setProperty("--pad-size", `${size}px`);
        const need = size * 0.72 + 8; // a little overlap with the map's corner is fine
        if (x < need) {
          if (width - map.width * scale < need) scale = Math.max(0.01, Math.min(height / map.height, (width - need) / map.width));
          x = need;
        }
      }
      const cssWidth = Math.floor(map.width * scale);
      const cssHeight = Math.floor(map.height * scale);
      // Chips stack down the side space beside the map; without room there (tablets, a
      // tall window) they line up along the top instead.
      const fits = x >= widest(chipsLeft) + 8 && width - x - cssWidth >= widest(chipsRight) + 8;
      surface.dataset.chips = fits ? "column" : "row";
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
      canvas.style.left = `${Math.floor(left + x)}px`;
      canvas.style.top = `${Math.floor(top + (height - cssHeight) / 2)}px`;
      canvas.width = Math.floor(map.width * scale * dpr);
      canvas.height = Math.floor(map.height * scale * dpr);
      ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(stage);
    // Chips change width (Leave asks to confirm, the room chip says "Link copied").
    if (chipsLeft) observer.observe(chipsLeft);

    // One render input reused every frame, so the loop doesn't allocate it 60 times a second.
    const view: RenderInput = { prev: null!, curr: null!, alpha: 0, localId: driver.localId, names: driver.names, speaking: driver.speaking, effects, nowMs: 0 };
    let raf = 0;
    const loop = (now: number) => {
      // Schedule first, so one frame that throws can't stop the game.
      raf = requestAnimationFrame(loop);
      const frame = driver.frame(now, button);
      if (padEl) {
        const held = button.held ? "true" : "false";
        if (padEl.dataset.pressed !== held) padEl.dataset.pressed = held;
      }
      if (!frame) return;
      let me: Tank | null = null;
      for (const t of frame.curr.tanks) if (t.id === driver.localId) me = t;
      if (me && me.team !== team) {
        team = me.team;
        surface.dataset.team = team; // colours the TAP button
      }
      if (frame.events.length > 0) {
        if (startsRound(frame.events)) effects = [];
        for (const e of effectsForEvents(frame.events, frame.curr, now)) effects.push(e);
        playEvents(frame.events, {
          localId: driver.localId,
          myTeam: me?.team ?? null,
          me: me ? { x: me.x, y: me.y } : null,
          mapWidth: map.width,
        });
      }
      if (effects.length > 0) effects = pruneEffects(effects, now);
      if (touch && portrait.matches) return;
      view.prev = frame.prev;
      view.curr = frame.curr;
      view.alpha = frame.alpha;
      view.effects = effects;
      view.nowMs = now;
      render(ctx, view);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointerdown", unlockAudio, true);
      window.removeEventListener("keydown", unlockAudio, true);
      observer.disconnect();
      button.dispose();
      driver.dispose();
    };
  }, [touch]);

  return (
    <div className={touch ? "game touch" : "game"} ref={surfaceRef} data-team="red">
      <div className="stage" ref={stageRef}>
        <canvas ref={canvasRef} />
      </div>
      {touch && (
        <button ref={padRef} type="button" className="fire-button" aria-label="Tap to shoot, hold to walk">
          <Icon name="target" className="fire-icon" />
          <span className="fire-tap">TAP</span>
        </button>
      )}
      {touch && <RotateHint />}
      <div className="game-chips left">{children}</div>
      <div className="game-chips right">
        <SoundToggle />
        <FullscreenToggle />
      </div>
    </div>
  );
}

// Turn sound effects on or off (remembered on this device).
function SoundToggle() {
  const [muted, setMutedState] = useState(false);
  // Read the saved setting before the first paint, so it never shows the wrong state.
  useLayoutEffect(() => setMutedState(isMuted()), []);
  return (
    <button
      type="button"
      className="chip icon-chip"
      aria-pressed={!muted}
      aria-label={muted ? "Sound off" : "Sound on"}
      title={muted ? "Sound off" : "Sound on"}
      onClick={() => {
        setMuted(!muted);
        setMutedState(!muted);
      }}
    >
      <Icon name={muted ? "soundOff" : "soundOn"} />
    </button>
  );
}

function FullscreenToggle() {
  const fs = useFullscreen();
  if (!fs.supported) return null;
  return (
    <button
      type="button"
      className="chip icon-chip"
      aria-pressed={fs.active}
      aria-label={fs.active ? "Exit fullscreen" : "Fullscreen"}
      title={fs.active ? "Exit fullscreen" : "Fullscreen"}
      onClick={fs.toggle}
    >
      <Icon name={fs.active ? "shrink" : "expand"} />
    </button>
  );
}

// Covers the game on a phone held upright. On Android, going fullscreen also locks the
// screen to landscape, which turns the game round by itself.
function RotateHint() {
  const fs = useFullscreen();
  return (
    <div className="rotate-hint" role="status">
      <div className="rotate-phone" aria-hidden>
        <Icon name="rotate" />
      </div>
      <p className="rotate-title">Turn your phone</p>
      <p className="rotate-text">The game plays sideways.</p>
      {fs.supported && !fs.active && (
        <button type="button" className="button small" onClick={fs.toggle}>
          Play fullscreen
        </button>
      )}
    </div>
  );
}

// Fullscreen API with the webkit prefix (iPad Safari). iPhones have no fullscreen API,
// so `supported` is false there and the chip is hidden.
type FsDocument = Document & { webkitFullscreenEnabled?: boolean; webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };
type FsElement = HTMLElement & { webkitRequestFullscreen?: () => void };
type LockableOrientation = ScreenOrientation & { lock?: (orientation: string) => Promise<void> };

function useFullscreen() {
  const [supported, setSupported] = useState(false);
  const [active, setActive] = useState(false);
  useEffect(() => {
    const doc = document as FsDocument;
    setSupported(Boolean(doc.fullscreenEnabled || doc.webkitFullscreenEnabled));
    const update = () => setActive(Boolean(doc.fullscreenElement || doc.webkitFullscreenElement));
    update();
    document.addEventListener("fullscreenchange", update);
    document.addEventListener("webkitfullscreenchange", update);
    return () => {
      document.removeEventListener("fullscreenchange", update);
      document.removeEventListener("webkitfullscreenchange", update);
    };
  }, []);

  async function toggle() {
    const doc = document as FsDocument;
    try {
      if (doc.fullscreenElement || doc.webkitFullscreenElement) {
        if (doc.exitFullscreen) await doc.exitFullscreen();
        else doc.webkitExitFullscreen?.();
        return;
      }
      // The whole page goes fullscreen, so it stays that way from the lobby into the match.
      const root = document.documentElement as FsElement;
      if (root.requestFullscreen) await root.requestFullscreen({ navigationUI: "hide" });
      else root.webkitRequestFullscreen?.();
      await (screen.orientation as LockableOrientation | undefined)?.lock?.("landscape");
    } catch {
      // Refused, or the device can't lock its orientation (iOS): play on as is.
    }
  }

  return { supported, active, toggle };
}

// The widest chip in a chip group, which is how wide the group is when stacked.
function widest(group: HTMLElement | null): number {
  let max = 0;
  if (group) for (const chip of group.children) max = Math.max(max, (chip as HTMLElement).offsetWidth);
  return max;
}
