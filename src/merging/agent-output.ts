import { fields, rows } from "../cli/projection.js";

const entry = fields([
  "id",
  "chainId",
  "prId",
  "autoMerge",
  "autoMergeSource",
  "autoMergeStage",
  "method",
  "checks",
  "noCi",
  "state",
  "detail",
  "ready",
  "preparationHold",
  "preparedHead",
  "mergeCommit",
]);
const chain = fields(["id", "state"]);
const operation = fields([
  "id",
  "entryId",
  "prId",
  "state",
  "kind",
  "phase",
  "detail",
  "resultHead",
  "head",
  "baseRef",
  "baseSha",
  "mergeCommit",
]);
const dependency = fields(["id", "dependentId", "prerequisiteId", "active", "reason", "referenceId", "preparation"]);
const reference = fields([
  "id",
  "targetUrl",
  "targetKind",
  "prId",
  "revision",
  "evidenceUrl",
  "hint",
  "active",
  "decision",
]);
export const mergingOutputs = {
  "merge-policy": entry,
  "merge-ready": entry,
  "auto-merge": fields(["prId", "enabled"], { entry }),
  "queue-chain": chain,
  chains: fields([], {
    chains: rows(chain),
    entries: rows(entry),
    operations: rows(operation),
    dependencies: rows(dependency),
  }),
  references: fields([], { references: rows(reference) }),
  dependencies: fields([], { dependencies: rows(dependency) }),
  "dependency-confirm": dependency,
  "dependency-remove": dependency,
  "reference-dismiss": reference,
  "pause-chain": chain,
  "resume-chain": chain,
  "cancel-chain": chain,
  "reconcile-operation": operation,
};
