import type { Room } from "@colyseus/sdk";
import { MSG, TICK_MS, type InputFrame, type InputMessage } from "@tank/shared";

// A test bot's button, sent the way the web client sends it: one numbered sample per sim
// tick. Call `flush` often (every ~20 ms); it sends the samples due since the last call.
export class BotButton {
  private seq = 0;
  private held = false;
  private pressPending = false;
  private due = 0;
  private last = performance.now();

  constructor(private room: Room) {}

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
      this.pressPending = false;
      this.due -= 1;
    }
    if (frames.length) this.room.send(MSG.input, frames satisfies InputMessage);
  }
}
