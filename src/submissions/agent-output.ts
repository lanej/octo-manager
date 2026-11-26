import { fields, rows } from "../cli/projection.js";

const submission = fields(["id", "state", "url", "prUrl", "prId", "detail", "policyVersion"], {
  request: fields(["repository", "headRef", "headSha", "baseRef", "draft"]),
});
export const historyOutputs = {
  "legacy-submissions": fields(["nextBeforeRowId"], {
    submissions: rows(submission),
  }),
  "legacy-submission": submission,
  "legacy-policy": fields([], {
    policy: fields(["id", "repository", "version", "sourceDigest", "requirements", "blockers"]),
  }),
};
