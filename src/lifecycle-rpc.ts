import { create } from "@bufbuild/protobuf";
import { schedulerClient } from "./client.js";
import {
  LifecycleAction,
  LifecycleCheckpointState,
  LifecycleRetirementPolicy,
  LifecycleReportSchema,
  type LifecycleReport,
} from "./gen/octomanager/v2/lifecycle_pb.js";
import type { ActivationReport } from "./lifecycle.js";
const actions = {
  inventory: LifecycleAction.INVENTORY,
  checkpoint: LifecycleAction.CHECKPOINT,
  stop: LifecycleAction.STOP,
  restore: LifecycleAction.RESTORE,
  verify: LifecycleAction.VERIFY,
};
const checkpoints = {
  confirmed: LifecycleCheckpointState.CONFIRMED,
  refused: LifecycleCheckpointState.REFUSED,
  pending: LifecycleCheckpointState.PENDING,
};
export function actionName(action: LifecycleAction): string {
  const entry = Object.entries(actions).find(([, value]) => value === action);
  if (entry === undefined) throw new Error("Unsupported lifecycle action");
  return entry[0];
}
export function wireLifecycle(report: ActivationReport): LifecycleReport {
  return create(LifecycleReportSchema, {
    schemaVersion: report.schema_version,
    targets: report.targets.map((target) => ({
      target: target.target,
      expectedIdentity: target.expected_identity ?? undefined,
      runningIdentity: target.running_identity ?? undefined,
      ready: target.ready,
      process: {
        pid: BigInt(target.process.pid),
        startIdentity: target.process.start_identity,
        nativeId: target.process.native_id,
        ownerVerified: target.process.owner_verified,
      },
      sessions: [],
      schedulerPaused: target.scheduler_paused,
      retirementPolicy:
        target.retirement_policy === "successful-exit"
          ? LifecycleRetirementPolicy.SUCCESSFUL_EXIT
          : LifecycleRetirementPolicy.UNKNOWN,
      stopAccepted: target.stop_accepted,
      ...(target.checkpoint === undefined
        ? {}
        : {
            checkpoint: {
              state: checkpoints[target.checkpoint.state],
              runId: target.checkpoint.run_id,
            },
          }),
      ...(target.reason === undefined ? {} : { reason: target.reason }),
    })),
  });
}
export function readLifecycle(
  report: LifecycleReport | undefined,
): ActivationReport {
  if (
    report === undefined ||
    report.schemaVersion !== 1 ||
    report.targets.length !== 1
  )
    throw new Error("Native lifecycle report schema unavailable");
  const target = report.targets[0];
  if (
    target === undefined ||
    target.target !== "local" ||
    target.process === undefined ||
    target.process.pid <= 0n ||
    target.process.pid > BigInt(Number.MAX_SAFE_INTEGER) ||
    target.process.startIdentity === "" ||
    target.process.nativeId === "" ||
    !target.process.ownerVerified ||
    target.sessions.length !== 0
  )
    throw new Error(
      "Native lifecycle process or session authority unavailable",
    );
  const retirement = target.retirementPolicy;
  if (
    retirement !== LifecycleRetirementPolicy.UNKNOWN &&
    retirement !== LifecycleRetirementPolicy.SUCCESSFUL_EXIT
  )
    throw new Error("Native retirement policy unavailable");
  const value: ActivationReport = {
    schema_version: 1,
    targets: [
      {
        target: target.target,
        expected_identity: target.expectedIdentity ?? null,
        running_identity: target.runningIdentity ?? null,
        ready: target.ready,
        process: {
          pid: Number(target.process.pid),
          start_identity: target.process.startIdentity,
          native_id: target.process.nativeId,
          owner_verified: true,
        },
        sessions: [],
        scheduler_paused: target.schedulerPaused,
        retirement_policy:
          retirement === LifecycleRetirementPolicy.SUCCESSFUL_EXIT
            ? "successful-exit"
            : "unknown",
        stop_accepted: target.stopAccepted,
      },
    ],
  };
  if (target.checkpoint !== undefined) {
    const entry = Object.entries(checkpoints).find(
      ([, state]) => state === target.checkpoint?.state,
    );
    if (entry === undefined)
      throw new Error("Native checkpoint state unavailable");
    const state = entry[0];
    if (state !== "confirmed" && state !== "refused" && state !== "pending")
      throw new Error("Native checkpoint state unsupported");
    value.targets[0].checkpoint = { state, run_id: target.checkpoint.runId };
  }
  if (target.reason !== undefined) value.targets[0].reason = target.reason;
  return value;
}
export async function runtimeLifecycle(
  directory: string,
  request: {
    action: string;
    expectedNativeId?: string;
    runId?: string;
    expectedIdentity?: string;
    restorePaused?: boolean;
  },
  timeoutMs?: number,
): Promise<ActivationReport> {
  const entry = Object.entries(actions).find(
    ([name]) => name === request.action,
  );
  if (entry === undefined) throw new Error("Unsupported lifecycle action");
  const response = await schedulerClient(directory).runtimeLifecycle(
    { ...request, action: entry[1] },
    timeoutMs === undefined ? undefined : { timeoutMs },
  );
  return readLifecycle(response.report);
}
