import { fields, rows } from "../cli/projection.js";

const assessment = fields(["id", "actionId", "state", "headSha", "policyVersion", "truncated"]);
const action = fields([
  "id",
  "prId",
  "ownerAgentId",
  "state",
  "summary",
  "evidenceUrl",
  "closeReason",
  "notificationKind",
  "evidenceHeadSha",
]);
const item = fields(["id", "applicable", "acknowledgedAtMs", "summary", "unavailable"], {
  action: fields([], { action, assessment }),
  merge: fields(["entryId", "chainId", "state"]),
  issue: fields(["issueId", "stage", "waiting"]),
  submission: fields(["submissionId", "state"]),
  participants: fields(["prId", "count"]),
  reference: fields(["referenceId"]),
});
const digest = fields(["id", "agentId", "state", "revision", "error", "cleanupPending"]);
const message = fields(["id", "recipientAgentId", "summary", "merge", "mergeTarget"], { items: rows(item) });
export const notificationOutputs = {
  message,
  digest: fields([], {
    digest,
    revision: fields(["digestId", "revision", "dispatchId", "messageIds", "mergeTarget"]),
  }),
  digests: rows(digest),
  ack: fields(["receipt", "itemCount"]),
  merge: fields(["state", "receipt", "pr", "head", "chain", "entry", "reason", "detail", "error"]),
  "acknowledge-message": fields(["message", "applicable", "receivedAtMs"]),
  "acknowledge-digest": fields(["receipt", "items"]),
};
