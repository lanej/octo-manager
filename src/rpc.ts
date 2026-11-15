import { DomainRepositoryAutomationPolicySchema } from "./gen/octomanager/v2/domain_pb.js";
import {mergeRoutes} from "./api/merge-routes.js";
import {wire} from "./api/codec.js";
import {DomainAgentDigestSchema,DomainDigestInspectionSchema,DomainMergeReceiptResultSchema,DomainArchivedSubmissionSchema,DomainArchivedSubmissionSummarySchema,DomainRepositoryPolicySchema} from "./gen/octomanager/v2/domain_pb.js";
import {archiveSubmission,digestInspection} from "./api/projections.js";
import {dashboardRoutes,wireScheduler,wireRefresh,wireDetails} from "./scheduling/rpc.js";
import {digestReceipt} from "./notifications/receipt.js";
import { complexity, renderTemplate } from "./submissions/contracts.js";
import { inboxRoutes } from "./tracking/inbox-rpc.js";
import { repairRoutes, wireRepair } from "./repairs/rpc.js";
import { activityRoutes } from "./activity/rpc.js";
import { actionStates, wirePR, wireAction,wireAgent, wireDelivery, wireTracking, trackingOperation } from "./tracking/rpc.js";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { setTimeout as delay } from "node:timers/promises";
import { SchedulerService, JobSchema, AttemptSchema, JobEventSchema, SnapshotSchema, JobStatus, SchedulerState, WorkerState, type Task as WireTask } from "./gen/octomanager/v2/scheduler_pb.js";
import { jobTransitions, parseTask, type Job, type JobEvent, type Status } from "./domain.js";
import type { Coordinator } from "./coordinator.js";
import { githubReads } from "./github-api.js";
import { wireGitHubUsage } from "./github-usage-rpc.js";

const statuses: Record<Status, JobStatus> = {
  queued: JobStatus.QUEUED, running: JobStatus.RUNNING, conflicted: JobStatus.CONFLICTED,
  resolving: JobStatus.RESOLVING, retry_wait: JobStatus.RETRY_WAIT, cancelling: JobStatus.CANCELLING,
  cancelled: JobStatus.CANCELLED, succeeded: JobStatus.SUCCEEDED, failed: JobStatus.FAILED, interrupted: JobStatus.INTERRUPTED,
};
export function wireJob(job: Job) {
  return create(JobSchema, {
    id: job.id, requestId: job.requestId,
    task: { kind: job.task.kind === "resolve_conflict" ? { case: "resolveConflict", value: {} } : { case: "summarizePullRequest", value: { url: job.task.url } } },
    status: statuses[job.status], createdAtMs: BigInt(job.createdAt), updatedAtMs: BigInt(job.updatedAt), availableAtMs: BigInt(job.availableAt),
    attempts: job.attempts.map(a => create(AttemptSchema, { number: a.number, startedAtMs: BigInt(a.startedAt), endedAtMs: a.endedAt === undefined ? undefined : BigInt(a.endedAt), workerPid: a.pid === undefined ? undefined : BigInt(a.pid), exitObservedAtMs: a.exitObservedAt === undefined ? undefined : BigInt(a.exitObservedAt), error: a.error })),
    retryCount: job.retryCount, resultMarkdown: job.result, error: job.error,
  });
}
export function wireEvent(event: JobEvent) { return create(JobEventSchema, { sequence: BigInt(event.seq), jobId: event.jobId, atMs: BigInt(event.at), kind: event.kind, detail: event.detail, prId: event.prId, actionId: event.actionId, actionContext: event.actionContext !== undefined ? { ...event.actionContext, state: actionStates[event.actionContext.state] } : undefined }); }
export function wireSnapshot(coordinator: Coordinator) {
  // WHY: A single owner executes these synchronous reads without yielding; the cursor covers exactly the state returned.
  const snapshot = coordinator.snapshot();
  return create(SnapshotSchema, {
    instanceId: coordinator.store.instanceId(), sequence: BigInt(coordinator.store.sequence()),
    scheduler: { running: SchedulerState.RUNNING, paused: SchedulerState.PAUSED, stopping: SchedulerState.STOPPING, stopped: SchedulerState.STOPPED }[snapshot.scheduler],
    worker: { idle: WorkerState.IDLE, busy: WorkerState.BUSY, recovering: WorkerState.RECOVERING }[snapshot.worker],
    tracking: wireTracking(coordinator.tracking),
    githubUsage: wireGitHubUsage(githubReads.usage()),
    githubScheduler:wireScheduler(coordinator.githubScheduler),
    mergeStatuses:coordinator.store.merging.entries().map(entry=>({prId:entry.prId,chainId:entry.chainId,chainState:coordinator.store.merging.chain(entry.chainId).state,autoMerge:entry.autoMerge,autoMergeSource:entry.autoMergeSource??"explicit",autoMergeStage:entry.autoMergeStage??"",state:entry.state,detail:entry.detail,prerequisiteUrls:coordinator.store.merging.dependencies().filter(edge=>edge.dependentId===entry.prId).map(edge=>coordinator.store.tracking.pr(edge.prerequisiteId).url)})),
    repairs: coordinator.repairs.store.list().map(wireRepair),
    jobs: snapshot.jobs.map(wireJob), recentEvents: snapshot.events.map(wireEvent), recoveryPid: snapshot.recoveryPid === undefined ? undefined : BigInt(snapshot.recoveryPid),
    allowedTransitions: Object.entries(jobTransitions).flatMap(([from, targets]) => targets.map(to => ({ from: statuses[from as Status], to: statuses[to] }))),
  });
}
function task(value?: WireTask) {
  if (value?.kind.case === "resolveConflict") return parseTask({ kind: "resolve_conflict" });
  if (value?.kind.case === "summarizePullRequest") return parseTask({ kind: "summarize_pr", url: value.kind.value.url });
  throw new ConnectError("A supported task is required", Code.InvalidArgument);
}
function command(coordinator: Coordinator, value: object): unknown {
  try { return coordinator.command(value); }
  catch (error) {
    if (error instanceof ConnectError) throw error;
    const message = error instanceof Error ? error.message : "Unknown failure";
    if (message === "Job not found") throw new ConnectError(message, Code.NotFound);
    if (message.startsWith("Request ID already used")) throw new ConnectError(message, Code.AlreadyExists);
    if (/previous worker|Only failed or interrupted/.test(message)) throw new ConnectError(message, Code.FailedPrecondition);
    if (message === "Coordinator is stopping") throw new ConnectError(message, Code.Unavailable);
    if (/Invalid|Expected|Unsupported|Task must/.test(message)) throw new ConnectError(message, Code.InvalidArgument);
    throw new ConnectError("Coordinator operation failed", Code.Internal);
  }
}
export function schedulerRoutes(coordinator: Coordinator, router: ConnectRouter): void {
  const tracking=coordinator.tracking;
  const owner=(value?:{harness:string;endpoint:string;sessionId:string;label?:string|undefined})=>{
    if(!value)throw new ConnectError("Owner is required",Code.InvalidArgument);
    return {harness:value.harness,endpoint:value.endpoint,sessionId:value.sessionId,...(value.label===undefined?{}:{label:value.label})};
  };
  router.service(SchedulerService, {
    ...dashboardRoutes(coordinator),
    getServerInfo(){return {apiVersion:2};},
    ...mergeRoutes(coordinator),
    subscribePullRequest(r){return trackingOperation(()=>{const participants=tracking.subscribe(r.id,owner(r.agent));return {participants:participants.slice(0,20),total:participants.length,hasMore:participants.length>20};});},
    unsubscribePullRequest(r){return trackingOperation(()=>{const participants=tracking.store.unsubscribe(r.id,r.agentId);return {participants:participants.slice(0,20),total:participants.length,hasMore:participants.length>20};});},
    listPRParticipants(r){return trackingOperation(()=>{const participants=tracking.store.participants(r.id);return {participants:participants.slice(r.offset,r.offset+20),total:participants.length,hasMore:participants.length>r.offset+20};});},
    mergeAgentMessage(r) {return trackingOperation(()=>{
      if(r.agentId!=="" && r.agentTarget!==undefined)throw new Error("Invalid mixed recipient references");
      const version=coordinator.store.digests.delivery(r.receiptId);
      const agentId=r.agentTarget===undefined?r.agentId:
        tracking.store.sessionAgent(r.agentTarget.harness,r.agentTarget.sessionId,r.agentTarget.endpoint===""?undefined:r.agentTarget.endpoint);
      const recipient=r.agentId===""?agentId:coordinator.store.merging.actor(r.agentId);
      coordinator.digests.acknowledge(version.digestId,version.revision,recipient);
      const target=version.mergeTarget;
      if(target===undefined)return {result:wire(DomainMergeReceiptResultSchema,{receipt:r.receiptId,state:"blocked",reason:"This message has no merge target"})};
      const result=coordinator.store.merging.transaction(()=>coordinator.merging.receipts.request(target,version.dispatchId,recipient));
      return {result:wire(DomainMergeReceiptResultSchema,{receipt:r.receiptId,...result})};
    });},
    getAgentDigest(r) {return trackingOperation(()=>{
      if(r.receiptId!=="" && (r.id!=="" || r.revision!==undefined))throw new Error("Invalid mixed message receipt references");
      const version=r.receiptId===""?undefined:coordinator.store.digests.delivery(r.receiptId);
      return {inspection:wire(DomainDigestInspectionSchema,digestInspection(coordinator.digests.inspect(version?.digestId??r.id,version?.revision??r.revision)))};
    });},
    listAgentDigests(r) {return {digests:coordinator.store.digests.list(r.agentId).slice(-100).map(value=>wire(DomainAgentDigestSchema,value))};},
    acknowledgeAgentDigest(r) {return trackingOperation(()=>{
      if(r.receiptId!=="" && (r.id!=="" || r.revision!==0))throw new Error("Invalid mixed message receipt references");
      if(r.agentId!=="" && r.agentTarget!==undefined)throw new Error("Invalid mixed recipient references");
      const version=r.receiptId===""?undefined:coordinator.store.digests.delivery(r.receiptId);
      const id=version?.digestId??r.id,number=version?.revision??r.revision;
      const agentId=r.agentTarget===undefined?r.agentId:tracking.store.sessionAgent(r.agentTarget.harness,r.agentTarget.sessionId,r.agentTarget.endpoint===""?undefined:r.agentTarget.endpoint);
      const messages=coordinator.digests.acknowledge(id,number,agentId,r.expectedBody);
      return digestReceipt(coordinator.digests,tracking.store,id,number,messages);
    });},
    getSubmission(r){return trackingOperation(()=>({
        submission: wire(DomainArchivedSubmissionSchema,archiveSubmission(coordinator.store.submissions.get(r.id))),
      }));
    },
    listSubmissions(r) {
      const page = coordinator.store.submissions.summaryPage(r.beforeRowId === 0n ? Number.MAX_SAFE_INTEGER : Number(r.beforeRowId), r.limit === 0 ? 20 : r.limit);
      return { submissions: page.items.map((value) => wire(DomainArchivedSubmissionSummarySchema,{id:value["id"],state:value["state"],detail:value["detail"],...(typeof value["url"]==="string"?{url:value["url"]}:{})})), nextBeforeRowId: BigInt(page.next ?? 0) };
    },
    getRepositoryPolicy(r){return trackingOperation(()=> {
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
          policy: wire(DomainRepositoryPolicySchema,policy),
          template: renderTemplate(policy, tier),
        };
      });
    },
    registerAgent(r){return trackingOperation(()=>({agent:wireAgent(tracking.registerAgent(owner(r.target)))}));},
    ...inboxRoutes(tracking.store),
    ...repairRoutes(coordinator.repairs),
    ...activityRoutes(coordinator.store.activity, () => coordinator.store.sequence(), (after) => coordinator.store.eventsSince(after).map(wireEvent), (before) => coordinator.store.activityBefore(before).map(wireEvent)),
    async trackPullRequest(r){return trackingOperation(()=>({pr:wirePR(tracking.track(r.url,owner(r.owner),r.cwd))}));},
    async listTrackedPullRequests(){return {prs:tracking.store.prs().map(wirePR)};},
    async getTrackedPullRequest(r){return trackingOperation(()=>({pr:wirePR(tracking.store.pr(r.id)),...(coordinator.store.repositories.get(tracking.store.pr(r.id).id)===undefined?{}:{repositoryPolicy:wire(DomainRepositoryAutomationPolicySchema,coordinator.store.repositories.get(tracking.store.pr(r.id).id))})}));},
    refreshTrackedPullRequest(r){return trackingOperation(()=>{tracking.requestRefresh(r.id);return {pr:wirePR(tracking.store.pr(r.id)),refresh:wireRefresh(coordinator.store.schedules.get(`tracking:${tracking.store.pr(r.id).id}`))};});},
    async assignPullRequest(r){return trackingOperation(()=>({pr:wirePR(tracking.assign(r.id,owner(r.owner)))}));},
    async untrackPullRequest(r){return trackingOperation(()=>({pr:wirePR(tracking.store.untrack(r.id))}));},
    async listActions(r){return {actions:tracking.store.actions().filter(a=>!r.prId||a.prId===r.prId).map(wireAction)};},
    async getAction(r){return trackingOperation(()=>({action:wireAction(tracking.store.action(r.id))}));},
    async acknowledgeAction(r){return trackingOperation(()=>({action:wireAction(tracking.store.progress(r.id,r.agentId,false))}));},
    async startAction(r){return trackingOperation(()=>({action:wireAction(tracking.store.progress(r.id,r.agentId,true))}));},
    async retryDelivery(r){return trackingOperation(()=>({delivery:wireDelivery(tracking.store.retryDelivery(r.id))}));},
    async reprofileAction(r){return trackingOperation(()=>({action:wireAction(tracking.store.reprofile(r.id,tracking.config))}));},
    submitJob(request) {
      let parsed;
      try { parsed = task(request.task); } catch { throw new ConnectError("A supported task with a valid public GitHub PR URL is required", Code.InvalidArgument); }
      return { job: wireJob(command(coordinator, { op: "submit", requestId: request.requestId, task: parsed }) as Job) };
    },
    getJob(request) { return { job: wireJob(command(coordinator, { op: "get", id: request.id }) as Job) }; },
    getPullRequest(request) {
      return trackingOperation(()=>{
        coordinator.githubScheduler.ensureReviews(request.url,request.refresh);
        const view=coordinator.githubScheduler.reviewState(request.url);
        return {pullRequest:wireDetails(view.details),refresh:wireRefresh(view.schedule)};
      });
    },
    getSnapshot() { return { snapshot: wireSnapshot(coordinator) }; },
    cancelJob(request) { return { job: wireJob(command(coordinator, { op: "cancel", id: request.id }) as Job) }; },
    retryJob(request) { return { job: wireJob(command(coordinator, { op: "retry", id: request.id }) as Job) }; },
    setPaused(request) { command(coordinator, { op: request.paused ? "pause" : "resume" }); return { snapshot: wireSnapshot(coordinator) }; },
    listEvents(request) {
      if(request.jobId!==undefined && request.prId!==undefined)throw new ConnectError("Choose job or PR filter",Code.InvalidArgument);
      if (request.afterSequence < 0n || request.afterSequence > BigInt(coordinator.store.sequence())) throw new ConnectError("Cursor is outside retained history", Code.OutOfRange);
      return { events: coordinator.store.eventsSince(Number(request.afterSequence), request.jobId, request.prId).map(wireEvent) };
    },
    async *watch(request, context) {
      if(request.jobId!==undefined && request.prId!==undefined)throw new ConnectError("Choose job or PR filter",Code.InvalidArgument);
      if (request.instanceId !== coordinator.store.instanceId()) throw new ConnectError("State instance changed; obtain a fresh snapshot", Code.FailedPrecondition);
      if (request.afterSequence < 0n || request.afterSequence > BigInt(coordinator.store.sequence())) throw new ConnectError("Cursor is ahead of retained history; obtain a fresh snapshot", Code.OutOfRange);
      let cursor = Number(request.afterSequence);
      while (!context.signal.aborted) {
        if (coordinator.snapshot().scheduler === "stopping" || coordinator.snapshot().scheduler === "stopped") throw new ConnectError("Coordinator is stopping", Code.Unavailable);
        const events = coordinator.store.eventsSince(cursor, request.jobId, request.prId);
        for (const event of events) { cursor = event.seq; yield { event: wireEvent(event) }; }
        await delay(50, undefined, { signal: context.signal }).catch(() => {});
      }
    },
  });
}
