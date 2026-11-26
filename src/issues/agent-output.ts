import { fields, rows } from "../cli/projection.js";

const brief = fields(["version", "outcome", "scope", "criteria", "assumptions", "questions", "blockingQuestions"]);
const assignment = fields([
  "id",
  "role",
  "state",
  "sessionId",
  "turnId",
  "briefVersion",
  "detail",
  "harness",
  "model",
  "evidence",
]);
const issue = fields(
  [
    "id",
    "reference",
    "title",
    "stage",
    "waiting",
    "detail",
    "assignmentId",
    "prUrl",
    "clarificationDueAtMs",
    "externallyClosed",
    "approvedVersion",
    "workspace",
  ],
  { brief, assignment },
);
const response = fields([], { issue });
export const issueOutputs = {
  "issue-subscribe": fields(["subscriptions"]),
  "issue-subscriptions": fields(["subscriptions"]),
  "issue-track": response,
  "issue-list": fields(["hasMore"], { issues: rows(issue) }),
  "issue-show": fields(["hasMoreEvents", "effects"], {
    issue,
    events: rows(fields(["sequence", "atMs", "kind", "detail"])),
  }),
  "issue-approve": response,
  "issue-approve-publication": response,
  "issue-approve-follow-up": response,
  "issue-answer": response,
  "issue-pause": response,
  "issue-resume": response,
  "issue-cancel": response,
  "issue-refresh": response,
};
