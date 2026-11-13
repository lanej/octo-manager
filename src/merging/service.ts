import { MergeDeclined } from "./async-merge.js";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { GitHubHTTPError, GitHubRateLimitError } from "../github-api.js";
import type { TrackingService } from "../tracking/service.js";
import type { ConflictStore } from "../repairs/cases.js";
import { resolveId } from "../tracking/identifiers.js";
import {
  mergeProvider,
  type MergeProvider,
  type MergeSnapshot,
} from "./github.js";
import { preparer, type Preparer } from "./preparation.js";
import { MergeStore } from "./store.js";
import {
  EffectNotStarted,
  ChainState,
  EntryState,
  OperationState,
  CommandSchema,
  checked,
  terminal,
  type MergeCommand,
  type MergeEntry,
  type MergeOperation,
  type PreparationProfile,
} from "./contracts.js";
import { checkGate, fingerprint, graphKey, readyFor } from "./policy.js";
export interface MergeOptions {
  provider?: MergeProvider;
  prepare?: Preparer;
  intervalMs?: number;
}
export class MergeService {
  private timer?: ReturnType<typeof setInterval>;
  private work: Promise<void> | undefined;
  private abort = new AbortController();
  private provider: MergeProvider;
  private prepare: Preparer;
  constructor(
    readonly store: MergeStore,
    private tracking: TrackingService,
    profiles: Record<string, PreparationProfile>,
    directory: string,
    cases: ConflictStore,
    private now: () => number,
    options: MergeOptions = {},
  ) {
    this.profiles = profiles;
    this.provider = options.provider ?? mergeProvider;
    const root = join(directory, "merge-workspaces");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.prepare = options.prepare ?? preparer(root, cases);
    this.interval = options.intervalMs ?? 1000;
    store.recover();
  }
  private profiles: Record<string, PreparationProfile>;
  private interval: number;
  start(): void {
    this.timer = setInterval(() => {
      this.tick().catch((error: unknown) => {
        console.error(
          error instanceof Error ? error.message : "Merge-chain tick failed",
        );
      });
    }, this.interval);
  }
  async close(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.abort.abort();
    await this.work;
  }
  command(value: unknown): unknown {
    const input = checked(CommandSchema, value);
    if (this.abort.signal.aborted) throw new Error("Coordinator is stopping");
    return this.dispatch(input);
  }
  private dispatch(input: MergeCommand): unknown {
    switch (input.op) {
      case "auto_merge":
        return this.store.autoMerge(
          input.pr,
          input.actorId,
          input.enabled,
          input.requestId,
        );
      case "queue":
        return this.store.queue(input.input);
      case "inspect":
        return this.store.inspect(input.id);
      case "references":
        return {
          references: this.store
            .refs()
            .filter(
              (ref) =>
                input.pr === undefined ||
                ref.prId === this.store.tracking.pr(input.pr).id,
            ),
        };
      case "dependencies":
        return {
          dependencies: this.store
            .dependencies()
            .filter(
              (edge) =>
                input.pr === undefined ||
                edge.dependentId === this.store.tracking.pr(input.pr).id,
            ),
        };
      case "confirm": {
        const profile =
          input.profile === undefined
            ? undefined
            : this.profiles[input.profile];
        if (input.profile !== undefined && profile === undefined)
          throw new Error("Unknown configured preparation profile");
        return this.store.confirm(
          input.pr,
          input.prerequisite,
          input.actorId,
          input.reason,
          input.referenceId,
          profile,
        );
      }
      case "remove":
        return this.store.removeDependency(input.id, input.actorId);
      case "decide":
        return this.store.decide(input.id, input.actorId, input.decision);
      case "policy":
        return this.store.configure(
          input.pr,
          input.actorId,
          input.checks,
          input.noCi,
        );
      case "ready":
        return this.store.ready(input.pr, input.actorId, input.head);
      case "pause":
        return this.store.control(input.id, ChainState.Paused);
      case "resume":
        return this.store.control(input.id, ChainState.Active);
      case "cancel":
        return this.store.control(input.id, ChainState.Cancelled);
      case "reconcile": {
        const ids = this.store.operations().map((op) => op.id),
          id = resolveId(input.id, ids),
          operation = this.store.operations().find((op) => op.id === id);
        if (
          operation === undefined ||
          operation.state !== OperationState.Uncertain
        )
          throw new Error("Uncertain operation not found");
        this.store.saveOperation({
          ...operation,
          detail: "Reconciliation requested",
          updatedAt: this.now(),
        });
        this.reconcileRequested.add(operation.id);
        return {
          id: operation.id,
          state: operation.state,
          detail: "Reconciliation queued; no operation will be replayed",
        };
      }
    }
  }
  private reconcileRequested = new Set<string>();
  tick(): Promise<void> {
    if (this.work !== undefined) return this.work;
    if (this.abort.signal.aborted) return Promise.resolve();
    this.work = this.run().finally(() => {
      this.work = undefined;
    });
    return this.work;
  }
  private active(entry: MergeEntry, op?: MergeOperation): boolean {
    const current = this.store.entries().find((item) => item.id === entry.id);
    const authority = (value: MergeEntry) =>
      fingerprint([
        value.autoMerge,
        value.checks,
        value.noCi,
        value.method,
        value.ready,
        value.preparationHold,
      ]);
    if (current === undefined || authority(current) !== authority(entry))
      return false;
    const pr = this.store.tracking.pr(entry.prId);
    return (
      !this.abort.signal.aborted &&
      pr.enabled &&
      entry.autoMerge &&
      this.store.chain(entry.chainId).state === ChainState.Active &&
      (op === undefined ||
        (pr.trackingEpoch === op.epoch &&
          pr.ownerAgentId === op.ownerId &&
          pr.observation?.headSha === op.head &&
          pr.observation.targetBase?.ref === op.baseRef &&
          pr.observation.targetBase.sha === op.baseSha &&
          graphKey(this.store.dependencies(), pr.id) === op.graph))
    );
  }
  private async run(): Promise<void> {
    for (const pr of this.store.tracking.prs().filter((pr) => pr.enabled))
      this.store.scan(pr);
    for (const operation of this.store
      .operations()
      .filter(
        (op) =>
          op.state === OperationState.Uncertain &&
          this.reconcileRequested.has(op.id),
      )) {
      this.reconcileRequested.delete(operation.id);
      await this.reconcile(operation);
    }
    for (const operation of this.store
      .operations()
      .filter(
        (op) =>
          op.state === OperationState.Running &&
          op.requestId !== undefined &&
          (op.nextCheckAt ?? 0) <= this.now(),
      ))
      await this.pollMerge(operation);
    for (const entry of this.store
      .entries()
      .filter(
        (entry) =>
          !terminal(entry.state) &&
          entry.nextAt <= this.now() &&
          !this.store.busy(entry.prId),
      )) {
      if (!this.active(entry)) continue;
      try {
        await this.advance(entry);
      } catch (error) {
        const fresh = this.store
          .entries()
          .find((value) => value.id === entry.id);
        if (fresh === undefined || this.store.busy(entry.prId)) continue;
        const delay =
          error instanceof GitHubRateLimitError
            ? Math.max(this.now() + 60000, error.retryAtMs)
            : this.now() + 60000;
        this.store.state(
          fresh,
          EntryState.Blocked,
          error instanceof Error
            ? error.message
            : "Merge evaluation unavailable",
          { nextAt: delay },
        );
      }
    }
    this.store.completeChains();
  }
  private async snapshot(prId: string): Promise<MergeSnapshot> {
    const pr = this.store.tracking.pr(prId),
      epoch = pr.trackingEpoch;
    const result = await this.provider.inspect(pr.url, this.abort.signal);
    this.store.tracking.observe(
      pr.id,
      result.observation,
      this.tracking.config,
      epoch,
    );
    return result;
  }
  private async advance(entry: MergeEntry): Promise<void> {
    const expectedGraph = graphKey(this.store.dependencies(), entry.prId);
    let pr = this.store.tracking.pr(entry.prId);
    const observation = pr.observation;
    if (observation === undefined) {
      this.store.state(
        entry,
        EntryState.Waiting,
        "Waiting for initial tracking evidence",
        { nextAt: this.now() + 60000 },
      );
      return;
    }
    if (observation.lifecycle !== "open") {
      const snapshot = await this.snapshot(pr.id);
      if (
        snapshot.observation.lifecycle === "merged" &&
        snapshot.mergeCommit !== undefined
      )
        this.store.state(entry, EntryState.Merged, "PR merged externally", {
          mergeCommit: snapshot.mergeCommit,
        });
      else
        this.store.state(
          entry,
          EntryState.Blocked,
          "PR closed without a confirmed merge",
          { nextAt: this.now() + 60000 },
        );
      return;
    }
    const dependencies = this.store
      .dependencies()
      .filter((edge) => edge.dependentId === pr.id);
    const preparations: {
      profile: PreparationProfile;
      commit: string;
      key: string;
    }[] = [];
    for (const dependency of dependencies) {
      const upstream = this.store.tracking.pr(dependency.prerequisiteId);
      if (upstream.observation?.lifecycle !== "merged") {
        this.store.state(
          entry,
          EntryState.Waiting,
          `Waiting for prerequisite ${upstream.url} to merge`,
          { nextAt: this.now() + 60000 },
        );
        return;
      }
      const snapshot = await this.snapshot(upstream.id);
      if (
        snapshot.observation.lifecycle !== "merged" ||
        snapshot.mergeCommit === undefined
      ) {
        this.store.state(
          entry,
          EntryState.Blocked,
          `Prerequisite has no confirmed merge commit: ${upstream.url}`,
          { nextAt: this.now() + 60000 },
        );
        return;
      }
      if (dependency.preparation !== undefined)
        preparations.push({
          profile: dependency.preparation,
          commit: snapshot.mergeCommit,
          key: fingerprint([
            dependency.id,
            dependency.preparation,
            snapshot.mergeCommit,
          ]),
        });
    }
    if (!this.active(entry)) return;
    const preparation = preparations.find(
      (item) =>
        entry.preparedKey !== fingerprint([item.key, observation.targetBase]) ||
        entry.preparedHead !== observation.headSha,
    );
    if (preparations.length > 1) {
      this.store.state(
        entry,
        EntryState.WaitingOwner,
        "Multiple preparation profiles require an owner-composed recipe",
        { nextAt: this.now() + 60000 },
      );
      return;
    }
    if (preparation !== undefined) {
      if (entry.preparationHold === true) return;
      const snapshot = await this.snapshot(pr.id);
      if (!this.active(entry)) return;
      const key = fingerprint([
        preparation.key,
        snapshot.observation.targetBase,
      ]);
      await this.execute(entry, snapshot, expectedGraph, {
        profile: preparation.profile,
        commit: preparation.commit,
        key,
      });
      return;
    }
    if (!readyFor(entry, pr, this.store.dependencies())) {
      const patch: Partial<MergeEntry> = { nextAt: this.now() + 60000 };
      const changed = entry.ready !== undefined;
      if (changed) {
        const fresh = { ...entry };
        delete fresh.ready;
        this.store.saveEntry(fresh);
        entry = fresh;
      }
      this.store.state(
        entry,
        EntryState.WaitingOwner,
        "Owner review assessment required for current head",
        patch,
      );
      return;
    }
    const snapshot = await this.snapshot(pr.id);
    pr = this.store.tracking.pr(pr.id);
    if (!this.active(entry)) return;
    if (!readyFor(entry, pr, this.store.dependencies())) {
      const fresh = { ...entry };
      delete fresh.ready;
      this.store.state(
        fresh,
        EntryState.WaitingOwner,
        "Head, target, ownership, or review feedback changed",
        { nextAt: this.now() + 60000 },
      );
      return;
    }
    const gate = checkGate(entry, snapshot);
    if (gate !== undefined) {
      this.store.state(entry, EntryState.WaitingChecks, gate, {
        nextAt: this.now() + 60000,
      });
      return;
    }
    await this.execute(entry, snapshot, expectedGraph);
  }
  private async execute(
    entry: MergeEntry,
    snapshot: MergeSnapshot,
    expectedGraph: string,
    preparation?: { profile: PreparationProfile; commit: string; key: string },
  ): Promise<void> {
    const pr = this.store.tracking.pr(entry.prId),
      target = snapshot.observation.targetBase;
    if (target === undefined) throw new Error("Target branch evidence missing");
    const at = this.now();
    let operation: MergeOperation = {
      id: randomUUID(),
      epoch: pr.trackingEpoch,
      entryId: entry.id,
      prId: pr.id,
      kind: preparation === undefined ? "merge" : "prepare",
      state: OperationState.Planned,
      phase: preparation === undefined ? "merging" : "local",
      head: snapshot.observation.headSha,
      baseRef: target.ref,
      baseSha: target.sha,
      graph: expectedGraph,
      ownerId: pr.ownerAgentId,
      createdAt: at,
      updatedAt: at,
      detail: "Operation planned",
      ...(preparation === undefined
        ? {}
        : {
            preparation: preparation.profile,
            prerequisiteCommit: preparation.commit,
            preparationKey: preparation.key,
          }),
    };
    this.store.transaction(() => {
      if (!this.active(entry, operation))
        throw new Error("Merge context changed before operation");
      this.store.saveOperation(operation);
      this.store.state(
        entry,
        preparation === undefined ? EntryState.Merging : EntryState.Preparing,
        preparation === undefined
          ? "Head-pinned merge in flight"
          : "Running deterministic preparation",
      );
    });
    try {
      if (!this.active(entry, operation))
        throw new Error("Merge chain paused, cancelled, or context changed");
      operation = { ...operation, state: OperationState.Running };
      this.store.saveOperation(operation);
      if (preparation !== undefined) {
        const head = await this.prepare({
          url: pr.url,
          operation,
          signal: this.abort.signal,
          beforePush: (head, workspace) => {
            if (!this.active(entry, operation))
              throw new Error(
                "Merge chain paused, cancelled, or context changed before push",
              );
            operation = {
              ...operation,
              phase: "pushing",
              resultHead: head,
              workspace,
              updatedAt: this.now(),
            };
            this.store.saveOperation(operation);
          },
        });
        operation = {
          ...operation,
          state: OperationState.Succeeded,
          resultHead: head,
          detail: "Preparation confirmed",
          updatedAt: this.now(),
        };
        this.store.saveOperation(operation);
        const fresh = { ...entry };
        delete fresh.ready;
        this.store.state(
          fresh,
          this.store.chain(entry.chainId).state === ChainState.Cancelled
            ? EntryState.Cancelled
            : EntryState.WaitingOwner,
          "Preparation finished; assess the resulting head",
          {
            preparedHead: head,
            preparedKey: preparation.key,
            nextAt: this.now() + 60000,
          },
        );
      } else {
        const result = await this.provider.merge(
          pr.url,
          operation.head,
          entry.method,
          this.abort.signal,
          () => {
            if (
              !this.active(entry, operation) ||
              !readyFor(
                entry,
                this.store.tracking.pr(pr.id),
                this.store.dependencies(),
              )
            )
              throw new EffectNotStarted(
                "Merge context changed before GitHub dispatch",
              );
          },
        );
        if (typeof result !== "string") {
          if (result.state === "pending") {
            this.store.saveOperation({
              ...operation,
              requestId: result.requestId,
              nextCheckAt: this.now() + 60000,
              updatedAt: this.now(),
              detail: "GitHub accepted asynchronous merge",
            });
            return;
          }
          if (result.state === "failed") throw new MergeDeclined(result.reason);
          if (result.state !== "merged") throw new Error(result.reason);
        }
        const sha = typeof result === "string" ? result : result.sha;
        operation = {
          ...operation,
          state: OperationState.Succeeded,
          mergeCommit: sha,
          detail: "GitHub confirmed merge",
          updatedAt: this.now(),
        };
        this.store.saveOperation(operation);
        this.store.state(entry, EntryState.Merged, "GitHub confirmed merge", {
          mergeCommit: sha,
        });
      }
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "Operation failed";
      const definite =
        operation.phase === "local" ||
        error instanceof EffectNotStarted ||
        error instanceof MergeDeclined ||
        (error instanceof GitHubHTTPError &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 409) ||
        error instanceof GitHubRateLimitError;
      operation = {
        ...operation,
        state: definite ? OperationState.Failed : OperationState.Uncertain,
        detail: detail.slice(0, 2000),
        updatedAt: this.now(),
      };
      this.store.saveOperation(operation);
      const fresh = { ...entry };
      delete fresh.ready;
      this.store.state(
        fresh,
        definite
          ? this.store.chain(entry.chainId).state === ChainState.Cancelled
            ? EntryState.Cancelled
            : EntryState.WaitingOwner
          : EntryState.Uncertain,
        detail,
        {
          nextAt: this.now() + 60000,
          ...(operation.kind === "prepare" && definite
            ? { preparationHold: true }
            : {}),
        },
      );
    }
  }
  private async pollMerge(operation: MergeOperation): Promise<void> {
    if (operation.requestId === undefined || this.provider.result === undefined)
      return;
    const entry = this.store
      .entries()
      .find((value) => value.id === operation.entryId);
    if (entry === undefined) return;
    try {
      const result = await this.provider.result(
        this.store.tracking.pr(operation.prId).url,
        operation.requestId,
        this.abort.signal,
      );
      if (result.state === "pending") {
        this.store.saveOperation({
          ...operation,
          nextCheckAt: this.now() + 60000,
          updatedAt: this.now(),
        });
        return;
      }
      if (result.state === "merged") {
        this.store.transaction(() => {
          this.store.saveOperation({
            ...operation,
            state: OperationState.Succeeded,
            mergeCommit: result.sha,
            updatedAt: this.now(),
            detail: "GitHub confirmed asynchronous merge",
          });
          this.store.state(entry, EntryState.Merged, "GitHub confirmed merge", {
            mergeCommit: result.sha,
          });
        });
        return;
      }
      const uncertain = result.state === "enqueued";
      this.store.saveOperation({
        ...operation,
        state: uncertain ? OperationState.Uncertain : OperationState.Failed,
        detail: result.reason.slice(0, 2000),
        updatedAt: this.now(),
      });
      const fresh = { ...entry };
      delete fresh.ready;
      this.store.state(
        fresh,
        uncertain
          ? EntryState.Uncertain
          : this.store.chain(entry.chainId).state === ChainState.Cancelled
            ? EntryState.Cancelled
            : EntryState.WaitingOwner,
        result.reason,
        { nextAt: this.now() + 60000 },
      );
    } catch (error) {
      const missing = error instanceof GitHubHTTPError && error.status === 404;
      this.store.saveOperation({
        ...operation,
        state: missing ? OperationState.Uncertain : OperationState.Running,
        detail:
          error instanceof Error
            ? error.message.slice(0, 2000)
            : "Merge result unavailable",
        nextCheckAt:
          error instanceof GitHubRateLimitError
            ? Math.max(this.now() + 60000, error.retryAtMs)
            : this.now() + 60000,
        updatedAt: this.now(),
      });
      if (missing)
        this.store.state(
          entry,
          EntryState.Uncertain,
          "Asynchronous merge result expired; reconcile the remote PR before proceeding",
        );
    }
  }
  private async reconcile(operation: MergeOperation): Promise<void> {
    const entry = this.store
      .entries()
      .find((entry) => entry.id === operation.entryId);
    if (entry === undefined) return;
    try {
      const snapshot = await this.snapshot(operation.prId);
      if (
        operation.kind === "merge" &&
        snapshot.observation.lifecycle === "merged" &&
        snapshot.mergeCommit !== undefined
      ) {
        this.store.saveOperation({
          ...operation,
          state: OperationState.Succeeded,
          mergeCommit: snapshot.mergeCommit,
          updatedAt: this.now(),
          detail: "PR now merged; original merge attribution remains uncertain",
        });
        this.store.state(
          entry,
          EntryState.Merged,
          "Merged state confirmed after uncertain attempt",
          { mergeCommit: snapshot.mergeCommit },
        );
      } else if (
        operation.kind === "prepare" &&
        operation.resultHead !== undefined &&
        snapshot.observation.headSha === operation.resultHead
      ) {
        this.store.saveOperation({
          ...operation,
          state: OperationState.Succeeded,
          updatedAt: this.now(),
          detail: "Prepared head confirmed on GitHub",
        });
        const fresh = { ...entry };
        delete fresh.ready;
        this.store.state(
          fresh,
          this.store.chain(entry.chainId).state === ChainState.Cancelled
            ? EntryState.Cancelled
            : EntryState.WaitingOwner,
          "Prepared head confirmed; owner readiness required",
          {
            preparedHead: operation.resultHead,
            ...(operation.preparationKey === undefined
              ? {}
              : { preparedKey: operation.preparationKey }),
            nextAt: this.now() + 60000,
          },
        );
      } else
        this.store.state(
          entry,
          EntryState.Uncertain,
          "Remote outcome remains inconclusive; operation will not be replayed",
          { nextAt: this.now() + 60000 },
        );
    } catch (error) {
      this.store.state(
        entry,
        EntryState.Uncertain,
        error instanceof Error ? error.message : "Reconciliation unavailable",
        { nextAt: this.now() + 60000 },
      );
    }
  }
}
