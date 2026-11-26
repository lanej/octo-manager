import { fields, rows } from "../cli/projection.js";
const report = fields(["requestId", "operationId", "name", "outcome", "detail", "prUrl", "evidenceUrl"], {
  actor: fields(["harness", "sessionId", "label"]),
});
const activity = fields(["sequence", "recordedAtMs"], { report });
const event = fields(["sequence", "jobId", "atMs", "kind", "detail", "prId", "actionId", "actionContext"]);
export const activityOutputs = {
  "record-activity": fields([], { activity }),
  activity: fields(["nextSequence", "hasMore"], {
    activities: rows(activity),
    events: rows(event),
  }),
};
