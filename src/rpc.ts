import {digestReceipt} from "./notifications/receipt.js";
import { complexity, renderTemplate } from "./submissions/contracts.js";
import { inboxRoutes } from "./tracking/inbox-rpc.js";
import { repairRoutes, wireRepair } from "./repairs/rpc.js";
import { activityRoutes } from "./activity/rpc.js";
import { actionStates, wirePR, wireAction,wireAgent, wireDelivery, wireTracking, trackingOperation } from "./tracking/rpc.js";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { setTimeout as delay } from "node:timers/promises";
import { SchedulerService, JobSchema, AttemptSchema, JobEventSchema, SnapshotSchema, JobStatus, SchedulerState, WorkerState, type Task as WireTask } from "./gen/octomanager/v1/scheduler_pb.js";
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
    subscribePullRequest(r){return trackingOperation(()=>{const participants=tracking.subscribe(r.id,owner(r.agent));return {participants:participants.slice(0,20),total:participants.length,hasMore:participants.length>20};});},
    unsubscribePullRequest(r){return trackingOperation(()=>{const participants=tracking.store.unsubscribe(r.id,r.agentId);return {participants:participants.slice(0,20),total:participants.length,hasMore:participants.length>20};});},
    listPRParticipants(r){return trackingOperation(()=>{const participants=tracking.store.participants(r.id);return {participants:participants.slice(r.offset,r.offset+20),total:participants.length,hasMore:participants.length>r.offset+20};});},
    getAgentDigest(r) {return trackingOperation(()=>({recordJson:JSON.stringify(coordinator.digests.inspect(r.id,r.revision))}));},
    listAgentDigests(r) {return {digestsJson:coordinator.store.digests.list(r.agentId).slice(-100).map(value=>JSON.stringify(value))};},
    acknowledgeAgentDigest(r) {return trackingOperation(()=>{
      const messages=coordinator.digests.acknowledge(r.id,r.revision,r.agentId,r.expectedBody);
      return digestReceipt(coordinator.digests,tracking.store,r.id,r.revision,messages);
    });},
    submitPullRequest(r){return trackingOperation(()=>({
        submissionJson: JSON.stringify(
          coordinator.submissions.submit(JSON.parse(r.inputJson)),
        ),
      }));
    },
    getSubmission(r){return trackingOperation(()=>({
        submissionJson: JSON.stringify(coordinator.store.submissions.get(r.id)),
      }));
    },
    listSubmissions() {
      return {
        submissionsJson: coordinator.store.submissions
          .list()
          .map((value) => JSON.stringify(value)),
      };
    },
    retrySubmission(r){return trackingOperation(()=>({
        submissionJson: JSON.stringify(coordinator.submissions.retry(r.id)),
      }));
    },
    cancelSubmission(r){return trackingOperation(()=>({
        submissionJson: JSON.stringify(coordinator.submissions.cancel(r.id)),
      }));
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
          policyJson: JSON.stringify(policy),
          template: renderTemplate(policy, tier),
        };
      });
    },
    registerAgent(r){return trackingOperation(()=>({agent:wireAgent(tracking.registerAgent(owner(r.target)))}));},
    ...inboxRoutes(tracking.store),
    ...repairRoutes(coordinator.repairs),
    ...activityRoutes(coordinator.store.activity, () => coordinator.store.sequence(), (after) => coordinator.store.eventsSince(after).map(wireEvent)),
    async trackPullRequest(r){return trackingOperation(()=>({pr:wirePR(tracking.track(r.url,owner(r.owner)))}));},
    async listTrackedPullRequests(){return {prs:tracking.store.prs().map(wirePR)};},
    async getTrackedPullRequest(r){return trackingOperation(()=>({pr:wirePR(tracking.store.pr(r.id))}));},
    async refreshTrackedPullRequest(r){return trackingOperation(async()=>{await tracking.refresh(r.id);return {pr:wirePR(tracking.store.pr(r.id))};});},
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
    async getPullRequest(request, context) {
      try { parseTask({ kind: "summarize_pr", url: request.url }); }
      catch { throw new ConnectError("A valid GitHub PR URL is required", Code.InvalidArgument); }
      try {
        const value = await coordinator.pullRequestDetails(request.url, context.signal);
        return { pullRequest: { ...value, observedAtMs: BigInt(value.observedAtMs), messages: value.messages.map(message => ({ ...message, atMs: BigInt(message.atMs), line: message.line === undefined ? undefined : BigInt(message.line) })) } };
      } catch (error) {
        const message = error instanceof Error ? error.message : "GitHub read failed";
        if (message.includes("Only confirmed public")) throw new ConnectError("Only confirmed public repository PRs are supported", Code.PermissionDenied);
        throw new ConnectError("GitHub reviews unavailable; check gh authentication, access, and connectivity", Code.Unavailable);
      }
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
