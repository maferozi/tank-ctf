import { Room, matchMaker, type Client } from "colyseus";
import {
  DEFAULT_HOLD_MS,
  DEFAULT_MAP,
  MAX_PLAYERS,
  MSG,
  SNAPSHOT_EVERY_TICKS,
  TICK_MS,
  addTank,
  cleanName,
  createState,
  isTeam,
  makeRoomCode,
  removeTank,
  step,
  type GameEvent,
  type InputMessage,
  type JoinOptions,
  type Player,
  type Roster,
  type Snapshot,
  type TankInput,
} from "@tank/shared";

const MAX_CATCH_UP_TICKS = 10; // after a stall, don't fast-forward more than this at once

// One match. Runs the shared sim at 60 Hz with every player's button state and sends
// snapshots to all players. The server is the only one who decides what happens.
export class GameRoom extends Room {
  maxClients = MAX_PLAYERS;

  private map = DEFAULT_MAP;
  private sim = createState(DEFAULT_MAP);
  private buttons = new Map<string, TankInput>();
  private players = new Map<string, Player>();
  private pendingEvents: GameEvent[] = [];
  private accMs = 0;

  async onCreate() {
    this.roomId = await this.freeRoomCode();

    this.onMessage(MSG.input, (client: Client, message: InputMessage) => {
      const input = this.buttons.get(client.sessionId);
      if (!input || typeof message !== "object" || message === null) return;
      const held = message.held === true;
      // Latch presses until the next tick, so a tap that starts and ends between two
      // ticks still fires.
      if (message.pressed === true || (held && !input.held)) input.pressed = true;
      input.held = held;
    });

    this.onMessage(MSG.ready, (client: Client) => client.send(MSG.roster, this.roster()));

    this.setSimulationInterval((deltaMs) => this.update(deltaMs), TICK_MS);
  }

  onJoin(client: Client, options: Partial<JoinOptions> = {}) {
    // Teams are picked by the player (phase 3 moves this into the lobby). No auto-balance.
    const team = isTeam(options.team) ? options.team : "red";
    const player: Player = { id: client.sessionId, name: cleanName(options.name), team };
    this.players.set(client.sessionId, player);
    this.buttons.set(client.sessionId, { held: false, pressed: false });
    addTank(this.sim, this.map, client.sessionId, team);
    this.sendRoster();
    console.log(`${player.name} (${team}) joined ${this.roomId}, ${this.players.size} player(s)`);
  }

  onLeave(client: Client) {
    const player = this.players.get(client.sessionId);
    this.players.delete(client.sessionId);
    this.buttons.delete(client.sessionId);
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
  }

  private tick() {
    step(this.sim, this.map, Object.fromEntries(this.buttons), { holdMs: DEFAULT_HOLD_MS });
    for (const input of this.buttons.values()) input.pressed = false;
    this.pendingEvents.push(...this.sim.events);

    if (this.sim.tick % SNAPSHOT_EVERY_TICKS === 0) {
      const { events: _lastStepEvents, ...state } = this.sim;
      const snapshot: Snapshot = { state, events: this.pendingEvents };
      this.broadcast(MSG.snapshot, snapshot);
      this.pendingEvents = [];
    }
  }

  private roster(): Roster {
    return { players: [...this.players.values()] };
  }

  private sendRoster() {
    this.broadcast(MSG.roster, this.roster());
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
