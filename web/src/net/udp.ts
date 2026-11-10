import type { Room } from "@colyseus/sdk";
import { MSG, UDP_CHANNEL_LABEL, UDP_OPEN_TIMEOUT_MS, parseRtcSignal, type ClientNet, type RtcSignal } from "@tank/shared";

// The browser's end of the UDP game channel (docs/NETCODE.md, "UDP game channel"): a WebRTC
// data channel to the game server, unordered and without retransmits, so a lost packet
// never holds up the next snapshot or tap the way it does on the WebSocket (TCP). The server
// makes the offer when we say hello; we answer. Owned by the session (like voice), so it
// lives from the lobby into the match and back.
//
// The game falls back to the WebSocket by itself (that's ClientNet): if this browser has no
// RTCPeerConnection, if the channel isn't open within UDP_OPEN_TIMEOUT_MS, or if it closes
// or goes quiet. It tries again later (RETRY_MS), then gives up for the session.
export interface UdpChannel {
  restart(): void; // after the room reconnected: a new channel
  // The channel closed or went quiet (called by ClientNet): back to the WebSocket, retry later.
  dead(reason: string): void;
  dispose(): void;
}

const RETRY_MS = [10_000, 30_000, 60_000, 120_000];
const POLL_MS = 100;
const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

function udpAllowed(): boolean {
  if (typeof RTCPeerConnection === "undefined") return false;
  // Dev only: ?udp=0 keeps the game on the WebSocket (remembered for the tab).
  if (process.env.NODE_ENV !== "production") {
    try {
      const flag = new URLSearchParams(location.search).get("udp");
      if (flag !== null) sessionStorage.setItem("tank-ctf:udp", flag);
      if (sessionStorage.getItem("tank-ctf:udp") === "0") return false;
    } catch {
      // Storage blocked: the default.
    }
  }
  return true;
}

export function createUdpChannel(room: Room, net: ClientNet): UdpChannel {
  let pc: RTCPeerConnection | null = null;
  let dc: RTCDataChannel | null = null;
  let peerId = -1;
  let remoteSet = false;
  let early: { candidate: string; mid: string }[] = []; // candidates before the offer was set
  let openTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0;
  let disposed = false;
  const poller = setInterval(() => net.poll(), POLL_MS);

  const send = (signal: RtcSignal) => {
    try {
      room.send(MSG.rtc, signal);
    } catch {
      // The room is closing.
    }
  };

  function closePeer() {
    const oldPc = pc;
    const oldDc = dc;
    pc = null;
    dc = null;
    remoteSet = false;
    early = [];
    if (openTimer) clearTimeout(openTimer);
    openTimer = null;
    try {
      oldDc?.close();
    } catch {}
    try {
      oldPc?.close();
    } catch {}
  }

  function start() {
    if (disposed || !udpAllowed()) return;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    closePeer();
    attempts++;
    send({ kind: "hello" });
    // No offer, or no open channel, in time: stay on the WebSocket.
    openTimer = setTimeout(() => fail("not open in time", true), UDP_OPEN_TIMEOUT_MS);
  }

  function fail(reason: string, tell: boolean) {
    if (disposed) return;
    if (process.env.NODE_ENV !== "production") console.info(`udp: back to WebSocket (${reason})`);
    const id = peerId;
    net.channelClosed();
    closePeer();
    if (tell && id >= 0) send({ kind: "close", id });
    if (!retryTimer && attempts <= RETRY_MS.length) retryTimer = setTimeout(start, RETRY_MS[attempts - 1] ?? 120_000);
  }

  async function onOffer(id: number, sdp: string) {
    closePeer();
    peerId = id;
    let conn: RTCPeerConnection;
    try {
      conn = pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    } catch {
      fail("no WebRTC", false);
      return;
    }
    openTimer = setTimeout(() => fail("not open in time", true), UDP_OPEN_TIMEOUT_MS);
    conn.onicecandidate = (e) => {
      if (e.candidate?.candidate && pc === conn) send({ kind: "cand", id, candidate: e.candidate.candidate, mid: e.candidate.sdpMid ?? "0" });
    };
    conn.onconnectionstatechange = () => {
      if (pc === conn && (conn.connectionState === "failed" || conn.connectionState === "closed")) fail(`connection ${conn.connectionState}`, true);
    };
    conn.ondatachannel = (e) => {
      const channel = e.channel;
      if (channel.label !== UDP_CHANNEL_LABEL || pc !== conn) return;
      dc = channel;
      channel.binaryType = "arraybuffer";
      channel.onmessage = (m) => {
        if (m.data instanceof ArrayBuffer) net.onUdpMessage(new Uint8Array(m.data));
      };
      channel.onclose = () => {
        if (dc === channel) fail("channel closed", true);
      };
      const opened = () => {
        if (dc !== channel) return;
        if (openTimer) clearTimeout(openTimer);
        openTimer = null;
        attempts = 0; // it works here: retry from the start of the schedule if it drops later
        net.channelOpened({
          send(bytes) {
            if (channel.readyState === "open") channel.send(bytes as Uint8Array<ArrayBuffer>);
          },
        });
      };
      if (channel.readyState === "open") opened();
      else channel.onopen = opened;
    };
    try {
      await conn.setRemoteDescription({ type: "offer", sdp });
      remoteSet = true;
      for (const c of early.splice(0)) await conn.addIceCandidate({ candidate: c.candidate, sdpMid: c.mid }).catch(() => {});
      const answer = await conn.createAnswer();
      await conn.setLocalDescription(answer);
      if (pc === conn && conn.localDescription) send({ kind: "answer", id, sdp: conn.localDescription.sdp });
    } catch (err) {
      if (pc === conn) fail(`bad offer: ${(err as Error).message}`, true);
    }
  }

  room.onMessage(MSG.rtc, (raw: unknown) => {
    const s = parseRtcSignal(raw);
    if (!s || disposed) return;
    if (s.kind === "offer") void onOffer(s.id, s.sdp);
    else if (s.kind === "cand" && s.id === peerId && pc) {
      if (!remoteSet) early.push({ candidate: s.candidate, mid: s.mid });
      else pc.addIceCandidate({ candidate: s.candidate, sdpMid: s.mid }).catch(() => {});
    } else if (s.kind === "close" && s.id === peerId && pc) fail("server closed it", false);
  });

  start();

  return {
    restart() {
      attempts = 0;
      net.channelClosed();
      start();
    },
    dead(reason) {
      fail(reason, true);
    },
    dispose() {
      disposed = true;
      clearInterval(poller);
      if (retryTimer) clearTimeout(retryTimer);
      const id = peerId;
      if (pc && id >= 0) send({ kind: "close", id });
      closePeer();
      net.channelClosed();
    },
  };
}
