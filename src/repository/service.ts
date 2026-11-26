import { RepositoryPolicyMonitor } from "./monitor.js";
import { inheritedAutomation, matchesBinding } from "./policy.js";
import { RepositoryPolicyStore } from "./store.js";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { githubRepository } from "../publication/contract.js";
import type { TrackingStore } from "../tracking/store.js";
import type { AgentMessage } from "../tracking/inbox.js";
import { OperationState } from "../merging/contracts.js";
import { receiptContext } from "../merging/receipts.js";
import { CheckWatchState } from "../tracking/checks.js";
import { EntryState, terminal } from "../merging/contracts.js";
import { NotificationState } from "./contracts.js";
import type { MergeStore } from "../merging/store.js";
import { defaults, type AutomationPolicy, type Instructions } from "./contracts.js";
export class RepositoryPolicies {
  private monitor = new RepositoryPolicyMonitor();
  private reconcileAt: number | undefined;
  private watchRetryAt: number | undefined;
  constructor(
    private store: RepositoryPolicyStore,
    private tracking: TrackingStore,
    private merging: MergeStore,
    private event: (kind: string, detail: string, prId?: string) => void,
  ) {}
  watch(changed: () => void): void {
    this.monitor.start(changed);
  }
  scheduled(now: number): number | undefined {
    if (this.reconcileAt !== undefined && now >= this.reconcileAt) {
      this.monitor.invalidate();
      this.reconcileAt = undefined;
    }
    if (this.watchRetryAt !== undefined && now >= this.watchRetryAt) {
      this.monitor.retryUnavailable();
      this.watchRetryAt = undefined;
    }
    const { monitorFiles } = this.tick(false);
    if (!monitorFiles) {
      this.watchRetryAt = undefined;
      return (this.reconcileAt = undefined);
    }
    // Watcher failure retries are bounded; a slow safety pass recovers missed filesystem events.
    this.reconcileAt ??= now + 300000;
    if (this.monitor.retryNeeded()) this.watchRetryAt ??= now + 5000;
    else this.watchRetryAt = undefined;
    return Math.min(this.reconcileAt, this.watchRetryAt ?? Infinity);
  }
  close(): void {
    this.monitor.close();
    this.reconcileAt = undefined;
    this.watchRetryAt = undefined;
  }
  get(prId: string): AutomationPolicy | undefined {
    return this.store.get(prId);
  }
  bind(prId: string, agentId: string, cwd?: string): void {
    if (cwd === undefined || this.tracking.pr(prId).ownerAgentId !== agentId) return;
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 2000,
        maxBuffer: 65536,
      }).trim();
    let root: string;
    try {
      root = realpathSync(git("rev-parse", "--show-toplevel"));
      const repository = new URL(this.tracking.pr(prId).url).pathname.split("/").slice(1, 3).join("/").toLowerCase();
      const remotes = git("config", "--get-regexp", "^remote\\..*\\.url$").split("\n");
      if (!remotes.some((line) => githubRepository(line.slice(line.indexOf(" ") + 1))?.toLowerCase() === repository))
        return;
    } catch {
      return;
    }
    const pr = this.tracking.pr(prId);
    const prior = this.get(prId);
    this.store.save({
      prId,
      root,
      ownerId: agentId,
      epoch: pr.trackingEpoch,
      status: "missing",
      hash: "",
      autoMerge: false,
      instructions: prior?.ownerId === agentId && prior.epoch === pr.trackingEpoch ? prior.instructions : {},
    });
    this.tick();
  }
  tick(refresh = true): { monitorFiles: boolean } {
    if (refresh) this.monitor.invalidate();
    let monitorFiles = false;
    const roots = new Set<string>();
    const contexts = this.tracking.prContexts();
    // Binding and merge decisions use current durable state; only file parsing is retained.
    const policies = this.store.enabledPolicies();
    const stale = contexts.filter((pr) => {
      const prior = policies.get(pr.id);
      return pr.enabled && prior !== undefined && !matchesBinding(prior, pr);
    });
    const disable = this.merging.inheritedDisableCandidates(stale.map((pr) => pr.id));
    for (const pr of contexts) {
      const prior = policies.get(pr.id);
      if (prior === undefined || !pr.enabled) continue;
      if (!matchesBinding(prior, pr)) {
        if (disable.has(pr.id)) this.merging.disableInherited(pr.id);
        const error = "Repository policy requires enrollment by the current owner and tracking epoch";
        if (prior.error !== error) {
          this.store.save({
            ...prior,
            status: "invalid",
            autoMerge: false,
            error,
          });
          this.event("repository_policy_updated", error, pr.id);
        }
        continue;
      }
      monitorFiles = true;
      roots.add(prior.root);
      const loaded = this.monitor.read(prior.root);
      const next: AutomationPolicy =
        loaded instanceof Error
          ? {
              ...prior,
              status: "invalid",
              hash: `error:${loaded.message}`,
              autoMerge: false,
              error: loaded.message,
            }
          : {
              prId: prior.prId,
              root: prior.root,
              ownerId: prior.ownerId,
              epoch: prior.epoch,
              ...loaded,
              ...(loaded.status === "missing"
                ? {
                    instructions: prior.instructions,
                    ...(prior.status !== "missing" || prior.error !== undefined
                      ? { error: "Repository policy file is missing" }
                      : {}),
                  }
                : {}),
            };
      if (JSON.stringify(prior) !== JSON.stringify(next)) {
        this.store.save(next);
        this.event(
          "repository_policy_updated",
          next.error ?? `Repository policy ${next.status}${next.stage === undefined ? "" : ` (${next.stage})`}`,
          pr.id,
        );
      }
      const entries = this.merging.entries(pr.id);
      let checksComplete: boolean | undefined;
      let decision = inheritedAutomation(next, entries, undefined, checksComplete);
      if (decision === "inspect_checks") {
        const observation = this.tracking.pr(pr.id).observation;
        checksComplete =
          observation?.checks.state === "complete" &&
          (observation.workflows === undefined || observation.workflows.state === "complete");
        decision = inheritedAutomation(next, entries, undefined, checksComplete);
      }
      if (decision === "inspect_setting") {
        const explicit = this.merging.settingSource(pr.id) === "explicit";
        decision = inheritedAutomation(next, entries, explicit, checksComplete);
      }
      if (decision === "apply" || decision === "revoke") {
        this.merging.autoMerge(
          pr.id,
          pr.ownerAgentId,
          next.autoMerge,
          `repository:${pr.id}:${String(pr.trackingEpoch)}`,
          undefined,
          "inherited",
        );
        this.merging.policyStage(pr.id, next.stage);
      }
    }
    this.monitor.retain(roots);
    return { monitorFiles };
  }
  forMessage(message: AgentMessage): string | undefined {
    const actionId = message.actionId === "" ? this.merging.readinessAction(message.id) : message.actionId;
    const action = actionId === undefined ? undefined : this.tracking.action(actionId);
    const prId = action?.prId ?? message.workflowPRId;
    if (prId === undefined) return undefined;
    const noticeEntry = this.merging.noticeEntry(message.id);
    const entry = noticeEntry ?? this.merging.entries(prId).find((value) => !terminal(value.state));
    let state: NotificationState | undefined;
    if (entry !== undefined && noticeEntry !== undefined) {
      if (entry.state === EntryState.Merged) state = NotificationState.Merged;
      else if (entry.state === EntryState.Uncertain) state = NotificationState.MergeUncertain;
      else if (entry.state === EntryState.WaitingOwner) {
        const pr = this.tracking.pr(prId);
        const failed = this.merging
          .operations(prId)
          .some(
            (operation) =>
              operation.entryId === entry.id &&
              operation.epoch === pr.trackingEpoch &&
              operation.head === pr.observation?.headSha &&
              operation.state === OperationState.Failed,
          );
        state =
          failed && entry.ready === undefined ? NotificationState.MergeBlocked : NotificationState.OwnerReviewRequired;
      } else if (entry.state === EntryState.Blocked) state = NotificationState.MergeBlocked;
    } else if (action !== undefined) {
      switch (action.blocker.kind) {
        case "review_feedback":
        case "changes_requested":
          state = NotificationState.ReviewFeedback;
          break;
        case "check_failed":
          state = NotificationState.ChecksFailed;
          break;
        case "conflict":
          state = NotificationState.MergeConflict;
          break;
        case "check_results": {
          const blocker = action.blocker;
          const pr = this.tracking.pr(prId);
          if (blocker.state !== CheckWatchState.Completed || blocker.headSha !== pr.observation?.headSha) break;
          if (
            blocker.checks.some((check) =>
              ["failure", "timed_out", "cancelled", "action_required", "startup_failure"].includes(check.conclusion),
            )
          ) {
            state = NotificationState.ChecksFailed;
            break;
          }
          const dependencies = this.merging
            .dependencies()
            .some(
              (edge) =>
                edge.dependentId === prId && this.tracking.pr(edge.prerequisiteId).observation?.lifecycle !== "merged",
            );
          const cached = this.merging.noticeReadiness(prId);
          state = dependencies
            ? NotificationState.DependenciesPending
            : entry?.state === EntryState.WaitingOwner
              ? NotificationState.OwnerReviewRequired
              : cached?.eligible === true &&
                  cached.target.actionId === action.id &&
                  cached.target.context === receiptContext(this.merging, pr)
                ? NotificationState.Ready
                : undefined;
          break;
        }
      }
    }
    return state === undefined ? undefined : this.instructions(prId, message.recipientAgentId, [state]);
  }
  instructions(prId: string, agentId: string, states: NotificationState[]): string | undefined {
    const pr = this.tracking.pr(prId),
      policy = this.get(prId);
    if (agentId !== pr.ownerAgentId) return undefined;
    const configured: Instructions =
      policy?.ownerId === agentId && policy.epoch === pr.trackingEpoch ? policy.instructions : {};
    const text = [...new Set(states.map((state) => configured[state] ?? defaults[state]))]
      .filter((value) => value !== "")
      .join("\n");
    return text === "" ? undefined : text;
  }
}
