import type { TankInput } from "@tank/shared";

// The single game button: any pointer (mouse, touch, pen) on the canvas, or Space / Enter.
export class OneButton {
  private pointers = new Set<number>();
  private keyDown = false;
  private pressedSinceTick = false;
  private cleanup: (() => void)[] = [];

  constructor(target: HTMLElement) {
    const onPointerDown = (e: PointerEvent) => {
      e.preventDefault();
      this.press(() => this.pointers.add(e.pointerId));
      try {
        target.setPointerCapture(e.pointerId);
      } catch {
        // Capture is only a nicety; release is tracked on window anyway.
      }
    };
    const onPointerUp = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isButtonKey(e) || e.repeat || isFormField(e.target)) return;
      e.preventDefault();
      this.press(() => (this.keyDown = true));
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!isButtonKey(e) || isFormField(e.target)) return;
      // Stops Space/Enter from also clicking a focused HUD button.
      e.preventDefault();
      this.keyDown = false;
    };
    const releaseAll = () => {
      this.pointers.clear();
      this.keyDown = false;
    };
    const onContextMenu = (e: Event) => e.preventDefault();

    target.addEventListener("pointerdown", onPointerDown);
    target.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", releaseAll);
    this.cleanup.push(() => {
      target.removeEventListener("pointerdown", onPointerDown);
      target.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", releaseAll);
    });
  }

  get held(): boolean {
    return this.pointers.size > 0 || this.keyDown;
  }

  // Called once per sim tick.
  consume(): TankInput {
    const input = { held: this.held, pressed: this.pressedSinceTick };
    this.pressedSinceTick = false;
    return input;
  }

  dispose(): void {
    this.cleanup.forEach((fn) => fn());
  }

  private press(apply: () => void): void {
    const wasHeld = this.held;
    apply();
    if (!wasHeld) this.pressedSinceTick = true;
  }
}

function isButtonKey(e: KeyboardEvent): boolean {
  return e.code === "Space" || e.code === "Enter";
}

// Text fields keep Space/Enter (needed later for the lobby name and room code).
function isFormField(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) return true;
  return target instanceof HTMLInputElement && !["range", "checkbox", "button"].includes(target.type);
}
