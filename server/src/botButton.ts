import type { Room } from "@colyseus/sdk";
import { MSG, TICK_MS, type InputFrame, type InputMessage } from "@tank/shared";

// A test bot's button, sent the way the web client sends it: one numbered sample per sim
// tick. Call `flush` often (every ~20 ms); it sends the samples due since the last call,
// straight over the room's WebSocket, or through a BotNet (WebSocket or UDP channel).
export interface InputSink {
  sendInput(frames: InputFrame[]): void;
}

export class BotButton {
  private seq = 0;
  private held = false;
  private pressPending = false;
  private due = 0;
  private last = performance.now();
  // Every tap's sample and when it was made, for measuring how long it takes to reach the
  // server (until a snapshot acks it). Cleared by whoever reads it.
  taps: { seq: number; at: number }[] = [];

  constructor(private sink: Room | InputSink) {}

  tap(): void {
    this.pressPending = true;
  }

  hold(down: boolean): void {
    if (down && !this.held) this.pressPending = true;
    this.held = down;
  }

  flush(now = performance.now()): void {
    this.due += (now - this.last) / TICK_MS;
    this.last = now;
    const frames: InputFrame[] = [];
    while (this.due >= 1) {
      frames.push({ seq: ++this.seq, held: this.held, pressed: this.pressPending });
      if (this.pressPending) this.taps.push({ seq: this.seq, at: now });
      this.pressPending = false;
      this.due -= 1;
    }
    if (!frames.length) return;
    if ("sendInput" in this.sink) this.sink.sendInput(frames);
    else this.sink.send(MSG.input, frames satisfies InputMessage);
  }
}
