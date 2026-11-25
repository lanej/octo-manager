// Synchronous local work sleeps until an input wakeup or its returned clock deadline.
export class LocalWork {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dueAt: number | undefined;
  private started = false;
  private closed = false;
  private running = false;

  constructor(
    private now: () => number,
    private work: () => number | undefined,
  ) {}

  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.runNow();
  }

  wake(): void {
    if (!this.started || this.closed || this.running) return;
    const now = this.now();
    if (this.dueAt !== undefined && this.dueAt <= now) return;
    this.schedule(now);
  }

  runNow(): void {
    if (this.closed || this.running) return;
    this.clear();
    this.running = true;
    let deadline: number | undefined;
    try {
      // Writes inside this synchronous pass are included in its resulting deadline.
      deadline = this.work();
    } finally {
      this.running = false;
    }
    if (deadline !== undefined) this.schedule(deadline);
  }

  close(): void {
    this.closed = true;
    this.clear();
  }

  private clear(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.dueAt = undefined;
  }

  private schedule(deadline: number): void {
    if (!this.started || this.closed) return;
    this.clear();
    this.dueAt = deadline;
    this.timer = setTimeout(
      () => {
        this.runNow();
      },
      Math.min(2147483647, Math.max(0, deadline - this.now())),
    );
  }
}
