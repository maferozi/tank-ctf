import { Room, matchMaker, type Client } from "colyseus";
import {
  DEFAULT_HOLD_MS,
  DEFAULT_MAP,
  InputQueue,
  MAX_FRAMES_PER_MESSAGE,
  MAX_PLAYERS,
  MSG,
  SNAPSHOT_EVERY_TICKS,
  TICK_MS,
  addTank,
  cleanName,
  createState,
  isMatchRounds,
  isTeam,
  makeRoomCode,
  removeTank,
  step,
  type GameEvent,
  type CreateOptions,
  type InputMessage,
  type JoinOptions,
  type Player,
  type RoomMetadata,
  type Roster,
  type Snapshot,
  type TankInput,
} from "@tank/shared";

// Clients send about 60 input messages a second (more on 120 Hz screens); anything far
// beyond that is abuse.
const MAX_MESSAGES_PER_SECOND = 240;

const MAX_CATCH_UP_TICKS = 10; // after a stall, don't fast-forward more than this at once
// TICK_STATS=1 logs how long ticks take (sim + snapshot), every STATS_EVERY_MS.
const TICK_STATS = process.env.TICK_STATS === "1";
const STATS_EVERY_MS = 5000;

// One match. Runs the shared sim at 60 Hz with every player's button state and sends
// snapshots to all players. The server is the only one who decides what happens.
export class GameRoom extends Room {
  maxClients = MAX_PLAYERS;
  maxMessagesPerSecond = MAX_MESSAGES_PER_SECOND;

  private map = DEFAULT_MAP;
  private sim = createState(DEFAULT_MAP);
  private queues = new Map<string, InputQueue>(); // per player: button samples, one per tick
  private players = new Map<string, Player>();
  private pendingEvents: GameEvent[] = [];
  private accMs = 0;
  private stats = { ticks: 0, totalMs: 0, maxMs: 0, catchUps: 0, since: performance.now() };

  async onCreate(options: Partial<CreateOptions> = {}) {
    this.roomId = await this.freeRoomCode();
    this.sim = createState(this.map, isMatchRounds(options.rounds) ? options.rounds : 1);

    this.onMessage(MSG.input, (client: Client, message: InputMessage) => {
      const queue = this.queues.get(client.sessionId);
      if (!queue || !Array.isArray(message)) return;
      queue.push(message.slice(0, MAX_FRAMES_PER_MESSAGE));
    });

    this.onMessage(MSG.ready, (client: Client) => client.send(MSG.roster, this.roster()));

    this.setSimulationInterval((deltaMs) => this.update(deltaMs), TICK_MS);
  }

  onJoin(client: Client, options: Partial<JoinOptions> = {}) {
    // Teams are picked by the player (phase 3 moves this into the lobby). No auto-balance.
    const team = isTeam(options.team) ? options.team : "red";
    const player: Player = { id: client.sessionId, name: cleanName(options.name), team };
    this.players.set(client.sessionId, player);
    this.queues.set(client.sessionId, new InputQueue());
    addTank(this.sim, this.map, client.sessionId, team);
    this.sendRoster();
    console.log(`${player.name} (${team}) joined ${this.roomId}, ${this.players.size} player(s)`);
  }

  onLeave(client: Client) {
    const player = this.players.get(client.sessionId);
    this.players.delete(client.sessionId);
    this.queues.delete(client.sessionId);
    removeTank(this.sim, client.sessionId);
    this.sendRoster();
    console.log(`${player?.name ?? client.sessionId} left ${this.roomId}, ${this.players.size} player(s)`);
  }

  // Fixed-step loop: timers are not exactly 16.67 ms, so step as many ticks as real time
  // allows and keep the remainder.
  private update(deltaMs: number) {
    this.accMs += deltaMs;
    let steps = 0;
    while (this.accMs >= TICK_MS && steps < MAX_CATCH_UP_TICKS) {
      this.tick();
      this.accMs -= TICK_MS;
      steps++;
    }
    if (steps === MAX_CATCH_UP_TICKS) this.accMs = 0;
    if (steps > 1) this.stats.catchUps++;
    if (TICK_STATS) this.logStats();
  }

  private logStats() {
    const s = this.stats;
    const now = performance.now();
    if (now - s.since < STATS_EVERY_MS) return;
    const rate = (s.ticks * 1000) / (now - s.since);
    console.log(
      `[${this.roomId}] ${this.players.size} players: ${rate.toFixed(1)} ticks/s, ` +
        `tick avg ${(s.totalMs / Math.max(1, s.ticks)).toFixed(3)} ms, max ${s.maxMs.toFixed(3)} ms, ` +
        `${s.catchUps} catch-ups`,
    );
    this.stats = { ticks: 0, totalMs: 0, maxMs: 0, catchUps: 0, since: now };
  }

  private tick() {
    const start = TICK_STATS ? performance.now() : 0;
    const inputs: Record<string, TankInput> = {};
    for (const [id, queue] of this.queues) inputs[id] = queue.next();
    step(this.sim, this.map, inputs, { holdMs: DEFAULT_HOLD_MS });
    this.pendingEvents.push(...this.sim.events);

    if (this.sim.tick % SNAPSHOT_EVERY_TICKS === 0) {
      const { events: _lastStepEvents, ...state } = this.sim;
      const acks = Object.fromEntries([...this.queues].map(([id, queue]) => [id, queue.ack]));
      const snapshot: Snapshot = { state, events: this.pendingEvents, acks };
      this.broadcast(MSG.snapshot, snapshot);
      this.pendingEvents = [];
    }
    if (TICK_STATS) {
      const ms = performance.now() - start;
      this.stats.ticks++;
      this.stats.totalMs += ms;
      this.stats.maxMs = Math.max(this.stats.maxMs, ms);
    }
  }

  private roster(): Roster {
    return { players: [...this.players.values()] };
  }

  // Players in the room see it via a message; people about to join read it from the
  // room's listing metadata (see the /rooms/:code route).
  private sendRoster() {
    const roster = this.roster();
    this.broadcast(MSG.roster, roster);
    const metadata: RoomMetadata = { ...roster, rounds: this.sim.match.rounds };
    void this.setMetadata(metadata);
  }

  // A 4-letter code nobody else is using right now.
  private async freeRoomCode(): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const code = makeRoomCode();
      const taken = await matchMaker.query({ roomId: code });
      if (taken.length === 0) return code;
    }
    throw new Error("could not find a free room code");
  }
}
