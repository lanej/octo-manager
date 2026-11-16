import {
  IssueStage,
  Waiting,
  Role,
  validateBrief,
  type IssueRecord,
  type IssuePolicy,
  type Assignment,
  type StageResult,
} from "./contracts.js";
export function applyResult(
  issue: IssueRecord,
  assignment: Assignment,
  value: StageResult,
  policy: IssuePolicy,
): IssueRecord {
  if (
    assignment.epoch !== issue.epoch ||
    assignment.briefVersion !== (issue.brief?.version ?? 0)
  )
    throw new Error("Superseded assignment cannot advance this issue");
  const next = {
    ...issue,
    assignmentId: "",
    detail: value.summary,
    waiting: Waiting.None,
  };
  switch (value.disposition) {
    case "blocked":
      return { ...next, waiting: Waiting.Blocked };
    case "brief":
    case "clarification": {
      if (assignment.role !== Role.Investigation || value.brief == null)
        throw new Error("Investigation brief required");
      validateBrief(value.brief);
      const brief = {
        ...value.brief,
        version: (issue.brief?.version ?? 0) + 1,
      };
      return {
        ...next,
        brief,
        approvedVersion: 0,
        publicationVersion: 0,
        epoch: issue.epoch + 1,
        stage: IssueStage.Investigation,
        waiting:
          brief.questions.length > 0 ? Waiting.Clarification : Waiting.Approval,
        clarificationRound: issue.clarificationRound + 1,
        timeoutPlanned: assignment.purpose === "timeout",
        clarificationDueAt: undefined,
      };
    }
    case "implemented":
      if (
        assignment.role !== Role.Implementation ||
        issue.stage !== IssueStage.InProgress
      )
        throw new Error("Implementation assignment required");
      return { ...next, stage: IssueStage.Testing };
    case "tested":
      if (
        assignment.role !== Role.Implementation ||
        issue.stage !== IssueStage.Testing ||
        value.evidence.length === 0
      )
        throw new Error("Testing evidence required");
      if (
        value.draft !== undefined &&
        (policy.publish || issue.publicationVersion === issue.brief?.version)
      )
        return {
          ...next,
          waiting: Waiting.Blocked,
          detail: "Publishing tested work through the code host",
        };
      if (value.prUrl == null)
        return {
          ...next,
          waiting: Waiting.Approval,
          detail: "Tests reported; publication approval or linked PR required",
        };
      if (!policy.publish && issue.publicationVersion !== issue.brief?.version)
        throw new Error("Publication is not authorized for this brief");
      return {
        ...next,
        stage: IssueStage.InReview,
        prUrl: value.prUrl,
        prHead: value.head ?? "",
      };
    case "verified":
      if (
        assignment.role !== Role.Verification ||
        issue.stage !== IssueStage.Verification ||
        value.evidence.length === 0 ||
        value.head !== issue.prHead
      )
        throw new Error(
          "Verification must cover the merged head with acceptance evidence",
        );
      return { ...next, stage: IssueStage.Done, verifiedHead: value.head };
    case "rework":
      if (assignment.role === Role.Verification)
        return {
          ...next,
          stage: IssueStage.Investigation,
          waiting: Waiting.None,
          approvedVersion: 0,
          pendingComments: [
            {
              id: `verification:${assignment.id}`,
              revision: String(issue.epoch),
              author: "verification",
              body: value.summary,
              url: issue.ref.url,
            },
          ],
        };
      return { ...next, stage: IssueStage.InProgress, waiting: Waiting.None };
    case "no_change":
      if (assignment.purpose !== "comments")
        throw new Error("No-change result requires comment assessment");
      return next;
    case "follow_up":
      if (
        assignment.role !== Role.Investigation ||
        value.followUpTitle?.trim() == null ||
        value.followUpBody?.trim() == null
      )
        throw new Error("Follow-up title and body required");
      return {
        ...next,
        waiting: policy.followUps ? Waiting.None : Waiting.Approval,
      };
  }
}
export function canImplement(issue: IssueRecord, policy: IssuePolicy): boolean {
  return (
    issue.brief !== undefined &&
    !issue.brief.blockingQuestions &&
    (issue.brief.questions.length === 0 ||
      (policy.assumptions && issue.timeoutPlanned)) &&
    (policy.implement || issue.approvedVersion === issue.brief.version)
  );
}
