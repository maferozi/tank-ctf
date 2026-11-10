import { MAX_FRAMES_PER_MESSAGE, SnapshotDecoder, type Snapshot, type SnapshotMessage } from "./net";
import type { InputFrame } from "./prediction";
import {
  InputSender,
  SnapshotFeed,
  UDP_KEEPALIVE_MS,
  UDP_MAX_SAMPLES,
  UDP_SILENT_MS,
  UdpSnapshotDecoder,
  decodeDown,
  encodeUp,
  type EventGroup,
} from "./udp";

// The client's side of the game traffic, whichever way it travels: the room's WebSocket, or
// the UDP channel when one is open (see udp.ts). Used by the browser (web/src/net/session.ts)
// and the test bots (server/src/botNet.ts); it knows nothing about WebRTC itself; the owner
// opens the channel, hands it over with `channelOpened`, and calls `poll` every ~100 ms.
//
// Switching either way loses nothing: inputs are kept until the server acks them and sent
// again on the new path (the server ignores ones it has), and snapshots from both paths go
// through one SnapshotFeed, so each tick and each event comes out once, in order.
export interface ClientChannel {
  send(bytes: Uint8Array): void;
}

export interface ClientNetHooks {
  sendInputWs(frames: InputFrame[]): void; // room.send(MSG.input, frames)
  requestKeyframeWs(): void; // room.send(MSG.keyframe)
  myId(): string;
  // The channel went quiet or closed: the owner should close it and tell the server.
  channelDead?(reason: string): void;
}

const KEYFRAME_RETRY_MS = 500; // a requested WebSocket keyframe should be the very next snapshot

export class ClientNet {
  readonly wsDecoder = new SnapshotDecoder();
  readonly udpDecoder = new UdpSnapshotDecoder();
  readonly feed = new SnapshotFeed();
  readonly sender = new InputSender();
  transport: "ws" | "udp" = "ws";
  private channel: ClientChannel | null = null;
  private listeners = new Set<(snap: Snapshot) => void>();
  private keyframeAskedAt = -Infinity;
  private lastUdpAt = -Infinity; // anything received on the channel
  private lastUpAt = -Infinity;
  private lastWsSnapAt = -Infinity;
  private openedAt = -Infinity;
  stats = { udpIn: 0, udpSnapshots: 0, wsSnapshots: 0, upSent: 0, fallbacks: 0, bytesIn: 0 };

  constructor(
    private hooks: ClientNetHooks,
    private now: () => number = () => performance.now(),
  ) {}

  onSnapshot(listener: (snap: Snapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // A snapshot from the WebSocket (MSG.snapshot).
  onWsMessage(msg: SnapshotMessage): void {
    this.lastWsSnapAt = this.now();
    const snap = this.wsDecoder.decode(msg);
    if (!snap) {
      const now = this.now();
      if (now - this.keyframeAskedAt > KEYFRAME_RETRY_MS) {
        this.keyframeAskedAt = now;
        this.hooks.requestKeyframeWs();
      }
      return;
    }
    this.keyframeAskedAt = -Infinity;
    this.stats.wsSnapshots++;
    if (msg.epoch !== undefined) this.udpDecoder.remember(msg.epoch, snap.state);
    const groups: EventGroup[] = msg.ev ?? [[snap.state.tick, msg.events]];
    this.deliver(this.feed.accept(msg.epoch, snap.state, groups, snap.acks));
  }

  // A message from the channel.
  onUdpMessage(bytes: Uint8Array): void {
    this.lastUdpAt = this.now();
    this.stats.udpIn++;
    this.stats.bytesIn += bytes.length;
    const msg = decodeDown(bytes);
    if (!msg) return; // a keepalive, or junk
    const d = this.udpDecoder.decode(msg);
    if (!d) return;
    this.stats.udpSnapshots++;
    this.deliver(this.feed.accept(d.epoch, d.state, d.groups, d.acks));
  }

  // Your button samples for this frame.
  sendInput(frames: InputFrame[]): void {
    this.sender.push(frames);
    if (this.channel) this.sendUp();
    else for (let i = 0; i < frames.length; i += MAX_FRAMES_PER_MESSAGE) this.hooks.sendInputWs(frames.slice(i, i + MAX_FRAMES_PER_MESSAGE));
  }

  channelOpened(channel: ClientChannel): void {
    this.channel = channel;
    this.transport = "udp";
    this.openedAt = this.lastUdpAt = this.now();
    this.sendUp(); // everything unacked, and our newest snapshot so deltas can start from it
  }

  // Back to the WebSocket (the channel closed, or went quiet). Samples the server may not
  // have yet go again over the WebSocket.
  channelClosed(): void {
    if (!this.channel) return;
    this.channel = null;
    this.transport = "ws";
    this.stats.fallbacks++;
    const unacked = this.sender.unacked;
    for (let i = 0; i < unacked.length; i += MAX_FRAMES_PER_MESSAGE) this.hooks.sendInputWs(unacked.slice(i, i + MAX_FRAMES_PER_MESSAGE));
  }

  // Call every ~100 ms: keepalive acks while no inputs flow (lobby, hidden tab), and the
  // check for a dead channel.
  poll(): void {
    if (!this.channel) return;
    const now = this.now();
    if (now - this.lastUdpAt > UDP_SILENT_MS && now - this.openedAt > UDP_SILENT_MS) {
      this.hooks.channelDead?.(`nothing on the channel for ${Math.round(now - this.lastUdpAt)} ms`);
      this.channelClosed();
      return;
    }
    if (now - this.lastUpAt >= UDP_KEEPALIVE_MS) this.sendUp();
  }

  // A new connection (the SDK reconnected): the server numbers nothing differently, but it
  // sends a WebSocket keyframe, and a reloaded page starts its samples from 1.
  reset(): void {
    this.wsDecoder.reset();
  }

  private sendUp(): void {
    if (!this.channel) return;
    this.lastUpAt = this.now();
    this.stats.upSent++;
    try {
      // All unacked samples; normally one message, more only after a long stall (a message
      // holds at most UDP_MAX_SAMPLES, and leaving the oldest out would lose them, taps too).
      const all = this.sender.unacked;
      for (let i = 0; i === 0 || i < all.length; i += UDP_MAX_SAMPLES) {
        this.channel.send(encodeUp({ ack: this.udpDecoder.newest, epoch: this.udpDecoder.epoch, samples: all.slice(i, i + UDP_MAX_SAMPLES) }));
      }
    } catch {
      // A closing channel: poll() notices and falls back.
    }
  }

  private deliver(snap: Snapshot | null): void {
    if (!snap) return;
    const ack = snap.acks[this.hooks.myId()];
    if (ack !== undefined) this.sender.ack(ack);
    this.listeners.forEach((l) => l(snap));
  }

  get lastWsSnapshotAt(): number {
    return this.lastWsSnapAt;
  }
}
