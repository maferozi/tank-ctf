import { Room, matchMaker, type Client } from "colyseus";
import {
  DEFAULT_HOLD_MS,
  InputQueue,
  RateLimiter,
  VOICE_BURST,
  VOICE_CONFIG_BURST,
  VOICE_CONFIG_PER_SECOND,
  VOICE_PER_SECOND,
  KEYFRAME_EVERY_SNAPSHOTS,
  MAX_FRAMES_PER_MESSAGE,
  MAX_REWIND_TICKS,
  MAX_PLAYERS,
  MSG,
  RECONNECT_SECONDS,
  SNAPSHOT_EVERY_TICKS,
  SnapshotHistory,
  UDP_IDLE_MS,
  buildDown,
  decodeUp,
  encodeDown,
  encodePing,
  newPeerState,
  notePeerAck,
  parseRtcSignal,
  TICK_MS,
  addTank,
  canStart,
  canVoice,
  cleanName,
  cloneDeep,
  createMatchState,
  diffState,
  getMap,
  isMatchRounds,
  isTeam,
  makeRoomCode,
  parseVoiceMessage,
  removeTank,
  roundMaps,
  step,
  type CreateOptions,
  type GameEvent,
  type InputMessage,
  type JoinOptions,
  type MatchRounds,
  type MoveMessage,
  type ShareVoiceMessage,
  type SimConfig,
  type Player,
  type RoomMetadata,
  type RoomPhase,
  type Roster,
  type SnapshotMessage,
  type SnapshotState,
  type TickInputs,
  type Team,
  type TeamMessage,
  type VoiceMessage,
  type StateDelta,
  type UdpPeerState,
} from "@tank/shared";
import { voiceConfig } from "./ice";
import { ServerUdpPeer, loadNdc, udpConfigFromEnv } from "./udp";

// The UDP game channel (see udp.ts): one per client that asks for it.
interface UdpLink {
  peer: ServerUdpPeer;
  state: UdpPeerState; // acks, keyframes, event floor (shared/src/udp.ts)
  lastRecv: number; // ms, last message from the client over the channel
  lastSent: number;
  active: boolean; // its snapshots go over the channel (not the WebSocket)
  count: number; // messages this second (rate limit)
  countResetAt: number;
}
const UDP_CONFIG = udpConfigFromEnv();
const UDP_PING_MS = 250; // keepalive while no snapshots flow
const RTC_BURST = 60; // signaling: offer/answer/candidates for a few attempts
const RTC_PER_SECOND = 5;

// Clients send about 60 input messages a second (more on 120 Hz screens); anything far
// beyond that is abuse.
const MAX_MESSAGES_PER_SECOND = 240;

const IDLE = { held: false, pressed: false };
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
  private queues = new Map<string, InputQueue>(); // per player: button samples, each applied once, in order
  private players = new Map<string, Player>(); // in join order
  private pendingEvents: GameEvent[] = [];
  // Snapshots go out as deltas against the previous one; `lastSent` is a copy of it.
  // Players in `needKeyframe` get the full state next (they just joined, came back, or
  // asked because a delta didn't fit).
  private lastSent: SnapshotState | null = null;
  private snapshotsSinceKeyframe = 0;
  private needKeyframe = new Set<string>();
  private voiceLimits = new Map<string, RateLimiter>(); // per player: MSG.voice rate
  private configLimits = new Map<string, RateLimiter>(); // per player: MSG.voiceConfig requests
  // UDP channel: recent snapshots and events (every client's deltas and event resends come
  // from here), the links, and per client the last snapshot tick it got over the WebSocket.
  private history = new SnapshotHistory();
  private udp = new Map<string, UdpLink>();
  private nextPeerId = 1;
  private rtcLimits = new Map<string, RateLimiter>();
  private wsLastTick = new Map<string, number>();
  private resumeFrom = new Map<string, number>(); // back from the channel: resend events after this tick
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
      if (!queue || !Array.isArray(message)) return; // InputQueue.push skips malformed frames
      queue.push(message.slice(0, MAX_FRAMES_PER_MESSAGE));
    });
    this.onMessage(MSG.ready, (client: Client) => client.send(MSG.roster, this.roster()));
    this.onMessage(MSG.keyframe, (client: Client) => this.needKeyframe.add(client.sessionId));
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
    // Each player may let the other team hear them in the match (off by default). Every
    // client sees it in the roster and adjusts voice; the relay rule follows it at once.
    this.onMessage(MSG.shareVoice, (client: Client, message: ShareVoiceMessage) => {
      const player = this.players.get(client.sessionId);
      if (!player || typeof message?.on !== "boolean" || message.on === player.shareVoice) return;
      player.shareVoice = message.on;
      this.sendRoster();
    });
    this.onMessage(MSG.voice, (client: Client, message: unknown) => this.relayVoice(client, message));
    this.onMessage(MSG.voiceConfig, (client: Client) => this.requestVoiceConfig(client));
    this.onMessage(MSG.rtc, (client: Client, message: unknown) => this.onRtc(client, message));

    this.setSimulationInterval((deltaMs) => this.update(deltaMs), TICK_MS);
    this.publishRoster();
  }

  onJoin(client: Client, options: Partial<JoinOptions> = {}) {
    const team = isTeam(options.team) ? options.team : "red";
    const player: Player = { id: client.sessionId, name: cleanName(options.name), team, away: false, shareVoice: false };
    this.players.set(client.sessionId, player);
    this.hostId ??= client.sessionId;
    this.needKeyframe.add(client.sessionId);
    // Joining mid-match: straight onto the picked team.
    if (this.phase === "playing") this.addSoldier(player);
    this.sendRoster();
    this.sendVoiceConfig(client);
    console.log(`${player.name} (${team}) joined ${this.roomId} ${this.phase === "playing" ? "mid-match" : "lobby"}, ${this.players.size} player(s)`);
  }

  // Connection lost without leaving (refresh, network blip): hold the seat. The soldier
  // stays where it is with the button released.
  onDrop(client: Client) {
    const player = this.players.get(client.sessionId);
    if (!player) return;
    player.away = true;
    this.closeUdp(client.sessionId);
    if (this.queues.has(client.sessionId)) this.queues.set(client.sessionId, new InputQueue());
    this.sendRoster();
    this.allowReconnection(client, RECONNECT_SECONDS);
    console.log(`${player.name} dropped from ${this.roomId}, holding the seat for ${RECONNECT_SECONDS} s`);
  }

  onReconnect(client: Client) {
    const player = this.players.get(client.sessionId);
    if (!player) return;
    player.away = false;
    this.needKeyframe.add(client.sessionId);
    this.closeUdp(client.sessionId); // the client asks for a new channel
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
    this.needKeyframe.delete(client.sessionId);
    this.voiceLimits.delete(client.sessionId);
    this.configLimits.delete(client.sessionId);
    this.rtcLimits.delete(client.sessionId);
    this.closeUdp(client.sessionId);
    this.wsLastTick.delete(client.sessionId);
    this.resumeFrom.delete(client.sessionId);
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
    // A fresh seed per match, picked here outside the sim, so power-box timings and kinds
    // differ every game. It reaches the clients in the snapshots.
    this.sim = createMatchState(this.rounds, this.maps, (Math.random() * 0x7fffffff) | 0);
    this.positions.clear(); // a new match starts its ticks from 0 again
    this.history.reset(); // a new epoch: channel acks from the last match mean nothing now
    this.wsLastTick.clear();
    this.resumeFrom.clear();
    this.queues.clear();
    this.pendingEvents = [];
    this.lastSent = null; // everyone starts with a keyframe
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
    this.lastSent = null;
    this.sendRoster();
    console.log(`${this.roomId}: match over, back to the lobby`);
  }

  // Fixed-step loop: timers are not exactly 16.67 ms, so step as many ticks as real time
  // allows and keep the remainder.
  private update(deltaMs: number) {
    this.pingUdp();
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
    // Each player's soldier takes exactly the samples its player sent, in order: none on a
    // tick their next sample hasn't arrived (it waits), two while draining a backlog. A
    // player who dropped out stands with the button up (timers and respawn keep going).
    const inputs: TickInputs = {};
    for (const [id, queue] of this.queues) inputs[id] = this.players.get(id)?.away ? IDLE : queue.next();
    step(this.sim, getMap(this.sim.mapId), inputs, this.simConfig);
    this.recordPositions();
    if (finalBanner && this.sim.winner === null) {
      this.endMatch();
      return;
    }
    this.pendingEvents.push(...this.sim.events);

    if (this.sim.tick % SNAPSHOT_EVERY_TICKS === 0) {
      this.sendSnapshot();
      this.pendingEvents = [];
    }
    if (TICK_STATS) {
      const ms = performance.now() - start;
      this.stats.ticks++;
      this.stats.totalMs += ms;
      this.stats.maxMs = Math.max(this.stats.maxMs, ms);
    }
  }

  // A keyframe for everyone every KEYFRAME_EVERY_SNAPSHOTS and when the map changes;
  // otherwise one delta for everyone in sync, and keyframes for those who need one.
  // Clients on the UDP channel get their own message there instead (sendUdpSnapshots).
  private sendSnapshot() {
    const { events: _lastStepEvents, ...live } = this.sim;
    const state = cloneDeep(live);
    const acks = Object.fromEntries([...this.queues].map(([id, queue]) => [id, queue.ack]));
    const events = this.pendingEvents;
    const epoch = this.history.epoch;
    this.history.push(state, events);
    const onUdp = this.sendUdpSnapshots(acks);

    const base = this.lastSent;
    const keyframeDue = ++this.snapshotsSinceKeyframe >= KEYFRAME_EVERY_SNAPSHOTS;
    // diffState throws if the state's top-level fields changed (a new version of the
    // rules); a keyframe covers that too.
    let delta: SnapshotMessage | null = null;
    if (base && !keyframeDue && base.mapId === state.mapId) {
      try {
        delta = { base: base.tick, delta: diffState(base, state), events, acks, epoch };
      } catch {
        delta = null;
      }
    }
    const full: SnapshotMessage = { full: state, events, acks, epoch };
    // Back from the channel: a keyframe, with every event since what it acked there.
    const resumed = [...this.resumeFrom.keys()].flatMap((id) => this.clients.getById(id) ?? []).filter((c) => !onUdp.has(c));
    const special = new Set([...onUdp, ...resumed]);
    if (!delta) {
      this.broadcast(MSG.snapshot, full, { except: [...special] });
      this.snapshotsSinceKeyframe = 0;
    } else {
      const keyed = [...this.needKeyframe].flatMap((id) => this.clients.getById(id) ?? []).filter((c) => !special.has(c));
      this.broadcast(MSG.snapshot, delta, { except: [...special, ...keyed] });
      for (const client of keyed) client.send(MSG.snapshot, full);
    }
    for (const client of resumed) {
      const from = this.resumeFrom.get(client.sessionId)!;
      client.send(MSG.snapshot, { full: state, events: [], ev: this.history.eventsAfter(from), acks, epoch } satisfies SnapshotMessage);
      this.resumeFrom.delete(client.sessionId);
    }
    for (const client of this.clients) if (!onUdp.has(client)) this.wsLastTick.set(client.sessionId, state.tick);
    this.needKeyframe.clear();
    this.lastSent = state;
  }

  // ---- UDP game channel ----

  // Sends this snapshot to every client whose channel is live (it sent something within
  // UDP_IDLE_MS), each as a delta against what that client acked. Returns those clients.
  private sendUdpSnapshots(acks: Record<string, number>): Set<Client> {
    const out = new Set<Client>();
    if (this.udp.size === 0) return out;
    const now = performance.now();
    const cache = new Map<number, StateDelta | null>(); // clients with the same ack share a delta
    for (const [id, link] of this.udp) {
      const client = this.clients.getById(id);
      const live = !!client && link.peer.open && now - link.lastRecv < UDP_IDLE_MS && !this.players.get(id)?.away;
      if (live && !link.active) {
        link.active = true;
        // Events up to the last WebSocket snapshot already reached it.
        const ws = this.wsLastTick.get(id);
        if (ws !== undefined) {
          link.state.floor = ws;
          link.state.floorEpoch = this.history.epoch;
        }
      } else if (!live && link.active) {
        this.deactivate(id, link);
      }
      if (!link.active || !client) continue;
      try {
        const msg = buildDown(this.history, link.state, acks, now, cache);
        if (!msg) continue;
        link.peer.send(encodeDown(msg));
        link.lastSent = now;
        out.add(client);
      } catch (err) {
        console.warn("udp: snapshot failed", err);
        this.deactivate(id, link);
      }
    }
    return out;
  }

  // Back to the WebSocket: a keyframe there, with the events it may have missed.
  private deactivate(id: string, link: UdpLink) {
    if (!link.active) return;
    link.active = false;
    const s = link.state;
    const epoch = this.history.epoch;
    const from = Math.max(s.ackEpoch === epoch ? s.ack : -1, s.floorEpoch === epoch ? s.floor : -1);
    this.resumeFrom.set(id, from);
    this.needKeyframe.add(id);
  }

  private pingUdp() {
    if (this.udp.size === 0) return;
    const now = performance.now();
    for (const link of this.udp.values()) {
      if (link.peer.open && now - link.lastSent >= UDP_PING_MS) {
        link.peer.send(encodePing());
        link.lastSent = now;
      }
    }
  }

  private onRtc(client: Client, raw: unknown) {
    const id = client.sessionId;
    if (!this.players.has(id)) return;
    let limit = this.rtcLimits.get(id);
    if (!limit) this.rtcLimits.set(id, (limit = new RateLimiter(RTC_BURST, RTC_PER_SECOND)));
    if (!limit.take(performance.now())) return;
    const signal = parseRtcSignal(raw);
    if (!signal) return;
    if (signal.kind === "hello") void this.startUdp(client);
    else if (signal.kind === "close") {
      const link = this.udp.get(id);
      if (link?.peer.id === signal.id) this.closeUdp(id);
    } else this.udp.get(id)?.peer.handleSignal(signal);
  }

  private async startUdp(client: Client) {
    const id = client.sessionId;
    if (!UDP_CONFIG.enabled) return;
    const ndc = await loadNdc();
    if (!ndc || !this.clients.getById(id) || this.players.get(id)?.away) return;
    this.closeUdp(id);
    const peerId = this.nextPeerId++;
    const peer = new ServerUdpPeer(
      ndc,
      peerId,
      UDP_CONFIG,
      (signal) => this.clients.getById(id)?.send(MSG.rtc, signal),
      (bytes) => this.onUdpMessage(id, peerId, bytes),
      () => {
        const link = this.udp.get(id);
        if (link?.peer.id !== peerId) return;
        this.udp.delete(id);
        this.deactivate(id, link);
        this.clients.getById(id)?.send(MSG.rtc, { kind: "close", id: peerId });
      },
    );
    if (peer.closed) return;
    this.udp.set(id, { peer, state: newPeerState(), lastRecv: -Infinity, lastSent: -Infinity, active: false, count: 0, countResetAt: 0 });
  }

  private onUdpMessage(id: string, peerId: number, bytes: Uint8Array) {
    const link = this.udp.get(id);
    if (!link || link.peer.id !== peerId) return;
    const now = performance.now();
    if (now >= link.countResetAt) {
      link.count = 0;
      link.countResetAt = now + 1000;
    }
    if (++link.count > MAX_MESSAGES_PER_SECOND) return; // flood: drop, the WebSocket rule would kick
    const up = decodeUp(bytes);
    if (!up) return;
    link.lastRecv = now;
    notePeerAck(link.state, up);
    if (up.samples.length && !this.players.get(id)?.away) this.queues.get(id)?.push(up.samples);
  }

  private closeUdp(id: string) {
    const link = this.udp.get(id);
    if (!link) return;
    this.udp.delete(id);
    this.deactivate(id, link);
    link.peer.close();
  }

  onDispose() {
    for (const id of [...this.udp.keys()]) this.closeUdp(id);
  }

  // Voice chat signaling: passed on only between two players who may hear each other
  // right now (lobby: anyone in the room; match: same team). The sender is stamped here,
  // never taken from the message. Too big, malformed or too frequent messages are dropped.
  // Audio itself never comes through the server.
  private relayVoice(client: Client, raw: unknown) {
    const from = client.sessionId;
    if (!this.players.has(from)) return;
    let limit = this.voiceLimits.get(from);
    if (!limit) this.voiceLimits.set(from, (limit = new RateLimiter(VOICE_BURST, VOICE_PER_SECOND)));
    if (!limit.take(performance.now())) return;
    const message = parseVoiceMessage(raw);
    if (!message || !canVoice({ phase: this.phase, players: [...this.players.values()] }, from, message.to)) return;
    const target = this.clients.getById(message.to);
    if (!target) return;
    const out: VoiceMessage = { to: message.to, from, kind: message.kind, data: message.data };
    target.send(MSG.voice, out);
  }

  // Clients ask for the ICE config when theirs is about to expire or after a reconnect;
  // more often than that is cut.
  private requestVoiceConfig(client: Client) {
    let limit = this.configLimits.get(client.sessionId);
    if (!limit) this.configLimits.set(client.sessionId, (limit = new RateLimiter(VOICE_CONFIG_BURST, VOICE_CONFIG_PER_SECOND)));
    if (limit.take(performance.now())) this.sendVoiceConfig(client);
  }

  private sendVoiceConfig(client: Client) {
    void voiceConfig(client.sessionId).then((config) => {
      if (this.clients.getById(client.sessionId)) client.send(MSG.voiceConfig, config);
    });
  }

  // Lag compensation: where every living soldier was over the last MAX_REWIND_TICKS ticks
  // (500 ms), so a shot is checked against enemies where the shooter saw them: a press
  // carries `seen`, the server tick its screen drew the others at (see Bullet.rewind).
  private positions = new Map<number, Map<string, { x: number; y: number }>>();
  private readonly simConfig: SimConfig = {
    holdMs: DEFAULT_HOLD_MS,
    rewind: (id, tick) => this.positions.get(tick)?.get(id) ?? null,
  };

  private recordPositions() {
    const now = new Map<string, { x: number; y: number }>();
    for (const t of this.sim.tanks) if (t.alive) now.set(t.id, { x: t.x, y: t.y });
    this.positions.set(this.sim.tick, now);
    this.positions.delete(this.sim.tick - MAX_REWIND_TICKS - 1);
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
