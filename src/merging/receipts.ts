import { shortId } from "../tracking/identifiers.js";
import { CheckWatchState } from "../tracking/checks.js";
import type { AgentMessage } from "../tracking/inbox.js";
import type { TrackingService } from "../tracking/service.js";
import {
  ActionState,
  type Action,
  type PRObservation,
  type TrackedPR,
} from "../tracking/types.js";
import { checkGate, feedbackKey, fingerprint, graphKey } from "./policy.js";
import { currentMergeChecks } from "./checks.js";
import {
  ChainState,
  EntryState,
  terminal,
  type MergeEntry,
} from "./contracts.js";
import type { MergeSnapshot } from "./github.js";
import type { MergeStore } from "./store.js";
import type { MessagePresentation, ReceiptTarget } from "./receipt-types.js";

// Observation time alone does not invalidate the decision. Evidence and authority do.
export function receiptContext(store: MergeStore, pr: TrackedPR): string {
  const o = pr.observation;
  return fingerprint([
    pr.trackingEpoch,
    pr.ownerAgentId,
    o?.headSha,
    o?.targetBase,
    o?.lifecycle,
    o?.mergeability,
    o?.checks,
    o?.workflows,
    o?.reviews,
    o === undefined ? undefined : feedbackKey(o),
    graphKey(store.dependencies(), pr.id),
  ]);
}
export class ReceiptMerges {
  constructor(
    private store: MergeStore,
    private tracking: TrackingService,
    private inspect: (
      prId: string,
      observation: PRObservation,
    ) => Promise<MergeSnapshot>,
    private now: () => number,
  ) {}
  private selection(message: AgentMessage) {
    if (!message.applicable) return undefined;
    const actionId =
      message.actionId === ""
        ? this.store.readinessAction(message.id)
        : message.actionId;
    if (actionId === undefined) return undefined;
    return this.candidate(this.tracking.store.action(actionId));
  }
  private candidate(action: Action) {
    const pr = this.tracking.store.pr(action.prId);
    const blocker = action.blocker;
    if (
      ![
        ActionState.Open,
        ActionState.Acknowledged,
        ActionState.Working,
      ].includes(action.progress.state) ||
      blocker.kind !== "check_results" ||
      blocker.state !== CheckWatchState.Completed ||
      !/^[a-f0-9]{40}([a-f0-9]{24})?$/u.test(blocker.headSha) ||
      blocker.headSha !== pr.observation?.headSha ||
      pr.observation.lifecycle !== "open" ||
      blocker.checks.length === 0 ||
      blocker.checks.some(
        (c) => !["success", "neutral", "skipped"].includes(c.conclusion),
      )
    )
      return undefined;
    return { action, pr };
  }
  private policyKey(pr: TrackedPR): string {
    const entry = this.store
      .entries()
      .find((e) => e.prId === pr.id && !terminal(e.state));
    return fingerprint(
      entry === undefined
        ? null
        : [
            entry.id,
            entry.method,
            entry.checks,
            entry.noCi,
            entry.autoMerge,
            entry.state,
            this.store.chain(entry.chainId).state,
            this.store.busy(pr.id),
          ],
    );
  }
  presentation = (message: AgentMessage): MessagePresentation => {
    const selected = this.selection(message);
    if (selected === undefined) return {};
    const { action, pr } = selected;
    if (
      pr.observation === undefined ||
      feedbackKey(pr.observation) === undefined
    )
      return { summary: "Checks passed · review status unavailable" };
    const cached = this.store.noticeReadiness(pr.id);
    if (
      cached === undefined ||
      cached.target.actionId !== action.id ||
      cached.target.context !== receiptContext(this.store, pr) ||
      cached.policy !== this.policyKey(pr) ||
      cached.retryAt <= this.now()
    )
      return { defer: true };
    return cached.eligible
      ? {
          summary: "Ready",
          ...(message.recipientAgentId === pr.ownerAgentId
            ? { mergeTarget: cached.target }
            : {}),
        }
      : {
          summary: `${action.blocker.kind === "check_results" && action.blocker.checks.every((check) => check.conclusion === "success") ? "Checks passed" : "Checks complete"} · ${cached.reason}`,
        };
  };
  async refresh(): Promise<void> {
    for (const pr of this.tracking.store.prs()) {
      if (!pr.enabled) continue;
      if (
        !this.tracking.store.subscriptions.list(pr).some((participant) => {
          const agent = this.tracking.store.agent(participant.agentId);
          return (
            this.tracking.config.endpoints[agent.endpoint]?.delivery === "queue"
          );
        })
      )
        continue;
      const selected = this.tracking.store
        .actions()
        .filter((action) => action.prId === pr.id)
        .map((action) => this.candidate(action))
        .find((candidate) => candidate !== undefined);
      if (
        selected === undefined ||
        selected.pr.observation === undefined ||
        feedbackKey(selected.pr.observation) === undefined
      ) {
        const prior = this.store.noticeReadiness(pr.id);
        if (prior !== undefined)
          this.store.notice(
            pr,
            "entry",
            `ready:${prior.target.actionId}`,
            "retired",
            "",
            false,
          );
        continue;
      }
      const old = this.store.noticeReadiness(pr.id);
      const context = receiptContext(this.store, pr);
      const policyKey = this.policyKey(pr);
      if (
        old?.target.actionId === selected.action.id &&
        old.target.context === context &&
        old.policy === policyKey &&
        old.retryAt > this.now()
      )
        continue;
      const target: ReceiptTarget = {
        prId: pr.id,
        actionId: selected.action.id,
        ownerId: pr.ownerAgentId,
        epoch: pr.trackingEpoch,
        head: selected.pr.observation.headSha,
        context,
        method: "squash",
      };
      let reason = "Merge readiness unavailable",
        eligible = false;
      try {
        const snapshot = await this.inspect(pr.id, selected.pr.observation);
        const fresh = this.tracking.store.pr(pr.id);
        const existing = this.store
          .entries()
          .find((e) => e.prId === pr.id && !terminal(e.state));
        target.method = existing?.method ?? snapshot.methods[0] ?? "squash";
        const policy = existing ?? {
          method: target.method,
          checks: [
            ...new Set(
              currentMergeChecks(snapshot.observation).map((c) => c.name),
            ),
          ],
          noCi: false,
        };
        const dependencies = this.store
          .dependencies()
          .filter((d) => d.dependentId === pr.id);
        reason =
          receiptContext(this.store, fresh) !== context ||
          this.policyKey(fresh) !== policyKey
            ? "PR changed; waiting for current evidence"
            : dependencies.some(
                  (d) =>
                    this.store.tracking.pr(d.prerequisiteId).observation
                      ?.lifecycle !== "merged" || d.preparation !== undefined,
                )
              ? "dependency requirements remain"
              : existing !== undefined &&
                  (this.store.chain(existing.chainId).state !==
                    ChainState.Active ||
                    this.store.busy(pr.id))
                ? "merge policy is paused or already busy"
                : (checkGate(policy, snapshot) ?? "");
        if (reason === "GitHub review gate: REVIEW_REQUIRED")
          reason = "awaiting review";
        else if (reason === "GitHub review gate: CHANGES_REQUESTED")
          reason = "review changes requested";
        else if (reason === "PR is a draft") reason = "draft";
        eligible = reason === "";
      } catch (error) {
        reason = `Readiness unavailable: ${error instanceof Error ? error.message.slice(0, 900) : "eligibility read failed"}`;
      }
      if (old !== undefined && old.target.actionId !== target.actionId)
        this.store.notice(
          pr,
          "entry",
          `ready:${old.target.actionId}`,
          "retired",
          "",
          false,
        );
      const revision = fingerprint([target, policyKey, eligible, reason]);
      if (!eligible)
        this.store.notice(
          pr,
          "entry",
          `ready:${target.actionId}`,
          revision,
          "",
          false,
        );
      const unreadCompletion = this.tracking.store.inbox
        .list(pr.ownerAgentId, 0, false, true)
        .messages.some((message) => message.actionId === target.actionId);
      if (
        eligible &&
        !unreadCompletion &&
        (old === undefined ||
          !old.eligible ||
          old.target.context !== context ||
          old.policy !== policyKey)
      ) {
        const number = new URL(pr.url).pathname.split("/").at(-1) ?? "";
        this.store.notice(
          pr,
          "entry",
          `ready:${target.actionId}`,
          revision,
          `[PR #${number}](${pr.url}) · Ready`,
          true,
        );
      }
      this.store.saveNoticeReadiness({
        target,
        policy: policyKey,
        checkedAt: this.now(),
        retryAt: this.now() + 300000,
        eligible,
        reason,
      });
      return; // One optional eligibility inspection per scheduler tick.
    }
  }
  request(target: ReceiptTarget, dispatchId: string, agentId: string) {
    const previous = this.store.receiptRequest(dispatchId);
    if (previous !== undefined)
      return previous.current
        ? this.result(previous.entry)
        : {
            state: "blocked",
            pr: this.tracking.store.pr(previous.entry.prId).url,
            reason: "A newer owner decision superseded this merge request",
          };
    const pr = this.tracking.store.pr(target.prId);
    if (pr.ownerAgentId !== agentId || target.ownerId !== agentId)
      throw new Error("PR belongs to another owner");
    if (
      !pr.enabled ||
      pr.trackingEpoch !== target.epoch ||
      pr.observation?.headSha !== target.head ||
      receiptContext(this.store, pr) !== target.context
    )
      return {
        state: "blocked",
        pr: pr.url,
        reason: "PR changed since this notice; inspect the current revision",
      };
    let entry = this.store
      .entries()
      .find((e) => e.prId === pr.id && !terminal(e.state));
    if (
      entry !== undefined &&
      (this.store.busy(pr.id) ||
        this.store.chain(entry.chainId).state !== ChainState.Active)
    )
      return {
        state: "blocked",
        pr: pr.url,
        reason:
          "Existing merge operation or paused merge policy requires attention",
      };
    if (entry === undefined) {
      const o = pr.observation;
      this.store.queue({
        requestId: `receipt:${dispatchId}`,
        actorId: agentId,
        entries: [
          {
            prUrl: pr.url,
            method: target.method,
            checks: [...new Set(currentMergeChecks(o).map((c) => c.name))],
          },
        ],
      });
      entry = { ...this.store.entry(pr.id), autoMerge: false };
      this.store.saveEntry(entry);
    }
    entry = this.store.ready(pr.id, agentId, target.head, {
      id: dispatchId,
      context: target.context,
    });
    this.store.saveReceiptRequest(dispatchId, entry);
    return this.result(entry);
  }
  private result(entry: MergeEntry) {
    return {
      state: entry.state === EntryState.WaitingChecks ? "queued" : entry.state,
      pr: this.tracking.store.pr(entry.prId).url,
      entry: shortId(entry.id),
      chain: shortId(entry.chainId),
      detail: entry.detail,
    };
  }
}
