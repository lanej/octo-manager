import { inputIntake } from "./intake.js";
import { requestReceiptMerge } from "../merging/receipt-request.js";
import { diagnosticsRoutes } from "../diagnostics/rpc.js";
import { actionName, wireLifecycle } from "../lifecycle-rpc.js";
import { Messages } from "../notifications/messages.js";
import { wireAssessment } from "../assessments/rpc.js";
import { issueRoutes } from "../issues/rpc.js";
import { DomainRepositoryAutomationPolicySchema } from "../gen/octomanager/v2/domain_pb.js";
import { mergeRoutes } from "./merge-routes.js";
import { wire } from "./codec.js";
import {
  DomainAgentDigestSchema,
  DomainDigestInspectionSchema,
  DomainMergeReceiptResultSchema,
  DomainArchivedSubmissionSchema,
  DomainArchivedSubmissionSummarySchema,
  DomainRepositoryPolicySchema,
} from "../gen/octomanager/v2/domain_pb.js";
import { archiveSubmission, digestInspection } from "./projections.js";
import { dashboardRoutes } from "../scheduling/rpc.js";
import { wireRefresh, wireDetails } from "../scheduling/projection.js";
import { digestReceipt } from "../notifications/receipt.js";
import { complexity, renderTemplate } from "../submissions/contracts.js";
import { inboxRoutes } from "../tracking/inbox-rpc.js";
import { repairRoutes } from "../repairs/rpc.js";
import { activityRoutes } from "../activity/rpc.js";
import {
  wirePR,
  wireAction,
  wireAgent,
  wireDelivery,
  trackingOperation,
} from "../tracking/rpc.js";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { setTimeout as delay } from "node:timers/promises";
import {
  SchedulerService,
  type Task as WireTask,
} from "../gen/octomanager/v2/scheduler_pb.js";
import { parseTask } from "../jobs/domain.js";
import type { Coordinator } from "../coordinator.js";
import { wireEvent, wireJob, wireSnapshot } from "./snapshot.js";

function task(value?: WireTask) {
  if (value?.kind.case === "resolveConflict")
    return parseTask({ kind: "resolve_conflict" });
  if (value?.kind.case === "summarizePullRequest")
    return parseTask({ kind: "summarize_pr", url: value.kind.value.url });
  throw new ConnectError("A supported task is required", Code.InvalidArgument);
}
function jobOperation<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof ConnectError) throw error;
    const message = error instanceof Error ? error.message : "Unknown failure";
    if (message === "Job not found")
      throw new ConnectError(message, Code.NotFound);
    if (message.startsWith("Request ID already used"))
      throw new ConnectError(message, Code.AlreadyExists);
    if (/previous worker|Only failed or interrupted/.test(message))
      throw new ConnectError(message, Code.FailedPrecondition);
    if (message === "Coordinator is stopping")
      throw new ConnectError(message, Code.Unavailable);
    if (/Invalid|Expected|Unsupported|Task must/.test(message))
      throw new ConnectError(message, Code.InvalidArgument);
    throw new ConnectError("Coordinator operation failed", Code.Internal);
  }
}
export function schedulerRoutes(
  coordinator: Coordinator,
  router: ConnectRouter,
): void {
  const tracking = coordinator.tracking;
  const messages = new Messages(
    coordinator.store,
    coordinator.digests,
    coordinator.merging.receipts.presentation,
  );
  const owner = (value?: {
    harness: string;
    endpoint: string;
    sessionId: string;
    label?: string | undefined;
  }) => {
    if (value === undefined)
      throw new ConnectError("Owner is required", Code.InvalidArgument);
    return {
      harness: value.harness,
      endpoint: value.endpoint,
      sessionId: value.sessionId,
      ...(value.label === undefined ? {} : { label: value.label }),
    };
  };
  router.service(
    SchedulerService,
    {
      ...issueRoutes(coordinator.issues),
      ...diagnosticsRoutes(coordinator.diagnostics),
      async runtimeLifecycle(r) {
        return {
          report: wireLifecycle(
            await coordinator.lifecycle(
              actionName(r.action),
              r.expectedNativeId,
              r.runId,
              r.expectedIdentity,
              r.restorePaused,
            ),
          ),
        };
      },
      ...dashboardRoutes(coordinator),
      getServerInfo() {
        return { apiVersion: 2 };
      },
      ...mergeRoutes(coordinator),
      subscribePullRequest(r) {
        return trackingOperation(() => {
          const participants = tracking.subscribe(r.id, owner(r.agent));
          return {
            participants: participants.slice(0, 20),
            total: participants.length,
            hasMore: participants.length > 20,
          };
        });
      },
      unsubscribePullRequest(r) {
        return trackingOperation(() => {
          const participants = tracking.store.unsubscribe(r.id, r.agentId);
          return {
            participants: participants.slice(0, 20),
            total: participants.length,
            hasMore: participants.length > 20,
          };
        });
      },
      listPRParticipants(r) {
        return trackingOperation(() => {
          const participants = tracking.store.participants(r.id);
          return {
            participants: participants.slice(r.offset, r.offset + 20),
            total: participants.length,
            hasMore: participants.length > r.offset + 20,
          };
        });
      },
      mergeAgentMessage(request) {
        return trackingOperation(() => ({
          result: wire(DomainMergeReceiptResultSchema, {
            receipt: request.receiptId,
            ...requestReceiptMerge(
              request,
              tracking.store,
              coordinator.store.merging,
              coordinator.merging.receipts,
              coordinator.digests,
            ),
          }),
        }));
      },
      readNotificationMessage(r) {
        return trackingOperation(() => {
          if (r.agentId !== "" && r.agentTarget !== undefined)
            throw new Error("Invalid mixed recipient references");
          const agentId =
            r.agentTarget === undefined
              ? coordinator.store.merging.actor(r.agentId)
              : tracking.store.sessionAgent(
                  r.agentTarget.harness,
                  r.agentTarget.sessionId,
                  r.agentTarget.endpoint === ""
                    ? undefined
                    : r.agentTarget.endpoint,
                );
          return messages.read(r.id, agentId);
        });
      },
      getNotificationMessage(r) {
        return trackingOperation(() => ({
          message: messages.get(r.id, r.full),
        }));
      },
      acknowledgeNotificationMessage(r) {
        return trackingOperation(() => {
          if (r.agentId !== "" && r.agentTarget !== undefined)
            throw new Error("Invalid mixed recipient references");
          const agentId =
            r.agentTarget === undefined
              ? coordinator.store.merging.actor(r.agentId)
              : tracking.store.sessionAgent(
                  r.agentTarget.harness,
                  r.agentTarget.sessionId,
                  r.agentTarget.endpoint === ""
                    ? undefined
                    : r.agentTarget.endpoint,
                );
          return {
            message: messages.acknowledge(r.id, agentId, r.expectedBody),
          };
        });
      },
      getAgentDigest(r) {
        return trackingOperation(() => {
          if (r.receiptId !== "" && (r.id !== "" || r.revision !== undefined))
            throw new Error("Invalid mixed message receipt references");
          const version =
            r.receiptId === ""
              ? undefined
              : coordinator.store.digests.delivery(r.receiptId);
          const inspection = coordinator.digests.inspect(
            version?.digestId ?? r.id,
            version?.revision ?? r.revision,
          );
          return {
            inspection: wire(
              DomainDigestInspectionSchema,
              digestInspection(inspection),
            ),
          };
        });
      },
      listAgentDigests(r) {
        return {
          digests: coordinator.store.digests
            .list(r.agentId)
            .slice(-100)
            .map((value) => wire(DomainAgentDigestSchema, value)),
        };
      },
      acknowledgeAgentDigest(r) {
        return trackingOperation(() => {
          if (r.receiptId !== "" && (r.id !== "" || r.revision !== 0))
            throw new Error("Invalid mixed message receipt references");
          if (r.agentId !== "" && r.agentTarget !== undefined)
            throw new Error("Invalid mixed recipient references");
          const version =
            r.receiptId === ""
              ? undefined
              : coordinator.store.digests.delivery(r.receiptId);
          const id = version?.digestId ?? r.id,
            number = version?.revision ?? r.revision;
          const agentId =
            r.agentTarget === undefined
              ? r.agentId
              : tracking.store.sessionAgent(
                  r.agentTarget.harness,
                  r.agentTarget.sessionId,
                  r.agentTarget.endpoint === ""
                    ? undefined
                    : r.agentTarget.endpoint,
                );
          const messages = coordinator.digests.acknowledge(
            id,
            number,
            agentId,
            r.expectedBody,
          );
          return digestReceipt(
            coordinator.digests,
            tracking.store,
            id,
            number,
            messages,
          );
        });
      },
      getSubmission(r) {
        return trackingOperation(() => ({
          submission: wire(
            DomainArchivedSubmissionSchema,
            archiveSubmission(coordinator.store.submissions.get(r.id)),
          ),
        }));
      },
      listSubmissions(r) {
        const page = coordinator.store.submissions.summaryPage(
          r.beforeRowId === 0n
            ? Number.MAX_SAFE_INTEGER
            : Number(r.beforeRowId),
          r.limit === 0 ? 20 : r.limit,
        );
        return {
          submissions: page.items.map((value) =>
            wire(DomainArchivedSubmissionSummarySchema, {
              id: value["id"],
              state: value["state"],
              detail: value["detail"],
              ...(typeof value["url"] === "string"
                ? { url: value["url"] }
                : {}),
            }),
          ),
          nextBeforeRowId: BigInt(page.next ?? 0),
        };
      },
      getRepositoryPolicy(r) {
        return trackingOperation(() => {
          const policy = coordinator.store.submissions.policy(
            r.repository.toLowerCase(),
            r.version,
          );
          if (policy === undefined)
            throw new ConnectError(
              "Policy not found; submit a PR to analyze repository guidelines",
              Code.NotFound,
            );
          const tier = complexity(r.tier === "" ? "standard" : r.tier);
          return {
            policy: wire(DomainRepositoryPolicySchema, policy),
            template: renderTemplate(policy, tier),
          };
        });
      },
      registerAgent(r) {
        return trackingOperation(() => ({
          agent: wireAgent(tracking.registerAgent(owner(r.target))),
        }));
      },
      ...inboxRoutes(tracking.store, (message) =>
        coordinator.merging.receipts.inboxReadyHead(message),
      ),
      ...repairRoutes(coordinator.repairs),
      ...activityRoutes(
        coordinator.store.activity,
        () => coordinator.store.sequence(),
        (after) => coordinator.store.eventsSince(after).map(wireEvent),
        (before) => coordinator.store.activityBefore(before).map(wireEvent),
      ),
      async trackPullRequest(r) {
        return trackingOperation(() => ({
          pr: wirePR(tracking.track(r.url, owner(r.owner), r.cwd)),
        }));
      },
      listTrackedPullRequests() {
        return { prs: tracking.store.prs().map(wirePR) };
      },
      async getTrackedPullRequest(r) {
        return trackingOperation(() => ({
          pr: wirePR(tracking.store.pr(r.id)),
          ...(coordinator.store.repositories.get(tracking.store.pr(r.id).id) ===
          undefined
            ? {}
            : {
                repositoryPolicy: wire(
                  DomainRepositoryAutomationPolicySchema,
                  coordinator.store.repositories.get(
                    tracking.store.pr(r.id).id,
                  ),
                ),
              }),
        }));
      },
      refreshTrackedPullRequest(r) {
        return trackingOperation(() => {
          tracking.requestRefresh(r.id);
          return {
            pr: wirePR(tracking.store.pr(r.id)),
            refresh: wireRefresh(
              coordinator.store.schedules.get(
                `tracking:${tracking.store.pr(r.id).id}`,
              ),
            ),
          };
        });
      },
      async assignPullRequest(r) {
        return trackingOperation(() => ({
          pr: wirePR(tracking.assign(r.id, owner(r.owner))),
        }));
      },
      async untrackPullRequest(r) {
        return trackingOperation(() => ({
          pr: wirePR(tracking.store.untrack(r.id)),
        }));
      },
      listActions(r) {
        return {
          actions: tracking.store
            .actions()
            .filter(
              (a) => r.prId === undefined || r.prId === "" || a.prId === r.prId,
            )
            .map((a) => wireAction(a, r.full)),
        };
      },
      getAction(r) {
        return trackingOperation(() => {
          const action = tracking.store.action(r.id),
            assessment = coordinator.store.assessments.latest(action.id);
          return {
            action: wireAction(action, r.full),
            ...(assessment === undefined
              ? {}
              : { assessment: wireAssessment(assessment, r.full) }),
          };
        });
      },
      getAssessment(r) {
        return trackingOperation(() => ({
          assessment: wireAssessment(
            coordinator.store.assessments.get(r.id),
            r.full,
          ),
        }));
      },
      retryAssessment(r) {
        return trackingOperation(() => ({
          assessment: wireAssessment(coordinator.assessments.retry(r.id)),
        }));
      },
      async acknowledgeAction(r) {
        return trackingOperation(() => ({
          action: wireAction(tracking.store.progress(r.id, r.agentId, false)),
        }));
      },
      async startAction(r) {
        return trackingOperation(() => ({
          action: wireAction(tracking.store.progress(r.id, r.agentId, true)),
        }));
      },
      async retryDelivery(r) {
        return trackingOperation(() => ({
          delivery: wireDelivery(tracking.store.retryDelivery(r.id)),
        }));
      },
      async reprofileAction(r) {
        return trackingOperation(() => ({
          action: wireAction(tracking.store.reprofile(r.id, tracking.config)),
        }));
      },
      submitJob(request) {
        let parsed;
        try {
          parsed = task(request.task);
        } catch {
          throw new ConnectError(
            "A supported task with a valid public GitHub PR URL is required",
            Code.InvalidArgument,
          );
        }
        return {
          job: wireJob(
            jobOperation(() =>
              coordinator.command({
                op: "submit",
                requestId: request.requestId,
                task: parsed,
              }),
            ),
          ),
        };
      },
      getJob(request) {
        return {
          job: wireJob(
            jobOperation(() =>
              coordinator.command({ op: "get", id: request.id }),
            ),
          ),
        };
      },
      getPullRequest(request) {
        return trackingOperation(() => {
          coordinator.githubScheduler.ensureReviews(
            request.url,
            request.refresh,
          );
          const view = coordinator.githubScheduler.reviewState(request.url);
          return {
            pullRequest: wireDetails(view.details),
            refresh: wireRefresh(view.schedule),
          };
        });
      },
      getSnapshot() {
        return { snapshot: wireSnapshot(coordinator) };
      },
      cancelJob(request) {
        return {
          job: wireJob(
            jobOperation(() =>
              coordinator.command({ op: "cancel", id: request.id }),
            ),
          ),
        };
      },
      retryJob(request) {
        return {
          job: wireJob(
            jobOperation(() =>
              coordinator.command({ op: "retry", id: request.id }),
            ),
          ),
        };
      },
      setPaused(request) {
        jobOperation(() =>
          coordinator.command({ op: request.paused ? "pause" : "resume" }),
        );
        return { snapshot: wireSnapshot(coordinator) };
      },
      listEvents(request) {
        if (request.jobId !== undefined && request.prId !== undefined)
          throw new ConnectError(
            "Choose job or PR filter",
            Code.InvalidArgument,
          );
        if (
          request.afterSequence < 0n ||
          request.afterSequence > BigInt(coordinator.store.sequence())
        )
          throw new ConnectError(
            "Cursor is outside retained history",
            Code.OutOfRange,
          );
        return {
          events: coordinator.store
            .eventsSince(
              Number(request.afterSequence),
              request.jobId,
              request.prId,
            )
            .map(wireEvent),
        };
      },
      async *watch(request, context) {
        if (request.jobId !== undefined && request.prId !== undefined)
          throw new ConnectError(
            "Choose job or PR filter",
            Code.InvalidArgument,
          );
        if (request.instanceId !== coordinator.store.instanceId())
          throw new ConnectError(
            "State instance changed; obtain a fresh snapshot",
            Code.FailedPrecondition,
          );
        if (
          request.afterSequence < 0n ||
          request.afterSequence > BigInt(coordinator.store.sequence())
        )
          throw new ConnectError(
            "Cursor is ahead of retained history; obtain a fresh snapshot",
            Code.OutOfRange,
          );
        let cursor = Number(request.afterSequence);
        while (!context.signal.aborted) {
          if (coordinator.isStopping())
            throw new ConnectError("Coordinator is stopping", Code.Unavailable);
          const events = coordinator.store.eventsSince(
            cursor,
            request.jobId,
            request.prId,
          );
          for (const event of events) {
            cursor = event.seq;
            yield { event: wireEvent(event) };
          }
          await delay(50, undefined, { signal: context.signal }).catch(
            () => {},
          );
        }
      },
    },
    {
      interceptors: [
        (next) => async (request) => {
          let release: () => void;
          try {
            release = coordinator.nativeAdmission(request.method.name);
          } catch {
            throw new ConnectError("Coordinator is stopping", Code.Unavailable);
          }
          try {
            return await next(request);
          } finally {
            release();
          }
        },
        inputIntake(() => {
          coordinator.inputsChanged();
        }),
      ],
    },
  );
}
