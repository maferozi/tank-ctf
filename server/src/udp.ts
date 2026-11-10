// The server's end of the UDP game channel: one WebRTC peer connection per client with an
// unordered, no-retransmit data channel "game" (node-datachannel / libdatachannel). See
// docs/NETCODE.md, "UDP game channel". Nothing here may crash the room: every WebRTC call is
// guarded, and if the native module can't load, clients simply stay on the WebSocket.
//
// Env:
//   UDP_PORT_MIN / UDP_PORT_MAX  UDP ports for the channels (default 40000-40100); open them
//                                (UDP, inbound) in the firewall / security group.
//   UDP_STUN                     STUN server used to learn the public address (default
//                                stun:stun.l.google.com:19302; "off" to skip).
//   PUBLIC_IP                    also offer every host candidate with this address (for a server
//                                behind 1:1 NAT, like EC2, when STUN is blocked).
//   UDP_OFF=1                    turn the channel off (everyone on the WebSocket).
//   UDP_LOSS / UDP_DELAY_MS / UDP_JITTER_MS   testing only: drop / delay what the server sends.
import type { DataChannel, PeerConnection } from "node-datachannel";
import { UDP_CHANNEL_LABEL, shapedSend, type LinkShaping, type RtcSignal } from "@tank/shared";

type Ndc = typeof import("node-datachannel").default;
let loading: Promise<Ndc | null> | null = null;

// node-datachannel is a native module; if it is missing or broken, the channel is off.
export function loadNdc(): Promise<Ndc | null> {
  loading ??= import("node-datachannel")
    .then((m) => {
      const ndc = (m.default ?? m) as Ndc;
      try {
        ndc.initLogger("Error", (level, message) => console.warn(`udp (libdatachannel ${level}): ${message}`));
      } catch {}
      return ndc;
    })
    .catch((err) => {
      console.warn(`udp: node-datachannel unavailable, game stays on WebSocket (${(err as Error).message})`);
      return null;
    });
  return loading;
}

export interface UdpConfig {
  enabled: boolean;
  portMin: number;
  portMax: number;
  iceServers: string[];
  publicIp: string | null;
  shaping: LinkShaping | null;
}

const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);

export function shapingFromEnv(env = process.env): LinkShaping | null {
  const s = { loss: num(env.UDP_LOSS, 0), delayMs: num(env.UDP_DELAY_MS, 0), jitterMs: num(env.UDP_JITTER_MS, 0) };
  return s.loss > 0 || s.delayMs > 0 || s.jitterMs > 0 ? s : null;
}

export function udpConfigFromEnv(env = process.env): UdpConfig {
  const stun = env.UDP_STUN ?? "stun:stun.l.google.com:19302";
  return {
    enabled: env.UDP_OFF !== "1",
    portMin: num(env.UDP_PORT_MIN, 40000),
    portMax: num(env.UDP_PORT_MAX, 40100),
    iceServers: stun === "off" ? [] : [stun],
    publicIp: env.PUBLIC_IP?.trim() || null,
    shaping: shapingFromEnv(env),
  };
}

// "a=candidate:1 1 UDP 2114977791 172.31.5.6 40007 typ host" -> the same with PUBLIC_IP, as
// an extra candidate (a lower foundation-unique id so both are kept).
export function publicCandidate(candidate: string, publicIp: string): string | null {
  const parts = candidate.replace(/^a=/, "").split(" ");
  // candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type>
  if (parts.length < 8 || parts[6] !== "typ" || parts[7] !== "host" || parts[4] === publicIp) return null;
  parts[0] = `${parts[0]}9`; // a different foundation
  parts[3] = String(Math.max(1, Number(parts[3]) - 1));
  parts[4] = publicIp;
  return parts.join(" ");
}

// One client's channel, server side. The server makes the offer.
export class ServerUdpPeer {
  open = false;
  closed = false;
  private pc: PeerConnection | null = null;
  private dc: DataChannel | null = null;
  bytesOut = 0;
  messagesOut = 0;

  constructor(
    ndc: Ndc,
    readonly id: number,
    private config: UdpConfig,
    private signal: (s: RtcSignal) => void,
    private onMessage: (bytes: Uint8Array) => void,
    private onClose: () => void,
  ) {
    try {
      const pc = (this.pc = new ndc.PeerConnection(`game-${id}`, {
        iceServers: config.iceServers,
        portRangeBegin: config.portMin,
        portRangeEnd: config.portMax,
      }));
      pc.onLocalDescription((sdp, type) => {
        if (type === "offer") this.safeSignal({ kind: "offer", id, sdp });
      });
      pc.onLocalCandidate((candidate, mid) => {
        const c = candidate.replace(/^a=/, "");
        this.safeSignal({ kind: "cand", id, candidate: c, mid });
        const pub = config.publicIp ? publicCandidate(c, config.publicIp) : null;
        if (pub) this.safeSignal({ kind: "cand", id, candidate: pub, mid });
      });
      pc.onStateChange((state) => {
        if (state === "failed" || state === "closed") this.close();
      });
      const dc = (this.dc = pc.createDataChannel(UDP_CHANNEL_LABEL, { unordered: true, maxRetransmits: 0 }));
      dc.onOpen(() => {
        this.open = true;
      });
      dc.onClosed(() => this.close());
      dc.onError(() => this.close());
      dc.onMessage((msg) => {
        if (typeof msg === "string" || this.closed) return;
        try {
          this.onMessage(msg instanceof ArrayBuffer ? new Uint8Array(msg) : new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength));
        } catch (err) {
          console.warn("udp: message handler failed", err);
        }
      });
    } catch (err) {
      console.warn("udp: could not create a peer connection", err);
      queueMicrotask(() => this.close());
    }
  }

  handleSignal(s: RtcSignal): void {
    if (this.closed || !this.pc || !("id" in s) || s.id !== this.id) return;
    try {
      if (s.kind === "answer") this.pc.setRemoteDescription(s.sdp, "answer");
      else if (s.kind === "cand") this.pc.addRemoteCandidate(s.candidate, s.mid);
    } catch (err) {
      console.warn(`udp: bad ${s.kind} from client`, (err as Error).message);
    }
  }

  send(bytes: Uint8Array): void {
    if (!this.open || this.closed) return;
    this.messagesOut++;
    this.bytesOut += bytes.length;
    shapedSend(this.config.shaping, () => {
      if (!this.open || this.closed || !this.dc) return;
      try {
        // Don't let SCTP queue up behind a stalled path: old snapshots are worthless.
        if (this.dc.bufferedAmount() < 64 * 1024) this.dc.sendMessageBinary(bytes);
      } catch {
        this.close();
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    const { dc, pc } = this;
    this.dc = this.pc = null;
    // Closing from inside one of its own callbacks is not allowed; do it on the next turn.
    setTimeout(() => {
      try {
        dc?.close();
      } catch {}
      try {
        pc?.close();
      } catch {}
    }, 0);
    try {
      this.onClose();
    } catch {}
  }

  private safeSignal(s: RtcSignal): void {
    if (this.closed) return;
    try {
      this.signal(s);
    } catch {}
  }
}
