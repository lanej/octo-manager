import { test, expect } from "bun:test";
import { runBeforeAfter } from "./support/security-before-after.js";
test("historical notification replay fails the exposure invariant while the current path contains the same attack", async () => {
  const report = await runBeforeAfter();
  expect(report.passed).toBe(true);
  expect(report.checks).toEqual({
    beforeDirectExposesAttack: true,
    beforeDigestExposesAttack: true,
    afterDirectExposesAttack: false,
    afterDigestExposesAttack: false,
    afterRecoveryExposesAttack: false,
    afterReceiptExposesAttack: false,
    beforeDirectSimulatedPublishCalls: 1,
    beforeDigestSimulatedPublishCalls: 1,
    afterDirectSimulatedPublishCalls: 0,
    afterDigestSimulatedPublishCalls: 0,
    hostileFeedbackPreserved: true,
    hostileAnalysisPreserved: true,
    hostileAssessmentState: "completed",
    forbiddenToolAssessmentState: "failed",
    actionRemainsOpen: true,
    receiptsConfirmed: true,
    benignBeforeDelivered: true,
    benignAfterDelivered: true,
  });
});
