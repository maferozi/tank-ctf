import type { TankInput } from "@tank/shared";

// The single game button: any pointer (mouse, touch, pen) on the target, or Space / Enter.
// The target is the whole game screen on desktop and the round TAP button on touch devices.
export class OneButton {
  private pointers = new Set<number>();
  private keyDown = false;
  private pressedSinceTick = false;
  private cleanup: (() => void)[] = [];

  constructor(target: HTMLElement) {
    const onPointerDown = (e: PointerEvent) => {
      // Links and buttons drawn on top of the game (room chip, "Back to start") keep their
      // clicks; capturing the pointer here would swallow them.
      const control = e.target instanceof Element ? e.target.closest(CONTROLS) : null;
      if (control && control !== target) return;
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
    // A chip the keyboard is on (Tab to Leave, Sound, ...) keeps Space/Enter, so it can be
    // pressed without a mouse; the soldier doesn't fire.
    const onChip = (e: Event) => {
      const control = e.target instanceof Element ? e.target.closest(CONTROLS) : null;
      return control !== null && control !== target;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isButtonKey(e) || e.repeat || isFormField(e.target) || onChip(e)) return;
      e.preventDefault();
      this.press(() => (this.keyDown = true));
    };
    const onKeyUp = (e: KeyboardEvent) => {
      // Always let go, even if focus moved onto a chip while the key was down.
      if (!isButtonKey(e) || isFormField(e.target)) return;
      if (!onChip(e)) e.preventDefault();
      this.keyDown = false;
    };
    // A chip clicked with the mouse would keep focus, and the next Space (meant to fire)
    // would click it again. Drop focus after pointer clicks; keyboard clicks (detail 0) keep it.
    const onClick = (e: MouseEvent) => {
      if (e.detail === 0 || !onChip(e)) return;
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused !== target && focused.closest(CONTROLS)) focused.blur();
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
    window.addEventListener("click", onClick);
    window.addEventListener("blur", releaseAll);
    this.cleanup.push(() => {
      target.removeEventListener("pointerdown", onPointerDown);
      target.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("click", onClick);
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

// Chip groups count as controls as a whole, so a tap on the "Leave match?" text or between
// two chips doesn't fire.
const CONTROLS = "a, button, input, select, textarea, label, .game-chips, .rotate-hint";

function isButtonKey(e: KeyboardEvent): boolean {
  return e.code === "Space" || e.code === "Enter";
}

// Text fields keep Space/Enter (needed later for the lobby name and room code).
function isFormField(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) return true;
  return target instanceof HTMLInputElement && !["range", "checkbox", "button"].includes(target.type);
}
