import type { Room } from "@colyseus/sdk";
import {
  MSG,
  VOICE_MAX_BITRATE,
  isPolite,
  tuneOpusSdp,
  voicePeers,
  canHear,
  type Roster,
  type VoiceConfig,
  type VoiceData,
  type VoiceKind,
  type VoiceMessage,
} from "@tank/shared";

// Voice chat: a mesh of peer-to-peer WebRTC audio connections, one per player you can hear
// (lobby: everyone in the room; match: your own team). Owned by the session, so it lives as
// long as the room connection, across page navigation. Signaling goes through the game
// room (MSG.voice); audio goes straight between browsers, encrypted (DTLS-SRTP), or through
// a TURN relay when a direct path can't be found. See docs/VOICE.md.
//
// Nothing here runs per frame: the game only reads `speaking`, a set updated ~10 times a
// second by a timer.

export type MicState = "idle" | "starting" | "on" | "blocked";

export interface VoiceChat {
  readonly selfId: string; // your player id
  readonly speaking: ReadonlySet<string>; // player ids talking right now (you included)
  readonly mic: MicState; // idle until the first tap in the room
  readonly micError: string; // why the mic is blocked
  readonly muted: boolean;
  readonly connecting: boolean; // a voice connection is being set up (first try, not yet connected)
  readonly peers: number; // players you have a voice connection with (or are setting one up)
  readonly unavailable: string; // why voice chat can't run in this browser ("" if it can)
  readonly needsTap: boolean; // the browser blocked playback: a tap is needed to hear others
  readonly showHint: boolean; // "use headphones", once, after the first tap
  readonly sharing: boolean; // your voice also goes to the other team in a match (your choice)
  readonly version: number; // changes whenever anything above does
  subscribe(listener: () => void): () => void;
  start(): void; // from a user gesture: turns the mic on and unlocks audio playback
  setMuted(muted: boolean): void;
  setSharing(on: boolean): void; // let the other team hear you in the match (off by default)
  retryMic(): void; // after "Mic blocked": ask again (e.g. once it's allowed in the browser)
  dismissHint(): void;
  hintShown(): void; // the hint is on screen: remember it, hide it after a while
  setRoster(roster: Roster): void;
  reconnected(): void; // the room connection came back after a blip
  dispose(): void; // stop the mic, close every connection
}

const MUTE_KEY = "tank-ctf:mic-muted";
const HINT_KEY = "tank-ctf:voice-hint-seen";
const HINT_MS = 9000;

const DEFAULT_CONFIG: VoiceConfig = {
  iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] }],
  relay: null,
  refreshMs: 6 * 3600_000,
};
const CONFIG_WAIT_MS = 3000; // then go ahead with STUN only

const SPEAK_POLL_MS = 100;
const SPEAK_LEVEL = 0.012; // RMS of the waveform (-1..1) that counts as talking
const SPEAK_HOLD_MS = 350; // stay "speaking" through short pauses between words
const FFT_SIZE = 512;

const POLITE_WAIT_MS = 2500; // polite side: no offer by then -> ask the other side to start
const BYE_RECONNECT_MS = 1000;
// A connection that isn't up by then (a lost offer or answer, ICE that never finishes) is
// started again from scratch; the wait doubles with each try that fails, up to the max.
const NEGOTIATE_DEADLINE_MS = 12_000;
const NEGOTIATE_DEADLINE_MAX_MS = 60_000;
const POLITE_DEADLINE_EXTRA_MS = 4000;
// The other side may replace our connection with a fresh one (or hang up and have us start
// one) at most this often; more is ignored (a misbehaving peer could otherwise make us
// build and tear down connections as fast as the server relays its messages).
const FRESH_MIN_MS = 3000;
const DISCONNECTED_RESTART_MS = 4000;
const MAX_ICE_RESTARTS = 2; // then the impolite side starts a fresh connection
const STATS_MS = 2000;
// Outgoing signaling pace (see send()); well inside the server's VOICE_BURST/VOICE_PER_SECOND.
const SEND_BURST = 60;
const SEND_PER_SECOND = 60;
const MAX_QUEUED_CANDIDATES = 400;

interface Meter {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  buf: Float32Array<ArrayBuffer>;
  loudAt: number;
  level: number; // last RMS read (dev stats)
}

interface Peer {
  id: string;
  polite: boolean;
  pc: RTCPeerConnection;
  epoch: number | null; // null: polite side waiting for the first offer
  makingOffer: boolean;
  ignoreOffer: boolean;
  chain: Promise<void>; // signaling for this peer, one step at a time
  sender: RTCRtpSender | null;
  audio: HTMLAudioElement | null;
  stream: MediaStream | null;
  meter: Meter | null;
  restarts: number;
  bitrateCapped: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  deadline: ReturnType<typeof setTimeout> | null; // see NEGOTIATE_DEADLINE_MS
  closed: boolean;
}

interface PeerStats {
  connectionState: RTCPeerConnectionState;
  bytesSent: number;
  bytesReceived: number;
  relay: boolean | null; // null until a path is picked
  rttMs: number | null;
  level: number | null; // loudness heard from this player (RMS), null: no meter
  playing: boolean; // their <audio> element is playing
}

declare global {
  interface Window {
    __voice?: unknown;
  }
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch {
    // Storage blocked: the setting lasts for this page only.
  }
}

export function createVoiceChat(room: Room): VoiceChat {
  return new Voice(room);
}

class Voice implements VoiceChat {
  readonly speaking = new Set<string>();
  mic: MicState = "idle";
  micError = "";
  muted = readFlag(MUTE_KEY);
  unavailable = "";
  needsTap = false;
  showHint = false;
  version = 0;

  private readonly me: string;
  private listeners = new Set<() => void>();
  private peersById = new Map<string, Peer>();
  private wanted = new Set<string>();
  private lastEpoch = new Map<string, number>();
  private freshAt = new Map<string, number>(); // when the other side last replaced our connection
  private failures = new Map<string, number>(); // connection deadlines missed in a row, per player
  private audioById = new Map<string, HTMLAudioElement>(); // kept across reconnects (iOS unlocks per element)
  private roster: Roster | null = null;
  private config: VoiceConfig | null = null;
  private pending: VoiceMessage[] = [];
  private micStream: MediaStream | null = null;
  private micTrack: MediaStreamTrack | null = null;
  private localMeter: Meter | null = null;
  private ctx: AudioContext | null = null;
  private speakTimer: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private urgentQueue: VoiceMessage[] = []; // offers, answers, byes waiting to be sent
  private candidateQueue: VoiceMessage[] = []; // ICE candidates waiting to be sent
  private sendTokens = SEND_BURST;
  private sendRefilledAt = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private hintTimer: ReturnType<typeof setTimeout> | null = null;
  private gestureArmed = false;
  private disposed = false;
  private stats: Record<string, PeerStats> = {};

  constructor(private readonly room: Room) {
    this.me = room.sessionId;
    room.onMessage(MSG.voice, (msg: VoiceMessage) => this.onSignal(msg));
    room.onMessage(MSG.voiceConfig, (config: VoiceConfig) => this.onConfig(config));
    room.send(MSG.voiceConfig); // the one sent on join may have arrived before this listener
    this.later(CONFIG_WAIT_MS, () => {
      if (!this.config) this.onConfig(DEFAULT_CONFIG);
    });
    if (typeof RTCPeerConnection !== "function") this.unavailable = "Voice chat isn't supported in this browser";
    this.armGesture();
    window.addEventListener("pagehide", this.onPageHide);
    window.addEventListener("pageshow", this.onPageShow);
    if (process.env.NODE_ENV !== "production") {
      this.statsTimer = setInterval(() => void this.collectStats(), STATS_MS);
      this.publishStats();
    }
  }

  // Only a first try counts: a player whose connection keeps failing (a strict network and
  // no TURN) must not leave the chip on "Connecting" for the whole session.
  get connecting(): boolean {
    if (this.mic === "starting") return true;
    for (const peer of this.peersById.values()) {
      if (peer.pc.connectionState !== "connected" && !this.failures.get(peer.id)) return true;
    }
    return false;
  }

  get selfId(): string {
    return this.me;
  }

  get peers(): number {
    return this.peersById.size;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private notify(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  // ---- Mic and audio playback ----

  start(): void {
    if (this.disposed) return;
    this.unlockAudio();
    if (this.unavailable) return;
    if (this.mic === "idle") void this.startMic();
    if (!readFlag(HINT_KEY) && !this.showHint) {
      this.showHint = true; // remembered once the chip actually shows it (hintShown)
      this.notify();
    }
  }

  private async startMic(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.setMic("blocked", window.isSecureContext ? "No microphone on this device" : "The mic needs an https:// page");
      return;
    }
    this.setMic("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        video: false,
      });
      if (this.disposed) {
        for (const t of stream.getTracks()) t.stop();
        return;
      }
      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error("no audio track");
      track.contentHint = "speech";
      track.enabled = !this.muted;
      track.onended = () => {
        if (this.micTrack === track) this.stopMic("Microphone disconnected");
      };
      this.micStream = stream;
      this.micTrack = track;
      for (const peer of this.peersById.values()) this.updateSender(peer);
      if (this.ctx) this.localMeter = this.meter(stream);
      this.setMic("on");
    } catch (err) {
      const name = (err as DOMException).name;
      this.setMic("blocked", name === "NotAllowedError" || name === "SecurityError" ? "Mic blocked: allow it in the browser" : "No microphone found");
    }
  }

  private stopMic(reason: string): void {
    for (const t of this.micStream?.getTracks() ?? []) t.stop();
    this.micStream = null;
    this.micTrack = null;
    this.dropMeter(this.localMeter);
    this.localMeter = null;
    for (const peer of this.peersById.values()) if (peer.sender) void peer.sender.replaceTrack(null).catch(() => {});
    this.setMic(reason ? "blocked" : "idle", reason);
  }

  private setMic(state: MicState, error = ""): void {
    this.mic = state;
    this.micError = error;
    if (state !== "on") this.speaking.delete(this.me);
    this.notify();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    writeFlag(MUTE_KEY, muted);
    if (this.micTrack) this.micTrack.enabled = !muted;
    if (muted) this.speaking.delete(this.me);
    this.notify();
  }

  // After "Mic blocked" the player can tap the chip to try again (e.g. after allowing it).
  retryMic(): void {
    if (this.mic === "blocked") {
      this.mic = "idle";
      this.start();
    }
  }

  hintShown(): void {
    if (!this.showHint || this.hintTimer) return;
    writeFlag(HINT_KEY, true);
    this.hintTimer = this.later(HINT_MS, () => this.dismissHint());
  }

  dismissHint(): void {
    if (!this.showHint) return;
    this.showHint = false;
    writeFlag(HINT_KEY, true);
    if (this.hintTimer) this.clearLater(this.hintTimer);
    this.hintTimer = null;
    this.notify();
  }

  // Browsers only play sound and open the mic after a user gesture: the first tap or key
  // in the room does both. A touch only counts as a gesture when the finger lifts
  // (pointerup / touchend / click, not pointerdown), so all of them are listened to. The
  // listeners stay until playback really runs, and come back whenever it stops again (iOS
  // suspends audio after a call or a trip to the home screen; a new player's audio may be
  // refused). Nothing here runs per frame, and once audio is unlocked nothing listens.
  private static readonly GESTURES = ["pointerdown", "pointerup", "touchend", "click", "keydown"] as const;

  private armGesture(): void {
    if (this.gestureArmed || this.disposed) return;
    this.gestureArmed = true;
    for (const type of Voice.GESTURES) window.addEventListener(type, this.onGesture, true);
  }

  private disarmGesture(): void {
    if (!this.gestureArmed) return;
    this.gestureArmed = false;
    for (const type of Voice.GESTURES) window.removeEventListener(type, this.onGesture, true);
  }

  private onGesture = (e: Event): void => {
    // A tap on the mic chip is handled by the chip (it would otherwise start the mic here
    // and then read as "mute" when the click lands); it still unlocks playback.
    if (e.target instanceof Element && e.target.closest(".mic-chip")) this.unlockAudio();
    else this.start();
    this.maybeDisarm();
  };

  // Playback works: no need to listen for taps any more.
  private maybeDisarm(): void {
    if (this.mic === "idle" && !this.unavailable) return; // the first tap still has to start the mic
    if (this.ctx && this.ctx.state !== "running") return;
    for (const peer of this.peersById.values()) if (peer.audio?.paused && peer.audio.srcObject) return;
    this.setNeedsTap(false);
    this.disarmGesture();
  }

  private setNeedsTap(on: boolean): void {
    if (this.needsTap === on) return;
    this.needsTap = on;
    this.notify();
  }

  // Playback was refused (no gesture yet, or iOS outside of one): wait for the next tap.
  private playRefused = (): void => {
    if (this.disposed) return;
    this.setNeedsTap(true);
    this.armGesture();
  };

  private play(audio: HTMLAudioElement): void {
    void audio.play().then(() => this.maybeDisarm(), this.playRefused);
  }

  private unlockAudio(): void {
    if (this.disposed) return;
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctx) {
        this.ctx = new Ctx();
        this.ctx.onstatechange = () => {
          if (!this.ctx || this.ctx.state === "closed") return;
          if (this.ctx.state === "running") this.maybeDisarm();
          else this.armGesture();
        };
        if (this.micStream) this.localMeter = this.meter(this.micStream);
        for (const peer of this.peersById.values()) this.attachMeter(peer);
        this.speakTimer = setInterval(this.pollSpeaking, SPEAK_POLL_MS);
      }
    }
    if (this.ctx && this.ctx.state !== "running") void this.ctx.resume().catch(() => {});
    for (const peer of this.peersById.values()) if (peer.audio?.paused && peer.audio.srcObject) this.play(peer.audio);
  }

  // ---- Speaking detection ----

  private meter(stream: MediaStream): Meter | null {
    if (!this.ctx) return null;
    const source = this.ctx.createMediaStreamSource(stream);
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0;
    source.connect(analyser); // not to the speakers: playback goes through <audio>
    return { source, analyser, buf: new Float32Array(analyser.fftSize), loudAt: -Infinity, level: 0 };
  }

  private dropMeter(meter: Meter | null): void {
    if (meter) meter.source.disconnect();
  }

  private attachMeter(peer: Peer): void {
    if (!peer.meter && peer.stream && this.ctx) peer.meter = this.meter(peer.stream);
  }

  // Loudness of each stream; `speaking` changes (and listeners hear about it) only when
  // someone starts or stops talking.
  private pollSpeaking = (): void => {
    const now = performance.now();
    let changed = this.check(this.me, this.localMeter, this.mic === "on" && !this.muted, now);
    for (const peer of this.peersById.values()) {
      if (this.check(peer.id, peer.meter, peer.pc.connectionState === "connected", now)) changed = true;
    }
    if (changed) this.notify();
  };

  private check(id: string, meter: Meter | null, enabled: boolean, now: number): boolean {
    let on = false;
    if (meter && enabled) {
      meter.analyser.getFloatTimeDomainData(meter.buf);
      let sum = 0;
      for (let i = 0; i < meter.buf.length; i++) sum += meter.buf[i]! * meter.buf[i]!;
      meter.level = Math.sqrt(sum / meter.buf.length);
      if (meter.level > SPEAK_LEVEL) meter.loudAt = now;
      on = now - meter.loudAt < SPEAK_HOLD_MS;
    }
    if (on === this.speaking.has(id)) return false;
    if (on) this.speaking.add(id);
    else this.speaking.delete(id);
    return true;
  }

  // ---- Who to connect to ----

  setRoster(roster: Roster): void {
    const wasSharing = this.sharing;
    this.roster = roster;
    this.reconcile();
    if (this.sharing !== wasSharing) this.notify();
  }

  reconnected(): void {
    // Signaling sent while we were away is lost. Connections that broke recover through
    // ICE restarts or their deadline, or the other side starts a fresh one when it sees us.
    this.askConfig();
  }

  private askConfig(): void {
    try {
      this.room.send(MSG.voiceConfig);
    } catch {
      // Not connected right now; reconnected() asks again.
    }
  }

  // Connect to everyone in our voice group, hang up on everyone else. Never throws: voice
  // trouble must not stop the room UI (this runs inside the roster handler).
  private reconcile(): void {
    if (this.disposed || this.unavailable || !this.config || !this.roster) return;
    this.wanted = new Set(voicePeers(this.roster, this.me));
    let changed = false;
    // Someone started or stopped sharing: send or stop sending the mic on existing lines.
    for (const peer of this.peersById.values()) if (this.wanted.has(peer.id)) this.updateSender(peer);
    for (const [id, peer] of this.peersById) {
      if (this.wanted.has(id)) continue;
      this.send(peer, "bye", {});
      this.closePeer(peer);
      changed = true;
    }
    for (const id of this.wanted) {
      if (this.peersById.has(id)) continue;
      if (!this.openPeer(id, isPolite(this.me, id) ? null : this.nextEpoch(id))) return;
      changed = true;
    }
    if (changed) this.notify();
  }

  // The browser can't make voice connections (no WebRTC, WebRTC turned off, a bad ICE
  // config, too many connections): voice is off for this room, the game goes on.
  private fail(reason: string, err: unknown): void {
    if (process.env.NODE_ENV !== "production") console.warn(`voice unavailable: ${reason}`, err);
    for (const peer of [...this.peersById.values()]) {
      this.send(peer, "bye", {}, true);
      this.closePeer(peer);
    }
    this.unavailable = reason;
    if (this.micStream) this.stopMic("");
    this.publishStats();
    this.notify();
  }

  private nextEpoch(id: string): number {
    const epoch = Math.max(Date.now(), (this.lastEpoch.get(id) ?? 0) + 1);
    this.lastEpoch.set(id, epoch);
    return epoch;
  }

  // ---- One connection ----

  // null if the browser refused to make the connection (voice is then unavailable).
  private openPeer(id: string, epoch: number | null): Peer | null {
    let pc: RTCPeerConnection;
    try {
      pc = new RTCPeerConnection({ iceServers: this.config!.iceServers as RTCIceServer[] });
    } catch (err) {
      this.fail("Voice chat couldn't start in this browser", err);
      return null;
    }
    const peer: Peer = {
      id,
      polite: isPolite(this.me, id),
      pc,
      epoch,
      makingOffer: false,
      ignoreOffer: false,
      chain: Promise.resolve(),
      sender: null,
      audio: null,
      stream: null,
      meter: null,
      restarts: 0,
      bitrateCapped: false,
      timer: null,
      deadline: null,
      closed: false,
    };
    if (epoch !== null) this.lastEpoch.set(id, Math.max(epoch, this.lastEpoch.get(id) ?? 0));
    this.peersById.set(id, peer);
    pc.onnegotiationneeded = () => this.negotiate(peer);
    pc.onicecandidate = (e) => {
      if (peer.epoch !== null) this.send(peer, "ice", { candidate: e.candidate ? e.candidate.toJSON() : null });
    };
    pc.ontrack = (e) => this.onTrack(peer, e.track);
    pc.onconnectionstatechange = () => this.onConnectionState(peer);
    this.armDeadline(peer);
    if (!peer.polite) {
      // The impolite side starts: adding the audio line fires negotiationneeded -> offer.
      try {
        const transceiver = pc.addTransceiver(this.trackFor(id) ?? "audio", { direction: "sendrecv" });
        peer.sender = transceiver.sender;
      } catch (err) {
        this.closePeer(peer);
        this.fail("Voice chat couldn't start in this browser", err);
        return null;
      }
    } else if (epoch === null) {
      // We wait for an offer. If none comes (the other side still holds an old connection
      // with us, e.g. after our page reloaded), ask it to start over.
      peer.timer = this.later(POLITE_WAIT_MS, () => {
        peer.timer = null;
        if (!peer.closed && peer.epoch === null) this.send(peer, "bye", {});
      });
    }
    return peer;
  }

  // Watchdog: a connection still not up after the deadline (a lost offer or answer leaves
  // both sides waiting forever, and ICE that never finishes never says "failed") is started
  // again. The impolite side opens a fresh one (its offer, with a higher epoch, replaces the
  // old connection on the other side). The polite side waits a little longer, so that offer
  // normally comes first; if it doesn't, it hangs up, which makes the other side start one.
  private armDeadline(peer: Peer): void {
    if (peer.deadline || peer.closed) return;
    const misses = this.failures.get(peer.id) ?? 0;
    const ms = Math.min(NEGOTIATE_DEADLINE_MAX_MS, NEGOTIATE_DEADLINE_MS * 2 ** misses) + (peer.polite ? POLITE_DEADLINE_EXTRA_MS : 0);
    peer.deadline = this.later(ms, () => {
      peer.deadline = null;
      if (peer.closed || peer.pc.connectionState === "connected") return;
      this.failures.set(peer.id, misses + 1);
      if (peer.polite) this.send(peer, "bye", {});
      this.closePeer(peer);
      this.openPeer(peer.id, peer.polite ? null : this.nextEpoch(peer.id));
      this.notify();
    });
  }

  // May the other side replace our connection with a fresh one right now? (See FRESH_MIN_MS.)
  private allowFresh(id: string): boolean {
    const now = performance.now();
    if (now - (this.freshAt.get(id) ?? -Infinity) < FRESH_MIN_MS) return false;
    this.freshAt.set(id, now);
    return true;
  }

  private closePeer(peer: Peer): void {
    peer.closed = true;
    if (peer.timer) this.clearLater(peer.timer);
    if (peer.deadline) this.clearLater(peer.deadline);
    peer.timer = peer.deadline = null;
    const { pc } = peer;
    pc.onnegotiationneeded = null;
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.onconnectionstatechange = null;
    pc.close();
    if (peer.audio) {
      // Kept for this player's next connection: on iOS an element that played once may play
      // again without a tap; a new one may not.
      peer.audio.pause();
      peer.audio.srcObject = null;
    }
    this.dropMeter(peer.meter);
    peer.meter = null;
    if (this.peersById.get(peer.id) === peer) this.peersById.delete(peer.id);
    this.speaking.delete(peer.id);
    delete this.stats[peer.id];
  }

  // Signaling is paced (SEND_PER_SECOND): connecting to a full lobby at once makes a few
  // hundred messages, and the server cuts a player who sends more than 240 messages a second
  // (game input included). Offers, answers and byes go before ICE candidates, so an answer
  // never waits behind a pile of candidates (or gets dropped by the server's own limit).
  // `now`: hanging up on leave, sent straight away.
  private send(peer: Peer, kind: VoiceKind, extra: Omit<VoiceData, "epoch">, now = false): void {
    if (this.disposed && kind !== "bye") return;
    const message: VoiceMessage = { to: peer.id, from: this.me, kind, data: { epoch: peer.epoch ?? 0, ...extra } };
    if (now) {
      this.transmit(message);
      return;
    }
    if (kind === "ice") {
      if (this.candidateQueue.length >= MAX_QUEUED_CANDIDATES) this.candidateQueue.shift();
      this.candidateQueue.push(message);
    } else {
      this.urgentQueue.push(message);
    }
    this.flush();
  }

  private flush = (): void => {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const now = performance.now();
    this.sendTokens = Math.min(SEND_BURST, this.sendTokens + ((now - this.sendRefilledAt) / 1000) * SEND_PER_SECOND);
    this.sendRefilledAt = now;
    while (this.sendTokens >= 1) {
      const next = this.urgentQueue.shift() ?? this.candidateQueue.shift();
      if (!next) return;
      this.sendTokens -= 1;
      this.transmit(next);
    }
    if (this.urgentQueue.length + this.candidateQueue.length > 0 && !this.disposed) {
      this.flushTimer = setTimeout(this.flush, Math.ceil(1000 / SEND_PER_SECOND));
    }
  };

  private transmit(message: VoiceMessage): void {
    try {
      this.room.send(MSG.voice, message);
    } catch {
      // The room connection is gone; nothing to tell.
    }
  }

  // Perfect negotiation (see MDN): either side may offer; on a clash the polite side
  // gives way. Each peer's steps run one at a time.
  private negotiate(peer: Peer): void {
    peer.chain = peer.chain.then(async () => {
      if (peer.closed || peer.epoch === null) return;
      const { pc } = peer;
      try {
        peer.makingOffer = true;
        const offer = await pc.createOffer();
        if (peer.closed || pc.signalingState !== "stable") return;
        await pc.setLocalDescription({ type: "offer", sdp: tuneOpusSdp(offer.sdp ?? "") });
        this.send(peer, "offer", { sdp: pc.localDescription?.sdp ?? "" });
      } catch (err) {
        this.warn(peer, "offer failed", err);
      } finally {
        peer.makingOffer = false;
      }
    });
  }

  private onSignal(msg: VoiceMessage): void {
    if (this.disposed) return;
    if (!this.config) {
      this.pending.push(msg);
      return;
    }
    const id = msg.from;
    if (!this.wanted.has(id)) return; // not in our voice group (any more)
    const epoch = msg.data?.epoch ?? 0;
    let peer = this.peersById.get(id);

    if (msg.kind === "bye") {
      // The other side hung up or wants a fresh start. Stale byes are ignored, and a peer
      // can't make us start over more often than FRESH_MIN_MS.
      if (!peer || (peer.epoch !== null && epoch !== 0 && epoch < peer.epoch)) return;
      const wait = this.allowFresh(id) ? 0 : FRESH_MIN_MS;
      this.closePeer(peer);
      this.notify();
      if (!peer.polite && wait === 0) this.reconcile(); // the impolite side starts again right away
      else this.later(Math.max(wait, peer.polite ? BYE_RECONNECT_MS : 0), () => this.reconcile());
      return;
    }
    if (!peer) return;
    if (peer.epoch === null) {
      if (msg.kind !== "offer") return;
      peer.epoch = epoch; // the first offer of a new connection
      if (peer.timer) this.clearLater(peer.timer);
      peer.timer = null;
    } else if (epoch < peer.epoch) {
      return; // for a connection that has been replaced
    } else if (epoch > peer.epoch) {
      if (msg.kind !== "offer" || !this.allowFresh(id)) return;
      this.closePeer(peer); // the other side started a fresh connection
      const fresh = this.openPeer(id, epoch);
      this.notify();
      if (!fresh) return;
      peer = fresh;
    }
    const target = peer;
    target.chain = target.chain.then(() => this.handle(target, msg)).catch((err) => this.warn(target, `${msg.kind} failed`, err));
  }

  private async handle(peer: Peer, msg: VoiceMessage): Promise<void> {
    if (peer.closed) return;
    const { pc } = peer;
    if (msg.kind === "offer" || msg.kind === "answer") {
      const collision = msg.kind === "offer" && (peer.makingOffer || pc.signalingState !== "stable");
      peer.ignoreOffer = !peer.polite && collision;
      if (peer.ignoreOffer) return;
      if (msg.kind === "answer" && pc.signalingState !== "have-local-offer") return; // stale
      if (collision) await pc.setLocalDescription({ type: "rollback" });
      await pc.setRemoteDescription({ type: msg.kind, sdp: msg.data.sdp ?? "" });
      if (msg.kind === "offer") {
        this.attachSender(peer);
        const answer = await pc.createAnswer();
        if (peer.closed) return;
        await pc.setLocalDescription({ type: "answer", sdp: tuneOpusSdp(answer.sdp ?? "") });
        this.send(peer, "answer", { sdp: pc.localDescription?.sdp ?? "" });
      }
    } else if (msg.kind === "ice") {
      try {
        await pc.addIceCandidate(msg.data.candidate ?? undefined);
      } catch (err) {
        if (!peer.ignoreOffer) this.warn(peer, "ice candidate failed", err);
      }
    }
  }

  // The polite side's audio line comes from the offer: make it two-way and put the mic on it.
  private attachSender(peer: Peer): void {
    if (peer.sender) return;
    const transceiver = peer.pc.getTransceivers().find((t) => t.receiver.track.kind === "audio");
    if (!transceiver) return;
    transceiver.direction = "sendrecv";
    peer.sender = transceiver.sender;
    this.updateSender(peer);
  }

  // Your mic goes to a player only if they may hear you (your team, or an enemy while you
  // share your voice). Other connections exist only so you can hear them: they get silence.
  private trackFor(id: string): MediaStreamTrack | null {
    if (!this.micTrack || !this.roster) return null;
    return canHear(this.roster, id, this.me) ? this.micTrack : null;
  }

  private updateSender(peer: Peer): void {
    if (!peer.sender || peer.closed) return;
    const track = this.trackFor(peer.id);
    if (peer.sender.track !== track) void peer.sender.replaceTrack(track).catch(() => {});
  }

  get sharing(): boolean {
    return this.roster?.players.find((p) => p.id === this.me)?.shareVoice === true;
  }

  setSharing(on: boolean): void {
    try {
      this.room.send(MSG.shareVoice, { on });
    } catch {
      // Not connected right now: the chip still shows the server's state.
    }
  }

  private onTrack(peer: Peer, track: MediaStreamTrack): void {
    if (peer.closed || track.kind !== "audio") return;
    peer.stream = new MediaStream([track]);
    if (!peer.audio) {
      let audio = this.audioById.get(peer.id);
      if (!audio) {
        audio = new Audio();
        audio.autoplay = true;
        audio.setAttribute("playsinline", "");
        this.audioById.set(peer.id, audio);
      }
      peer.audio = audio;
    }
    peer.audio.srcObject = peer.stream;
    this.play(peer.audio); // refused (autoplay rules): retried on the next tap
    this.dropMeter(peer.meter);
    peer.meter = null;
    this.attachMeter(peer);
  }

  private onConnectionState(peer: Peer): void {
    if (peer.closed) return;
    const state = peer.pc.connectionState;
    if (state === "connected") {
      peer.restarts = 0;
      this.failures.delete(peer.id);
      if (peer.timer) this.clearLater(peer.timer);
      if (peer.deadline) this.clearLater(peer.deadline);
      peer.timer = peer.deadline = null;
      this.capBitrate(peer);
    } else if (state === "disconnected") {
      // Often comes back by itself (Wi-Fi hiccup); restart ICE if it doesn't.
      if (peer.timer) this.clearLater(peer.timer);
      peer.timer = this.later(DISCONNECTED_RESTART_MS, () => {
        peer.timer = null;
        if (!peer.closed && peer.pc.connectionState === "disconnected") this.restart(peer);
      });
    } else if (state === "failed") {
      this.restart(peer);
    }
    if (!peer.closed && state !== "connected" && state !== "closed") this.armDeadline(peer); // recovery gets a deadline too
    if (state === "closed") {
      // Closed by the browser, not by us: replace it rather than keep a dead connection.
      this.closePeer(peer);
      this.later(BYE_RECONNECT_MS, () => this.reconcile());
    }
    this.notify();
  }

  private restart(peer: Peer): void {
    if (peer.restarts++ < MAX_ICE_RESTARTS) {
      peer.pc.restartIce(); // fires negotiationneeded: an offer with new ICE credentials
    } else if (!peer.polite) {
      this.closePeer(peer);
      this.openPeer(peer.id, this.nextEpoch(peer.id));
      this.notify();
    }
  }

  // Speech needs little: cap the encoder (the SDP's maxaveragebitrate asks the other side).
  private capBitrate(peer: Peer): void {
    const sender = peer.sender;
    if (!sender || peer.bitrateCapped) return;
    peer.bitrateCapped = true;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      for (const e of params.encodings) e.maxBitrate = VOICE_MAX_BITRATE;
      void sender.setParameters(params).catch(() => {});
    } catch {
      // Older browsers: the SDP limit still applies.
    }
  }

  // ---- ICE config ----

  private onConfig(config: VoiceConfig): void {
    if (this.disposed) return;
    const first = !this.config;
    this.config = config;
    for (const peer of this.peersById.values()) {
      try {
        peer.pc.setConfiguration({ ...peer.pc.getConfiguration(), iceServers: config.iceServers as RTCIceServer[] });
      } catch {
        // Some browsers refuse changes mid-connection; new connections use the new config.
      }
    }
    // TURN credentials expire: ask for fresh ones in time. One timer, whatever the number of
    // configs that come in (on join, on request, after reconnects).
    if (this.refreshTimer) this.clearLater(this.refreshTimer);
    this.refreshTimer = this.later(Math.max(10_000, config.refreshMs), () => {
      this.refreshTimer = null;
      this.askConfig();
    });
    if (first) {
      this.reconcile();
      const pending = this.pending;
      this.pending = [];
      for (const msg of pending) this.onSignal(msg);
    }
    this.publishStats();
  }

  // ---- Timers, teardown, dev stats ----

  private later(ms: number, fn: () => void): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.disposed) fn();
    }, ms);
    this.timers.add(t);
    return t;
  }

  private clearLater(t: ReturnType<typeof setTimeout>): void {
    clearTimeout(t);
    this.timers.delete(t);
  }

  // Closing the page ends voice. A page kept in the back/forward cache (persisted) may come
  // back: hang up and stop the mic now, and start over from the first tap on return.
  private onPageHide = (e: PageTransitionEvent): void => {
    if (!e.persisted) {
      this.dispose();
      return;
    }
    for (const peer of [...this.peersById.values()]) {
      this.send(peer, "bye", {}, true);
      this.closePeer(peer);
    }
    if (this.micStream) this.stopMic("");
    this.notify();
  };

  private onPageShow = (e: PageTransitionEvent): void => {
    if (!e.persisted || this.disposed) return;
    this.armGesture();
    this.askConfig();
    this.reconcile();
  };

  dispose(): void {
    if (this.disposed) return;
    for (const peer of [...this.peersById.values()]) {
      this.send(peer, "bye", {}, true);
      this.closePeer(peer);
    }
    this.disposed = true;
    for (const t of this.micStream?.getTracks() ?? []) t.stop();
    this.micStream = null;
    this.micTrack = null;
    this.localMeter = null;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.refreshTimer = this.hintTimer = null;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.urgentQueue = [];
    this.candidateQueue = [];
    for (const audio of this.audioById.values()) {
      audio.pause();
      audio.srcObject = null;
    }
    this.audioById.clear();
    if (this.speakTimer) clearInterval(this.speakTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.disarmGesture();
    window.removeEventListener("pagehide", this.onPageHide);
    window.removeEventListener("pageshow", this.onPageShow);
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.speaking.clear();
    this.mic = "idle";
    if (process.env.NODE_ENV !== "production" && window.__voice) delete window.__voice;
    this.notify();
  }

  private warn(peer: Peer, what: string, err: unknown): void {
    if (process.env.NODE_ENV !== "production") console.warn(`voice ${peer.id}: ${what}`, err);
  }

  // Dev only: window.__voice shows what each voice connection is doing.
  private async collectStats(): Promise<void> {
    for (const peer of this.peersById.values()) {
      const s: PeerStats = {
        connectionState: peer.pc.connectionState,
        bytesSent: 0,
        bytesReceived: 0,
        relay: null,
        rttMs: null,
        level: peer.meter ? Math.round(peer.meter.level * 1000) / 1000 : null,
        playing: !!peer.audio && !peer.audio.paused,
      };
      try {
        const report = await peer.pc.getStats();
        let pairId: string | undefined;
        report.forEach((r) => {
          if (r.type === "outbound-rtp" && r.kind === "audio") s.bytesSent += r.bytesSent ?? 0;
          if (r.type === "inbound-rtp" && r.kind === "audio") s.bytesReceived += r.bytesReceived ?? 0;
          if (r.type === "transport" && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
        });
        if (!pairId) report.forEach((r) => r.type === "candidate-pair" && r.nominated && r.state === "succeeded" && (pairId = r.id));
        const pair = pairId ? report.get(pairId) : undefined;
        if (pair) {
          s.relay = report.get(pair.localCandidateId)?.candidateType === "relay" || report.get(pair.remoteCandidateId)?.candidateType === "relay";
          if (typeof pair.currentRoundTripTime === "number") s.rttMs = Math.round(pair.currentRoundTripTime * 1000);
        }
      } catch {
        // Closed while we looked.
      }
      if (!peer.closed) this.stats[peer.id] = s;
    }
    this.publishStats();
  }

  private publishStats(): void {
    if (process.env.NODE_ENV === "production" || this.disposed) return;
    window.__voice = {
      me: this.me,
      mic: this.mic,
      micError: this.micError,
      muted: this.muted,
      unavailable: this.unavailable || undefined,
      needsTap: this.needsTap,
      relay: this.config ? (this.config.relay ?? "relay not configured") : "waiting for config",
      iceServers: this.config?.iceServers.map((s) => s.urls),
      speaking: [...this.speaking],
      peers: { ...this.stats },
      wanted: [...this.wanted],
    };
  }
}
