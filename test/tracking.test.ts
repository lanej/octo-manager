import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import {
  ActionState,
  DeliveryState,
  type ObservationInput,
} from "../src/tracking/types.js";
import { defaultTrackingConfig } from "../src/tracking/config.js";
const target = { harness: "codex", endpoint: "local", sessionId: "thread-one" };
const url = "https://github.com/owner/repo/pull/1";
const observation = (
  patch: Partial<ObservationInput> = {},
): ObservationInput => ({
  observedAt: 1234,
  headSha: "head1",
  baseSha: "base1",
  lifecycle: "open",
  mergeability: "conflicting",
  checks: { state: "complete", value: [] },
  reviews: { state: "complete", value: [] },
  ...patch,
});
test("tracking preserves jobs across migration and restart, blocker episodes and ownership", async () => {
  const dir = await mkdtemp(join(tmpdir(), "octo-tracking-"));
  let store = new Store(dir, () => 2000);
  const config = defaultTrackingConfig();
  try {
    const job = store.submit({ kind: "resolve_conflict" }, "old-job");
    const p = store.tracking.track(url, target);
    assert.equal(store.tracking.track(url, target).id, p.id);
    assert.throws(
      () => store.tracking.track(url, { ...target, sessionId: "other" }),
      /another owner/,
    );
    store.tracking.observe(p.id, observation(), config);
    store.tracking.observe(p.id, observation(), config);
    assert.equal(store.tracking.actions().length, 1);
    assert.equal(store.tracking.deliveries().length, 1);
    const action = store.tracking.actions()[0]!;
    assert.throws(
      () => store.tracking.progress(action.id, "wrong", false),
      /another agent/,
    );
    assert.throws(
      () => store.tracking.progress(action.id, p.ownerAgentId, true),
      /Acknowledge/,
    );
    store.tracking.progress(action.id, p.ownerAgentId, false);
    store.tracking.progress(action.id, p.ownerAgentId, true);
    const owner = store.tracking.assign(p.id, {
      ...target,
      sessionId: "thread-two",
    });
    assert.equal(
      store.tracking.action(action.id).progress.state,
      ActionState.Open,
    );
    assert.notEqual(owner.ownerAgentId, p.ownerAgentId);
    store.tracking.observe(
      p.id,
      observation({
        mergeability: "unknown",
        checks: { state: "unavailable", reason: "offline" },
      }),
      config,
    );
    assert.equal(
      store.tracking.action(action.id).progress.state,
      ActionState.Open,
    );
    store.tracking.observe(
      p.id,
      observation({ mergeability: "mergeable" }),
      config,
    );
    assert.equal(
      store.tracking.action(action.id).progress.state,
      ActionState.Resolved,
    );
    store.tracking.observe(p.id, observation(), config);
    assert.equal(store.tracking.actions().length, 2);
    store.close();
    store = new Store(dir, () => 3000);
    assert.equal(store.get(job.id).requestId, "old-job");
    assert.equal(store.tracking.actions().length, 2);
    assert.equal(store.tracking.pr(p.id).originAgentId, p.ownerAgentId);
    store.tracking.untrack(p.id);
    assert(
      store.tracking
        .deliveries()
        .every((d) => d.progress.state === DeliveryState.Cancelled),
    );
    assert.equal(
      store.tracking.track(url, { ...target, sessionId: "thread-two" }).enabled,
      true,
    );
    assert(
      store
        .eventsSince(0)
        .some((e) => e.prId === p.id && e.kind === "action_opened"),
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("check reruns and effective reviews retain uncertainty and do not resolve on a push", async () => {
  const dir = await mkdtemp(join(tmpdir(), "octo-policy-"));
  const store = new Store(dir);
  const config = defaultTrackingConfig();
  try {
    const p = store.tracking.track(url, target);
    const c = {
      id: "run:1",
      key: "run:lint",
      name: "lint",
      headSha: "head1",
      status: "completed",
      conclusion: "failure",
      at: 10,
      url,
    };
    const review = {
      id: "r1",
      author: "alice",
      headSha: "head1",
      state: "CHANGES_REQUESTED",
      at: 10,
      url,
    };
    store.tracking.observe(
      p.id,
      observation({
        mergeability: "mergeable",
        checks: { state: "complete", value: [c] },
        reviews: { state: "complete", value: [review] },
      }),
      config,
    );
    assert.equal(store.tracking.actions().length, 2);
    store.tracking.observe(
      p.id,
      observation({
        mergeability: "mergeable",
        checks: {
          state: "partial",
          reason: "truncated",
          value: [{ ...c, conclusion: "success" }],
        },
        reviews: { state: "complete", value: [review] },
      }),
      config,
    );
    assert(
      store.tracking
        .actions()
        .every((a) => a.progress.state === ActionState.Open),
    );
    store.tracking.observe(
      p.id,
      observation({
        headSha: "head2",
        mergeability: "mergeable",
        reviews: { state: "complete", value: [review] },
      }),
      config,
    );
    assert.equal(
      store.tracking.actions().find((a) => a.blocker.kind === "check_failed")!
        .progress.state,
      ActionState.Superseded,
    );
    assert.equal(
      store.tracking
        .actions()
        .find((a) => a.blocker.kind === "changes_requested")!.progress.state,
      ActionState.Open,
    );
    store.tracking.observe(
      p.id,
      observation({
        headSha: "head2",
        mergeability: "mergeable",
        reviews: {
          state: "complete",
          value: [review, { ...review, id: "r2", state: "APPROVED", at: 20 }],
        },
      }),
      config,
    );
    assert.equal(
      store.tracking
        .actions()
        .find((a) => a.blocker.kind === "changes_requested")!.progress.state,
      ActionState.Resolved,
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("incomplete check and review histories do not create falsely effective blockers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "octo-partial-"));
  const store = new Store(dir);
  const config = defaultTrackingConfig();
  try {
    const p = store.tracking.track(url, target);
    store.tracking.observe(
      p.id,
      observation({
        mergeability: "unknown",
        checks: {
          state: "partial",
          reason: "later page failed",
          value: [
            {
              id: "old",
              key: "lint",
              name: "lint",
              headSha: "head1",
              status: "completed",
              conclusion: "failure",
              at: 1,
              url,
            },
          ],
        },
        reviews: {
          state: "partial",
          reason: "approval may be on missing page",
          value: [
            {
              id: "old-review",
              author: "alice",
              headSha: "head1",
              state: "CHANGES_REQUESTED",
              at: 1,
              url,
            },
          ],
        },
      }),
      config,
    );
    assert.equal(store.tracking.actions().length, 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
