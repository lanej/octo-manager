import { fields, rows } from "../cli/projection.js";

const agent = fields(["id", "target", "harnessVersion"]);
const observation = fields(["observedAtMs", "headSha", "baseSha", "targetBase", "lifecycle", "mergeability"]);
const pr = fields(
  [
    "id",
    "url",
    "ownerAgentId",
    "enabled",
    "trackingState",
    "refreshError",
    "refreshErrorAtMs",
    "drainDeadlineAtMs",
    "archivedAtMs",
    "archiveReason",
  ],
  { observation },
);
const assessment = fields(["id", "actionId", "state", "headSha", "policyVersion", "truncated"]);
const action = fields([
  "id",
  "prId",
  "ownerAgentId",
  "state",
  "summary",
  "evidenceUrl",
  "closeReason",
  "progressAtMs",
  "notificationKind",
  "evidenceHeadSha",
]);
const delivery = fields([
  "id",
  "actionId",
  "recipientAgentId",
  "state",
  "progress",
  "messageSequence",
  "acknowledgedAtMs",
]);
const message = fields([
  "sequence",
  "id",
  "actionId",
  "recipientAgentId",
  "acknowledgedAtMs",
  "applicable",
  "submissionId",
  "issueId",
  "workflowPrId",
  "readyHead",
]);
const checkWatch = fields(["id", "prId", "headSha", "state", "replacementHeadSha"]);
const prResponse = fields(["refresh"], {
  pr,
  repositoryPolicy: fields(["status", "stage", "autoMerge", "error", "root", "path"]),
});
const actionResponse = fields([], { action, assessment });
export const trackingOutputs = {
  agents: rows(agent),
  "register-agent": fields([], { agent }),
  track: prResponse,
  tracked: fields([], { prs: rows(pr) }),
  pr: prResponse,
  refresh: prResponse,
  assign: prResponse,
  untrack: prResponse,
  actions: fields([], { actions: rows(action) }),
  action: actionResponse,
  assessment: fields([], { assessment }),
  "retry-assessment": fields([], { assessment }),
  acknowledge: actionResponse,
  working: actionResponse,
  reprofile: actionResponse,
  "retry-delivery": fields([], { delivery }),
  inbox: fields(["nextSequence", "hasMore"], { messages: rows(message) }),
  tracking: fields([], {
    prs: rows(pr),
    agents: rows(agent),
    actions: rows(action),
    deliveries: rows(delivery),
    checkWatches: rows(checkWatch),
  }),
};
