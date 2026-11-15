import {isMessage} from "@bufbuild/protobuf";
import {file_octomanager_v2_domain} from "./gen/octomanager/v2/domain_pb.js";
import {unwire} from "./api/codec.js";
import { actionContext } from "./tracking/evidence.js";
import { ActionState as TrackingActionState, DeliveryState as TrackingDeliveryState } from "./gen/octomanager/v2/tracking_pb.js";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { join } from "node:path";
import { SchedulerService, JobStatus, SchedulerState, WorkerState, type Job as WireJob, type Snapshot as WireSnapshot, type JobEvent as WireEvent } from "./gen/octomanager/v2/scheduler_pb.js";
import { digest, parseTask, type Job, type JobEvent, type Snapshot, type Status } from "./domain.js";

export function schedulerClient(directory: string) {
  // WHY: Isolate Unix-socket requests so stream cancellation or coordinator restart cannot reuse a stale Bun HTTP connection.
  const options={httpVersion:"1.1" as const,baseUrl:"http://localhost",nodeOptions:{socketPath:join(directory,"run.sock"),agent:false as const},defaultTimeoutMs:10000};
  const raw=createClient(SchedulerService,createConnectTransport(options));
  let ready:Promise<void>|undefined;
  return createClient(SchedulerService,createConnectTransport({...options,interceptors:[next=>async request=>{
    if(request.method.name!=="GetServerInfo"){
      ready??=raw.getServerInfo({}).then(info=>{if(info.apiVersion!==2)throw new ConnectError("Incompatible Octo API; update the server, CLI, and dashboard together",Code.FailedPrecondition);}).catch((error:unknown)=>{
        ready=undefined;
        if(error instanceof ConnectError&&(error.code===Code.Unimplemented||error.code===Code.NotFound))throw new ConnectError("Incompatible Octo API; update the server, CLI, and dashboard together",Code.FailedPrecondition);
        throw error;
      });
      await ready;
    }
    return next(request);
  }]}));
}
function job(value?: WireJob): Job {
  if (!value?.task) throw new Error("Server returned no job task");
  const task = parseTask(value.task.kind.case === "resolveConflict" ? { kind: "resolve_conflict" } : { kind: "summarize_pr", url: value.task.kind.case === "summarizePullRequest" ? value.task.kind.value.url : "" });
  const status = JobStatus[value.status]?.toLowerCase() as Status;
  if (!status || status === ("unspecified" as Status)) throw new Error("Unsupported job status");
  return { id: value.id, requestId: value.requestId, task, digest: digest(task), status, createdAt: Number(value.createdAtMs), updatedAt: Number(value.updatedAtMs), availableAt: Number(value.availableAtMs), retryCount: value.retryCount, attempts: value.attempts.map(a => ({ number: a.number, startedAt: Number(a.startedAtMs), ...(a.endedAtMs === undefined ? {} : { endedAt: Number(a.endedAtMs) }), ...(a.workerPid === undefined ? {} : { pid: Number(a.workerPid) }), ...(a.exitObservedAtMs === undefined ? {} : { exitObservedAt: Number(a.exitObservedAtMs) }), ...(a.error === undefined ? {} : { error: a.error }) })), ...(value.resultMarkdown === undefined ? {} : { result: value.resultMarkdown }), ...(value.error === undefined ? {} : { error: value.error }) };
}
function event(value: WireEvent): JobEvent {
  const context = value.actionContext;
  const mapped = context === undefined ? undefined : actionContext({ ...context, state: TrackingActionState[context.state].replace(/^ACTION_STATE_/, "").toLowerCase() });
  return { seq: Number(value.sequence), jobId: value.jobId, at: Number(value.atMs), kind: value.kind, detail: value.detail, ...(value.prId === undefined ? {} : { prId: value.prId }), ...(value.actionId === undefined ? {} : { actionId: value.actionId }), ...(mapped === undefined ? {} : { actionContext: mapped }) };
}
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

export async function trackingRequest(directory:string,command:string,id?:string,options:{url?:string;harness?:string;endpoint?:string;sessionId?:string;agentId?:string;label?:string;after?:string;includeAcknowledged?:boolean;applicableOnly?:boolean}={}):Promise<unknown>{
 const client=schedulerClient(directory);
 const owner={harness:options.harness??'codex',endpoint:options.endpoint??'local',sessionId:options.sessionId??'',label:options.label};
 switch(command){
  case 'agents':return (await client.getSnapshot({})).snapshot?.tracking?.agents;
  case 'register-agent':return client.registerAgent({target:owner});
  case 'track':return client.trackPullRequest({url:options.url??'',owner});
  case 'tracked':return client.listTrackedPullRequests({});
  case 'pr':return client.getTrackedPullRequest({id:id??''});
  case 'refresh':return client.refreshTrackedPullRequest({id:id??''});
  case 'assign':return client.assignPullRequest({id:id??'',owner});
  case 'untrack':return client.untrackPullRequest({id:id??''});
  case 'actions':return client.listActions({prId:id});
  case 'action':return client.getAction({id:id??''});
  case 'acknowledge':return client.acknowledgeAction({id:id??'',agentId:options.agentId??''});
  case 'inbox':return client.listAgentMessages({agentId:options.agentId??'',afterSequence:BigInt(options.after??'0'),includeAcknowledged:options.includeAcknowledged??false,applicableOnly:options.applicableOnly??false});
  case 'acknowledge-message':return client.acknowledgeMessage({id:id??'',agentId:options.agentId??''});
  case 'working':return client.startAction({id:id??'',agentId:options.agentId??''});
  case 'retry-delivery':return client.retryDelivery({id:id??''});
  case 'reprofile':return client.reprofileAction({id:id??''});
  case 'tracking':return (await client.getSnapshot({})).snapshot?.tracking;
  default:throw new Error('Unsupported tracking command');
 }
}

export function cliJSON(key:string,value:unknown):unknown {
 if(key==="$typeName")return undefined;
 if(isMessage(value)){const schema=file_octomanager_v2_domain.messages.find(schema=>schema.typeName===value.$typeName);if(schema!==undefined)return unwire(schema,value);}
 if(typeof value==="bigint")return Number(value);
 if(value!==null&&typeof value==="object"&&"$typeName" in value){
  const data:Record<string,unknown>=Object.fromEntries(Object.entries(value));
  const state=typeof data["state"]==="number"?data["state"]:0;
  if(data["$typeName"]==="octomanager.v2.PendingAction")return {...data,$typeName:undefined,state:TrackingActionState[state]?.toLowerCase()??"unknown"};
  if(data["$typeName"]==="octomanager.v2.ActionDelivery")return {...data,$typeName:undefined,state:TrackingDeliveryState[state]?.toLowerCase()??"unknown"};
 }
 return value;
}
