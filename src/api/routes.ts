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
import { wirePR, wireAction, wireAgent, wireDelivery, trackingOperation } from "../tracking/rpc.js";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { SchedulerService, type Task as WireTask } from "../gen/octomanager/v2/scheduler_pb.js";
import { parseTask } from "../jobs/domain.js";
import type { ApplicationApi } from "../application/api.js";
import { wireEvent, wireJob, wireSnapshot } from "./snapshot.js";

function task(value?: WireTask) {
  if (value?.kind.case === "resolveConflict") return parseTask({ kind: "resolve_conflict" });
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
    if (message === "Job not found") throw new ConnectError(message, Code.NotFound);
    if (message.startsWith("Request ID already used")) throw new ConnectError(message, Code.AlreadyExists);
    if (/previous worker|Only failed or interrupted/.test(message))
      throw new ConnectError(message, Code.FailedPrecondition);
    if (message === "Coordinator is stopping") throw new ConnectError(message, Code.Unavailable);
    if (/Invalid|Expected|Unsupported|Task must/.test(message)) throw new ConnectError(message, Code.InvalidArgument);
    throw new ConnectError("Coordinator operation failed", Code.Internal);
  }
}

export function schedulerRoutes(application: ApplicationApi, router: ConnectRouter): void {
  const tracking = application.services.tracking;
  const messages = new Messages(
    application.store,
    application.services.digests,
    application.services.merging.receipts.presentation,
  );
  const owner = (value?: { harness: string; endpoint: string; sessionId: string; label?: string | undefined }) => {
    if (!value) throw new ConnectError("Owner is required", Code.InvalidArgument);
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
      ...issueRoutes(application.services.issues),
      ...diagnosticsRoutes(application.diagnostics),
      async runtimeLifecycle(r) {
        return {
          report: wireLifecycle(
            await application.runtime.lifecycle(
              actionName(r.action),
              r.expectedNativeId,
              r.runId,
              r.expectedIdentity,
              r.restorePaused,
            ),
          ),
        };
      },
      ...dashboardRoutes(application),
      getServerInfo() {
        return { apiVersion: 2 };
      },
      ...mergeRoutes(application.services.merging),
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
              application.store.merging,
              application.services.merging.receipts,
              application.services.digests,
            ),
          }),
        }));
      },
      readNotificationMessage(r) {
        return trackingOperation(() => {
          if (r.agentId !== "" && r.agentTarget !== undefined) throw new Error("Invalid mixed recipient references");
          const agentId =
            r.agentTarget === undefined
              ? application.store.merging.actor(r.agentId)
              : tracking.store.sessionAgent(
                  r.agentTarget.harness,
                  r.agentTarget.sessionId,
                  r.agentTarget.endpoint === "" ? undefined : r.agentTarget.endpoint,
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
          if (r.agentId !== "" && r.agentTarget !== undefined) throw new Error("Invalid mixed recipient references");
          const agentId =
            r.agentTarget === undefined
              ? application.store.merging.actor(r.agentId)
              : tracking.store.sessionAgent(
                  r.agentTarget.harness,
                  r.agentTarget.sessionId,
                  r.agentTarget.endpoint === "" ? undefined : r.agentTarget.endpoint,
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
          const version = r.receiptId === "" ? undefined : application.store.digests.delivery(r.receiptId);
          const inspection = application.services.digests.inspect(
            version?.digestId ?? r.id,
            version?.revision ?? r.revision,
          );
          return {
            inspection: wire(DomainDigestInspectionSchema, digestInspection(inspection)),
          };
        });
      },
      listAgentDigests(r) {
        return {
          digests: application.store.digests
            .list(r.agentId)
            .slice(-100)
            .map((value) => wire(DomainAgentDigestSchema, value)),
        };
      },
      acknowledgeAgentDigest(r) {
        return trackingOperation(() => {
          if (r.receiptId !== "" && (r.id !== "" || r.revision !== 0))
            throw new Error("Invalid mixed message receipt references");
          if (r.agentId !== "" && r.agentTarget !== undefined) throw new Error("Invalid mixed recipient references");
          const version = r.receiptId === "" ? undefined : application.store.digests.delivery(r.receiptId);
          const id = version?.digestId ?? r.id,
            number = version?.revision ?? r.revision;
          const agentId =
            r.agentTarget === undefined
              ? r.agentId
              : tracking.store.sessionAgent(
                  r.agentTarget.harness,
                  r.agentTarget.sessionId,
                  r.agentTarget.endpoint === "" ? undefined : r.agentTarget.endpoint,
                );
          const messages = application.services.digests.acknowledge(id, number, agentId, r.expectedBody);
          return digestReceipt(application.services.digests, tracking.store, id, number, messages);
        });
      },
      getSubmission(r) {
        return trackingOperation(() => ({
          submission: wire(DomainArchivedSubmissionSchema, archiveSubmission(application.store.submissions.get(r.id))),
        }));
      },
      listSubmissions(r) {
        const page = application.store.submissions.summaryPage(
          r.beforeRowId === 0n ? Number.MAX_SAFE_INTEGER : Number(r.beforeRowId),
          r.limit === 0 ? 20 : r.limit,
        );
        return {
          submissions: page.items.map((value) =>
            wire(DomainArchivedSubmissionSummarySchema, {
              id: value["id"],
              state: value["state"],
              detail: value["detail"],
              ...(typeof value["url"] === "string" ? { url: value["url"] } : {}),
            }),
          ),
          nextBeforeRowId: BigInt(page.next ?? 0),
        };
      },
      getRepositoryPolicy(r) {
        return trackingOperation(() => {
          const policy = application.store.submissions.policy(r.repository.toLowerCase(), r.version);
          if (!policy)
            throw new ConnectError("Policy not found; submit a PR to analyze repository guidelines", Code.NotFound);
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
      ...inboxRoutes(tracking.store, (message) => application.services.merging.receipts.inboxReadyHead(message)),
      ...repairRoutes(application.services.repairs),
      ...activityRoutes(
        application.store.activity,
        () => application.store.sequence(),
        (after) => application.store.eventsSince(after).map(wireEvent),
        (before) => application.store.activityBefore(before).map(wireEvent),
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
          ...(!application.store.repositories.get(tracking.store.pr(r.id).id)
            ? {}
            : {
                repositoryPolicy: wire(
                  DomainRepositoryAutomationPolicySchema,
                  application.store.repositories.get(tracking.store.pr(r.id).id),
                ),
              }),
        }));
      },
      refreshTrackedPullRequest(r) {
        return trackingOperation(() => {
          tracking.requestRefresh(r.id);
          return {
            pr: wirePR(tracking.store.pr(r.id)),
            refresh: wireRefresh(application.store.schedules.get(`tracking:${tracking.store.pr(r.id).id}`)),
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
            .filter((a) => r.prId === undefined || r.prId === "" || a.prId === r.prId)
            .map((a) => wireAction(a, r.full)),
        };
      },
      getAction(r) {
        return trackingOperation(() => {
          const action = tracking.store.action(r.id),
            assessment = application.store.assessments.latest(action.id);
          return {
            action: wireAction(action, r.full),
            ...(!assessment ? {} : { assessment: wireAssessment(assessment, r.full) }),
          };
        });
      },
      getAssessment(r) {
        return trackingOperation(() => ({
          assessment: wireAssessment(application.store.assessments.get(r.id), r.full),
        }));
      },
      retryAssessment(r) {
        return trackingOperation(() => ({
          assessment: wireAssessment(application.services.assessments.retry(r.id)),
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
              application.jobs.command({
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
          job: wireJob(jobOperation(() => application.jobs.command({ op: "get", id: request.id }))),
        };
      },
      getPullRequest(request) {
        return trackingOperation(() => {
          application.services.githubScheduler.ensureReviews(request.url, request.refresh);
          const view = application.services.githubScheduler.reviewState(request.url);
          return {
            pullRequest: wireDetails(view.details),
            refresh: wireRefresh(view.schedule),
          };
        });
      },
      getSnapshot() {
        return { snapshot: wireSnapshot(application) };
      },
      cancelJob(request) {
        return {
          job: wireJob(jobOperation(() => application.jobs.command({ op: "cancel", id: request.id }))),
        };
      },
      retryJob(request) {
        return {
          job: wireJob(jobOperation(() => application.jobs.command({ op: "retry", id: request.id }))),
        };
      },
      setPaused(request) {
        jobOperation(() => application.jobs.command({ op: request.paused ? "pause" : "resume" }));
        return { snapshot: wireSnapshot(application) };
      },
      listEvents(request) {
        if (request.jobId !== undefined && request.prId !== undefined)
          throw new ConnectError("Choose job or PR filter", Code.InvalidArgument);
        if (request.afterSequence < 0n || request.afterSequence > BigInt(application.store.sequence()))
          throw new ConnectError("Cursor is outside retained history", Code.OutOfRange);
        return {
          events: application.store
            .eventsSince(Number(request.afterSequence), request.jobId, request.prId)
            .map(wireEvent),
        };
      },
      async *watch(request, context) {
        if (request.jobId !== undefined && request.prId !== undefined)
          throw new ConnectError("Choose job or PR filter", Code.InvalidArgument);
        if (request.instanceId !== application.store.instanceId())
          throw new ConnectError("State instance changed; obtain a fresh snapshot", Code.FailedPrecondition);
        if (request.afterSequence < 0n || request.afterSequence > BigInt(application.store.sequence()))
          throw new ConnectError("Cursor is ahead of retained history; obtain a fresh snapshot", Code.OutOfRange);
        let cursor = Number(request.afterSequence);
        const signal = AbortSignal.any([context.signal, application.services.githubScheduler.signal]);
        while (!context.signal.aborted) {
          if (application.runtime.isStopping() || signal.aborted)
            throw new ConnectError("Coordinator is stopping", Code.Unavailable);
          let resume = () => {};
          const notification = new Promise<void>((resolve) => {
            resume = resolve;
          });
          // Subscribe before the read: appends during cursor draining must also wake
          // this consumer, including while a yielded page is under backpressure.
          const release = application.store.subscribeEvents(resume);
          signal.addEventListener("abort", resume, { once: true });
          try {
            const events = application.store.eventsSince(cursor, request.jobId, request.prId);
            for (const event of events) {
              cursor = event.seq;
              yield { event: wireEvent(event) };
            }
            if (events.length === 0) await notification;
          } finally {
            release();
            signal.removeEventListener("abort", resume);
          }
        }
      },
    },
    {
      interceptors: [
        (next) => async (request) => {
          let release: () => void;
          try {
            release = application.runtime.nativeAdmission(request.method.name);
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
          application.inputs.changed();
        }),
      ],
    },
  );
}
