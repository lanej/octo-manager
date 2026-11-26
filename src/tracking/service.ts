import type { FSWatcher } from "node:fs";
import type { ScheduledTask, WorkScheduler } from "../scheduling/work.js";
import { RefreshKind, ScheduleState } from "../scheduling/contracts.js";
import type { ScheduleStore } from "../scheduling/store.js";
import { defaultPollPolicy, schedulePoll, type PollState, type PollPolicy } from "./polling.js";
import { GitHubRequestCancelledError } from "../github/errors.js";
import { GitHubRateLimitError } from "../github/reads.js";
import { TrackingState } from "./retirement.js";
import { Handoffs } from "../integrations/handoffs.js";
import { readFailureExcerpt } from "./messages.js";
import {
  DeliveryState,
  supportedTrackingTarget,
  TrackingHarness,
  unfinished,
  type AgentRef,
  type AgentTarget,
  type Delivery,
  type DeliveryAttempt,
  type ObservationInput,
} from "./types.js";
import { TrackingStore } from "./store.js";
import type { TrackingConfig } from "./config.js";
import { GitHubObservationChangedError, readObservation } from "./github.js";
import { CodexConnection, DeliveryError, type AgentConnection } from "../agents/codex.js";

export interface TrackingOptions {
  repositoryEnrollment?: (prId: string, agentId: string, cwd?: string) => void;
  stateDirectory?: string;
  schedules?: ScheduleStore;
  interactive?: <T>(work: () => T) => T;
  managedQueue?: (agentId: string) => boolean;
  // Positive ownership facts apply only to recorded rows in this synchronous selection pass.
  managedQueueBatch?: (agentIds: readonly string[]) => ReadonlySet<string>;
  notificationRecorded?: (recipientAgentId: string) => void;
  failureExcerpt?: typeof readFailureExcerpt;
  read?: typeof readObservation;
  connect?: (agent: AgentRef) => AgentConnection;
  intervalMs?: number;
}

export class TrackingService {
  private handoffWork: Promise<void> | undefined;
  private handoffDirty = false;
  private handoffs: Handoffs | undefined;
  private handoffWatcher: FSWatcher | undefined;
  private handoffWatchWork: Promise<void> | undefined;
  private handoffWatchFailure: { error: Error } | undefined;
  private task: ScheduledTask | undefined;
  private refreshes = new Map<string, Promise<unknown>>();
  private refreshTriggers = new Map<string, "manual" | "poll">();
  private refreshEpochs = new Map<string, number>();
  private pollStates = new Map<string, PollState>();
  private githubRetryAt = 0;
  private deliveryBusy = false;
  private deliveryWork?: Promise<void>;
  private refreshControllers = new Map<string, AbortController>();
  private stopped = false;
  private connections = new Set<AgentConnection>();

  constructor(
    readonly store: TrackingStore,
    readonly config: TrackingConfig,
    private now: () => number = Date.now,
    private options: TrackingOptions = {},
  ) {
    this.handoffs = options.stateDirectory === undefined ? undefined : new Handoffs(options.stateDirectory, now);
    store.transaction(() => {
      const at = this.now();
      for (const a of store.attempts().filter((a) => a.outcome.state === "sending"))
        store.saveAttempt({
          ...a,
          outcome: {
            state: "uncertain",
            at,
            reason: "Coordinator restarted during delivery",
          },
        });
      for (const d of store.deliveries())
        if (d.progress.state === DeliveryState.Sending) {
          store.saveDelivery(
            {
              ...d,
              progress: {
                state: DeliveryState.Uncertain,
                at,
                reason: "Coordinator restarted during delivery",
              },
              updatedAt: at,
            },
            "delivery_uncertain",
          );
        }
    });
    store.prepareSafeRecovery();
  }

  get failureExcerpt(): typeof readFailureExcerpt {
    return this.options.failureExcerpt ?? readFailureExcerpt;
  }

  start(scheduler: WorkScheduler): void {
    this.task = scheduler.task("tracking", () => this.tick());
    if (this.handoffs) {
      const failed = (error: unknown) => {
        this.handoffWatcher?.close();
        this.handoffWatcher = undefined;
        this.handoffWatchFailure = {
          error: error instanceof Error ? error : new Error("Handoff watcher failed"),
        };
        this.task?.wake();
      };
      this.handoffWatchWork = this.handoffs
        .watch(() => {
          this.handoffChanged();
        }, failed)
        .then((watcher) => {
          if (this.stopped) watcher.close();
          else {
            this.handoffWatcher = watcher;
            this.handoffChanged();
          }
        })
        .catch(failed);
    }
    this.task.wake();
  }

  private handoffChanged(): void {
    if (this.handoffWork) this.handoffDirty = true;
    else this.task?.wake();
  }

  wake(): void {
    this.task?.wake();
  }

  inputsChanged(prId?: string): void {
    for (const [id, value] of this.deliveryNotBefore)
      if (prId === undefined || value.prId === prId) this.deliveryNotBefore.delete(id);
    this.wake();
  }

  private validateTarget(target: AgentTarget): void {
    if (!supportedTrackingTarget(target) || !Object.hasOwn(this.config.endpoints, target.endpoint))
      throw new Error("Unsupported harness or endpoint");
  }

  registerAgent(target: AgentTarget) {
    this.validateTarget(target);
    return this.store.registerAgent(target);
  }

  track(url: string, target: AgentTarget, cwd?: string) {
    this.validateTarget(target);
    const p = this.store.track(url, target);
    this.options.repositoryEnrollment?.(p.id, this.store.registerAgent(target).id, cwd);
    this.requestRefresh(p.id);
    return p;
  }

  subscribe(id: string, target: AgentTarget) {
    this.validateTarget(target);
    return this.store.subscribe(id, target);
  }

  assign(id: string, target: AgentTarget) {
    this.validateTarget(target);
    return this.store.assign(id, target);
  }

  requestRefresh(id: string): void {
    const pr = this.store.pr(id);
    if (!pr.enabled) throw new Error("PR tracking is disabled");
    if (this.stopped) throw new Error("Coordinator is stopping");
    if (this.refreshes.has(pr.id)) {
      this.refreshTriggers.set(pr.id, "manual");
      return;
    }
    const old = this.pollState(pr.id);
    const next: PollState = {
      ...old,
      epoch: pr.trackingEpoch,
      active: old?.active ?? false,
      intervalMs: this.config.polling?.minimumMs ?? 60000,
      nextAt: this.now(),
    };
    this.savePoll(pr.id, next, true);
    this.wake();
  }

  private pollState(id: string): PollState | undefined {
    const saved = this.options.schedules?.get(`tracking:${id}`);
    if (saved && saved.epoch !== undefined)
      return {
        epoch: saved.epoch,
        active: saved.active === true,
        intervalMs: saved.intervalMs,
        nextAt: saved.dueAtMs,
        ...(saved.deferredReason === undefined ? {} : { deferredReason: saved.deferredReason }),
        ...(saved.signature === undefined ? {} : { signature: saved.signature }),
      };
    return this.pollStates.get(id);
  }

  private savePoll(id: string, state: PollState, interactive = false): void {
    this.pollStates.set(id, state);
    const previous = this.options.schedules?.get(`tracking:${id}`);
    const lastError = this.store.pr(id).lastRefreshError?.message;
    this.options.schedules?.save({
      ...(previous?.lastAttemptAtMs === undefined ? {} : { lastAttemptAtMs: previous.lastAttemptAtMs }),
      ...(lastError === undefined ? {} : { lastError }),
      key: `tracking:${id}`,
      kind: RefreshKind.Tracking,
      subject: id,
      dueAtMs: state.nextAt,
      intervalMs: state.intervalMs,
      epoch: state.epoch,
      active: state.active,
      ...(state.signature === undefined ? {} : { signature: state.signature }),
      ...(state.deferredReason === undefined ? {} : { deferredReason: state.deferredReason }),
      state: interactive ? ScheduleState.Queued : ScheduleState.Deferred,
    });
  }

  refresh(id: string, trigger: "poll" | "manual" = "manual"): Promise<unknown> {
    if (this.stopped) return Promise.reject(new Error("Coordinator is stopping"));
    const p = this.store.pr(id);
    if (!p.enabled) return Promise.reject(new Error("PR tracking is disabled"));
    const existing = this.refreshes.get(p.id);
    if (existing && trigger === "manual") this.refreshTriggers.set(p.id, "manual");
    if (existing)
      return this.refreshEpochs.get(p.id) === p.trackingEpoch
        ? existing
        : existing.then(() => this.refresh(id, trigger));
    if (this.now() < this.githubRetryAt) return Promise.reject(new GitHubRateLimitError(this.githubRetryAt));
    const scheduled = this.options.schedules?.get(`tracking:${p.id}`);
    this.options.schedules?.save({
      ...scheduled,
      key: `tracking:${p.id}`,
      kind: RefreshKind.Tracking,
      subject: p.id,
      dueAtMs: scheduled?.dueAtMs ?? this.now(),
      intervalMs: scheduled?.intervalMs ?? 60000,
      state: ScheduleState.Running,
      lastAttemptAtMs: this.now(),
    });
    const controller = new AbortController();
    this.refreshControllers.set(p.id, controller);
    this.refreshTriggers.set(p.id, trigger);
    let observed: ObservationInput | undefined;
    let deferredReason: string | undefined;
    const priorReason = this.pollState(p.id)?.deferredReason ?? p.lastRefreshError?.message;
    const work = (async () => {
      try {
        const input: ObservationInput = await (this.options.read ?? readObservation)(
          p.url,
          controller.signal,
          undefined,
          this.now,
          undefined,
          this.store.checks.reconciliationChecks(p.id),
        );
        const current = this.store.pr(p.id);
        if (!this.stopped && current.enabled && current.trackingEpoch === p.trackingEpoch) {
          const accepted = this.store.observe(p.id, input, this.config, p.trackingEpoch);
          if (accepted.observation?.id !== current.observation?.id) {
            observed = input;
            if (priorReason !== undefined) this.store.refreshOutcome(p.id, "recovered", priorReason);
          }
        }
      } catch (error) {
        if (error instanceof GitHubRateLimitError) this.githubRetryAt = Math.max(this.githubRetryAt, error.retryAtMs);
        const cancelled = controller.signal.aborted || error instanceof GitHubRequestCancelledError;
        if (this.store.prContext(p.id).trackingEpoch === p.trackingEpoch) {
          const reason = (error instanceof Error ? error.message : "GitHub refresh failed").slice(0, 1000);
          if (cancelled || (!this.stopped && error instanceof GitHubObservationChangedError)) {
            deferredReason = reason;
            this.store.refreshOutcome(p.id, cancelled ? "cancelled" : "retry_scheduled", reason);
          } else if (!this.stopped) this.store.refreshError(p.id, reason);
        }
      } finally {
        const minimumMs = this.options.intervalMs ?? this.config.polling?.minimumMs ?? defaultPollPolicy.minimumMs;
        const policy: PollPolicy = {
          minimumMs,
          maximumMs: Math.max(minimumMs, this.config.polling?.maximumMs ?? defaultPollPolicy.maximumMs),
          activeMaximumMs: Math.max(
            minimumMs,
            this.config.polling?.activeMaximumMs ?? defaultPollPolicy.activeMaximumMs,
          ),
        };
        this.savePoll(p.id, {
          ...schedulePoll(
            this.pollState(p.id),
            p.trackingEpoch,
            observed,
            this.now(),
            policy,
            this.refreshTriggers.get(p.id) ?? trigger,
            this.githubRetryAt,
          ),
          ...(deferredReason === undefined ? {} : { deferredReason }),
        });
        if (this.stopped) {
          const interrupted = this.options.schedules?.get(`tracking:${p.id}`);
          if (interrupted)
            this.options.schedules?.save({
              ...interrupted,
              state: ScheduleState.Queued,
              dueAtMs: this.now(),
              deferredReason: "Interrupted refresh queued after restart",
            });
        }
        this.refreshes.delete(p.id);
        this.refreshEpochs.delete(p.id);
        this.refreshTriggers.delete(p.id);
        this.refreshControllers.delete(p.id);
        this.wake();
      }
      return this.store.pr(p.id);
    })();
    this.refreshEpochs.set(p.id, p.trackingEpoch);
    this.refreshes.set(p.id, work);
    return work;
  }

  tick(): number | undefined {
    if (this.stopped) return;
    if (this.handoffWatchFailure) {
      const { error } = this.handoffWatchFailure;
      this.handoffWatchFailure = undefined;
      throw error;
    }
    // File intake only needs a fallback while its push channel is unavailable.
    let next = this.handoffs && !this.handoffWatcher ? this.now() + 30000 : Infinity;
    if (this.handoffs && !this.handoffWork) {
      this.handoffWork = this.handoffs
        .drain((request) => {
          const existing = this.store.prContexts().find((pr) => pr.url === request.url);
          if (existing) {
            const owner = this.store.agent(existing.ownerAgentId);
            if (
              owner.harness !== request.owner.harness ||
              owner.endpoint !== request.owner.endpoint ||
              owner.sessionId !== request.owner.sessionId
            )
              return {
                accepted: false,
                reason: "PR already belongs to another agent; explicit reassignment is required",
              };
          }
          this.track(request.url, request.owner, request.cwd);
          return { accepted: true };
        })
        .catch(() => {})
        .finally(() => {
          this.handoffWork = undefined;
          if (this.handoffDirty) {
            this.handoffDirty = false;
            this.task?.wake();
          }
        });
    }
    for (const id of this.store.retirement.expire()) this.refreshControllers.get(id)?.abort();
    const queued = this.options.schedules?.queuedKeys();
    for (const p of this.store.prContexts()) {
      if (p.state === TrackingState.Draining && p.drainDeadlineAt !== undefined)
        next = Math.min(next, p.drainDeadlineAt);
      if (
        !p.enabled ||
        (p.state !== TrackingState.Watching &&
          p.state !== TrackingState.Draining &&
          queued?.has(`tracking:${p.id}`) !== true)
      )
        continue;
      if (this.now() < this.githubRetryAt) {
        next = Math.min(next, this.githubRetryAt);
        continue;
      }
      const state = this.pollState(p.id);
      if (((state?.epoch === p.trackingEpoch ? state.nextAt : undefined) ?? 0) <= this.now()) this.runPoll(p.id);
      if (!this.refreshes.has(p.id)) next = Math.min(next, Math.max(this.githubRetryAt, state?.nextAt ?? this.now()));
    }
    if (!this.deliveryBusy) {
      this.deliveryBusy = true;
      this.deliveryWork = this.deliverNext()
        .catch(() => {})
        .finally(() => {
          this.deliveryBusy = false;
          delete this.deliveryWork;
        });
      next = Math.min(next, this.deliveryDeadline);
    }
    return Number.isFinite(next) ? next : undefined;
  }

  private runPoll(id: string): void {
    const saved = this.options.schedules?.get(`tracking:${id}`);
    const run = () => this.refresh(id, saved?.state === ScheduleState.Queued ? "manual" : "poll").catch(() => {});
    if (saved?.state === ScheduleState.Queued && this.options.interactive)
      this.options.interactive(run).catch(() => {});
    else run().catch(() => {});
  }

  private usesPullInbox(agentId: string): boolean {
    return (
      Object.is(this.store.agent(agentId).harness, TrackingHarness.Pi) || this.options.managedQueue?.(agentId) === true
    );
  }

  private deliveryNotBefore = new Map<string, { at: number; prId: string }>();

  private *deliveryPlans(): Generator<{ delivery: Delivery; at: number }> {
    const candidates = this.store.deliveryCandidates();
    const managed = this.options.managedQueueBatch?.([
      ...new Set(
        candidates.filter((candidate) => candidate.messageRecorded).map((candidate) => candidate.recipientAgentId),
      ),
    ]);
    for (const d of candidates) {
      // Recorded pull-inbox work belongs to digest reconciliation; direct selection does not need its body.
      if (d.messageRecorded && (managed?.has(d.recipientAgentId) === true || this.usesPullInbox(d.recipientAgentId)))
        continue;
      const message = this.store.inbox.get(d.id);
      if (message?.acknowledgedAt !== undefined || (message && this.usesPullInbox(d.recipientAgentId))) continue;
      const replaced = this.store.inbox.isReplaced(d.id);
      let at: number | undefined;
      if (replaced) {
        if (message && (d.progress.state === DeliveryState.Uncertain || d.progress.state === DeliveryState.Delivered))
          at = message.nextCheckAt;
      } else if (d.progress.state === DeliveryState.Pending) at = d.progress.nextAttemptAt;
      else if (d.progress.state === DeliveryState.Uncertain)
        at = message?.nextCheckAt ?? this.nextUncertainCheck.get(d.id) ?? 0;
      else if (d.progress.state === DeliveryState.Delivered && message?.applicable === true) at = message.nextCheckAt;
      if (at === undefined) continue;
      const action = this.store.action(d.actionId);
      if (
        !replaced &&
        (!this.store.pr(action.prId).enabled ||
          !unfinished(action) ||
          !this.store.subscriptions.includes(action.prId, d.recipientAgentId))
      )
        continue;
      yield {
        delivery: d,
        at: Math.max(at, this.deliveryNotBefore.get(d.id)?.at ?? 0),
      };
    }
  }

  private deliveryDeadline = Infinity;

  private async deliverNext(): Promise<void> {
    this.deliveryDeadline = Infinity;
    let plan: { delivery: Delivery; at: number } | undefined;
    for (const candidate of this.deliveryPlans()) {
      if (candidate.at <= this.now()) {
        plan = candidate;
        break;
      }
      this.deliveryDeadline = Math.min(this.deliveryDeadline, candidate.at);
    }
    if (!plan) return;
    try {
      await this.deliver(plan.delivery);
    } finally {
      const current = this.store.deliveryCandidates().find((value) => value.id === plan.delivery.id);
      const message = this.store.inbox.get(plan.delivery.id);
      const next =
        current?.progress.state === DeliveryState.Pending
          ? current.progress.nextAttemptAt
          : current?.progress.state === DeliveryState.Uncertain
            ? (message?.nextCheckAt ?? this.nextUncertainCheck.get(plan.delivery.id) ?? 0)
            : current?.progress.state === DeliveryState.Delivered && message?.applicable === true
              ? message.nextCheckAt
              : undefined;
      // An unchanged due row needs bounded upkeep rather than another immediate attempt.
      if (next !== undefined && next <= this.now())
        this.deliveryNotBefore.set(plan.delivery.id, {
          at: this.now() + 30000,
          prId: this.store.action(plan.delivery.actionId).prId,
        });
      else this.deliveryNotBefore.delete(plan.delivery.id);
      this.task?.wake();
    }
  }

  private async deliver(d: Delivery): Promise<void> {
    if (this.store.inbox.isReplaced(d.id)) {
      await this.reconcileReplaced(d);
      return;
    }
    const action = this.store.action(d.actionId),
      pr = this.store.pr(action.prId),
      agent = this.store.agent(d.recipientAgentId);
    if (!pr.enabled || !unfinished(action) || !this.store.subscriptions.includes(action.prId, agent.id)) return;
    try {
      if (d.progress.state === DeliveryState.Pending && !this.store.inbox.get(d.id)) {
        const notice = this.store.noticeForAction(action, agent.id);
        this.store.transaction(() => {
          this.store.inbox.freezeNotice(d.id, notice);
          this.store.inbox.record(d.id, this.store.inbox.render(d.id, notice));
        });
        this.options.notificationRecorded?.(d.recipientAgentId);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Message capture failed";
      this.store.transaction(() => {
        this.store.saveDelivery(
          {
            ...d,
            progress: {
              state: DeliveryState.Unavailable,
              at: this.now(),
              reason: `Could not freeze notification: ${reason}`,
            },
            updatedAt: this.now(),
          },
          "delivery_unavailable",
        );
      });
      return;
    }
    if (this.usesPullInbox(agent.id)) return;
    const message = this.store.inbox.get(d.id);
    const endpoint = this.config.endpoints[agent.endpoint];
    if (!endpoint) {
      this.store.saveDelivery(
        {
          ...d,
          progress: {
            state: DeliveryState.Unavailable,
            at: this.now(),
            reason: "Recipient endpoint is not configured",
          },
          updatedAt: this.now(),
        },
        "delivery_unavailable",
      );
      return;
    }
    const connection: AgentConnection =
      this.options.connect?.(agent) ?? new CodexConnection(endpoint.socket, endpoint.delivery);
    this.connections.add(connection);
    let attempt: DeliveryAttempt | undefined;
    const reconciling =
      d.progress.state === DeliveryState.Uncertain ||
      d.progress.state === DeliveryState.Delivered ||
      this.store
        .attempts()
        .some(
          (attempt) =>
            attempt.deliveryId === d.id &&
            (attempt.outcome.state === "accepted" || attempt.outcome.state === "uncertain"),
        );
    try {
      const prepared = await connection.prepare(agent);
      if (!this.current(d)) return;
      if (prepared.version !== undefined && prepared.version !== "") this.store.runtime(agent.id, prepared.version);
      if (reconciling) {
        const found = await connection.find(agent, d.id, message?.body);
        if (message) {
          if (found.received === true && found.found && this.current(d)) this.store.acknowledgeMessage(d.id, agent.id);
          else this.store.inbox.defer(d.id, this.now() + 300000);
        }
        if (!this.stopped && found.found && this.current(d, true) && d.progress.state !== DeliveryState.Delivered)
          this.store.transaction(() => {
            this.store.saveDelivery(
              {
                ...d,
                progress: {
                  state: DeliveryState.Delivered,
                  at: this.now(),
                  ...(found.turnId === undefined ? {} : { turnId: found.turnId }),
                  ...(found.queueId === undefined ? {} : { queueId: found.queueId }),
                  ...(found.note === undefined ? {} : { note: found.note }),
                },
                updatedAt: this.now(),
              },
              "delivery_reconciled",
            );
          });
        // rationale: Bounded absence cannot prove rejection. Replays retain the same ID and immutable body so recipients can recognize duplicates.
        this.nextUncertainCheck.set(d.id, this.now() + 60000);
        if (found.found || !message) return;
      }
      if (prepared.busy) {
        if (reconciling && d.progress.state !== DeliveryState.Pending) {
          this.store.inbox.defer(d.id, this.now() + 5000);
          return;
        }
        if (this.current(d))
          this.store.transaction(() => {
            this.store.saveDelivery(
              {
                ...d,
                progress: {
                  state: DeliveryState.Pending,
                  nextAttemptAt: this.now() + 5000,
                },
                updatedAt: this.now(),
              },
              "delivery_waiting",
            );
          });
        return;
      }
      if (!this.current(d) || this.store.inbox.isReplaced(d.id) || !message || !message.notice) return;
      const previous = this.store.attempts().filter((a) => a.deliveryId === d.id);
      const started: DeliveryAttempt = {
        deliveryId: d.id,
        number: previous.length + 1,
        startedAt: this.now(),
        ...(prepared.version === undefined ? {} : { harnessVersion: prepared.version }),
        outcome: { state: "sending" },
      };
      attempt = started;
      this.store.transaction(() => {
        this.store.saveAttempt(started);
        this.store.saveDelivery(
          {
            ...d,
            progress: { state: DeliveryState.Sending, startedAt: this.now() },
            updatedAt: this.now(),
          },
          "delivery_sending",
        );
      });
      const result = await connection.send(agent, d.id, message.body);
      if (this.stopped) return;
      this.store.inbox.defer(d.id, this.now() + 300000);
      this.store.transaction(() => {
        this.store.saveAttempt({
          ...started,
          outcome: {
            state: "accepted",
            at: this.now(),
            ...(result.turnId === undefined ? {} : { turnId: result.turnId }),
            ...(result.queueId === undefined ? {} : { queueId: result.queueId }),
          },
        });
        if (this.current(d, true))
          this.store.saveDelivery(
            {
              ...d,
              progress: {
                state: DeliveryState.Delivered,
                at: this.now(),
                ...(result.turnId === undefined ? {} : { turnId: result.turnId }),
                ...(result.queueId === undefined ? {} : { queueId: result.queueId }),
                ...(result.note === undefined ? {} : { note: result.note }),
              },
              updatedAt: this.now(),
            },
            "delivery_delivered",
          );
      });
    } catch (error) {
      if (this.stopped) return;
      if (!attempt && reconciling) {
        this.store.inbox.defer(d.id, this.now() + 60000);
        this.nextUncertainCheck.set(d.id, this.now() + 60000);
        const reason = error instanceof Error ? error.message : "Receipt lookup unavailable";
        if (this.current(d) && (d.progress.state !== DeliveryState.Uncertain || d.progress.reason !== reason))
          this.store.transaction(() => {
            this.store.saveDelivery(
              {
                ...d,
                progress: {
                  state: DeliveryState.Uncertain,
                  at: this.now(),
                  reason,
                },
                updatedAt: this.now(),
              },
              "delivery_receipt_unavailable",
            );
          });
        return;
      }
      const applicable = this.current(d, true);
      if (!attempt && !applicable) return;
      const reason = error instanceof Error ? error.message : "Agent delivery failed";
      const failedAttempt: DeliveryAttempt = attempt ?? {
        deliveryId: d.id,
        number: this.store.attempts().filter((a) => a.deliveryId === d.id).length + 1,
        startedAt: this.now(),
        outcome: { state: "sending" },
      };
      const uncertain = reconciling || (error instanceof DeliveryError && error.uncertain);
      const retry = !message
        ? [5000, 30000, 120000][d.retryCount ?? 0]
        : [5000, 30000, 120000][Math.min(d.retryCount ?? 0, 2)];
      const progress: Delivery["progress"] = uncertain
        ? { state: DeliveryState.Uncertain, at: this.now(), reason }
        : (error instanceof DeliveryError && error.permanent) || retry === undefined
          ? { state: DeliveryState.Unavailable, at: this.now(), reason }
          : { state: DeliveryState.Pending, nextAttemptAt: this.now() + retry };
      this.store.transaction(() => {
        this.store.saveAttempt({
          ...failedAttempt,
          outcome: {
            state: uncertain ? "uncertain" : "rejected",
            at: this.now(),
            reason,
          },
        });
        if (applicable)
          this.store.saveDelivery(
            {
              ...d,
              retryCount: (d.retryCount ?? 0) + 1,
              progress,
              updatedAt: this.now(),
            },
            `delivery_${progress.state}`,
          );
      });
      if (uncertain) {
        this.nextUncertainCheck.set(d.id, this.now() + 60000);
        this.store.inbox.defer(d.id, this.now() + 60000);
      }
    } finally {
      this.connections.delete(connection);
      connection.close();
    }
  }

  private async reconcileReplaced(delivery: Delivery): Promise<void> {
    const message = this.store.inbox.get(delivery.id);
    const agent = this.store.agent(delivery.recipientAgentId);
    if (Object.is(agent.harness, TrackingHarness.Pi)) return;
    const endpoint = this.config.endpoints[agent.endpoint];
    if (!message || !endpoint) return;
    const connection = this.options.connect?.(agent) ?? new CodexConnection(endpoint.socket, endpoint.delivery);
    this.connections.add(connection);
    // A replacement fences sends, while exact historical receipt evidence remains independently reconcilable.
    this.store.inbox.defer(delivery.id, this.now() + 60000);
    const stopped = () => this.stopped;
    try {
      await connection.prepare(agent);
      if (stopped()) return;
      const found = await connection.find(agent, delivery.id, message.body);
      if (stopped() || !found.found) return;
      this.store.transaction(() => {
        if (found.received === true) this.store.acknowledgeMessageInside(delivery.id, agent.id);
        const current = this.store.deliveries().find((value) => value.id === delivery.id);
        if (!current || current.progress.state === DeliveryState.Cancelled) return;
        this.store.saveDelivery(
          {
            ...current,
            progress: {
              state: DeliveryState.Delivered,
              at: this.now(),
              ...(found.turnId === undefined ? {} : { turnId: found.turnId }),
              ...(found.queueId === undefined ? {} : { queueId: found.queueId }),
              ...(found.note === undefined ? {} : { note: found.note }),
            },
            updatedAt: this.now(),
          },
          "delivery_reconciled",
        );
      });
    } catch {
      // Missing history or transport failure leaves the original outcome unknown for a later read-only retry.
    } finally {
      this.connections.delete(connection);
      connection.close();
    }
  }

  private nextUncertainCheck = new Map<string, number>();

  private current(d: Delivery, includeReceived = false): boolean {
    const value = this.store.deliveries().find((x) => x.id === d.id);
    const action = this.store.action(d.actionId);
    return (
      !this.stopped &&
      !!value &&
      value.progress.state !== DeliveryState.Cancelled &&
      this.store.pr(action.prId).enabled &&
      unfinished(action) &&
      this.store.subscriptions.includes(action.prId, d.recipientAgentId) &&
      (includeReceived || this.store.inbox.get(d.id)?.acknowledgedAt === undefined)
    );
  }

  checkpointable(): boolean {
    return (
      this.handoffWork === undefined &&
      this.refreshes.size === 0 &&
      !this.deliveryBusy &&
      this.deliveryWork === undefined &&
      this.connections.size === 0 &&
      !this.store
        .deliveries()
        .some(
          (delivery) =>
            delivery.progress.state === DeliveryState.Pending ||
            delivery.progress.state === DeliveryState.Sending ||
            delivery.progress.state === DeliveryState.Uncertain,
        ) &&
      !this.store
        .attempts()
        .some((attempt) => attempt.outcome.state === "sending" || attempt.outcome.state === "uncertain")
    );
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.task?.close();
    this.handoffWatcher?.close();
    await this.handoffWatchWork;
    for (const controller of this.refreshControllers.values()) controller.abort();
    for (const c of this.connections) c.close();
    await Promise.allSettled([
      ...this.refreshes.values(),
      ...(!this.handoffWork ? [] : [this.handoffWork]),
      ...(this.deliveryWork ? [this.deliveryWork] : []),
    ]);
  }
}
