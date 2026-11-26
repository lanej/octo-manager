import type { ScheduledTask, WorkScheduler } from "./work.js";
import { GitHubRequestCancelledError } from "../github/errors.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import type { GitHubResource } from "../github/usage.js";
import { canonicalPR } from "../github/pr-identity.js";
import type { PullRequestDetails } from "../github/reviews.js";
import { RefreshKind, ScheduleState, type ScheduledRefresh, type SchedulerPolicy } from "./contracts.js";
import type { ScheduleStore } from "./store.js";

export interface RequestDispatch {
  readonly signal: AbortSignal;
  dispatch<T>(resource: GitHubResource, work: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  defer(resource: GitHubResource, until: number): void;
  deadline(resource: GitHubResource): number;
}
interface Pending {
  resource: GitHubResource;
  interactive: boolean;
  signal: AbortSignal | undefined;
  run: () => Promise<void>;
  reject: (error: Error) => void;
}

export class GitHubScheduler extends EventEmitter implements RequestDispatch {
  private task: ScheduledTask | undefined;
  private heartbeat: ScheduledTask | undefined;
  private dashboards = 0;
  private queue: Pending[] = [];
  private busy = false;
  private inFlight: Promise<void> | undefined;
  private closed = false;
  private sequence = 0;
  private nextTickAtMs = 0;
  private lastInteractive = false;
  private priority = new AsyncLocalStorage<boolean>();
  private interests = new Map<string, number>();
  private reviews = new Map<string, Promise<void>>();
  private abort = new AbortController();

  constructor(
    readonly store: ScheduleStore,
    readonly policy: SchedulerPolicy,
    private now: () => number,
    private readReviews: (url: string, signal: AbortSignal) => Promise<PullRequestDetails>,
    private poll: () => void,
  ) {
    super();
  }

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  start(scheduler: WorkScheduler): void {
    this.task = scheduler.task("github-dispatch", () => {
      const reviews = this.store.reviews();
      this.refreshReviews(reviews);
      this.pump();
      return this.nextDeadline(reviews);
    });
    this.heartbeat = scheduler.task("github-heartbeat", () => {
      this.sequence++;
      this.nextTickAtMs = this.dashboards > 0 ? this.now() + this.policy.tickMs : 0;
      this.poll();
      this.emit("heartbeat");
      return this.nextTickAtMs === 0 ? undefined : this.nextTickAtMs;
    });
    this.task.wake();
    if (this.dashboards > 0) this.heartbeat.wake();
  }

  dashboardInterest(): () => void {
    this.dashboards++;
    if (this.dashboards === 1) {
      this.nextTickAtMs = this.now() + this.policy.tickMs;
      this.heartbeat?.at(this.nextTickAtMs);
    }
    return () => {
      this.dashboards--;
      if (this.dashboards === 0) {
        this.nextTickAtMs = 0;
        this.heartbeat?.at(undefined);
      }
    };
  }

  private changed(): void {
    if (this.closed) return;
    this.sequence++;
    this.emit("change");
  }

  private nextDeadline(reviews: readonly ScheduledRefresh[]): number | undefined {
    let next = Infinity;
    if (!this.busy && this.queue.length > 0) {
      const dispatch = this.store.dispatch();
      for (const item of this.queue)
        if (item.signal?.aborted !== true)
          next = Math.min(
            next,
            Math.max(dispatch.nextAtMs, item.resource === "core" ? dispatch.coreRetryAtMs : dispatch.graphqlRetryAtMs),
          );
    }
    for (const entry of reviews)
      if (
        entry.kind === RefreshKind.Reviews &&
        !this.reviews.has(entry.key) &&
        (this.interests.has(entry.subject) || entry.state === ScheduleState.Queued)
      )
        next = Math.min(next, entry.dueAtMs);
    return Number.isFinite(next) ? next : undefined;
  }

  interactive<T>(work: () => T): T {
    return this.priority.run(true, work);
  }

  deadline(resource: GitHubResource): number {
    const state = this.store.dispatch();
    return resource === "core" ? state.coreRetryAtMs : state.graphqlRetryAtMs;
  }

  defer(resource: GitHubResource, until: number): void {
    const state = this.store.dispatch();
    if (resource === "core") state.coreRetryAtMs = Math.max(state.coreRetryAtMs, until);
    else state.graphqlRetryAtMs = Math.max(state.graphqlRetryAtMs, until);
    this.store.saveDispatch(state);
    this.task?.wake();
    this.changed();
  }

  dispatch<T>(resource: GitHubResource, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new GitHubRequestCancelledError("GitHub scheduler is stopping"));
    if (signal?.aborted === true) return Promise.reject(new GitHubRequestCancelledError());
    return new Promise<T>((resolve, reject) => {
      const cancel = () => {
        this.queue = this.queue.filter((value) => value !== item);
        this.task?.wake();
        this.changed();
        reject(new GitHubRequestCancelledError());
      };
      const item: Pending = {
        resource,
        interactive: this.priority.getStore() === true,
        signal,
        reject,
        run: async () => {
          signal?.removeEventListener("abort", cancel);
          try {
            if (signal?.aborted === true) throw new GitHubRequestCancelledError();
            resolve(await work());
          } catch (error) {
            reject(error instanceof Error ? error : new Error("GitHub request failed"));
          }
        },
      };
      signal?.addEventListener("abort", cancel, { once: true });
      this.queue.push(item);
      this.task?.wake();
      this.changed();
    });
  }

  interest(raw: string): () => void {
    const url = canonicalPR(raw);
    this.interests.set(url, (this.interests.get(url) ?? 0) + 1);
    this.ensureReviews(
      url,
      this.store.view(url) === undefined && this.store.get(`reviews:${url}`)?.lastError === undefined,
    );
    return () => {
      const remaining = (this.interests.get(url) ?? 1) - 1;
      if (remaining === 0) this.interests.delete(url);
      else this.interests.set(url, remaining);
      this.task?.wake();
    };
  }

  ensureReviews(raw: string, force = false): void {
    const url = canonicalPR(raw),
      key = `reviews:${url}`;
    const previous = this.store.get(key);
    if (!previous)
      this.store.save({
        key,
        kind: RefreshKind.Reviews,
        subject: url,
        dueAtMs: this.now(),
        intervalMs: 60000,
        state: ScheduleState.Queued,
      });
    else if (force && previous.state !== ScheduleState.Running)
      this.store.save({
        ...previous,
        dueAtMs: this.now(),
        state: ScheduleState.Queued,
      });
    this.task?.wake();
    this.changed();
  }

  reviewState(raw: string) {
    const url = canonicalPR(raw);
    return {
      details: this.store.view(url),
      schedule: this.store.get(`reviews:${url}`),
    };
  }

  private refreshReviews(reviews = this.store.reviews()): void {
    for (const entry of reviews) {
      if (entry.kind !== RefreshKind.Reviews || this.reviews.has(entry.key)) continue;
      if (!this.interests.has(entry.subject) && entry.state !== ScheduleState.Queued) continue;
      if (entry.dueAtMs > this.now()) continue;
      const attemptedAt = this.now();
      this.store.save({
        ...entry,
        state: ScheduleState.Running,
        lastAttemptAtMs: attemptedAt,
      });
      this.changed();
      const work = this.interactive(async () => {
        try {
          const value = await this.readReviews(entry.subject, this.abort.signal);
          if (this.closed) return;
          const old = this.store.view(entry.subject);
          const same =
            old !== undefined &&
            JSON.stringify({ ...old, observedAtMs: 0 }) === JSON.stringify({ ...value, observedAtMs: 0 });
          const intervalMs = same ? Math.min(900000, entry.intervalMs * 2) : 60000;
          this.store.saveView(value);
          const next = {
            ...entry,
            state: ScheduleState.Deferred,
            lastAttemptAtMs: attemptedAt,
            intervalMs,
            dueAtMs: this.now() + intervalMs,
          };
          delete next.lastError;
          this.store.save(next);
        } catch (error) {
          if (!this.closed)
            this.store.save({
              ...entry,
              state: ScheduleState.Deferred,
              dueAtMs: this.now() + entry.intervalMs,
              lastAttemptAtMs: attemptedAt,
              lastError: error instanceof Error ? error.message.slice(0, 2000) : "Review refresh failed",
            });
        }
      }).finally(() => {
        this.reviews.delete(entry.key);
        this.task?.wake();
        this.changed();
      });
      this.reviews.set(entry.key, work);
    }
  }

  tick(): void {
    if (this.closed) return;
    this.sequence++;
    this.nextTickAtMs = this.now() + this.policy.tickMs;
    this.poll();
    this.refreshReviews();
    this.pump();
    this.emit("tick");
  }

  private pump(): void {
    if (this.busy || this.queue.length === 0) return;
    const dispatch = this.store.dispatch();
    if (dispatch.nextAtMs > this.now()) return;
    const ready = this.queue.filter(
      (item) =>
        item.signal?.aborted !== true &&
        (item.resource === "core" ? dispatch.coreRetryAtMs : dispatch.graphqlRetryAtMs) <= this.now(),
    );
    const item = ready.find((value) => value.interactive !== this.lastInteractive) ?? ready[0];
    if (!item) return;
    this.queue = this.queue.filter((value) => value !== item);
    this.lastInteractive = item.interactive;
    this.busy = true;
    this.store.saveDispatch({
      ...dispatch,
      nextAtMs: this.now() + this.policy.requestSpacingMs,
    });
    this.changed();
    this.inFlight = item
      .run()
      .finally(() => {
        const current = this.store.dispatch();
        this.store.saveDispatch({
          ...current,
          nextAtMs: Math.max(current.nextAtMs, this.now() + this.policy.requestSpacingMs),
        });
        this.busy = false;
        this.task?.wake();
        this.changed();
      })
      .catch(() => {});
  }

  status() {
    const state = this.store.dispatch();
    return {
      tickMs: this.policy.tickMs,
      requestSpacingMs: this.policy.requestSpacingMs,
      tickSequence: this.sequence,
      nextTickAtMs: this.nextTickAtMs,
      nextDispatchAtMs: Math.max(this.now(), state.nextAtMs),
      queuedRequests: this.queue.length,
      inFlight: this.busy,
      coreRetryAtMs: state.coreRetryAtMs,
      graphqlRetryAtMs: state.graphqlRetryAtMs,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.task?.close();
    this.heartbeat?.close();
    this.abort.abort();
    for (const item of this.queue.splice(0)) item.reject(new GitHubRequestCancelledError("GitHub scheduler stopped"));
    await Promise.all([...this.reviews.values(), ...(!this.inFlight ? [] : [this.inFlight])]);
  }
}
