import type { ServiceImpl } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import type { SchedulerService } from "../gen/octomanager/v2/scheduler_pb.js";
import {
  IssueStage as WireStage,
  IssueWaiting as WireWaiting,
  IssueOperation,
} from "../gen/octomanager/v2/issues_pb.js";
import {
  IssueStage,
  Waiting,
  type IssueRecord,
  type Assignment,
} from "./contracts.js";
import type { IssueService } from "./service.js";
const stages: Record<IssueStage, WireStage> = {
  investigation: WireStage.INVESTIGATION,
  ready: WireStage.READY,
  in_progress: WireStage.IN_PROGRESS,
  testing: WireStage.TESTING,
  in_review: WireStage.IN_REVIEW,
  verification: WireStage.VERIFICATION,
  done: WireStage.DONE,
  cancelled: WireStage.CANCELLED,
};
const waiting: Record<Waiting, WireWaiting> = {
  none: WireWaiting.NONE,
  needs_clarification: WireWaiting.NEEDS_CLARIFICATION,
  blocked: WireWaiting.BLOCKED,
  awaiting_approval: WireWaiting.AWAITING_APPROVAL,
  paused: WireWaiting.PAUSED,
};
export function wireIssue(issue: IssueRecord, assignment?: Assignment) {
  return {
    id: issue.id,
    reference: issue.ref,
    title: issue.title,
    stage: stages[issue.stage],
    waiting: waiting[issue.waiting],
    detail: issue.detail,
    brief: issue.brief,
    assignmentId: issue.assignmentId,
    prUrl: issue.prUrl,
    updatedAtMs: BigInt(issue.updatedAt),
    clarificationDueAtMs:
      issue.clarificationDueAt === undefined
        ? undefined
        : BigInt(issue.clarificationDueAt),
    externallyClosed: issue.externalClosed,
    approvedVersion: issue.approvedVersion,
    workspace: issue.workspace,
    assignment:
      assignment === undefined ? undefined : wireAssignment(assignment),
  };
}
function wireAssignment(item: Assignment) {
  return {
    id: item.id,
    role: item.role,
    state: item.state,
    sessionId: item.sessionId,
    turnId: item.turnId,
    briefVersion: item.briefVersion,
    detail: item.detail,
    harness: item.profile.harness,
    model: item.profile.model,
    evidence: item.result?.evidence ?? [],
  };
}
function operation(value: IssueOperation): string {
  switch (value) {
    case IssueOperation.APPROVE:
      return "approve";
    case IssueOperation.APPROVE_PUBLICATION:
      return "approve-publication";
    case IssueOperation.APPROVE_FOLLOW_UP:
      return "approve-follow-up";
    case IssueOperation.ANSWER:
      return "answer";
    case IssueOperation.PAUSE:
      return "pause";
    case IssueOperation.RESUME:
      return "resume";
    case IssueOperation.CANCEL:
      return "cancel";
    case IssueOperation.REFRESH:
      return "refresh";
    case IssueOperation.UNSPECIFIED:
      throw new Error("Issue operation required");
    default:
      throw new Error("Unsupported issue operation");
  }
}
function perform<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    throw new ConnectError(
      error instanceof Error ? error.message : "Issue operation failed",
      Code.FailedPrecondition,
    );
  }
}
export function issueRoutes(
  service: IssueService,
): Pick<
  ServiceImpl<typeof SchedulerService>,
  "enrollIssue" | "listIssues" | "getIssue" | "updateIssue"
> {
  return {
    enrollIssue(request) {
      return perform(() => ({
        issue: wireIssue(
          service.enroll(
            request.provider,
            request.url,
            request.root,
            request.ownerAgentId,
            request.requestId,
          ),
        ),
      }));
    },
    listIssues(request) {
      const all = service.store.list();
      return {
        issues: all
          .slice(request.offset, request.offset + 20)
          .map((issue) =>
            wireIssue(issue, service.store.assignments(issue.id).at(-1)),
          ),
        hasMore: all.length > request.offset + 20,
      };
    },
    getIssue(request) {
      return perform(() => {
        const issue = service.store.get(request.id);
        const events = service.store.events(
          issue.id,
          request.beforeSequence === 0n
            ? Number.MAX_SAFE_INTEGER
            : Number(request.beforeSequence),
        );
        return {
          issue: wireIssue(issue, service.store.assignments(issue.id).at(-1)),
          briefs: service.store.briefs(issue.id),
          effects: service.store
            .effects()
            .filter((effect) => effect.issueId === issue.id)
            .concat(
              (() => {
                const storage = service.store.repository.get(issue.id);
                if (
                  storage === undefined ||
                  (storage.pending === undefined && storage.error === "")
                )
                  return [];
                return [
                  {
                    id: `${issue.id}:storage`,
                    issueId: issue.id,
                    kind: "persist_content",
                    state: storage.error === "" ? "pending" : "failed",
                    body: "",
                    title: "",
                    url: "",
                  },
                ];
              })(),
            )
            .slice(0, 20)
            .map((effect) => ({
              id: effect.id,
              kind: effect.kind,
              state: effect.state,
              url: effect.url,
            })),
          assignments: service.store
            .assignments(issue.id)
            .slice(-10)
            .map(wireAssignment),
          events: events.map((event) => ({
            sequence: BigInt(event.sequence),
            atMs: BigInt(event.at),
            kind: event.kind,
            detail: event.detail,
          })),
          hasMoreEvents: events.length === 50,
        };
      });
    },
    updateIssue(request) {
      return perform(() => ({
        issue: wireIssue(
          service.command(
            request.id,
            operation(request.operation),
            request.text,
            request.briefVersion,
            request.requestId,
          ),
        ),
      }));
    },
  };
}
