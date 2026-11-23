import { shortId } from "../tracking/identifiers.js";
import { CheckWatchState } from "../tracking/checks.js";
import type { AgentMessage } from "../tracking/inbox.js";
import type { TrackingService } from "../tracking/service.js";
import {
  ActionState,
  TrackingHarness,
  type Action,
  type PRObservation,
  type TrackedPR,
} from "../tracking/types.js";
import {
  checkGate,
  feedbackKey,
  fingerprint,
  graphKey,
  reviewGate,
} from "./policy.js";
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
function publicReason(reason: string): string {
  return reason.startsWith("Readiness unavailable:")
    ? "readiness unavailable"
    : reason;
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
    private repositoryInstructions?: (
      message: AgentMessage,
    ) => string | undefined,
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
    const blocker = action.blocker;
    if (
      ![
        ActionState.Open,
        ActionState.Acknowledged,
        ActionState.Working,
      ].includes(action.progress.state) ||
      blocker.kind !== "check_results"
    )
      return undefined;
    const pr = this.tracking.store.pr(action.prId);
    if (
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
    const entry = this.store.entries(pr.id).find((e) => !terminal(e.state));
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
            entry.ready?.source,
            entry.ready?.head,
            entry.ready?.feedback,
            this.store.chain(entry.chainId).state,
            this.store.busy(pr.id),
          ],
    );
  }
  presentation = (message: AgentMessage): MessagePresentation => {
    const prId =
      message.workflowPRId ??
      message.participantPRId ??
      (message.actionId === ""
        ? undefined
        : this.tracking.store.action(message.actionId).prId);
    const taskInstructions =
      prId === undefined
        ? undefined
        : this.store.agentInstructions(prId, message.recipientAgentId);
    const readiness = this.readinessPresentation(message);
    const instructions = [
      readiness.instructions,
      this.repositoryInstructions?.(message),
      taskInstructions,
    ]
      .filter((value) => value !== undefined && value !== "")
      .join("\n");
    return {
      ...readiness,
      ...(instructions === "" ? {} : { instructions }),
    };
  };
  private readinessPresentation(message: AgentMessage): MessagePresentation {
    const selected = this.selection(message);
    if (selected === undefined) return {};
    const { action, pr } = selected;
    if (
      pr.observation === undefined ||
      feedbackKey(pr.observation) === undefined
    )
      return {
        summary: "Checks passed · review status unavailable",
        status: "review_unavailable",
      };
    const cached = this.store.noticeReadiness(pr.id);
    if (
      cached === undefined ||
      cached.inspectionError !== undefined ||
      cached.target.actionId !== action.id ||
      cached.target.context !== receiptContext(this.store, pr) ||
      cached.policy !== this.policyKey(pr) ||
      cached.retryAt <= this.now()
    )
      return { defer: true };
    return cached.eligible
      ? {
          summary: "Ready",
          status: "ready",
          ...(message.recipientAgentId === pr.ownerAgentId
            ? { mergeTarget: cached.target }
            : {}),
        }
      : {
          status:
            cached.reason === "Review feedback requires owner assessment"
              ? "feedback_assessment"
              : "blocked",
          summary: `${action.blocker.kind === "check_results" && action.blocker.checks.every((check) => check.conclusion === "success") ? "Checks passed" : "Checks complete"} · ${publicReason(cached.reason)}`,
          ...(cached.reason === "Review feedback requires owner assessment"
            ? {
                instructions: `Review and address current feedback or record its accepted disposition, then attest with \`octo-manager pr ready ${pr.url} --head ${pr.observation.headSha}\`.`,
              }
            : {}),
        };
  }
  async refresh(): Promise<void> {
    for (const metadata of this.tracking.store.prContexts()) {
      let pr: TrackedPR = metadata;
      if (!pr.enabled) continue;
      const prior = this.store.noticeReadiness(pr.id);
      const entries = this.store.entries(pr.id);
      const head = entries.some((entry) => entry.state === EntryState.Merged)
        ? this.tracking.store.observationHead(pr.id)
        : undefined;
      const merged = entries.some(
        (entry) =>
          entry.state === EntryState.Merged && entry.ready?.head === head,
      );
      if (merged) {
        if (prior !== undefined)
          this.store.notice(
            pr,
            "entry",
            `ready:${prior.target.actionId}`,
            "merged",
            "",
            false,
          );
        continue;
      }
      const authorized = entries.find((entry) => !terminal(entry.state));
      if (
        this.store.busy(pr.id) ||
        (authorized?.ready !== undefined &&
          authorized.state === EntryState.WaitingChecks &&
          this.store.chain(authorized.chainId).state === ChainState.Active &&
          (authorized.autoMerge || authorized.receiptId !== undefined))
      )
        continue;
      const readinessRecipients = this.tracking.store.subscriptions
        .list(pr)
        .filter((participant) => {
          const agent = this.tracking.store.agent(participant.agentId);
          return (
            Object.is(agent.harness, TrackingHarness.Pi) ||
            this.tracking.config.endpoints[agent.endpoint]?.delivery === "queue"
          );
        })
        .map((participant) => participant.agentId)
        .sort();
      if (readinessRecipients.length === 0) continue;
      const selected = this.tracking.store
        .actions(pr.id)
        .toReversed()
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
      if (
        !selected.pr.enabled ||
        selected.pr.ownerAgentId !== pr.ownerAgentId ||
        selected.pr.trackingEpoch !== pr.trackingEpoch
      )
        continue;
      pr = selected.pr;
      const old = this.store.noticeReadiness(pr.id);
      const context = receiptContext(this.store, pr);
      const policyKey = this.policyKey(pr);
      if (
        old?.target.actionId === selected.action.id &&
        old.target.context === context &&
        old.policy === policyKey &&
        (old.inspectionError !== undefined ||
          JSON.stringify(old.recipients) ===
            JSON.stringify(readinessRecipients)) &&
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
        policy: policyKey,
        method: "squash",
      };
      target.method = authorized?.method ?? "squash";
      const dependencyBlocked = this.store
        .dependencies()
        .some(
          (d) =>
            d.dependentId === pr.id &&
            (this.store.tracking.pr(d.prerequisiteId).observation?.lifecycle !==
              "merged" ||
              d.preparation !== undefined),
        );
      let reason = "dependency requirements remain",
        eligible = false;
      try {
        if (!dependencyBlocked) {
          const snapshot = await this.inspect(pr.id, selected.pr.observation);
          const fresh = this.tracking.store.pr(pr.id);
          const existing = this.store
            .entries(pr.id)
            .find((e) => !terminal(e.state));
          target.method = existing?.method ?? snapshot.methods[0] ?? "squash";
          const assessment = this.store.ownerAssessment(fresh);
          const policy = {
            method: target.method,
            checks: existing?.checks ?? [
              ...new Set(
                currentMergeChecks(snapshot.observation).map(
                  (check) => check.name,
                ),
              ),
            ],
            noCi: existing?.noCi ?? false,
            ...(assessment === undefined ? {} : { ready: assessment }),
          };
          reason =
            receiptContext(this.store, fresh) !== context ||
            this.policyKey(fresh) !== policyKey
              ? "PR changed; waiting for current evidence"
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
        }
      } catch (error) {
        // A failed read is not evidence that eligibility changed. Keep the last
        // decision for deduplication, but suppress its offer until revalidated.
        const sameDecision =
          old?.target.actionId === target.actionId &&
          old.target.context === context &&
          old.policy === policyKey;
        this.store.saveNoticeReadiness({
          ...(sameDecision
            ? old
            : {
                target,
                policy: policyKey,
                generation: (old?.generation ?? 0) + 1,
                recipients: readinessRecipients,
                eligible: false,
                reason: "readiness unavailable",
              }),
          checkedAt: this.now(),
          retryAt: this.now() + 300000,
          inspectionError:
            error instanceof Error
              ? error.message.slice(0, 1000)
              : "eligibility read failed",
        });
        return;
      }
      const semantic = fingerprint([
        target,
        policyKey,
        eligible,
        publicReason(reason),
      ]);
      const changed =
        old === undefined ||
        semantic !==
          fingerprint([
            old.target,
            old.policy,
            old.eligible,
            publicReason(old.reason),
          ]);
      const generation =
        old === undefined ? 1 : old.generation + (changed ? 1 : 0);
      this.store.transaction(() => {
        if (old !== undefined && old.target.actionId !== target.actionId)
          this.store.notice(
            pr,
            "entry",
            `ready:${old.target.actionId}`,
            "retired",
            "",
            false,
          );
        const number = new URL(pr.url).pathname.split("/").at(-1) ?? "";
        if (
          changed ||
          JSON.stringify(old.recipients) !== JSON.stringify(readinessRecipients)
        ) {
          this.store.notice(
            pr,
            "entry",
            `ready:${target.actionId}`,
            `${String(generation)}:${semantic}`,
            `[PR #${number}](${pr.url}) · ${eligible ? "Ready" : `Checks complete · ${publicReason(reason)}`}`,
            true,
            readinessRecipients,
          );
        }
        for (const action of this.tracking.store
          .actions()
          .filter((action) => action.prId === pr.id)) {
          if (this.candidate(action) !== undefined)
            this.tracking.store.replaceCompletionNotifications(
              action.id,
              readinessRecipients,
            );
        }
        this.store.saveNoticeReadiness({
          target,
          policy: policyKey,
          checkedAt: this.now(),
          generation,
          recipients: readinessRecipients,
          retryAt: this.now() + 300000,
          eligible,
          reason,
        });
      });
      return; // One optional eligibility inspection per scheduler tick.
    }
  }
  inboxReadyHead(message: AgentMessage): string | undefined {
    if (
      message.workflowPRId === undefined ||
      this.store.readinessAction(message.id) === undefined ||
      !Object.is(
        this.tracking.store.agent(message.recipientAgentId).harness,
        TrackingHarness.Pi,
      )
    )
      return undefined;
    return this.presentation(message).mergeTarget?.head;
  }
  requestFromInbox(id: string, agentId: string, url: string, head: string) {
    const agent = this.tracking.store.agent(agentId);
    const pr = this.tracking.store.pr(url);
    const message = this.tracking.store.inbox.get(id);
    if (
      !Object.is(agent.harness, TrackingHarness.Pi) ||
      pr.ownerAgentId !== agentId ||
      message?.recipientAgentId !== agentId ||
      message.workflowPRId !== pr.id ||
      this.store.readinessAction(message.id) === undefined ||
      !/^[a-f0-9]{40}([a-f0-9]{24})?$/u.test(head)
    )
      throw new Error("Invalid Pi merge receipt or ownership");

    const dispatchId = `pi-inbox:${message.id}:${head}`;
    const previous = this.store.receiptRequest(dispatchId);
    if (previous !== undefined) {
      if (!previous.current)
        return {
          state: "blocked",
          pr: url,
          reason: "A newer owner decision superseded this merge request",
        };
      return this.result(previous.entry);
    }
    const target = this.presentation(message).mergeTarget;
    if (target?.prId !== pr.id || target.head !== head)
      return {
        state: "blocked",
        pr: url,
        reason: "This Pi notice does not authorize the expected head",
      };
    this.tracking.store.acknowledgeMessageInside(message.id, agentId);
    return this.request(target, dispatchId, agentId);
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
      receiptContext(this.store, pr) !== target.context ||
      this.policyKey(pr) !== target.policy
    )
      return {
        state: "blocked",
        pr: pr.url,
        reason: "PR changed since this notice; inspect the current revision",
      };
    const assessment = this.store.ownerAssessment(pr);
    const review = reviewGate(pr.observation, assessment);
    if (review !== undefined)
      return { state: "blocked", pr: pr.url, reason: review };
    if (this.store.noticeReadiness(pr.id)?.inspectionError !== undefined)
      return {
        state: "blocked",
        pr: pr.url,
        reason: "Readiness unavailable; waiting for a successful inspection",
      };
    let entry = this.store.entries(pr.id).find((e) => !terminal(e.state));
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
