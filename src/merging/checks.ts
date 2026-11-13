import { checkReplaces } from "../tracking/checks.js";
import type {
  CheckObservation,
  PRObservation,
  ObservationInput,
} from "../tracking/types.js";
export function currentMergeChecks(
  observation: ObservationInput | PRObservation,
): CheckObservation[] {
  const workflows =
    observation.workflows?.state === "complete"
      ? observation.workflows.value
      : [];
  const superseded = workflows.filter(
    (old) =>
      old.conclusion === "cancelled" &&
      old.workflowId !== undefined &&
      old.suiteId !== undefined &&
      ["push", "pull_request", "pull_request_target"].includes(
        old.event ?? "",
      ) &&
      workflows.some(
        (current) =>
          current.suiteId !== undefined &&
          current.suiteId !== old.suiteId &&
          current.workflowId === old.workflowId &&
          current.event === old.event &&
          current.headSha === old.headSha &&
          current.at > old.at &&
          current.status === "completed" &&
          current.conclusion === "success",
      ),
  );
  const suites = new Set(superseded.map((run) => run.suiteId));
  const runs =
    observation.checks.state === "complete" ? observation.checks.value : [];
  const values = [...runs, ...workflows];
  return values
    .filter(
      (check) =>
        !values.some(
          (candidate) =>
            candidate.headSha === check.headSha &&
            checkReplaces(check, candidate),
        ),
    )
    .filter(
      (check) =>
        check.suiteId === undefined ||
        !suites.has(check.suiteId) ||
        check.status !== "completed" ||
        check.conclusion !== "cancelled",
    );
}
