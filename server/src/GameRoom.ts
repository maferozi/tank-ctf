import { Room, matchMaker, type Client } from "colyseus";
import {
  DEFAULT_HOLD_MS,
  InputQueue,
  MAX_FRAMES_PER_MESSAGE,
  MAX_PLAYERS,
  MSG,
  RECONNECT_SECONDS,
  SNAPSHOT_EVERY_TICKS,
  TICK_MS,
  addTank,
  canStart,
  cleanName,
  createMatchState,
  getMap,
  isMatchRounds,
  isTeam,
  makeRoomCode,
  removeTank,
  roundMaps,
  step,
  type CreateOptions,
  type GameEvent,
  type InputMessage,
  type JoinOptions,
  type MatchRounds,
  type MoveMessage,
  type Player,
  type RoomMetadata,
  type RoomPhase,
  type Roster,
  type Snapshot,
  type TankInput,
  type Team,
  type TeamMessage,
} from "@tank/shared";

// Clients send about 60 input messages a second (more on 120 Hz screens); anything far
// beyond that is abuse.
const MAX_MESSAGES_PER_SECOND = 240;

const MAX_CATCH_UP_TICKS = 10; // after a stall, don't fast-forward more than this at once
// TICK_STATS=1 logs how long ticks take (sim + snapshot), every STATS_EVERY_MS.
const TICK_STATS = process.env.TICK_STATS === "1";
const STATS_EVERY_MS = 5000;

// One room. It starts in the lobby: players pick (or are moved to) a team and the host
// starts the match. During the match teams are locked and the shared sim runs at 60 Hz;
// the server is the only one who decides what happens. When the match is over everyone
// is back in the lobby.
export class GameRoom extends Room {
  maxClients = MAX_PLAYERS;
  maxMessagesPerSecond = MAX_MESSAGES_PER_SECOND;

  private phase: RoomPhase = "lobby";
  private hostId: string | null = null;
  private rounds: MatchRounds = 1;
  private maps: string[] = roundMaps(1);
  private sim = createMatchState(1);
  private queues = new Map<string, InputQueue>(); // per player: button samples, one per tick
  private players = new Map<string, Player>(); // in join order
  private pendingEvents: GameEvent[] = [];
  private accMs = 0;
  private stats = { ticks: 0, totalMs: 0, maxMs: 0, catchUps: 0, since: performance.now() };

  async onCreate(options: Partial<CreateOptions> = {}) {
    this.roomId = await this.freeRoomCode();
    // Match type and a map per round, as picked by the room's creator (bad picks are
    // replaced with valid ones).
    this.rounds = isMatchRounds(options.rounds) ? options.rounds : 1;
    this.maps = roundMaps(this.rounds, Array.isArray(options.maps) ? options.maps : undefined);

    this.onMessage(MSG.input, (client: Client, message: InputMessage) => {
      const queue = this.queues.get(client.sessionId);
      if (!queue || !Array.isArray(message)) return;
      queue.push(message.slice(0, MAX_FRAMES_PER_MESSAGE));
    });
    this.onMessage(MSG.ready, (client: Client) => client.send(MSG.roster, this.roster()));
    this.onMessage(MSG.team, (client: Client, message: TeamMessage) => {
      this.setTeam(client.sessionId, message?.team);
    });
    this.onMessage(MSG.move, (client: Client, message: MoveMessage) => {
      if (client.sessionId !== this.hostId || typeof message?.playerId !== "string") return;
      this.setTeam(message.playerId, message.team);
    });
    this.onMessage(MSG.start, (client: Client) => {
      if (client.sessionId === this.hostId) this.startMatch();
    });

    this.setSimulationInterval((deltaMs) => this.update(deltaMs), TICK_MS);
    this.publishRoster();
  }

  onJoin(client: Client, options: Partial<JoinOptions> = {}) {
    const team = isTeam(options.team) ? options.team : "red";
    const player: Player = { id: client.sessionId, name: cleanName(options.name), team, away: false };
    this.players.set(client.sessionId, player);
    this.hostId ??= client.sessionId;
    // Joining mid-match: straight onto the picked team.
    if (this.phase === "playing") this.addSoldier(player);
    this.sendRoster();
    console.log(`${player.name} (${team}) joined ${this.roomId} ${this.phase === "playing" ? "mid-match" : "lobby"}, ${this.players.size} player(s)`);
  }

  // Connection lost without leaving (refresh, network blip): hold the seat. The soldier
  // stays where it is with the button released.
  onDrop(client: Client) {
    const player = this.players.get(client.sessionId);
    if (!player) return;
    player.away = true;
    if (this.queues.has(client.sessionId)) this.queues.set(client.sessionId, new InputQueue());
    this.sendRoster();
    this.allowReconnection(client, RECONNECT_SECONDS);
    console.log(`${player.name} dropped from ${this.roomId}, holding the seat for ${RECONNECT_SECONDS} s`);
  }

  onReconnect(client: Client) {
    const player = this.players.get(client.sessionId);
    if (!player) return;
    player.away = false;
    // A reloaded page numbers its button samples from 1 again.
    if (this.queues.has(client.sessionId)) this.queues.set(client.sessionId, new InputQueue());
    this.sendRoster();
    console.log(`${player.name} reconnected to ${this.roomId}`);
  }

  // Left for good: chose to leave, or didn't come back in time.
  onLeave(client: Client) {
    const player = this.players.get(client.sessionId);
    this.players.delete(client.sessionId);
    this.queues.delete(client.sessionId);
    removeTank(this.sim, client.sessionId);
    if (this.hostId === client.sessionId) this.hostId = this.players.keys().next().value ?? null;
    this.sendRoster();
    console.log(`${player?.name ?? client.sessionId} left ${this.roomId}, ${this.players.size} player(s)`);
  }

  // Lobby only: teams are locked during a match.
  private setTeam(playerId: string, team: unknown) {
    const player = this.players.get(playerId);
    if (this.phase !== "lobby" || !player || !isTeam(team) || player.team === team) return;
    player.team = team as Team;
    this.sendRoster();
  }

  private startMatch() {
    if (this.phase !== "lobby" || !canStart(this.roster())) return;
    this.sim = createMatchState(this.rounds, this.maps);
    this.queues.clear();
    this.pendingEvents = [];
    this.accMs = 0;
    for (const player of this.players.values()) this.addSoldier(player);
    this.phase = "playing";
    this.sendRoster();
    console.log(`${this.roomId}: match started with ${this.players.size} player(s)`);
  }

  private addSoldier(player: Player) {
    addTank(this.sim, getMap(this.sim.mapId), player.id, player.team);
    this.queues.set(player.id, new InputQueue());
  }

  private endMatch() {
    this.phase = "lobby";
    this.queues.clear();
    this.sendRoster();
    console.log(`${this.roomId}: match over, back to the lobby`);
  }

  // Fixed-step loop: timers are not exactly 16.67 ms, so step as many ticks as real time
  // allows and keep the remainder.
  private update(deltaMs: number) {
    if (this.phase !== "playing") return;
    this.accMs += deltaMs;
    let steps = 0;
    while (this.accMs >= TICK_MS && steps < MAX_CATCH_UP_TICKS && this.phase === "playing") {
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
    // The final banner of the match is showing: when it ends, go back to the lobby
    // instead of letting the sim start a new match by itself.
    const finalBanner = this.sim.winner !== null && this.sim.match.round >= this.sim.match.rounds;
    const inputs: Record<string, TankInput> = {};
    for (const [id, queue] of this.queues) inputs[id] = queue.next();
    step(this.sim, getMap(this.sim.mapId), inputs, { holdMs: DEFAULT_HOLD_MS });
    if (finalBanner && this.sim.winner === null) {
      this.endMatch();
      return;
    }
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
    return {
      players: [...this.players.values()].map((p) => ({ ...p })),
      hostId: this.hostId,
      phase: this.phase,
      rounds: this.rounds,
      maps: this.maps,
    };
  }

  // Players in the room see it via a message; people about to join read it from the
  // room's listing metadata (see the /rooms/:code route).
  private sendRoster() {
    this.broadcast(MSG.roster, this.roster());
    this.publishRoster();
  }

  private publishRoster() {
    const metadata: RoomMetadata = this.roster();
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
