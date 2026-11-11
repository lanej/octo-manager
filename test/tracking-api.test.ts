import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Coordinator } from "../src/coordinator.js";
import { schedulerClient } from "../src/client.js";
import { readObservation } from "../src/tracking/github.js";
import { publicPullRequest } from "../src/github.js";
import { loadTrackingConfig, selectProfile } from "../src/tracking/config.js";
import { ActionState } from "../src/tracking/types.js";
const url = "https://github.com/owner/private/pull/1";
const input = {
  observedAt: 1000,
  headSha: "head",
  baseSha: "base",
  lifecycle: "open" as const,
  mergeability: "conflicting" as const,
  checks: { state: "complete" as const, value: [] },
  reviews: { state: "complete" as const, value: [] },
};
test("CLI enrollment, typed API progress and replay work without a summary worker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "octo-api-"));
  const coordinator = new Coordinator(dir, {
    trackingOptions: {
      read: async () => input,
      connect: () => ({
        prepare: async () => ({ busy: true }),
        send: async () => ({}),
        find: async () => ({ found: false }),
        close() {},
      }),
    },
  });
  try {
    await coordinator.start();
    const cli = Bun.spawn(
      [
        process.execPath,
        "src/cli.ts",
        "track",
        "--url",
        url,
        "--thread-id",
        "test-thread",
        "--state",
        dir,
        "--json",
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const result = JSON.parse(await new Response(cli.stdout).text());
    assert.equal(await cli.exited, 0);
    assert.equal(result.pr.url, url);
    const client = schedulerClient(dir);
    await client.refreshTrackedPullRequest({ id: result.pr.id });
    const snapshot = (await client.getSnapshot({})).snapshot!;
    assert.equal(snapshot.jobs.length, 0);
    assert.equal(snapshot.tracking!.prs.length, 1);
    const action = snapshot.tracking!.actions[0]!;
    await client.acknowledgeAction({
      id: action.id,
      agentId: result.pr.ownerAgentId,
    });
    await client.startAction({
      id: action.id,
      agentId: result.pr.ownerAgentId,
    });
    const events = await client.listEvents({
      afterSequence: 0n,
      prId: result.pr.id,
    });
    assert(events.events.some((e) => e.actionId === action.id));
    assert(events.events.every((e) => e.prId === result.pr.id));
    const store = coordinator.store.tracking;
    assert.equal(store.action(action.id).progress.state, ActionState.Working);
    const db = new DatabaseSync(join(dir, "jobs.sqlite"));
    db.exec("PRAGMA foreign_keys=ON");
    try {
      assert.throws(() =>
        db
          .prepare("UPDATE actions SET state='invented' WHERE id=?")
          .run(action.id),
      );
      const second = store.track("https://github.com/owner/private/pull/2", {
        harness: "codex",
        endpoint: "local",
        sessionId: "test-thread",
      });
      store.observe(second.id, input, coordinator.tracking.config);
      assert.throws(() =>
        db
          .prepare("UPDATE actions SET opened_observation_id=? WHERE id=?")
          .run(store.pr(second.id).observation!.id, action.id),
      );
    } finally {
      db.close();
    }
  } finally {
    await coordinator.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("private observations remain separate from public-only Pi tools; partial later pages stay partial", async () => {
  const paths: string[] = [];
  const raw = {
    state: "open",
    merged: false,
    mergeable: true,
    head: { sha: "head" },
    base: { sha: "base", ref: "main", repo: { private: true } },
  };
  const o = await readObservation(
    url,
    undefined,
    async (path) => {
      paths.push(path);
      if (path.endsWith("/pulls/1")) return raw;
      if (path.includes("/git/ref/")) return { object: { sha: "base-tip" } };
      if (path.includes("/reviews?")) {
        if (path.includes("page=2")) throw new Error("offline");
        return Array.from({ length: 100 }, (_, i) => ({
          id: i,
          user: { login: "reviewer" },
          state: "CHANGES_REQUESTED",
          commit_id: "head",
          submitted_at: "2026-11-09T00:00:00Z",
        }));
      }
      if (path.includes("check-runs")) return { check_runs: [] };
      return [];
    },
    () => 1000,
  );
  assert.equal(o.headSha, "head");
  assert.equal(o.reviews.state, "partial");
  assert.equal(paths.length, 8);
  assert.deepEqual(o.targetBase, { ref: "main", sha: "base-tip" });
  assert.throws(() => publicPullRequest(raw), /Only confirmed public/);
});
test("routing selects exact-check profiles and rejects invalid configuration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "octo-config-"));
  const path = join(dir, "config.json");
  try {
    await writeFile(
      path,
      JSON.stringify({
        endpoints: { local: { delivery: "queue", socket: "/tmp/codex.sock" } },
        profiles: {
          lint: {
            instructions: "Read lint output only",
            harness: "codex",
            model: "cheap-model",
          },
        },
        rules: [{ kind: "check_failed", checkName: "lint", profile: "lint" }],
      }),
    );
    const config = loadTrackingConfig(path),
      blocker = {
        kind: "check_failed" as const,
        sourceId: "run",
        checkName: "lint",
        headSha: "head",
        checkKey: "run:lint",
      };
    assert.deepEqual(config.endpoints["local"], {
      delivery: "queue",
      socket: "/tmp/codex.sock",
    });
    for (const endpoint of [
      { delivery: "shell" },
      { command: "codex" },
      { socket: "relative" },
    ]) {
      await writeFile(path, JSON.stringify({ endpoints: { local: endpoint } }));
      assert.throws(() => loadTrackingConfig(path), /Invalid endpoint/);
    }
    assert.equal(selectProfile(blocker, config).model, "cheap-model");
    assert.equal(
      selectProfile({ ...blocker, checkName: "build" }, config).name,
      "check_failed",
    );
    await writeFile(
      path,
      JSON.stringify({
        rules: [{ kind: "conflict", checkName: "lint", profile: "missing" }],
      }),
    );
    assert.throws(() => loadTrackingConfig(path), /Invalid/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("additive migration preserves a pre-tracking database, event cursor, and identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "octo-migrate-"));
  const path = join(dir, "jobs.sqlite");
  const db = new DatabaseSync(path);
  const job = {
    id: "legacy",
    requestId: "old-request",
    digest: "old-digest",
    task: { kind: "resolve_conflict" },
    status: "queued",
    createdAt: 123,
    updatedAt: 123,
    availableAt: 123,
    attempts: [],
    retryCount: 0,
  };
  db.exec(
    "CREATE TABLE jobs(id TEXT PRIMARY KEY,request_id TEXT UNIQUE NOT NULL,data TEXT NOT NULL);CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL,at INTEGER NOT NULL,kind TEXT NOT NULL,detail TEXT NOT NULL);CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
  );
  db.prepare("INSERT INTO jobs VALUES(?,?,?)").run(
    job.id,
    job.requestId,
    JSON.stringify(job),
  );
  db.exec(
    "INSERT INTO events(job_id,at,kind,detail) VALUES('legacy',123,'queued','fixture');INSERT INTO settings VALUES('instance_id','legacy-instance')",
  );
  db.close();
  const { Store } = await import("../src/store.js");
  const store = new Store(dir);
  try {
    assert.deepEqual(store.get(job.id), job);
    assert.equal(store.instanceId(), "legacy-instance");
    assert.equal(store.sequence(), 1);
    assert.equal(store.tracking.prs().length, 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
