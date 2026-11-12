import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  agentMessage,
  logExcerpt,
  readFailureExcerpt,
} from "../src/tracking/messages.js";
import { ActionState, type Action } from "../src/tracking/types.js";
const pr = "https://github.com/owner/repo/pull/13";
const action: Action = {
  id: "action",
  prId: "pr",
  openedObservationId: 1,
  sourceKey: "run:10",
  ownerAgentId: "owner",
  blocker: {
    kind: "check_failed",
    sourceId: "run:10",
    checkName: "macOS",
    checkKey: "macos",
    headSha: "ad8968bf1234",
  },
  summary: "macOS check failed",
  evidenceUrl: "https://github.com/owner/repo/actions/runs/20/job/10",
  profile: {
    name: "check_failed",
    instructions: "Standing policy",
    model: "cheap-model",
  },
  progress: { state: ActionState.Open },
  createdAt: 1,
  updatedAt: 1,
};
test("agent notices contain bounded actionable evidence without execution policy or receipt commands", () => {
  const body = agentMessage(
    action,
    pr,
    "delivery",
    "ENOENT: handoff disappeared\n" + "😀".repeat(5000),
  );
  assert(Buffer.byteLength(body) < 4096);
  assert(body.includes("PR #13"));
  assert(body.includes("ad8968bf"));
  assert(body.includes("> ENOENT: handoff disappeared"));
  assert(body.includes(action.evidenceUrl));
  assert(!body.includes("Standing policy"));
  assert(!body.includes("cheap-model"));
  assert(!body.includes("acknowledge"));
  assert(!body.includes("instructions"));
  assert(!body.includes("authoriz"));
  assert(body.includes("…"));
});
test("failure excerpts use bounded job logs and preserve a run link when diagnostics are unavailable", async () => {
  const log = `setup\tcheck\t2026-11-11T00:00:00Z ENOENT: handoff disappeared\nsetup\tcheck\t2026-11-11T00:00:00Z at status (handoffs.ts:203)`;
  assert.equal(
    logExcerpt(log),
    "ENOENT: handoff disappeared\nat status (handoffs.ts:203)",
  );
  const excerpt = await readFailureExcerpt(
    action,
    pr,
    AbortSignal.timeout(1000),
    (repository, run, job) => {
      assert.equal(repository, "owner/repo");
      assert.equal(run, "20");
      assert.equal(job, "10");
      return Promise.resolve(log);
    },
  );
  assert(excerpt !== undefined && excerpt.includes("ENOENT"));
  assert.equal(
    await readFailureExcerpt(action, pr, AbortSignal.timeout(1000), () =>
      Promise.reject(new Error("unavailable")),
    ),
    undefined,
  );
  assert(agentMessage(action, pr, "delivery").includes(action.evidenceUrl));
  assert.equal(
    await readFailureExcerpt(
      {
        ...action,
        evidenceUrl: "https://github.com/other/repo/actions/runs/20/job/10",
      },
      pr,
      AbortSignal.timeout(1000),
      () => {
        throw new Error("Must not read a different repository");
      },
    ),
    undefined,
  );
});
