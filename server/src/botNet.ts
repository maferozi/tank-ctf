// A test bot's game traffic, the way the web client does it (shared ClientNet): over the
// WebSocket, or with TRANSPORT=udp over the UDP channel (node-datachannel standing in for
// the browser's RTCPeerConnection), falling back to the WebSocket if it doesn't open.
// UDP_LOSS / UDP_DELAY_MS / UDP_JITTER_MS shape what the bot sends (the server shapes what it
// sends with the same variables), for testing loss without root.
import type { Room } from "@colyseus/sdk";
import type { DataChannel, PeerConnection } from "node-datachannel";
import {
  ClientNet,
  MSG,
  UDP_CHANNEL_LABEL,
  UDP_OPEN_TIMEOUT_MS,
  parseRtcSignal,
  shapedSend,
  type InputFrame,
  type RtcSignal,
  type Snapshot,
  type SnapshotMessage,
} from "@tank/shared";
import { loadNdc, shapingFromEnv } from "./udp";

export type Transport = "ws" | "udp";
export const TRANSPORT: Transport = process.env.TRANSPORT === "udp" ? "udp" : "ws";

export class BotNet {
  readonly net: ClientNet;
  private pc: PeerConnection | null = null;
  private dc: DataChannel | null = null;
  private peerId = -1;
  private poller: ReturnType<typeof setInterval>;
  private shaping = shapingFromEnv();
  private openWaiters: ((ok: boolean) => void)[] = [];
  closed = false;

  constructor(
    readonly room: Room,
    readonly transport: Transport = TRANSPORT,
  ) {
    this.net = new ClientNet({
      sendInputWs: (frames) => room.send(MSG.input, frames),
      requestKeyframeWs: () => room.send(MSG.keyframe),
      myId: () => room.sessionId,
      channelDead: () => this.closeChannel(true),
    });
    room.onMessage(MSG.snapshot, (msg: SnapshotMessage) => this.net.onWsMessage(msg));
    room.onMessage(MSG.rtc, (raw: unknown) => {
      const s = parseRtcSignal(raw);
      if (s) void this.onSignal(s);
    });
    this.poller = setInterval(() => this.net.poll(), 100);
    if (transport === "udp") room.send(MSG.rtc, { kind: "hello" } satisfies RtcSignal);
  }

  onSnapshot(listener: (snap: Snapshot) => void): () => void {
    return this.net.onSnapshot(listener);
  }

  sendInput(frames: InputFrame[]): void {
    this.net.sendInput(frames);
  }

  // Resolves true once the channel is open (false after UDP_OPEN_TIMEOUT_MS, or for ws).
  waitOpen(ms = UDP_OPEN_TIMEOUT_MS): Promise<boolean> {
    if (this.transport === "ws") return Promise.resolve(false);
    if (this.net.transport === "udp") return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      this.openWaiters.push((ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
    });
  }

  private async onSignal(s: RtcSignal) {
    if (this.closed) return;
    if (s.kind === "offer") {
      const ndc = await loadNdc();
      if (!ndc) return;
      this.closeChannel(false);
      this.peerId = s.id;
      const id = s.id;
      const pc = (this.pc = new ndc.PeerConnection(`bot-${this.room.sessionId}`, { iceServers: [] }));
      pc.onLocalDescription((sdp, type) => {
        if (type === "answer") this.room.send(MSG.rtc, { kind: "answer", id, sdp } satisfies RtcSignal);
      });
      pc.onLocalCandidate((candidate, mid) => {
        this.room.send(MSG.rtc, { kind: "cand", id, candidate: candidate.replace(/^a=/, ""), mid } satisfies RtcSignal);
      });
      pc.onDataChannel((dc) => {
        if (dc.getLabel() !== UDP_CHANNEL_LABEL || this.pc !== pc) return;
        this.dc = dc;
        dc.onMessage((m) => {
          if (typeof m === "string") return;
          this.net.onUdpMessage(m instanceof ArrayBuffer ? new Uint8Array(m) : new Uint8Array(m.buffer, m.byteOffset, m.byteLength));
        });
        dc.onClosed(() => {
          if (this.dc === dc) this.closeChannel(true);
        });
        const open = () => {
          this.net.channelOpened({
            send: (bytes) =>
              shapedSend(this.shaping, () => {
                try {
                  if (this.dc === dc && dc.isOpen()) dc.sendMessageBinary(bytes);
                } catch {}
              }),
          });
          this.openWaiters.splice(0).forEach((w) => w(true));
        };
        if (dc.isOpen()) open();
        else dc.onOpen(open);
      });
      try {
        pc.setRemoteDescription(s.sdp, "offer");
      } catch {
        this.closeChannel(true);
      }
    } else if (s.kind === "cand" && s.id === this.peerId) {
      try {
        this.pc?.addRemoteCandidate(s.candidate, s.mid);
      } catch {}
    } else if (s.kind === "close" && s.id === this.peerId) {
      this.closeChannel(false);
    }
  }

  // Back to the WebSocket. `tell`: let the server know we stopped using it.
  closeChannel(tell: boolean): void {
    const { pc, dc } = this;
    if (!pc) return;
    this.pc = null;
    this.dc = null;
    this.net.channelClosed();
    if (tell) {
      try {
        this.room.send(MSG.rtc, { kind: "close", id: this.peerId } satisfies RtcSignal);
      } catch {}
    }
    setTimeout(() => {
      try {
        dc?.close();
      } catch {}
      try {
        pc.close();
      } catch {}
    }, 0);
  }

  dispose(): void {
    this.closed = true;
    clearInterval(this.poller);
    this.closeChannel(false);
  }
}
