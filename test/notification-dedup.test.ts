import { test, expect } from "bun:test";
import { renderDigest } from "../src/notifications/render.js";
import type { AgentMessage } from "../src/tracking/inbox.js";
function notice(id: string, summary: string): AgentMessage {
  return {
    id,
    sequence: 1,
    actionId: "",
    submissionId: id,
    recipientAgentId: "agent",
    createdAt: 0,
    nextCheckAt: 0,
    applicable: true,
    body: `[octo-delivery:${id}]\n${summary}\nNext: octo-manager submission ${id}\nSubmission: ${id}`,
  };
}
test("submission applicability blockers share one request while every source is receipted", () => {
  const reason =
    "PR submission needs_input: Unverified applicability condition: ";
  const result = renderDigest(
    [
      notice("a", reason + "report-verification-gaps"),
      notice("b", reason + "verification-gaps"),
      notice("c", reason + "verification-gaps"),
    ],
    "/tmp/state",
    "12345678-1111-1111-1111-111111111111",
  );
  expect(result.body).toStartWith(
    "PR submission needs input: verify applicability conditions: report-verification-gaps, verification-gaps\n\n",
  );
  expect(result.messageIds).toEqual(["a", "b", "c"]);
  expect(result.body).not.toContain("\n- ");
});
test("exact repeats collapse within a PR while distinct evidence and PRs remain visible", () => {
  const a = "[PR #1](https://github.com/owner/repo/pull/1) · Finding";
  const b = "[PR #2](https://github.com/owner/repo/pull/2) · Finding";
  const result = renderDigest(
    [
      notice("a", a),
      notice("b", a),
      notice("c", b),
      notice(
        "d",
        a + "\n[Evidence](https://github.com/owner/repo/pull/1#discussion_r1)",
      ),
      notice("e", "PR submission failed: permission denied"),
    ],
    "/tmp/state",
    "12345678-1111-1111-1111-111111111111",
  );
  expect(result.body.match(/- Finding/g)).toHaveLength(2);
  expect(result.body).toContain(b);
  expect(result.body).toContain("#discussion_r1");
  expect(result.body).toContain("PR submission failed: permission denied");
  expect(result.messageIds).toEqual(["a", "b", "c", "d", "e"]);
});
