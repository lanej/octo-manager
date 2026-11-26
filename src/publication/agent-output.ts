import { fields, rows } from "../cli/projection.js";

const receipt = fields(["id", "state", "url", "error", "tracking", "legacy", "detail"]);
export const publicationOutputs = {
  "submit-pr": receipt,
  submission: receipt,
  "retry-submission": receipt,
  submissions: fields(["next"], { items: rows(receipt) }),
};
