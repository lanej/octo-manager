import {
  AssessmentState,
  AssessmentDisposition,
} from "../gen/octomanager/v1/tracking_pb.js";
import type { Assessment, AssessmentResult } from "./contracts.js";
const states: Record<Assessment["state"], AssessmentState> = {
  pending: AssessmentState.PENDING,
  running: AssessmentState.RUNNING,
  completed: AssessmentState.COMPLETED,
  failed: AssessmentState.FAILED,
  interrupted: AssessmentState.INTERRUPTED,
  superseded: AssessmentState.SUPERSEDED,
};
const dispositions: Record<
  AssessmentResult["disposition"],
  AssessmentDisposition
> = {
  potential_change: AssessmentDisposition.POTENTIAL_CHANGE,
  no_change_suggested: AssessmentDisposition.NO_CHANGE_SUGGESTED,
  insufficient_context: AssessmentDisposition.INSUFFICIENT_CONTEXT,
};
export function wireAssessment(item: Assessment, full = false) {
  return {
    id: item.id,
    actionId: item.input.actionId,
    state: states[item.state],
    headSha: /^[a-f0-9]{40,64}$/u.test(item.input.headSha)
      ? item.input.headSha
      : "",
    policyVersion: item.input.policyVersion,
    history: item.history.map((entry) => ({
      state: states[entry.state],
      atMs: BigInt(entry.at),
    })),
    truncated: item.input.truncated,
    createdAtMs: BigInt(item.createdAt),
    updatedAtMs: BigInt(item.updatedAt),
    ...(full
      ? {
          untrustedEvidence: item.input.evidence,
          ...(item.result === undefined
            ? {}
            : {
                disposition: dispositions[item.result.disposition],
                untrustedAnalysis: item.result.analysis,
              }),
        }
      : {}),
  };
}
