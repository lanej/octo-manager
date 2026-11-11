import { Code, ConnectError } from "@connectrpc/connect";
import {
  RepairState as WireState,
  type RequestRebaseRequest,
} from "../gen/octomanager/v1/repairs_pb.js";
import { RepairState, type RepairAttempt } from "./types.js";
import type { RepairService } from "./service.js";
const states: Record<RepairState, WireState> = {
  [RepairState.Queued]: WireState.QUEUED,
  [RepairState.Running]: WireState.RUNNING,
  [RepairState.AwaitingChecks]: WireState.AWAITING_CHECKS,
  [RepairState.Succeeded]: WireState.SUCCEEDED,
  [RepairState.Blocked]: WireState.BLOCKED,
  [RepairState.Failed]: WireState.FAILED,
  [RepairState.Uncertain]: WireState.UNCERTAIN,
};
export function wireRepair(a: RepairAttempt) {
  return {
    id: a.id,
    prId: a.prId,
    prUrl: a.request.prUrl,
    state: states[a.state],
    step: a.step,
    detail: a.detail,
    createdAtMs: BigInt(a.createdAt),
    updatedAtMs: BigInt(a.updatedAt),
    profile: a.request.profile,
    harness: a.profile.harness,
    model: a.profile.model,
    originalHead: a.source?.headSha,
    targetSha: a.source?.targetSha,
    targetRef: a.source?.targetRef,
    resultHead: a.resultHead,
    conflictedPaths: a.conflictedPaths,
    usedAgent: a.usedAgent,
    history: a.history.map((h) => ({
      state: states[h.state],
      step: h.step,
      detail: h.detail,
      atMs: BigInt(h.at),
    })),
  };
}
export function repairRoutes(service: RepairService) {
  return {
    requestRebase(r: RequestRebaseRequest) {
      try {
        return {
          repair: wireRepair(
            service.request({
              requestId: r.requestId,
              prUrl: r.url,
              profile: r.profile,
            }),
          ),
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Repair request failed";
        throw new ConnectError(
          message,
          message.includes("already used")
            ? Code.AlreadyExists
            : message.includes("stopping")
              ? Code.Unavailable
              : message.startsWith("Invalid")
                ? Code.InvalidArgument
                : Code.FailedPrecondition,
        );
      }
    },
    listRepairs() {
      return { repairs: service.store.list().map(wireRepair) };
    },
  };
}
