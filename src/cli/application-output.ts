import { fields, rows } from "./projection.js";

const job = fields([
  "id",
  "requestId",
  "task",
  "status",
  "retryCount",
  "availableAt",
  "result",
  "error",
]);
const event = fields([
  "seq",
  "jobId",
  "at",
  "kind",
  "detail",
  "prId",
  "actionId",
  "actionContext",
]);
export const applicationOutputs = {
  submit: job,
  get: job,
  cancel: job,
  retry: job,
  pause: fields(["scheduler"]),
  resume: fields(["scheduler"]),
  demo: fields([], { conflict: job, github: job }),
  events: rows(event),
};
