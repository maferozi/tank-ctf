import type { GameEvent, Team } from "@tank/shared";

// Sound effects, synthesized with Web Audio (no audio files). Browsers only allow sound
// after a user gesture, so the audio context starts on the first press anywhere.
// Sounds pan left/right with where they happen, and other players' shots and deaths get
// quieter with distance from your own soldier.

const MUTE_KEY = "tank-ctf:muted";
const FLARE_BURST = 4; // a flare fires this many bullets at once

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;
let muted = loadMuted();

function loadMuted(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(value: boolean): void {
  muted = value;
  if (master) master.gain.value = value ? 0 : 1;
  try {
    localStorage.setItem(MUTE_KEY, value ? "1" : "0");
  } catch {
    // Storage blocked: the setting just isn't remembered.
  }
}

// Call from a user gesture (press, click, key) so the browser lets audio play.
export function unlockAudio(): void {
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 1;
    // A gentle limiter so many sounds at once don't clip.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.ratio.value = 8;
    master.connect(limiter).connect(ctx.destination);
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === "suspended") void ctx.resume();
}

interface Where {
  pan: number; // -1 left .. 1 right
  gain: number; // 0..1
}

// A voice: an output node already panned and scaled, plus the start time.
function voice(where: Where): { out: GainNode; t: number } | null {
  // A context still starting up ("suspended" right after the first press) plays what was
  // scheduled as soon as it is running, so the very first shot is heard too.
  if (!ctx || !master || ctx.state === "closed" || muted) return null;
  const out = ctx.createGain();
  out.gain.value = where.gain;
  const panner = ctx.createStereoPanner();
  panner.pan.value = where.pan;
  out.connect(panner).connect(master);
  return { out, t: ctx.currentTime };
}

// One oscillator note with a quick attack and an exponential decay; optional pitch slide.
function tone(
  out: AudioNode,
  t: number,
  { type = "sine", freq, to, dur, vol = 0.3, delay = 0 }: { type?: OscillatorType; freq: number; to?: number; dur: number; vol?: number; delay?: number },
): void {
  const c = ctx!;
  const start = t + delay;
  const osc = c.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, start + dur);
  const env = c.createGain();
  env.gain.setValueAtTime(0.0001, start);
  env.gain.exponentialRampToValueAtTime(vol, start + 0.005);
  env.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(env).connect(out);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

// A burst of filtered noise (gunshots, impacts, whooshes).
function hiss(
  out: AudioNode,
  t: number,
  { dur, vol = 0.3, filter = "highpass", freq = 1000, to, q = 0.8, delay = 0 }: { dur: number; vol?: number; filter?: BiquadFilterType; freq?: number; to?: number; q?: number; delay?: number },
): void {
  const c = ctx!;
  const start = t + delay;
  const src = c.createBufferSource();
  src.buffer = noise;
  src.playbackRate.value = 0.8 + Math.random() * 0.4;
  const f = c.createBiquadFilter();
  f.type = filter;
  f.Q.value = q;
  f.frequency.setValueAtTime(freq, start);
  if (to) f.frequency.exponentialRampToValueAtTime(to, start + dur);
  const env = c.createGain();
  env.gain.setValueAtTime(vol, start);
  env.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  src.connect(f).connect(env).connect(out);
  src.start(start, Math.random() * 0.5);
  src.stop(start + dur + 0.02);
}

const SOUNDS = {
  // Short pop: a noise crack over a low thump.
  shot(where: Where) {
    const v = voice(where);
    if (!v) return;
    hiss(v.out, v.t, { dur: 0.07, vol: 0.5, freq: 1800 });
    tone(v.out, v.t, { type: "triangle", freq: 180, to: 60, dur: 0.08, vol: 0.45 });
  },
  // Flare: four bullets at once, a rising whoosh with a crackle.
  flare(where: Where) {
    const v = voice(where);
    if (!v) return;
    hiss(v.out, v.t, { dur: 0.25, vol: 0.35, filter: "bandpass", freq: 600, to: 3000, q: 2 });
    tone(v.out, v.t, { type: "sawtooth", freq: 220, to: 880, dur: 0.18, vol: 0.12 });
    hiss(v.out, v.t, { dur: 0.06, vol: 0.4, freq: 2000, delay: 0.02 });
  },
  // Your own bullet stopping on a wall or dropping: a soft tick.
  drop(where: Where) {
    const v = voice(where);
    if (!v) return;
    hiss(v.out, v.t, { dur: 0.04, vol: 0.12, filter: "bandpass", freq: 2500, q: 3 });
  },
  // A crate breaks: a woody crack over a short crunch.
  crateBreak(where: Where) {
    const v = voice(where);
    if (!v) return;
    hiss(v.out, v.t, { dur: 0.16, vol: 0.4, filter: "bandpass", freq: 900, to: 300, q: 1.5 });
    tone(v.out, v.t, { type: "square", freq: 140, to: 70, dur: 0.12, vol: 0.12 });
  },
  // Someone goes down: an impact thud and a falling groan.
  kill(where: Where) {
    const v = voice(where);
    if (!v) return;
    hiss(v.out, v.t, { dur: 0.18, vol: 0.5, filter: "lowpass", freq: 1500, to: 200 });
    tone(v.out, v.t, { type: "square", freq: 320, to: 70, dur: 0.32, vol: 0.14 });
    tone(v.out, v.t, { type: "sine", freq: 110, to: 45, dur: 0.25, vol: 0.5 });
  },
  // You got a kill: a bright confirm on top of the thud.
  killConfirm() {
    const v = voice({ pan: 0, gain: 1 });
    if (!v) return;
    tone(v.out, v.t, { type: "triangle", freq: 1320, dur: 0.12, vol: 0.18, delay: 0.05 });
    tone(v.out, v.t, { type: "triangle", freq: 1760, dur: 0.18, vol: 0.18, delay: 0.12 });
  },
  // You were shot: a low, dull hit.
  died() {
    const v = voice({ pan: 0, gain: 1 });
    if (!v) return;
    tone(v.out, v.t, { type: "sawtooth", freq: 220, to: 55, dur: 0.6, vol: 0.18 });
    hiss(v.out, v.t, { dur: 0.4, vol: 0.3, filter: "lowpass", freq: 800, to: 100 });
  },
  // A shield blocks a bullet: metallic ping.
  shieldHit(where: Where) {
    const v = voice(where);
    if (!v) return;
    tone(v.out, v.t, { freq: 1250, dur: 0.3, vol: 0.2 });
    tone(v.out, v.t, { freq: 1870, dur: 0.22, vol: 0.12 });
    hiss(v.out, v.t, { dur: 0.03, vol: 0.2, freq: 4000 });
  },
  // A shield's last hit: the bubble shatters like glass, a bright crash sliding down.
  shieldBreak(where: Where) {
    const v = voice(where);
    if (!v) return;
    hiss(v.out, v.t, { dur: 0.35, vol: 0.4, filter: "bandpass", freq: 6000, to: 1800, q: 1.2 });
    tone(v.out, v.t, { type: "triangle", freq: 1870, to: 620, dur: 0.32, vol: 0.18 });
    [2490, 2960, 2220].forEach((f, i) => tone(v.out, v.t, { freq: f, dur: 0.12, vol: 0.08, delay: 0.03 + i * 0.045 }));
  },
  // Power picked up: a quick rising arpeggio, different for each power.
  power(where: Where, kind: "shield" | "speed" | "flare") {
    const v = voice(where);
    if (!v) return;
    const notes = { shield: [392, 523, 659, 784], speed: [523, 659, 784, 1047, 1319], flare: [659, 880, 1109, 1319] }[kind];
    const type: OscillatorType = kind === "shield" ? "triangle" : kind === "speed" ? "square" : "sawtooth";
    const step = kind === "speed" ? 0.04 : 0.06;
    notes.forEach((f, i) => tone(v.out, v.t, { type, freq: f, dur: 0.16, vol: type === "triangle" ? 0.25 : 0.08, delay: i * step }));
  },
  // Flags. Good news for your team goes up, bad news goes down.
  flagTaken(good: boolean) {
    const v = voice({ pan: 0, gain: 1 });
    if (!v) return;
    const [a, b] = good ? [587, 880] : [740, 440];
    tone(v.out, v.t, { type: "square", freq: a, dur: 0.14, vol: 0.12 });
    tone(v.out, v.t, { type: "square", freq: b, dur: 0.22, vol: 0.12, delay: 0.13 });
    if (!good) tone(v.out, v.t, { type: "square", freq: b, dur: 0.22, vol: 0.12, delay: 0.38 });
  },
  flagDropped() {
    const v = voice({ pan: 0, gain: 1 });
    if (!v) return;
    tone(v.out, v.t, { type: "triangle", freq: 660, dur: 0.12, vol: 0.25 });
    tone(v.out, v.t, { type: "triangle", freq: 440, dur: 0.2, vol: 0.25, delay: 0.1 });
  },
  flagReturned() {
    const v = voice({ pan: 0, gain: 1 });
    if (!v) return;
    [784, 988, 1175].forEach((f, i) => tone(v.out, v.t, { type: "triangle", freq: f, dur: 0.25, vol: 0.2, delay: i * 0.07 }));
  },
  // Round won: a fanfare. Lost: a falling minor phrase.
  roundOver(won: boolean) {
    const v = voice({ pan: 0, gain: 1 });
    if (!v) return;
    const notes = won ? [523, 659, 784, 1047] : [440, 415, 392, 311];
    notes.forEach((f, i) => {
      const last = i === notes.length - 1;
      tone(v.out, v.t, { type: "square", freq: f, dur: last ? 0.6 : 0.16, vol: 0.1, delay: i * 0.14 });
      tone(v.out, v.t, { type: "triangle", freq: f / 2, dur: last ? 0.6 : 0.16, vol: 0.2, delay: i * 0.14 });
    });
  },
  // New round: two short beeps and a higher one.
  roundStart() {
    const v = voice({ pan: 0, gain: 1 });
    if (!v) return;
    tone(v.out, v.t, { type: "square", freq: 660, dur: 0.1, vol: 0.1 });
    tone(v.out, v.t, { type: "square", freq: 660, dur: 0.1, vol: 0.1, delay: 0.18 });
    tone(v.out, v.t, { type: "square", freq: 990, dur: 0.25, vol: 0.12, delay: 0.36 });
  },
};

export interface SoundView {
  localId: string;
  myTeam: Team | null;
  me: { x: number; y: number } | null; // your soldier, for distance falloff
  mapWidth: number;
}

// Plays the sounds for one frame's events.
export function playEvents(events: readonly GameEvent[], view: SoundView): void {
  if (!ctx || events.length === 0) return;
  const where = (x: number, y: number, mine: boolean): Where => {
    const pan = Math.max(-1, Math.min(1, (x / view.mapWidth) * 2 - 1)) * 0.7;
    if (mine || !view.me) return { pan, gain: 1 };
    const d = Math.hypot(x - view.me.x, y - view.me.y);
    return { pan, gain: Math.max(0.25, 0.75 - d / 1600) };
  };
  // A flare burst is several "fire" events from one soldier in the same frame.
  const shots = new Map<string, GameEvent[]>();
  for (const e of events) {
    if (e.type === "fire") shots.set(e.tankId, [...(shots.get(e.tankId) ?? []), e]);
  }
  for (const [id, list] of shots) {
    const e = list[0]!;
    const w = where(e.x, e.y, id === view.localId);
    if (list.length >= FLARE_BURST) SOUNDS.flare(w);
    else SOUNDS.shot(w);
  }
  for (const e of events) {
    const mine = e.tankId === view.localId;
    if (e.type === "drop" && mine) SOUNDS.drop(where(e.x, e.y, true));
    if (e.type === "crateBreak") SOUNDS.crateBreak(where(e.x, e.y, mine));
    if (e.type === "kill") {
      if (mine) SOUNDS.died();
      else {
        SOUNDS.kill(where(e.x, e.y, false));
        if (e.by === view.localId) SOUNDS.killConfirm();
      }
    }
    if (e.type === "shieldHit") SOUNDS.shieldHit(where(e.x, e.y, mine));
    if (e.type === "shieldBreak") SOUNDS.shieldBreak(where(e.x, e.y, mine));
    if (e.type === "power") SOUNDS.power(where(e.x, e.y, mine), e.kind);
    if (e.type === "flag") {
      // e.team is whose flag it is.
      const ours = e.team === view.myTeam;
      if (e.action === "taken") SOUNDS.flagTaken(!ours);
      if (e.action === "dropped") SOUNDS.flagDropped();
      if (e.action === "returned") SOUNDS.flagReturned();
    }
    if (e.type === "capture") SOUNDS.roundOver(e.team === view.myTeam);
    if (e.type === "round") SOUNDS.roundStart();
  }
}
