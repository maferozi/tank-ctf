"use client";

import { MAPS, getMap, type GameMap } from "@tank/shared";
import { useEffect, useRef, useState } from "react";
import { drawMapPreview } from "@/game/render";

// A map drawn small, straight from the map data (so it never goes out of date).
export function MapPreview({ map, width }: { map: GameMap; width: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const height = Math.round((width * map.height) / map.width);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const scale = (width / map.width) * dpr;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    drawMapPreview(ctx, map);
  }, [map, width, height]);
  return <canvas ref={ref} className="map-preview" style={{ width, height }} aria-hidden />;
}

// Read-only strip of the map for each round (join page, lobby).
export function RoundMaps({ maps }: { maps: string[] }) {
  return (
    <div className="round-slots join-maps" aria-label="Maps">
      {maps.map((id, i) => (
        <div key={i} className="round-slot">
          {maps.length > 1 && <span className="round-label">R{i + 1}</span>}
          <MapPreview map={getMap(id)} width={maps.length > 1 ? 52 : 150} />
          <span className="round-map">{getMap(id).name}</span>
        </div>
      ))}
    </div>
  );
}

// One map per round. Tap a round, then tap a map to put it in that round (the next round
// is selected after each pick, so tapping maps in order fills the rounds in order).
export function MapPicker({ maps, onChange }: { maps: string[]; onChange: (maps: string[]) => void }) {
  const [slot, setSlot] = useState(0);
  const rounds = maps.length;
  const active = Math.min(slot, rounds - 1);

  function pick(id: string) {
    const next = [...maps];
    next[active] = id;
    onChange(next);
    setSlot((active + 1) % rounds);
  }

  return (
    <div className="field">
      <span className="field-label">{rounds === 1 ? "Map" : `Map for round ${active + 1}`}</span>
      {rounds > 1 && (
        <div className="round-slots" role="radiogroup" aria-label="Round">
          {maps.map((id, i) => (
            <button key={i} type="button" role="radio" aria-checked={i === active} className="round-slot" onClick={() => setSlot(i)}>
              <span className="round-label">R{i + 1}</span>
              <MapPreview map={getMap(id)} width={52} />
              <span className="round-map">{getMap(id).name}</span>
            </button>
          ))}
        </div>
      )}
      <div className="map-grid" role="radiogroup" aria-label={rounds === 1 ? "Map" : `Map for round ${active + 1}`}>
        {MAPS.map((m) => (
          <button key={m.id} type="button" role="radio" aria-checked={maps[active] === m.id} className="map-card" onClick={() => pick(m.id)}>
            <MapPreview map={m} width={150} />
            <span className="map-name">{m.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
