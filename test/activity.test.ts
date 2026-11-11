import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Code, ConnectError } from "@connectrpc/connect";
import { Coordinator } from "../src/coordinator.js";
import { schedulerClient } from "../src/client.js";
import { Store } from "../src/store.js";
import {
  ActivityName,
  ActivityOutcome,
} from "../src/gen/octomanager/v1/activity_pb.js";

const input = {
  requestId: "merge-report-1",
  operationId: "merge-operation-1",
  name: ActivityName.MERGE_PR,
  outcome: ActivityOutcome.SUCCEEDED,
  actor: {
    harness: "codex",
    sessionId: "caller",
    version: "0.167.0",
    model: "reported-model",
  },
  detail: "Merged PR after checking the exact head",
  prUrl: "https://github.com/lanej/octo-manager/pull/2",
  evidenceUrl:
    "https://github.com/lanej/octo-manager/commit/197e1b61054babefa12daa7eb017ab2dd4db06dd",
};
function hasCode(code: Code): (error: unknown) => boolean {
  return (error) => error instanceof ConnectError && error.code === code;
}

async function cli(args: string[]): Promise<string> {
  const child = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(code, 0, error);
  return output;
}

test("agent CLI reports survive restart without a worker or tracked PR and replay once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-activity-"));
  const coordinator = new Coordinator(directory);
  try {
    await coordinator.start();
    const reportArgs = [
      "--request-id",
      input.requestId,
      "--operation-id",
      input.operationId,
      "--name",
      "merge_pr",
      "--outcome",
      "succeeded",
      "--harness",
      input.actor.harness,
      "--thread-id",
      input.actor.sessionId,
      "--harness-version",
      input.actor.version,
      "--model",
      input.actor.model,
      "--detail",
      input.detail,
      "--url",
      input.prUrl,
      "--evidence",
      input.evidenceUrl,
      "--json",
    ];
    for (const prefix of [
      ["--state", directory, "record-activity"],
      ["record-activity", "--state", directory],
    ]) {
      assert.match(await cli([...prefix, ...reportArgs]), /"sequence":"1"/u);
    }
    for (const args of [
      ["--state", directory, "activity", "--json"],
      ["activity", "--state", directory, "--json"],
    ]) {
      assert.match(await cli(args), /ACTIVITY_NAME_MERGE_PR/u);
    }
    assert.match(
      await cli(["--state", directory, "tracking", "--json"]),
      /"prs":\[\]/u,
    );
    const client = schedulerClient(directory);
    const first = (await client.listActivity({})).activities;
    assert.equal(first.length, 1);
    const entry = first[0];
    assert(entry !== undefined);
    assert.equal(entry.report?.actor?.sessionId, "caller");
    assert.equal(entry.report.actor.version, input.actor.version);
    assert.equal(entry.report.actor.model, input.actor.model);
    assert.equal(entry.report.evidenceUrl, input.evidenceUrl);
    assert.equal(entry.report.name, ActivityName.MERGE_PR);
    assert.equal(entry.report.outcome, ActivityOutcome.SUCCEEDED);
    const duplicates = await Promise.all([
      client.recordActivity({ report: input }),
      client.recordActivity({ report: input }),
    ]);
    assert(
      duplicates.every(
        (response) => response.activity?.sequence === entry.sequence,
      ),
    );
    assert.equal(coordinator.store.sequence(), 1);
    assert.equal(coordinator.store.jobs().length, 0);
    assert.equal(coordinator.store.tracking.prs().length, 0);
    const events = await client.listEvents({});
    assert.equal(events.events.length, 1);
    assert.equal(events.events[0]?.kind, "agent_activity");
    assert.equal(
      (await client.listActivity({ afterSequence: entry.sequence })).activities
        .length,
      0,
    );
    await assert.rejects(
      client.recordActivity({
        report: { ...input, detail: "different report" },
      }),
      hasCode(Code.AlreadyExists),
    );
    await assert.rejects(
      client.recordActivity({
        report: {
          ...input,
          requestId: "invalid",
          outcome: ActivityOutcome.UNSPECIFIED,
        },
      }),
      hasCode(Code.InvalidArgument),
    );
    await assert.rejects(
      client.listActivity({ afterSequence: 2n }),
      hasCode(Code.OutOfRange),
    );
    coordinator.store.event("", "delivery_delivered", "notification accepted");
    for (let i = 0; i < 200; i++)
      coordinator.store.event("", "progress", "streamed text");
    await client.recordActivity({
      report: {
        ...input,
        requestId: "uncertain-report",
        outcome: ActivityOutcome.UNCERTAIN,
      },
    });
    const mixed = await client.listActivity({ afterSequence: 1n });
    assert.equal(mixed.nextSequence, 201n);
    assert.equal(mixed.hasMore, true);
    assert.equal(mixed.events.length, 1);
    assert.equal(mixed.events[0]?.kind, "delivery_delivered");
    assert.equal(mixed.activities.length, 0);
    const tail = await client.listActivity({
      afterSequence: mixed.nextSequence,
    });
    assert.equal(tail.nextSequence, 203n);
    assert.equal(tail.hasMore, false);
    const tailReport = tail.activities[0]?.report;
    assert(tailReport !== undefined);
    assert.equal(tailReport.outcome, ActivityOutcome.UNCERTAIN);
    assert.equal(tailReport.operationId, input.operationId);
    await coordinator.close();
    const reopened = new Store(directory);
    try {
      assert.equal(reopened.activity.list(0)[0]?.name, "merge_pr");
      assert.equal(
        reopened.activity.list(0)[0]?.actor.version,
        input.actor.version,
      );
      assert.equal(reopened.sequence(), 203);
    } finally {
      reopened.close();
    }
  } finally {
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("activity preserves legacy events and identity, enforces named data, and pages in sequence order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-activity-db-"));
  const original = new Store(directory);
  const identity = original.instanceId();
  original.event("", "scheduler_paused", "existing event");
  original.close();
  const db = new DatabaseSync(join(directory, "jobs.sqlite"));
  db.exec(
    "DROP TABLE agent_activity; ALTER TABLE events DROP COLUMN action_context_json; ALTER TABLE pr_observations DROP COLUMN target_base_json; PRAGMA user_version=1",
  );
  db.close();
  const store = new Store(directory);
  try {
    assert.equal(store.instanceId(), identity);
    assert.equal(store.sequence(), 1);
    const report = { ...input, name: "run_checks", outcome: "attempted" };
    for (let i = 0; i < 201; i++)
      store.activity.record({ ...report, requestId: `check-${String(i)}` });
    const page = store.activity.list(0);
    assert.equal(page.length, 200);
    assert.equal(page[0]?.sequence, 2);
    assert.equal(page[199]?.sequence, 201);
    assert.equal(store.activity.list(201)[0]?.sequence, 202);
    assert.throws(
      () =>
        store.activity.record({
          ...report,
          requestId: "invalid",
          name: "run_arbitrary_shell",
        }),
      /Invalid activity name/u,
    );
    assert.throws(
      () =>
        store.activity.record({
          ...report,
          requestId: "invalid",
          evidenceUrl: "javascript:alert(1)",
        }),
      /Invalid activity evidence/u,
    );
    assert.throws(
      () =>
        store.activity.record({
          ...report,
          requestId: "invalid",
          detail: "injected\u001b[2J",
        }),
      /Invalid activity detail/u,
    );
    assert.equal(store.sequence(), 202);
    const reader = new DatabaseSync(join(directory, "jobs.sqlite"));
    try {
      assert.equal(
        reader.prepare("PRAGMA user_version").get()?.["user_version"],
        3,
      );
      assert.throws(() =>
        reader.prepare("UPDATE agent_activity SET outcome='invented'").run(),
      );
      assert.throws(() =>
        reader.prepare("UPDATE agent_activity SET name='merge_pr'").run(),
      );
    } finally {
      reader.close();
    }
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
