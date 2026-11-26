import { fields, rows } from "../cli/projection.js";

const repair = fields([
  "id",
  "prId",
  "prUrl",
  "state",
  "step",
  "detail",
  "originalHead",
  "targetSha",
  "targetRef",
  "resultHead",
  "conflictedPaths",
  "usedAgent",
  "mechanicalRepairs",
]);
const conflict = fields(["id", "repairId", "prUrl", "round", "path", "recipe", "decision", "reason"]);
export const repairOutputs = {
  rebase: fields([], { repair }),
  repairs: fields([], { repairs: rows(repair) }),
  "conflict-cases": fields(["nextId"], { cases: rows(conflict) }),
  "conflict-case": fields([], { conflictCase: conflict }),
};
