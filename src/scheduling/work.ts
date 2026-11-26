export type TaskResult = number | undefined;
export type TaskWork = () => TaskResult | Promise<TaskResult>;
export type TaskCallback = TaskWork | (() => void) | (() => Promise<void>);
export interface ScheduledTask {
  wake(): void;
  at(deadline: number | undefined): void;
  runNow(): void;
  close(): void;
}
interface Task {
  key: string;
  work: TaskWork;
  deadline: number | undefined;
  next: number | undefined;
  wakeAt: number | undefined;
  retryAt: number | undefined;
  planVersion: number;
  cancelled: boolean;
  running: boolean;
  closed: boolean;
}
const retryDelay = 5000;
const maximumTimeout = 2147483647;

// One clock owns local work; capabilities own their input events and next useful deadline.
export class WorkScheduler {
  private readonly tasks = new Map<string, Task>();
  private readonly inFlight = new Set<Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerAt: number | undefined;
  private state: "new" | "running" | "stopped" | "closed" = "new";
  private generation = 0;
  private draining = false;
  private closing: Promise<void> | undefined;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly onError?: (key: string, error: unknown) => void | Promise<void>,
    private readonly observe?: (key: string, work: TaskWork) => ReturnType<TaskWork>,
  ) {}

  task(key: string, work: TaskCallback): ScheduledTask {
    if (this.state === "closed") throw new Error("Work scheduler is closed");
    if (this.tasks.has(key)) throw new Error(`Duplicate scheduled task: ${key}`);
    const task: Task = {
      key,
      work: () => this.invoke(work),
      deadline: undefined,
      next: undefined,
      wakeAt: undefined,
      retryAt: undefined,
      planVersion: 0,
      cancelled: false,
      running: false,
      closed: false,
    };
    this.tasks.set(key, task);
    return {
      wake: () => {
        if (!this.accepts(task)) return;
        task.wakeAt ??= this.now();
        this.arm();
      },
      at: (deadline) => {
        if (!this.accepts(task)) return;
        this.validate(deadline);
        task.deadline = deadline;
        task.next = undefined;
        task.planVersion++;
        task.cancelled = deadline === undefined;
        this.arm();
      },
      runNow: () => {
        if (!this.accepts(task)) return;
        if (task.running) {
          task.wakeAt ??= this.now();
          return;
        }
        this.dispatch(task);
      },
      close: () => {
        task.closed = true;
        this.clearPlan(task);
        this.arm();
      },
    };
  }

  start(): void {
    if (this.state === "closed" || this.state === "running") return;
    this.state = "running";
    this.arm();
  }

  stop(): void {
    if (this.state === "closed") return;
    this.state = "stopped";
    this.generation++;
    this.clearTimer();
    for (const task of this.tasks.values()) this.clearPlan(task);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stop();
    this.state = "closed";
    for (const task of this.tasks.values()) task.closed = true;
    this.closing = Promise.allSettled([...this.inFlight]).then(() => undefined);
    return this.closing;
  }

  private invoke(work: TaskCallback): TaskResult | Promise<TaskResult> {
    const result: unknown = work();
    if (typeof result === "number" || result === undefined) return result;
    return Promise.resolve(result).then((value) => {
      this.validate(value);
      return value;
    });
  }

  private accepts(task: Task): boolean {
    return !task.closed && this.state !== "stopped" && this.state !== "closed";
  }

  private validate(deadline: unknown): asserts deadline is number | undefined {
    if (deadline !== undefined && (typeof deadline !== "number" || !Number.isFinite(deadline)))
      throw new Error("Scheduled deadline must be finite or undefined");
  }

  private clearPlan(task: Task): void {
    task.deadline = undefined;
    task.next = undefined;
    task.wakeAt = undefined;
    task.retryAt = undefined;
  }

  private due(task: Task): number {
    if (task.closed || task.running) return Infinity;
    const deadline = Math.min(task.deadline ?? Infinity, task.next ?? Infinity, task.wakeAt ?? Infinity);
    return Math.max(deadline, task.retryAt ?? -Infinity);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.timerAt = undefined;
  }

  private arm(): void {
    if (this.draining) return;
    if (this.state !== "running") {
      this.clearTimer();
      return;
    }
    let at = Infinity;
    for (const task of this.tasks.values()) at = Math.min(at, this.due(task));
    if (at === this.timerAt && this.timer && at > this.now()) return;
    this.clearTimer();
    if (!Number.isFinite(at)) return;
    this.timerAt = at;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.timerAt = undefined;
        this.drain();
      },
      Math.min(maximumTimeout, Math.max(0, at - this.now())),
    );
  }

  private isRunning(): boolean {
    return this.state === "running";
  }

  private drain(): void {
    if (!this.isRunning()) return;
    this.draining = true;
    try {
      const now = this.now();
      const ready = [...this.tasks.values()].filter((task) => this.due(task) <= now);
      for (const task of ready) {
        if (!this.isRunning()) break;
        if (this.due(task) <= now) this.dispatch(task);
      }
    } finally {
      this.draining = false;
      this.arm();
    }
  }

  private dispatch(task: Task): void {
    if (!this.accepts(task) || task.running) return;
    task.running = true;
    task.wakeAt = undefined;
    task.next = undefined;
    task.retryAt = undefined;
    if (task.deadline !== undefined && task.deadline <= this.now()) task.deadline = undefined;
    const generation = this.generation,
      planVersion = task.planVersion;
    let resolve: () => void = () => {};
    const done = new Promise<void>((settle) => {
      resolve = settle;
    });
    this.inFlight.add(done);
    const failed = (error: unknown) => {
      if (!this.accepts(task) || this.generation !== generation) return;
      task.retryAt = this.now() + retryDelay;
      task.next = task.retryAt;
      try {
        // Reporter failures cannot escape scheduler cleanup.
        Promise.resolve(this.onError?.(task.key, error)).then(undefined, () => undefined);
      } catch {
        // The error hook cannot prevent bounded retries or lifecycle cleanup.
      }
    };
    const finish = (result: unknown, failure?: { error: unknown }) => {
      try {
        if (this.accepts(task) && this.generation === generation) {
          if (failure) failed(failure.error);
          else {
            this.validate(result);
            // An explicit cancellation made during this pass outranks its stale returned plan.
            if (!(task.planVersion !== planVersion && task.cancelled)) task.next = result;
          }
        }
      } catch (error) {
        failed(error);
      } finally {
        task.running = false;
        this.inFlight.delete(done);
        resolve();
        this.arm();
      }
    };
    try {
      const result = this.observe ? this.observe(task.key, task.work) : task.work();
      if (typeof result === "number" || result === undefined) finish(result);
      else
        Promise.resolve(result).then(
          (value) => {
            finish(value);
          },
          (error: unknown) => {
            finish(undefined, { error });
          },
        );
    } catch (error) {
      finish(undefined, { error });
    }
  }
}
