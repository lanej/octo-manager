import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { join } from "node:path";
import { SchedulerService, JobStatus, SchedulerState, WorkerState, type Job as WireJob, type Snapshot as WireSnapshot, type JobEvent as WireEvent } from "./gen/octomanager/v1/scheduler_pb.js";
import { digest, parseTask, type Job, type JobEvent, type Snapshot, type Status } from "./domain.js";

export function schedulerClient(directory: string) {
  // WHY: Isolate Unix-socket requests so stream cancellation or coordinator restart cannot reuse a stale Bun HTTP connection.
  return createClient(SchedulerService, createConnectTransport({ httpVersion: "1.1", baseUrl: "http://localhost", nodeOptions: { socketPath: join(directory, "run.sock"), agent: false }, defaultTimeoutMs: 10000 }));
}
function job(value?: WireJob): Job {
  if (!value?.task) throw new Error("Server returned no job task");
  const task = parseTask(value.task.kind.case === "resolveConflict" ? { kind: "resolve_conflict" } : { kind: "summarize_pr", url: value.task.kind.case === "summarizePullRequest" ? value.task.kind.value.url : "" });
  const status = JobStatus[value.status]?.toLowerCase() as Status;
  if (!status || status === ("unspecified" as Status)) throw new Error("Unsupported job status");
  return { id: value.id, requestId: value.requestId, task, digest: digest(task), status, createdAt: Number(value.createdAtMs), updatedAt: Number(value.updatedAtMs), availableAt: Number(value.availableAtMs), retryCount: value.retryCount, attempts: value.attempts.map(a => ({ number: a.number, startedAt: Number(a.startedAtMs), ...(a.endedAtMs === undefined ? {} : { endedAt: Number(a.endedAtMs) }), ...(a.workerPid === undefined ? {} : { pid: Number(a.workerPid) }), ...(a.exitObservedAtMs === undefined ? {} : { exitObservedAt: Number(a.exitObservedAtMs) }), ...(a.error === undefined ? {} : { error: a.error }) })), ...(value.resultMarkdown === undefined ? {} : { result: value.resultMarkdown }), ...(value.error === undefined ? {} : { error: value.error }) };
}
function event(value: WireEvent): JobEvent { return { seq: Number(value.sequence), jobId: value.jobId, at: Number(value.atMs), kind: value.kind, detail: value.detail }; }
function snapshot(value?: WireSnapshot): Snapshot {
  if (!value) throw new Error("Server returned no snapshot");
  return { scheduler: SchedulerState[value.scheduler]!.toLowerCase() as Snapshot["scheduler"], worker: WorkerState[value.worker]!.toLowerCase() as Snapshot["worker"], jobs: value.jobs.map(job), events: value.recentEvents.map(event), ...(value.recoveryPid === undefined ? {} : { recoveryPid: Number(value.recoveryPid) }) };
}
export async function request(directory: string, command: object): Promise<any> {
  const client = schedulerClient(directory);
  const c = command as Record<string, any>;
  if (c.op === "snapshot") return snapshot((await client.getSnapshot({})).snapshot);
  if (c.op === "get") return job((await client.getJob({ id: c.id })).job);
  if (c.op === "submit") {
    const task = parseTask(c.task);
    return job((await client.submitJob({ requestId: c.requestId, task: { kind: task.kind === "resolve_conflict" ? { case: "resolveConflict", value: {} } : { case: "summarizePullRequest", value: { url: task.url } } } })).job);
  }
  if (c.op === "cancel") return job((await client.cancelJob({ id: c.id })).job);
  if (c.op === "retry") return job((await client.retryJob({ id: c.id })).job);
  if (c.op === "pause" || c.op === "resume") { const result = snapshot((await client.setPaused({ paused: c.op === "pause" })).snapshot); return { scheduler: result.scheduler }; }
  if (c.op === "events") return (await client.listEvents({ afterSequence: BigInt(c.after ?? 0), jobId: c.id })).events.map(event);
  throw new Error("Unsupported command");
}
