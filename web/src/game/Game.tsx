"use client";

import {
  DEFAULT_HOLD_MS,
  DEFAULT_MAP,
  TICK_MS,
  addTank,
  cloneState,
  createState,
  step,
} from "@tank/shared";
import { useEffect, useRef, useState } from "react";
import { OneButton } from "./input";
import { POWER_STYLE, pruneEffects, render, type Effect } from "./render";

const LOCAL_ID = "you";
const TARGETS = 3; // spinning blue tanks to practise on until online play exists
const MAX_FRAME_MS = 250; // avoid a spiral of catch-up ticks after a tab switch

// Phase 1: single-player prototype. The local tank plus spinning blue targets.
export function Game() {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const padRef = useRef<HTMLButtonElement>(null);
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

    const map = DEFAULT_MAP;
    const state = createState(map);
    addTank(state, map, LOCAL_ID, "red");
    for (let i = 0; i < TARGETS; i++) addTank(state, map, `target-${i}`, "blue");
    // Dev-only hook so the sim can be inspected from the browser console.
    if (process.env.NODE_ENV !== "production") (window as unknown as { __tank?: unknown }).__tank = state;

    let prev = cloneState(state);
    let effects: Effect[] = [];
    const button = new OneButton(padEl ?? surface);

    // Fit the map into the stage, which is the screen minus the pad on touch devices.
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const scale = Math.min(stage.clientWidth / map.width, stage.clientHeight / map.height);
      canvas.style.width = `${Math.floor(map.width * scale)}px`;
      canvas.style.height = `${Math.floor(map.height * scale)}px`;
      canvas.width = Math.floor(map.width * scale * dpr);
      canvas.height = Math.floor(map.height * scale * dpr);
      ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(stage);

    let acc = 0;
    let last = performance.now();
    let raf = 0;
    const frame = (now: number) => {
      acc += Math.min(now - last, MAX_FRAME_MS);
      last = now;
      while (acc >= TICK_MS) {
        prev = cloneState(state);
        step(state, map, { [LOCAL_ID]: button.consume() }, { holdMs: DEFAULT_HOLD_MS });
        for (const e of state.events) {
          const team = state.tanks.find((t) => t.id === e.tankId)?.team ?? "red";
          const base = { x: e.x, y: e.y, bornMs: now, team };
          if (e.type === "fire") effects.push({ ...base, kind: "flash" });
          if (e.type === "drop") effects.push({ ...base, kind: "puff" });
          if (e.type === "kill") effects.push({ ...base, kind: "boom" });
          if (e.type === "shieldHit") effects.push({ ...base, kind: "spark", color: POWER_STYLE.shield.color });
          if (e.type === "power") {
            const style = POWER_STYLE[e.kind];
            effects.push({ ...base, kind: "text", label: style.label, color: style.color });
          }
        }
        acc -= TICK_MS;
      }
      if (padEl) padEl.dataset.pressed = String(button.held);
      effects = pruneEffects(effects, now);
      render(ctx, { map, prev, curr: state, alpha: acc / TICK_MS, localId: LOCAL_ID, effects, nowMs: now });
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      button.dispose();
    };
  }, [touch]);

  // Desktop: the whole screen is the button. Touch: only the pad beside the map is.
  return (
    <div className={touch ? "game touch" : "game"} ref={surfaceRef}>
      <div className="stage" ref={stageRef}>
        <canvas ref={canvasRef} />
      </div>
      {touch && (
        <div className="pad">
          <button ref={padRef} type="button" className="fire-button" aria-label="Tap to shoot, hold to drive">
            <span className="fire-tap">TAP</span>
            <span className="fire-hold">hold to drive</span>
          </button>
        </div>
      )}
    </div>
  );
}
