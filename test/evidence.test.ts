import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.js";
import { readObservation } from "../src/tracking/github.js";
import { defaultTrackingConfig } from "../src/tracking/config.js";
import { findings } from "../src/tracking/policy.js";
import { ActionState, type ObservationInput } from "../src/tracking/types.js";
import { rpcRejection } from "../src/agents/diagnostics.js";

const url = "https://github.com/owner/repo/pull/1";
const input: ObservationInput = {
  observedAt: 1000,
  headSha: "head",
  baseSha: "ancestor",
  targetBase: { ref: "release/test", sha: "target-tip" },
  lifecycle: "open",
  mergeability: "conflicting",
  checks: { state: "complete", value: [] },
  reviews: { state: "complete", value: [] },
};

test("conflict evidence uses the independently read target while retaining the PR-reported base", async () => {
  const pr = {
    head: { sha: "head" },
    base: { sha: "ancestor", ref: "release/test", repo: { private: true } },
    state: "open",
    merged: false,
    mergeable: false,
  };
  let refReads = 0;
  const read = (path: string): Promise<unknown> => {
    if (path.includes("/pulls/1") && !path.includes("reviews"))
      return Promise.resolve(pr);
    if (path.endsWith("git/ref/heads/release%2Ftest")) {
      refReads++;
      return Promise.resolve({ object: { sha: "target-tip" } });
    }
    if (path.includes("check-runs")) return Promise.resolve({ check_runs: [] });
    return Promise.resolve([]);
  };
  const observation = await readObservation(url, undefined, read, () => 1000);
  assert.equal(observation.baseSha, "ancestor");
  assert.deepEqual(observation.targetBase, {
    ref: "release/test",
    sha: "target-tip",
  });
  assert.deepEqual(
    findings({ ...observation, id: 1, prId: "pr" }, url)[0]?.blocker,
    {
      kind: "conflict",
      headSha: "head",
      baseSha: "target-tip",
      baseRef: "release/test",
    },
  );
  assert.equal(refReads, 2);
  let prReads = 0;
  await assert.rejects(
    readObservation(url, undefined, (path) => {
      if (path.endsWith("/pulls/1"))
        return Promise.resolve({ ...pr, mergeable: ++prReads === 1 });
      return read(path);
    }),
    /revisions changed/,
  );
  let unstableReads = 0;
  await assert.rejects(
    readObservation(url, undefined, async (path) =>
      path.includes("/git/ref/")
        ? { object: { sha: ++unstableReads === 1 ? "target-tip" : "new-tip" } }
        : read(path),
    ),
    /revisions changed/,
  );
  await assert.rejects(
    readObservation(url, undefined, async (path) => {
      if (path.includes("/git/ref/")) throw new Error("target offline");
      return read(path);
    }),
    /target offline/,
  );
  const closed = await readObservation(url, undefined, async (path) => {
    assert(!path.includes("/git/ref/"));
    const result = await read(path);
    return path.endsWith("/pulls/1") ? { ...pr, state: "closed" } : result;
  });
  assert.equal(closed.lifecycle, "closed");
  assert.equal(closed.targetBase, undefined);
});

test("action events retain their state and actor after progress, reassignment and reopening a v2 database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "octo-evidence-"));
  let store = new Store(dir, () => 1000);
  try {
    const pr = store.tracking.track(url, {
      harness: "codex",
      endpoint: "local",
      sessionId: "first",
      label: "Original owner",
    });
    store.tracking.observe(pr.id, input, defaultTrackingConfig());
    const action = store.tracking.actions()[0];
    assert(action !== undefined);
    store.tracking.progress(action.id, pr.ownerAgentId, false);
    const acknowledgment = store
      .eventsSince(0)
      .find((event) => event.actionContext?.state === ActionState.Acknowledged);
    assert(acknowledgment !== undefined);
    assert.equal(acknowledgment.actionContext?.actorSessionId, "first");
    store.tracking.reprofile(action.id, defaultTrackingConfig());
    assert.equal(
      store.eventsSince(0).find((event) => event.kind === "action_reprofiled")
        ?.actionContext?.actorAgentId,
      undefined,
    );
    store.tracking.progress(action.id, pr.ownerAgentId, true);
    store.tracking.assign(pr.id, {
      harness: "codex",
      endpoint: "local",
      sessionId: "second",
    });
    assert.deepEqual(
      store.eventsSince(0).find((event) => event.seq === acknowledgment.seq),
      acknowledgment,
    );
    assert.deepEqual(
      store.tracking.pr(pr.id).observation?.targetBase,
      input.targetBase,
    );
    const instance = store.instanceId(),
      sequence = store.sequence();
    store.close();
    store = new Store(dir);
    assert.deepEqual(
      store.eventsSince(0).find((event) => event.seq === acknowledgment.seq),
      acknowledgment,
    );
    store.close();
    const db = new DatabaseSync(join(dir, "jobs.sqlite"));
    db.exec(
      "DROP TABLE conflict_cases; DROP TABLE repair_attempts; ALTER TABLE events DROP COLUMN action_context_json; ALTER TABLE pr_observations DROP COLUMN target_base_json; PRAGMA user_version=2",
    );
    db.close();
    store = new Store(dir);
    assert.equal(store.instanceId(), instance);
    assert.equal(store.sequence(), sequence);
    assert.equal(
      store.eventsSince(0).find((event) => event.seq === acknowledgment.seq)
        ?.actionContext,
      undefined,
    );
    assert.equal(store.tracking.pr(pr.id).observation?.targetBase, undefined);
    store.tracking.observe(pr.id, input, defaultTrackingConfig());
    assert.deepEqual(
      store.tracking.pr(pr.id).observation?.targetBase,
      input.targetBase,
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("RPC diagnostics bound and clean untrusted error text without losing method or code", () => {
  const reason = rpcRejection(
    "thread/resume",
    { code: -32601, message: "unsupported\u001b[31m\n" + "x".repeat(3000) },
    "0.167.0",
  );
  assert(reason.includes("thread/resume"));
  assert(reason.includes("-32601"));
  assert(reason.includes("0.167.0"));
  assert(!reason.includes("\u001b"));
  assert(!reason.includes("\n"));
  assert(reason.length < 2150);
  assert(rpcRejection("turn/start", null).includes("No upstream message"));
});
