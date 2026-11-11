import { RecipeDecision, type ConflictCase } from "./cases.js";
import {
  ConflictDecision,
  type ListConflictCasesRequest,
  type GetConflictCaseRequest,
} from "../gen/octomanager/v1/repairs_pb.js";
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
    mechanicalRepairs: a.mechanicalRepairs,
    history: a.history.map((h) => ({
      state: states[h.state],
      step: h.step,
      detail: h.detail,
      atMs: BigInt(h.at),
    })),
  };
}
const decisions: Record<RecipeDecision, ConflictDecision> = {
  [RecipeDecision.Pending]: ConflictDecision.PENDING,
  [RecipeDecision.Applied]: ConflictDecision.APPLIED,
  [RecipeDecision.Declined]: ConflictDecision.DECLINED,
  [RecipeDecision.Error]: ConflictDecision.ERROR,
};
function wireCase(c: ConflictCase, url: string) {
  return {
    id: BigInt(c.id),
    repairId: c.repairId,
    prUrl: url,
    round: c.round,
    path: c.path,
    recipe: c.recipe,
    toolVersion: c.toolVersion,
    decision: decisions[c.decision],
    reason: c.reason,
    atMs: BigInt(c.at),
    baseBlob: c.refs.base,
    targetBlob: c.refs.target,
    replayedBlob: c.refs.replayed,
    baseText: c.inputs?.base,
    targetText: c.inputs?.target,
    replayedText: c.inputs?.replayed,
    candidate: c.candidate,
    agentResult: c.agentResult,
  };
}
function caseNumber(id: bigint) {
  if (id < 0n || id > BigInt(Number.MAX_SAFE_INTEGER))
    throw new ConnectError("Invalid conflict case ID", Code.InvalidArgument);
  return Number(id);
}
export function repairRoutes(service: RepairService) {
  return {
    listConflictCases(r: ListConflictCasesRequest) {
      const cases = service.conflicts?.list(caseNumber(r.afterId)) ?? [];
      const attempts = new Map(
        service.store.list().map((a) => [a.id, a.request.prUrl]),
      );
      return {
        cases: cases.map((c) => wireCase(c, attempts.get(c.repairId) ?? "")),
        nextId: BigInt(cases.at(-1)?.id ?? caseNumber(r.afterId)),
      };
    },
    getConflictCase(r: GetConflictCaseRequest) {
      const id = caseNumber(r.id);
      try {
        const c = service.conflicts?.get(id);
        if (c === undefined) throw new Error("Not found");
        return {
          conflictCase: wireCase(
            c,
            service.store.get(c.repairId).request.prUrl,
          ),
        };
      } catch {
        throw new ConnectError("Conflict case not found", Code.NotFound);
      }
    },
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
