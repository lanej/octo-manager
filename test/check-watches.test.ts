import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.js";
import {
  CheckWatchState,
  checkEvidence,
  checksFinished,
} from "../src/tracking/checks.js";
import { defaultTrackingConfig } from "../src/tracking/config.js";
import { TrackingService } from "../src/tracking/service.js";
import { readObservation } from "../src/tracking/github.js";
import {
  ActionState,
  DeliveryState,
  type CheckObservation,
  type ObservationInput,
} from "../src/tracking/types.js";

const url = "https://github.com/owner/repo/pull/1";
const check = (
  id: string,
  status = "completed",
  conclusion = "success",
): CheckObservation => ({
  id,
  key: "same-app:same-job-name",
  name: "check (linux)",
  headSha: "head",
  status,
  conclusion,
  at: 1000,
  url: `${url}#${id}`,
});
const observation = (
  patch: Partial<ObservationInput> = {},
): ObservationInput => ({
  observedAt: 1000,
  headSha: "head",
  baseSha: "base",
  lifecycle: "open",
  mergeability: "mergeable",
  checks: { state: "complete", value: [] },
  workflows: { state: "complete", value: [] },
  reviews: { state: "complete", value: [] },
  ...patch,
});
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Check handoff did not finish");
}

test("Octo waits durably for every observed execution and queues a head-pinned completion once, including successful checks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-checks-"));
  let store = new Store(directory);
  const config = defaultTrackingConfig();
  const pr = store.tracking.track(url, {
    harness: "codex",
    endpoint: "local",
    sessionId: "owner",
  });
  try {
    store.tracking.observe(pr.id, observation(), config);
    assert.equal(
      store.tracking.checks.list()[0]?.state,
      CheckWatchState.Waiting,
    );
    assert.equal(store.tracking.actions().length, 0);
    const a = check("run:1"),
      b = check("run:2", "in_progress", "");
    const queuedWorkflow = check("workflow:3:1", "queued", "");
    const pending = observation({
      checks: { state: "complete", value: [a, b] },
      workflows: { state: "complete", value: [queuedWorkflow] },
    });
    store.tracking.observe(pr.id, pending, config);
    const watch = store.tracking.checks.list()[0];
    assert(watch !== undefined);
    assert.equal(watch.state, CheckWatchState.Waiting);
    store.close();
    store = new Store(directory);
    store.tracking.observe(
      pr.id,
      {
        ...pending,
        checks: {
          state: "complete",
          value: [a, { ...b, status: "completed", conclusion: "success" }],
        },
      },
      config,
    );
    assert.equal(
      store.tracking.checks.list()[0]?.state,
      CheckWatchState.Waiting,
    );
    const complete = observation({
      checks: {
        state: "complete",
        value: [a, { ...b, status: "completed", conclusion: "success" }],
      },
      workflows: {
        state: "complete",
        value: [
          { ...queuedWorkflow, status: "completed", conclusion: "success" },
        ],
      },
    });
    store.tracking.observe(
      pr.id,
      {
        ...complete,
        checks: {
          state: "partial",
          value:
            complete.checks.state === "complete" ? complete.checks.value : [],
          reason: "Later page offline",
        },
      },
      config,
    );
    assert.equal(store.tracking.actions().length, 0);
    store.tracking.observe(pr.id, complete, config);
    store.tracking.observe(pr.id, complete, config);
    const action = store.tracking.actions()[0];
    assert(action !== undefined && action.blocker.kind === "check_results");
    assert.equal(action.blocker.checks.length, 3);
    assert.equal(action.blocker.headSha, "head");
    assert.equal(action.summary, "Checks passed");
    assert.equal(store.tracking.actions().length, 1);
    assert.equal(store.tracking.checks.list()[0]?.id, watch.id);
    const sent: string[] = [];
    const service = new TrackingService(store.tracking, config, Date.now, {
      read: () => Promise.resolve(complete),
      connect: (agent) => ({
        prepare: () => Promise.resolve({ busy: false }),
        send: (_agent, id, body) => {
          assert.equal(agent.id, pr.ownerAgentId);
          assert.equal(store.tracking.inbox.get(id)?.body, body);
          sent.push(body);
          return Promise.resolve({ queueId: "admitted" });
        },
        find: () => Promise.resolve({ found: true }),
        close: () => {},
      }),
    });
    try {
      service.tick();
      await until(() => sent.length === 1);
      await until(
        () =>
          store.tracking.deliveries()[0]?.progress.state ===
          DeliveryState.Delivered,
      );
    } finally {
      await service.close();
    }
    const body = sent[0];
    assert(body !== undefined);
    assert(body.includes('"kind":"check_results"'));
    assert(body.includes('"headSha":"head"'));
    assert.equal(
      store.tracking.action(action.id).progress.state,
      ActionState.Open,
    );
    store.close();
    store = new Store(directory);
    store.tracking.observe(pr.id, complete, config);
    assert.equal(store.tracking.actions().length, 1);
    assert.equal(store.tracking.inbox.list(pr.ownerAgentId).messages.length, 1);
    const rerun = observation({
      checks: { state: "complete", value: [check("run:4", "in_progress", "")] },
    });
    store.tracking.observe(pr.id, rerun, config);
    assert.equal(store.tracking.checks.list().length, 2);
    assert.equal(
      store.tracking.checks.list()[1]?.state,
      CheckWatchState.Waiting,
    );
    store.tracking.observe(
      pr.id,
      {
        ...rerun,
        checks: {
          state: "complete",
          value: [check("run:4", "completed", "cancelled")],
        },
      },
      config,
    );
    const result = store.tracking
      .actions()
      .find(
        (candidate) =>
          candidate.blocker.kind === "check_results" &&
          candidate.id !== action.id,
      );
    assert.equal(result?.summary, "Checks finished with issues");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("head replacement reports supersession and merged PRs finish an existing watch without cancelling its callback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-check-heads-"));
  const store = new Store(directory),
    config = defaultTrackingConfig();
  const pr = store.tracking.track(url, {
    harness: "codex",
    endpoint: "local",
    sessionId: "owner",
  });
  try {
    store.tracking.observe(pr.id, observation(), config);
    store.tracking.observe(pr.id, observation({ headSha: "new-head" }), config);
    const replaced = store.tracking.actions()[0];
    assert(replaced !== undefined && replaced.blocker.kind === "check_results");
    assert.equal(replaced.blocker.state, CheckWatchState.Superseded);
    assert.equal(replaced.blocker.replacementHeadSha, "new-head");
    const finished = observation({
      headSha: "new-head",
      lifecycle: "merged",
      checks: {
        state: "complete",
        value: [{ ...check("run:done"), headSha: "new-head" }],
      },
    });
    store.tracking.observe(pr.id, finished, config);
    store.tracking.observe(pr.id, finished, config);
    assert.equal(
      store.tracking
        .actions()
        .filter((action) => action.blocker.kind === "check_results").length,
      2,
    );
    assert.equal(
      store.tracking.action(replaced.id).progress.state,
      ActionState.Open,
    );
    assert.equal(
      store.tracking.checks.list()[1]?.state,
      CheckWatchState.Completed,
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("GitHub workflow coverage waits for queued runs even when every materialized job is already green", async () => {
  const result = await readObservation(url, undefined, (path) => {
    if (path.endsWith("/pulls/1"))
      return Promise.resolve({
        state: "open",
        merged: false,
        mergeable: true,
        head: { sha: "head" },
        base: { sha: "base", ref: "main", repo: { private: false } },
      });
    if (path.includes("/git/ref/"))
      return Promise.resolve({ object: { sha: "base" } });
    if (path.includes("check-runs")) return Promise.resolve({ check_runs: [] });
    if (path.includes("/actions/runs?")) {
      assert(path.includes("head_sha=head"));
      return Promise.resolve({
        workflow_runs: [
          {
            id: 1,
            run_attempt: 2,
            name: "CI",
            head_sha: "head",
            status: "queued",
            conclusion: null,
            html_url: `${url}/checks`,
          },
        ],
      });
    }
    return Promise.resolve([]);
  });
  assert(result.workflows?.state === "complete");
  assert.equal(result.workflows.value[0]?.id, "workflow:1:2");
});

test("a missing previously running execution remains waiting and status ties keep the newest-first result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-check-missing-"));
  const store = new Store(directory),
    config = defaultTrackingConfig();
  const pr = store.tracking.track(url, {
    harness: "codex",
    endpoint: "local",
    sessionId: "owner",
  });
  try {
    const pending = check("run:pending", "in_progress", "");
    store.tracking.observe(
      pr.id,
      observation({
        checks: { state: "complete", value: [pending, check("run:green")] },
      }),
      config,
    );
    store.tracking.observe(
      pr.id,
      observation({
        checks: { state: "complete", value: [check("run:green")] },
      }),
      config,
    );
    assert.equal(
      store.tracking.checks.list()[0]?.state,
      CheckWatchState.Waiting,
    );
    assert.equal(store.tracking.actions().length, 0);
    store.tracking.observe(
      pr.id,
      observation({
        checks: {
          state: "complete",
          value: [
            { ...pending, status: "completed", conclusion: "success" },
            check("run:green"),
          ],
        },
      }),
      config,
    );
    assert.equal(
      store.tracking.checks.list()[0]?.state,
      CheckWatchState.Completed,
    );
    const evidence = checkEvidence({
      ...observation(),
      id: 1,
      prId: pr.id,
      checks: {
        state: "complete",
        value: [
          { ...check("status:20", "success", "success"), key: "context" },
          { ...check("status:19", "pending", "pending"), key: "context" },
        ],
      },
    });
    assert.equal(checksFinished(evidence), true);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("large check results retain full evidence, bound outgoing text and cannot starve the next delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-check-large-"));
  const store = new Store(directory),
    config = defaultTrackingConfig();
  const pr = store.tracking.track(url, {
    harness: "codex",
    endpoint: "local",
    sessionId: "owner",
  });
  const value = observation({
    checks: {
      state: "complete",
      value: [
        {
          ...check("run:huge", "completed", "failure"),
          name: "x".repeat(1100000),
        },
      ],
    },
  });
  store.tracking.observe(pr.id, value, config);
  const sent: string[] = [];
  const service = new TrackingService(store.tracking, config, Date.now, {
    read: () => Promise.resolve(value),
    connect: () => ({
      prepare: () => Promise.resolve({ busy: false }),
      send: (_agent, _id, body) => {
        sent.push(body);
        return Promise.resolve({ queueId: "accepted" });
      },
      find: () => Promise.resolve({ found: true }),
      close: () => {},
    }),
  });
  try {
    service.tick();
    await until(
      () =>
        store.tracking.deliveries()[0]?.progress.state ===
        DeliveryState.Unavailable,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    service.tick();
    await until(() => sent.length === 1);
    const body = sent[0];
    assert(body !== undefined);
    assert(body.length < 40000);
    assert(body.includes('"omittedChecks":1'));
    const action = store.tracking
      .actions()
      .find((action) => action.blocker.kind === "check_results");
    assert(action?.blocker.kind === "check_results");
    assert.equal(action.blocker.checks[0]?.name.length, 1100000);
  } finally {
    await service.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("version7 migration retains existing message payloads, sequences and receipts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-check-migration-"));
  let store = new Store(directory);
  const config = defaultTrackingConfig();
  const pr = store.tracking.track(url, {
    harness: "codex",
    endpoint: "local",
    sessionId: "owner",
  });
  try {
    store.tracking.observe(
      pr.id,
      observation({ mergeability: "conflicting" }),
      config,
    );
    const delivery = store.tracking.deliveries()[0];
    assert(delivery !== undefined);
    const message = store.tracking.inbox.record(
      delivery.id,
      "Exact historical bytes",
    );
    const receipt = store.tracking.acknowledgeMessage(
      message.id,
      pr.ownerAgentId,
    );
    const identity = store.instanceId();
    store.close();
    const db = new DatabaseSync(join(directory, "jobs.sqlite"));
    db.exec(
      "DROP TABLE check_watches; ALTER TABLE pr_observations DROP COLUMN workflow_runs_json; PRAGMA user_version=7",
    );
    db.close();
    store = new Store(directory);
    assert.equal(store.instanceId(), identity);
    assert.deepEqual(store.tracking.inbox.get(message.id), receipt);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the coordinator polls and returns completed checks without a waiting caller", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-check-background-"));
  const store = new Store(directory),
    config = defaultTrackingConfig();
  let reads = 0;
  let received: ((body: string) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const delivered = new Promise<string>((resolve, reject) => {
    received = resolve;
    timer = setTimeout(() => {
      reject(new Error("Background check callback timed out"));
    }, 5000);
  });
  const service = new TrackingService(store.tracking, config, Date.now, {
    intervalMs: 5,
    read: () => {
      reads++;
      return Promise.resolve(
        observation({
          lifecycle: reads === 1 ? "open" : "merged",
          checks: { state: "complete", value: [check("run:job")] },
          workflows: {
            state: "complete",
            value: [
              check(
                "workflow:run:1",
                reads === 1 ? "queued" : "completed",
                reads === 1 ? "" : "success",
              ),
            ],
          },
        }),
      );
    },
    connect: () => ({
      prepare: () => Promise.resolve({ busy: false }),
      send: (_agent, _id, body) => {
        received?.(body);
        return Promise.resolve({ queueId: "background-result" });
      },
      find: () => Promise.resolve({ found: true }),
      close: () => {},
    }),
  });
  try {
    service.start();
    const pr = service.track(url, {
      harness: "codex",
      endpoint: "local",
      sessionId: "owner",
    });
    assert.equal(pr.url, url);
    const body = await delivered;
    assert(reads >= 2);
    assert(body.includes('"kind":"check_results"'));
    assert(body.includes('"headSha":"head"'));
    assert.equal(
      store.tracking.checks.list()[0]?.state,
      CheckWatchState.Completed,
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await service.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("disappearing failed executions stay in waiting and completed-generation result history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-check-retained-"));
  const store = new Store(directory),
    config = defaultTrackingConfig();
  const pr = store.tracking.track(url, {
    harness: "codex",
    endpoint: "local",
    sessionId: "owner",
  });
  try {
    const failure = check("run:failed", "completed", "failure"),
      pending = check("run:pending", "in_progress", "");
    store.tracking.observe(
      pr.id,
      observation({ checks: { state: "complete", value: [failure, pending] } }),
      config,
    );
    const onlyGreen = observation({
      checks: {
        state: "complete",
        value: [{ ...pending, status: "completed", conclusion: "success" }],
      },
    });
    store.tracking.observe(pr.id, onlyGreen, config);
    const results = store.tracking
      .actions()
      .filter((action) => action.blocker.kind === "check_results");
    assert.equal(results.length, 1);
    const action = results[0];
    assert(action?.blocker.kind === "check_results");
    assert(
      action.blocker.checks.some(
        (check) => check.id === failure.id && check.conclusion === "failure",
      ),
    );
    assert.equal(action.summary, "Checks finished with issues");
    store.tracking.observe(pr.id, onlyGreen, config);
    assert.equal(store.tracking.checks.list().length, 1);
    assert.equal(
      store.tracking
        .actions()
        .filter((action) => action.blocker.kind === "check_results").length,
      1,
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
