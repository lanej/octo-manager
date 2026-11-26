import { create } from "@bufbuild/protobuf";
import type { SnapshotSource } from "../application/api.js";
import {
  AttemptSchema,
  JobEventSchema,
  JobSchema,
  GitHubSchedulerStatusSchema,
  JobStatus,
  SchedulerState,
  SnapshotSchema,
  WorkerState,
} from "../gen/octomanager/v2/scheduler_pb.js";
import { githubReads } from "../github/reads.js";
import { wireIssue } from "../issues/rpc.js";
import {
  jobTransitions,
  type Job,
  type JobEvent,
  type Status,
} from "../jobs/domain.js";
import { wireRepair } from "../repairs/rpc.js";
import { wireScheduler } from "../scheduling/projection.js";
import { actionStates, wireTracking } from "../tracking/rpc.js";
import { wireGitHubUsage } from "./github-usage.js";

const statuses: Record<Status, JobStatus> = {
  queued: JobStatus.QUEUED,
  running: JobStatus.RUNNING,
  conflicted: JobStatus.CONFLICTED,
  resolving: JobStatus.RESOLVING,
  retry_wait: JobStatus.RETRY_WAIT,
  cancelling: JobStatus.CANCELLING,
  cancelled: JobStatus.CANCELLED,
  succeeded: JobStatus.SUCCEEDED,
  failed: JobStatus.FAILED,
  interrupted: JobStatus.INTERRUPTED,
};
const statusByName = new Map(Object.entries(statuses));

export function wireJob(job: Job) {
  return create(JobSchema, {
    id: job.id,
    requestId: job.requestId,
    task: {
      kind:
        job.task.kind === "resolve_conflict"
          ? { case: "resolveConflict", value: {} }
          : { case: "summarizePullRequest", value: { url: job.task.url } },
    },
    status: statuses[job.status],
    createdAtMs: BigInt(job.createdAt),
    updatedAtMs: BigInt(job.updatedAt),
    availableAtMs: BigInt(job.availableAt),
    attempts: job.attempts.map((a) =>
      create(AttemptSchema, {
        number: a.number,
        startedAtMs: BigInt(a.startedAt),
        endedAtMs: a.endedAt === undefined ? undefined : BigInt(a.endedAt),
        workerPid: a.pid === undefined ? undefined : BigInt(a.pid),
        exitObservedAtMs:
          a.exitObservedAt === undefined ? undefined : BigInt(a.exitObservedAt),
        error: a.error,
      }),
    ),
    retryCount: job.retryCount,
    resultMarkdown: job.result,
    error: job.error,
  });
}
export function wireEvent(event: JobEvent) {
  return create(JobEventSchema, {
    sequence: BigInt(event.seq),
    jobId: event.jobId,
    atMs: BigInt(event.at),
    kind: event.kind,
    detail: event.detail,
    prId: event.prId,
    actionId: event.actionId,
    actionContext:
      event.actionContext !== undefined
        ? {
            ...event.actionContext,
            state: actionStates[event.actionContext.state],
          }
        : undefined,
  });
}
export function wireSnapshot(application: SnapshotSource) {
  // WHY: A single owner executes these synchronous reads without yielding; the cursor covers exactly the state returned.
  const snapshot = application.jobs.snapshot();
  return create(SnapshotSchema, {
    instanceId: application.store.instanceId(),
    sequence: BigInt(application.store.sequence()),
    scheduler: {
      running: SchedulerState.RUNNING,
      paused: SchedulerState.PAUSED,
      stopping: SchedulerState.STOPPING,
      stopped: SchedulerState.STOPPED,
    }[snapshot.scheduler],
    worker: {
      idle: WorkerState.IDLE,
      busy: WorkerState.BUSY,
      recovering: WorkerState.RECOVERING,
    }[snapshot.worker],
    issues: application.store.issues
      .list()
      .slice(0, 50)
      .map((issue) =>
        wireIssue(issue, application.store.issues.assignments(issue.id).at(-1)),
      ),
    tracking: wireTracking(application.services.tracking),
    githubUsage: wireGitHubUsage(githubReads.usage()),
    githubScheduler: wireScheduler(application.services.githubScheduler),
    mergeStatuses: application.store.merging.entries().map((entry) => ({
      prId: entry.prId,
      chainId: entry.chainId,
      chainState: application.store.merging.chain(entry.chainId).state,
      autoMerge: entry.autoMerge,
      autoMergeSource: entry.autoMergeSource ?? "explicit",
      autoMergeStage: entry.autoMergeStage ?? "",
      state: entry.state,
      detail: entry.detail,
      prerequisiteUrls: application.store.merging
        .dependencies()
        .filter((edge) => edge.dependentId === entry.prId)
        .map((edge) => application.store.tracking.pr(edge.prerequisiteId).url),
    })),
    repairs: application.services.repairs.store.list().map(wireRepair),
    jobs: snapshot.jobs.map(wireJob),
    recentEvents: snapshot.events.map(wireEvent),
    recoveryPid:
      snapshot.recoveryPid === undefined
        ? undefined
        : BigInt(snapshot.recoveryPid),
    allowedTransitions: Object.entries(jobTransitions).flatMap(
      ([from, targets]) =>
        targets.map((to) => ({
          from: statusByName.get(from) ?? JobStatus.UNSPECIFIED,
          to: statuses[to],
        })),
    ),
  });
}

// Dashboard subscribers share the durable projection. Liveness refreshes only the
// time-sensitive usage/dispatch overlay; data ticks also invalidate transient jobs.
export function retainedDashboardSnapshot(application: SnapshotSource) {
  let snapshot: ReturnType<typeof wireSnapshot> | undefined;
  let inputRevision: string | undefined;
  let revision = 0;
  let projectedRevision = -1;
  return {
    invalidate: () => {
      revision++;
    },
    read: () => {
      const current = application.store.inputRevision();
      if (
        snapshot === undefined ||
        inputRevision !== current ||
        projectedRevision !== revision
      ) {
        snapshot = wireSnapshot(application);
        inputRevision = current;
        projectedRevision = revision;
      }
      return {
        ...snapshot,
        githubUsage: wireGitHubUsage(githubReads.usage()),
        githubScheduler: create(
          GitHubSchedulerStatusSchema,
          wireScheduler(application.services.githubScheduler),
        ),
      };
    },
  };
}
