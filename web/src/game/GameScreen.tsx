"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Driver } from "./driver";
import { OneButton } from "./input";
import { POWER_STYLE, pruneEffects, render, type Effect } from "./render";

// The full-screen game view: canvas, one-button input and (on touch devices) the TAP pad.
// Desktop: the whole screen is the button. Touch: only the pad beside the map is.
// `makeDriver` decides where the game comes from (solo sim or the server).
export function GameScreen({ makeDriver, children }: { makeDriver: () => Driver; children?: ReactNode }) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const padRef = useRef<HTMLButtonElement>(null);
  const makeDriverRef = useRef(makeDriver);
  makeDriverRef.current = makeDriver;
  // Phones and tablets get a dedicated on-screen button; null until measured on the client.
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
    let effects: Effect[] = [];

    // Fit the map inside the stage's padding (room for the outline); the stage is the
    // screen minus the pad on touch devices.
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const pad = getComputedStyle(stage);
      const width = stage.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight);
      const height = stage.clientHeight - parseFloat(pad.paddingTop) - parseFloat(pad.paddingBottom);
      const scale = Math.max(0.01, Math.min(width / map.width, height / map.height));
      canvas.style.width = `${Math.floor(map.width * scale)}px`;
      canvas.style.height = `${Math.floor(map.height * scale)}px`;
      canvas.width = Math.floor(map.width * scale * dpr);
      canvas.height = Math.floor(map.height * scale * dpr);
      ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(stage);

    let raf = 0;
    const loop = (now: number) => {
      // Schedule first, so one frame that throws can't stop the game.
      raf = requestAnimationFrame(loop);
      const frame = driver.frame(now, button);
      if (padEl) padEl.dataset.pressed = String(button.held);
      if (frame) {
        for (const e of frame.events) {
          const team = frame.curr.tanks.find((t) => t.id === e.tankId)?.team ?? "red";
          const base = { x: e.x, y: e.y, bornMs: now, team };
          if (e.type === "fire") effects.push({ ...base, kind: "flash" });
          if (e.type === "drop") effects.push({ ...base, kind: "puff" });
          if (e.type === "kill") effects.push({ ...base, kind: "boom" });
          if (e.type === "shieldHit") effects.push({ ...base, kind: "spark", color: POWER_STYLE.shield.color });
          if (e.type === "power") {
            const style = POWER_STYLE[e.kind];
            effects.push({ ...base, kind: "text", label: style.label, color: style.color });
          }
          if (e.type === "flag") {
            const label = { taken: "FLAG TAKEN", dropped: "FLAG DROPPED", returned: "FLAG RETURNED" }[e.action];
            effects.push({ ...base, kind: "text", label, color: e.team === "red" ? "#ff5a5f" : "#3fa7ff" });
          }
          if (e.type === "round") effects = [];
        }
        effects = pruneEffects(effects, now);
        render(ctx, { ...frame, localId: driver.localId, names: driver.names, effects, nowMs: now });
      }
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      button.dispose();
      driver.dispose();
    };
  }, [touch]);

  return (
    <div className={touch ? "game touch" : "game"} ref={surfaceRef}>
      <div className="stage" ref={stageRef}>
        <canvas ref={canvasRef} />
      </div>
      {touch && (
        <div className="pad">
          <button ref={padRef} type="button" className="fire-button" aria-label="Tap to shoot, hold to walk">
            <span className="fire-tap">TAP</span>
            <span className="fire-hold">hold to walk</span>
          </button>
        </div>
      )}
      {children}
    </div>
  );
}
