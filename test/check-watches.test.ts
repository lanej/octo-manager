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

test("check watches notify completed success once and report each failure once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-checks-"));
  let store = new Store(directory);
  const config = defaultTrackingConfig();
  const pr = store.tracking.track(url, {
    harness: "codex",
    endpoint: "local",
    sessionId: "owner",
  });
  try {
    const pending = observation({
      checks: { state: "complete", value: [check("run:1", "in_progress", "")] },
    });
    store.tracking.observe(pr.id, pending, config);
    const watch = store.tracking.checks.list()[0];
    assert.equal(watch?.state, CheckWatchState.Waiting);
    store.close();
    store = new Store(directory);
    const complete = observation({
      checks: { state: "complete", value: [check("run:1")] },
    });
    store.tracking.observe(
      pr.id,
      {
        ...complete,
        workflows: { state: "partial", value: [], reason: "offline" },
      },
      config,
    );
    assert.equal(
      store.tracking.checks.list()[0]?.state,
      CheckWatchState.Waiting,
    );
    store.tracking.observe(pr.id, complete, config);
    store.tracking.observe(pr.id, complete, config);
    assert.equal(
      store.tracking.checks.list()[0]?.state,
      CheckWatchState.Completed,
    );
    assert.equal(store.tracking.checks.list()[0]?.id, watch.id);
    assert.equal(store.tracking.actions().length, 1);
    assert.equal(
      store.tracking.actions()[0]?.summary,
      "Checks passed; no merge conflicts",
    );
    assert.equal(store.tracking.deliveries().length, 1);
    for (const checks of [
      { state: "unavailable" as const, reason: "offline" },
      { state: "partial" as const, value: [], reason: "offline page" },
      { state: "complete" as const, value: [] },
    ]) {
      store.tracking.observe(pr.id, observation({ checks }), config);
      assert.equal(
        store.tracking.actions()[0]?.progress.state,
        ActionState.Open,
      );
    }
    store.close();
    store = new Store(directory);
    store.tracking.observe(pr.id, complete, config);
    assert.equal(store.tracking.actions().length, 1);
    const sent: string[] = [];
    const service = new TrackingService(store.tracking, config, Date.now, {
      read: () => Promise.resolve(complete),
      connect: () => ({
        prepare: () => Promise.resolve({ busy: false }),
        send: (_agent, _id, body) => {
          sent.push(body);
          return Promise.resolve({ queueId: "ready" });
        },
        find: () => Promise.resolve({ found: true }),
        close: () => {},
      }),
    });
    try {
      service.tick();
      await until(() => sent.length === 1);
      const body = sent[0];
      assert(body !== undefined);
      assert(body.includes("Checks passed; no merge conflicts"));
      assert(!body.includes("Failed run"));
    } finally {
      await service.close();
    }
    const failure = observation({
      checks: {
        state: "complete",
        value: [check("run:2", "completed", "failure")],
      },
    });
    store.tracking.observe(pr.id, failure, config);
    store.tracking.observe(pr.id, failure, config);
    assert.equal(store.tracking.checks.list().length, 2);
    assert.equal(store.tracking.actions().length, 2);
    assert.equal(store.tracking.actions()[1]?.blocker.kind, "check_failed");
    assert.equal(
      store.tracking.actions()[0]?.progress.state,
      ActionState.Superseded,
    );
    assert.equal(store.tracking.deliveries().length, 2);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("head replacement and successful merged-PR completion remain in watch history without agent work", async () => {
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
    const replaced = store.tracking.checks.list()[0];
    assert.equal(replaced?.state, CheckWatchState.Superseded);
    assert.equal(replaced.replacementHeadSha, "new-head");
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
    assert.equal(store.tracking.actions().length, 0);
    assert.equal(store.tracking.deliveries().length, 0);
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

test("large failure names retain full evidence while outgoing messages stay compact", async () => {
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
    await until(() => sent.length === 1);
    const body = sent[0];
    assert(body !== undefined);
    assert(Buffer.byteLength(body) < 2048);
    assert(body.includes("Failed run"));
    const action = store.tracking.actions()[0];
    assert(action?.blocker.kind === "check_failed");
    assert.equal(action.blocker.checkName.length, 1100000);
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

test("the coordinator reports failed workflow completion without a waiting caller", async () => {
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
          lifecycle: reads === 1 ? "open" : "closed",
          checks: { state: "complete", value: [check("run:job")] },
          workflows: {
            state: "complete",
            value: [
              check(
                "workflow:run:1",
                reads === 1 ? "queued" : "completed",
                reads === 1 ? "" : "failure",
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
    assert(body.includes("Failed check:"));
    assert(body.includes("head"));
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
    assert.equal(action.summary, "Failed check: check (linux)");
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

test("completion identifies an uncovered workflow instead of repeating a covered failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-check-uncovered-"));
  const store = new Store(directory),
    config = defaultTrackingConfig();
  const pr = store.tracking.track(url, {
    harness: "codex",
    endpoint: "local",
    sessionId: "owner",
  });
  try {
    const failure = {
      ...check("run:1", "completed", "failure"),
      url: "https://github.com/owner/repo/actions/runs/3/job/1",
      at: 1100,
    };
    store.tracking.observe(
      pr.id,
      observation({ checks: { state: "complete", value: [failure] } }),
      config,
    );
    const workflows = [
      {
        ...check("workflow:3:1", "completed", "failure"),
        at: 1000,
        url: "https://github.com/owner/repo/actions/runs/3",
      },
      {
        ...check("workflow:4:1", "completed", "failure"),
        at: 1000,
        name: "deployment",
        url: "https://github.com/owner/repo/actions/runs/4",
      },
    ];
    store.tracking.observe(
      pr.id,
      observation({
        checks: { state: "complete", value: [failure] },
        workflows: { state: "complete", value: workflows },
      }),
      config,
    );
    const result = store.tracking
      .actions()
      .find((action) => action.blocker.kind === "check_results");
    assert(result?.blocker.kind === "check_results");
    assert.deepEqual(
      result.blocker.checks.map((check) => check.id),
      ["workflow:4:1"],
    );
    assert.equal(result.summary, "Failed check: deployment");
    const history = store.tracking.checks.list().at(-1)?.evidence;
    assert(history !== undefined && history.state !== "unavailable");
    assert.equal(history.value.length, 3);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("retained workflow failure is not reported again in a later same-head generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-check-repeat-"));
  const store = new Store(directory),
    config = defaultTrackingConfig();
  const pr = store.tracking.track(url, {
    harness: "codex",
    endpoint: "local",
    sessionId: "owner",
  });
  try {
    const failure = check("workflow:1:1", "completed", "failure");
    store.tracking.observe(
      pr.id,
      observation({ workflows: { state: "complete", value: [failure] } }),
      config,
    );
    assert.equal(store.tracking.actions().length, 1);
    store.tracking.observe(
      pr.id,
      observation({
        checks: { state: "complete", value: [check("run:2")] },
        workflows: { state: "complete", value: [failure] },
      }),
      config,
    );
    assert.equal(store.tracking.checks.list().length, 2);
    assert.equal(store.tracking.actions().length, 1);
    assert.equal(store.tracking.deliveries().length, 1);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup preserves queued successful completions without rewriting history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-check-legacy-"));
  let store = new Store(directory);
  const config = defaultTrackingConfig();
  const pr = store.tracking.track(url, {
    harness: "codex",
    endpoint: "local",
    sessionId: "owner",
  });
  try {
    const success = check("workflow:1:1");
    store.tracking.observe(
      pr.id,
      observation({
        workflows: {
          state: "complete",
          value: [{ ...success, conclusion: "failure" }],
        },
      }),
      config,
    );
    const action = store.tracking.actions()[0],
      delivery = store.tracking.deliveries()[0];
    assert(action?.blocker.kind === "check_results" && delivery !== undefined);
    store.tracking.inbox.record(delivery.id, "Historical success body");
    store.close();
    const db = new DatabaseSync(join(directory, "jobs.sqlite"));
    try {
      db.prepare(
        "UPDATE actions SET blocker_json=?,summary='Checks passed' WHERE id=?",
      ).run(
        JSON.stringify({ ...action.blocker, checks: [success] }),
        action.id,
      );
      db.prepare("UPDATE check_watches SET evidence_json=? WHERE id=?").run(
        JSON.stringify({ state: "complete", value: [success] }),
        action.blocker.watchId,
      );
    } finally {
      db.close();
    }
    store = new Store(directory);
    assert.equal(
      store.tracking.action(action.id).progress.state,
      ActionState.Open,
    );
    assert.equal(
      store.tracking.deliveries()[0]?.progress.state,
      DeliveryState.Pending,
    );
    assert.equal(
      store.tracking.inbox.get(delivery.id)?.body,
      "Historical success body",
    );
    assert.equal(store.tracking.inbox.get(delivery.id)?.applicable, true);
    assert.equal(
      store.tracking.checks.list()[0]?.state,
      CheckWatchState.Completed,
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("readiness distinguishes conflicts and neutral checks and expires when the PR closes", async () => {
  for (const mergeability of ["mergeable", "conflicting", "unknown"] as const) {
    const directory = await mkdtemp(join(tmpdir(), "octo-readiness-"));
    const store = new Store(directory),
      config = defaultTrackingConfig();
    const pr = store.tracking.track(url, {
      harness: "codex",
      endpoint: "local",
      sessionId: "owner",
    });
    try {
      const complete = observation({
        mergeability,
        checks: {
          state: "complete",
          value: [check("run:1", "completed", "neutral")],
        },
      });
      store.tracking.observe(pr.id, complete, config);
      const readiness = store.tracking
        .actions()
        .find((action) => action.blocker.kind === "check_results");
      assert(readiness !== undefined);
      assert(readiness.summary.includes("includes neutral/skipped"));
      assert(
        readiness.summary.includes(
          mergeability === "mergeable"
            ? "no merge conflicts"
            : mergeability === "conflicting"
              ? "merge conflict remains"
              : "conflict status unknown",
        ),
      );
      store.tracking.observe(
        pr.id,
        { ...complete, lifecycle: "merged" },
        config,
      );
      assert.equal(
        store.tracking.action(readiness.id).progress.state,
        ActionState.Superseded,
      );
      const delivery = store.tracking
        .deliveries()
        .find((delivery) => delivery.actionId === readiness.id);
      assert.equal(delivery?.progress.state, DeliveryState.Cancelled);
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

for (const upgrade of [false, true]) {
  test(`merged failures retire without losing history (${upgrade ? "upgrade" : "refresh"})`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "octo-merged-failures-"));
    let store = new Store(directory);
    const config = defaultTrackingConfig();
    try {
      const pr = store.tracking.track(url, {
        harness: "codex",
        endpoint: "local",
        sessionId: "owner",
      });
      const failure = observation({
        workflows: {
          state: "complete",
          value: [check("workflow:1", "completed", "failure")],
        },
      });
      store.tracking.observe(pr.id, failure, config);
      const action = store.tracking
        .actions()
        .find((a) => a.blocker.kind === "check_results");
      assert(action !== undefined);
      const delivery = store.tracking
        .deliveries()
        .find((d) => d.actionId === action.id);
      assert(delivery !== undefined);
      store.tracking.inbox.record(delivery.id, "Final failed workflow");
      assert.equal(store.tracking.inbox.get(delivery.id)?.applicable, true);
      if (upgrade) {
        store.close();
        const db = new DatabaseSync(join(directory, "jobs.sqlite"));
        try {
          db.prepare(
            "UPDATE pr_observations SET lifecycle='merged' WHERE pr_id=?",
          ).run(pr.id);
        } finally {
          db.close();
        }
        store = new Store(directory);
      } else {
        store.tracking.observe(
          pr.id,
          { ...failure, lifecycle: "merged" },
          config,
        );
      }
      assert.equal(
        store.tracking.actions().find((a) => a.id === action.id)?.progress
          .state,
        ActionState.Superseded,
      );
      assert.equal(store.tracking.inbox.get(delivery.id)?.applicable, false);
      assert.equal(
        store.tracking.inbox.get(delivery.id)?.body,
        "Final failed workflow",
      );
      assert.equal(
        store.tracking.inbox.get(delivery.id)?.acknowledgedAt,
        undefined,
      );
      assert.equal(
        store.tracking.checks.list()[0]?.state,
        CheckWatchState.Completed,
      );
      const actions = store.tracking.actions().length;
      store.tracking.observe(
        pr.id,
        { ...failure, lifecycle: "merged" },
        config,
      );
      assert.equal(store.tracking.actions().length, actions);
      store.close();
      store = new Store(directory);
      assert.equal(store.tracking.inbox.get(delivery.id)?.applicable, false);
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
