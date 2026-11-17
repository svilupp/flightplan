/** A raw-attach keyboard preflight failed before any input was sent. */
export class KeyboardPreflightError extends Error {
  readonly code = "KEYBOARD_NOT_READY";
  readonly dispatchState = "not_dispatched";
  readonly retrySafe = true;
  constructor(reason: string) {
    super(reason);
    this.name = "KeyboardPreflightError";
  }
}
