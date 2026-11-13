import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import type { GitHubResource } from "../github-usage.js";
import { canonicalPR } from "../tracking/github.js";
import type { PullRequestDetails } from "../github.js";
import {
  RefreshKind,
  ScheduleState,
  type SchedulerPolicy,
} from "./contracts.js";
import type { ScheduleStore } from "./store.js";

export interface RequestDispatch {
  readonly signal: AbortSignal;
  dispatch<T>(
    resource: GitHubResource,
    work: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
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
  private timer: ReturnType<typeof setInterval> | undefined;
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
    private readReviews: (
      url: string,
      signal: AbortSignal,
    ) => Promise<PullRequestDetails>,
    private poll: () => void,
  ) {
    super();
  }
  get signal(): AbortSignal {
    return this.abort.signal;
  }
  start(): void {
    this.timer = setInterval(() => {
      this.tick();
    }, this.policy.tickMs);
    this.tick();
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
    if (resource === "core")
      state.coreRetryAtMs = Math.max(state.coreRetryAtMs, until);
    else state.graphqlRetryAtMs = Math.max(state.graphqlRetryAtMs, until);
    this.store.saveDispatch(state);
  }
  dispatch<T>(
    resource: GitHubResource,
    work: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.closed)
      return Promise.reject(new Error("GitHub scheduler is stopping"));
    if (signal?.aborted === true)
      return Promise.reject(new Error("GitHub request cancelled"));
    return new Promise<T>((resolve, reject) => {
      const cancel = () => {
        this.queue = this.queue.filter((value) => value !== item);
        reject(new Error("GitHub request cancelled"));
      };
      const item: Pending = {
        resource,
        interactive: this.priority.getStore() === true,
        signal,
        reject,
        run: async () => {
          signal?.removeEventListener("abort", cancel);
          try {
            signal?.throwIfAborted();
            resolve(await work());
          } catch (error) {
            reject(
              error instanceof Error
                ? error
                : new Error("GitHub request failed"),
            );
          }
        },
      };
      signal?.addEventListener("abort", cancel, { once: true });
      this.queue.push(item);
    });
  }
  interest(raw: string): () => void {
    const url = canonicalPR(raw);
    this.interests.set(url, (this.interests.get(url) ?? 0) + 1);
    this.ensureReviews(
      url,
      this.store.view(url) === undefined &&
        this.store.get(`reviews:${url}`)?.lastError === undefined,
    );
    return () => {
      const remaining = (this.interests.get(url) ?? 1) - 1;
      if (remaining === 0) this.interests.delete(url);
      else this.interests.set(url, remaining);
    };
  }
  ensureReviews(raw: string, force = false): void {
    const url = canonicalPR(raw),
      key = `reviews:${url}`;
    const previous = this.store.get(key);
    if (previous === undefined)
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
  }
  reviewState(raw: string) {
    const url = canonicalPR(raw);
    return {
      details: this.store.view(url),
      schedule: this.store.get(`reviews:${url}`),
    };
  }
  private refreshReviews(): void {
    for (const entry of this.store.list()) {
      if (entry.kind !== RefreshKind.Reviews || this.reviews.has(entry.key))
        continue;
      if (
        !this.interests.has(entry.subject) &&
        entry.state !== ScheduleState.Queued
      )
        continue;
      if (entry.dueAtMs > this.now()) continue;
      const attemptedAt = this.now();
      this.store.save({
        ...entry,
        state: ScheduleState.Running,
        lastAttemptAtMs: attemptedAt,
      });
      const work = this.interactive(async () => {
        try {
          const value = await this.readReviews(
            entry.subject,
            this.abort.signal,
          );
          if (this.closed) return;
          const old = this.store.view(entry.subject);
          const same =
            old !== undefined &&
            JSON.stringify({ ...old, observedAtMs: 0 }) ===
              JSON.stringify({ ...value, observedAtMs: 0 });
          const intervalMs = same
            ? Math.min(900000, entry.intervalMs * 2)
            : 60000;
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
              lastError:
                error instanceof Error
                  ? error.message.slice(0, 2000)
                  : "Review refresh failed",
            });
        }
      }).finally(() => {
        this.reviews.delete(entry.key);
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
    if (this.busy || this.store.dispatch().nextAtMs > this.now()) return;
    const ready = this.queue.filter(
      (item) =>
        item.signal?.aborted !== true &&
        this.deadline(item.resource) <= this.now(),
    );
    const item =
      ready.find((value) => value.interactive !== this.lastInteractive) ??
      ready[0];
    if (item === undefined) return;
    this.queue = this.queue.filter((value) => value !== item);
    this.lastInteractive = item.interactive;
    this.busy = true;
    this.store.saveDispatch({
      ...this.store.dispatch(),
      nextAtMs: this.now() + this.policy.requestSpacingMs,
    });
    this.inFlight = item
      .run()
      .finally(() => {
        this.store.saveDispatch({
          ...this.store.dispatch(),
          nextAtMs: Math.max(
            this.store.dispatch().nextAtMs,
            this.now() + this.policy.requestSpacingMs,
          ),
        });
        this.busy = false;
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
    if (this.timer !== undefined) clearInterval(this.timer);
    this.abort.abort();
    for (const item of this.queue.splice(0))
      item.reject(new Error("GitHub scheduler stopped"));
    await Promise.all([
      ...this.reviews.values(),
      ...(this.inFlight === undefined ? [] : [this.inFlight]),
    ]);
  }
}
