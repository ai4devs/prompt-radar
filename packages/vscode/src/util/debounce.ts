// Minimal trailing-edge debouncer with explicit flush, used for the 500 ms
// auto-save of the prompt index and response log (spec §8.1).
export class Debouncer {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending = false;

  constructor(
    private readonly fn: () => void | Promise<void>,
    private readonly delayMs: number
  ) {}

  schedule(): void {
    this.pending = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pending = false;
      void this.fn();
    }, this.delayMs);
  }

  /** Run any pending work immediately (e.g. on deactivate). */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.pending) {
      this.pending = false;
      await this.fn();
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
