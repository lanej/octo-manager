import { failedStepLogs } from "../src/tracking/job-logs.js";
import { shortId, resolveId } from "../src/tracking/identifiers.js";
import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  agentMessage,
  logExcerpt,
  readFailureExcerpt,
} from "../src/tracking/messages.js";
import { CheckWatchState } from "../src/tracking/checks.js";
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

test("success completion is a compact readiness signal rather than a failed-run report", () => {
  const body = agentMessage(
    {
      ...action,
      blocker: {
        kind: "check_results",
        watchId: "watch",
        headSha: "ad8968bf1234",
        state: CheckWatchState.Completed,
        checks: [],
      },
      summary: "Checks passed; no merge conflicts",
      evidenceUrl: pr,
    },
    pr,
    "delivery",
  );
  assert(body.includes("Checks passed; no merge conflicts"));
  assert(body.includes(pr));
  assert(!body.includes("Failed run"));
  assert(Buffer.byteLength(body) < 512);
});

test("short UUIDs expand on collisions and resolve only unambiguous prefixes", () => {
  const first = "deadbeef-1234-4567-89ab-0123456789ab";
  const second = "deadbeef-2234-4567-89ab-0123456789ab";
  assert.equal(shortId(first), "deadbeef");
  assert.equal(shortId(first, [first, second]), "deadbeef1");
  assert.equal(shortId(second, [first, second]), "deadbeef2");
  assert.equal(resolveId("deadbeef1", [first, second]), first);
  assert.equal(resolveId(first, [first, second]), first);
  assert.equal(resolveId("deadbee", [first]), undefined);
  assert.throws(() => resolveId("deadbeef", [first, second]), /ambiguous/);
  const body = agentMessage({ ...action, id: first }, pr, second, undefined, {
    actions: [first, second],
    messages: [first, second],
  });
  assert(body.startsWith("[octo-delivery:deadbeef2]\n"));
  assert(body.endsWith("Action: deadbeef1"));
  assert(!body.includes(first));
  assert(!body.includes(second));
});

test("failure excerpts select failed steps before bounded output and long cleanup", async () => {
  const log = [
    "2026-11-13T00:00:00.100Z Error: expected setup diagnostic",
    "2026-11-13T00:01:00.100Z Error: expected test diagnostic",
    "2026-11-13T00:01:00.200Z FATAL ERROR: Allocation failed - JavaScript heap out of memory",
    ...Array.from(
      { length: 180 },
      (_, i) => `2026-11-13T00:01:01.100Z stack frame ${String(i)}`,
    ),
    ...Array.from(
      { length: 180 },
      (_, i) => `2026-11-13T00:02:00.100Z cleanup ${String(i)}`,
    ),
    "2026-11-13T00:02:00.200Z Error: unrelated cleanup message",
  ].join("\n");
  const metadata = {
    id: 10,
    run_id: 20,
    steps: [
      {
        conclusion: "success",
        started_at: "2026-11-13T00:00:00Z",
        completed_at: "2026-11-13T00:00:01Z",
      },
      {
        conclusion: "failure",
        started_at: "2026-11-13T00:01:00Z",
        completed_at: "2026-11-13T00:01:02Z",
      },
      {
        conclusion: "success",
        started_at: "2026-11-13T00:02:00Z",
        completed_at: "2026-11-13T00:02:01Z",
      },
    ],
  };
  const excerpt = await readFailureExcerpt(
    action,
    pr,
    AbortSignal.timeout(1000),
    () =>
      Promise.resolve(failedStepLogs(log, metadata, { job: "10", run: "20" })),
  );
  assert(excerpt !== undefined);
  assert(
    excerpt.startsWith(
      "FATAL ERROR: Allocation failed - JavaScript heap out of memory",
    ),
  );
  assert(!excerpt.includes("cleanup"));
  assert(!excerpt.includes("2026-11-13"));
  assert(Buffer.byteLength(excerpt) <= 480);
  assert.throws(
    () =>
      failedStepLogs(
        log,
        {
          id: 10,
          run_id: 20,
          steps: [
            { conclusion: "failure", started_at: null, completed_at: null },
          ],
        },
        { job: "10", run: "20" },
      ),
    /timing unavailable/,
  );
  assert.throws(
    () => failedStepLogs(log, metadata, { job: "10", run: "999" }),
    /does not match/,
  );
  assert.equal(
    await readFailureExcerpt(action, pr, AbortSignal.timeout(1000), () =>
      Promise.resolve(
        failedStepLogs(
          log,
          {
            id: 10,
            run_id: 20,
            steps: [
              { conclusion: "failure", started_at: null, completed_at: null },
            ],
          },
          { job: "10", run: "20" },
        ),
      ),
    ),
    undefined,
  );
});

test("adjacent cleanup cannot replace the failed-step diagnostic", () => {
  const metadata = {
    id: 10,
    run_id: 20,
    steps: [
      {
        conclusion: "failure",
        started_at: "2026-11-13T00:01:00Z",
        completed_at: "2026-11-13T00:01:02Z",
      },
      {
        conclusion: "success",
        started_at: "2026-11-13T00:01:02Z",
        completed_at: "2026-11-13T00:01:03Z",
      },
    ],
  };
  const log =
    "2026-11-13T00:01:01.900Z Error: actual failed step\n2026-11-13T00:01:02.400Z FATAL ERROR: expected cleanup fixture";
  assert.equal(
    logExcerpt(failedStepLogs(log, metadata, { job: "10", run: "20" })),
    "Error: actual failed step",
  );
  const sameSecond = {
    ...metadata,
    steps: metadata.steps.map((step) => ({
      ...step,
      started_at: "2026-11-13T00:01:02Z",
      completed_at: "2026-11-13T00:01:02Z",
    })),
  };
  assert.equal(
    logExcerpt(failedStepLogs(log, sameSecond, { job: "10", run: "20" })),
    undefined,
  );
});
