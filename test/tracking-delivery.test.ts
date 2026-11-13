import { GitHubScheduler } from "../src/scheduling/service.js";
import { defaultSchedulerPolicy } from "../src/scheduling/contracts.js";
import { readFailureExcerpt } from "../src/tracking/messages.js";
import { shortId } from "../src/tracking/identifiers.js";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { TrackingService } from "../src/tracking/service.js";
import { DeliveryError, type AgentConnection } from "../src/agents/codex.js";
import {
  ActionState,
  DeliveryState,
  type ObservationInput,
} from "../src/tracking/types.js";
import { defaultTrackingConfig } from "../src/tracking/config.js";
const input: ObservationInput = {
  observedAt: 1000,
  headSha: "head",
  baseSha: "base",
  lifecycle: "open",
  mergeability: "conflicting",
  checks: { state: "complete", value: [] },
  reviews: { state: "complete", value: [] },
};
const target = { harness: "codex", endpoint: "local", sessionId: "owner" };
const url = "https://github.com/owner/repo/pull/1";
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail("Timed out waiting for delivery");
}
function connection(patch: Partial<AgentConnection> = {}): AgentConnection {
  return {
    prepare: async () => ({ busy: false, version: "0.167.0" }),
    send: async () => ({ turnId: "triage-turn" }),
    find: async () => ({ found: false }),
    close: () => {},
    ...patch,
  };
}
test("busy threads wait, delivery acceptance is not acknowledgment, and origin settings are untouched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "octo-delivery-"));
  let at = 1000;
  const store = new Store(dir, () => at);
  const config = defaultTrackingConfig();
  let busy = true,
    sends = 0;
  const p = store.tracking.track(url, target);
  store.tracking.observe(p.id, input, config);
  const service = new TrackingService(store.tracking, config, () => at, {
    read: async () => input,
    connect: () =>
      connection({
        prepare: async () => ({ busy, version: "0.167.0" }),
        send: async (agent, id, message) => {
          sends++;
          assert.equal(agent.sessionId, "owner");
          assert(message.includes("Merge conflict"));
          assert(message.includes(`[octo-delivery:${shortId(id)}]`));
          return { turnId: "turn" };
        },
      }),
  });
  try {
    service.tick();
    await until(
      () =>
        store.tracking.deliveries()[0]!.progress.state ===
          DeliveryState.Pending &&
        store.tracking.deliveries()[0]!.updatedAt === at,
    );
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(sends, 0);
    busy = false;
    at += 5000;
    service.tick();
    await until(
      () =>
        store.tracking.deliveries()[0]!.progress.state ===
        DeliveryState.Delivered,
    );
    assert.equal(store.tracking.actions()[0]!.progress.state, ActionState.Open);
    assert.equal(sends, 1);
    assert.equal(store.tracking.attempts()[0]!.harnessVersion, "0.167.0");
    store.tracking.progress(
      store.tracking.actions()[0]!.id,
      p.ownerAgentId,
      false,
    );
    assert.equal(
      store.tracking.actions()[0]!.progress.state,
      ActionState.Acknowledged,
    );
  } finally {
    await service.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("reassignment during an ambiguous send preserves attempt evidence and does not notify the old owner again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "octo-race-"));
  const store = new Store(dir);
  const config = defaultTrackingConfig();
  const p = store.tracking.track(url, target);
  store.tracking.observe(p.id, input, config);
  let rejectSend!: (e: Error) => void;
  let entered = false;
  const service = new TrackingService(store.tracking, config, Date.now, {
    read: async () => input,
    connect: () =>
      connection({
        send: async () => {
          entered = true;
          return new Promise((_, reject) => {
            rejectSend = reject;
          });
        },
      }),
  });
  try {
    service.tick();
    await until(() => entered);
    store.tracking.assign(p.id, { ...target, sessionId: "new-owner" });
    rejectSend(new DeliveryError("Lost response", true));
    await until(
      () => store.tracking.attempts()[0]!.outcome.state === "uncertain",
    );
    assert.equal(
      store.tracking.deliveries()[0]!.progress.state,
      DeliveryState.Cancelled,
    );
    assert.equal(
      store.tracking.deliveries()[1]!.progress.state,
      DeliveryState.Pending,
    );
  } finally {
    await service.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("uncertain sends are reconciled after restart without blindly resending", async () => {
  const dir = await mkdtemp(join(tmpdir(), "octo-unknown-"));
  let at = 1000;
  let store = new Store(dir, () => at);
  const config = defaultTrackingConfig();
  const p = store.tracking.track(url, target);
  store.tracking.observe(p.id, input, config);
  let sends = 0;
  let service = new TrackingService(store.tracking, config, () => at, {
    read: async () => input,
    connect: () =>
      connection({
        send: async () => {
          sends++;
          throw new DeliveryError("Lost acceptance", true);
        },
      }),
  });
  try {
    service.tick();
    await until(
      () =>
        store.tracking.deliveries()[0]!.progress.state ===
        DeliveryState.Uncertain,
    );
    await service.close();
    store.close();
    store = new Store(dir, () => at);
    service = new TrackingService(store.tracking, config, () => at, {
      read: async () => input,
      connect: () =>
        connection({
          find: async () => ({
            found: true,
            queueId: "accepted-before-restart",
            note: "Queue admission only",
          }),
          send: async () => {
            sends++;
            return {};
          },
        }),
    });
    at += 60000;
    service.tick();
    await until(
      () =>
        store.tracking.deliveries()[0]!.progress.state ===
        DeliveryState.Delivered,
    );
    assert.equal(sends, 1);
    const progress = store.tracking.deliveries()[0]?.progress;
    assert(progress?.state === DeliveryState.Delivered);
    assert.equal(progress.queueId, "accepted-before-restart");
    assert.equal(progress.note, "Queue admission only");
    assert.equal(store.tracking.actions()[0]?.progress.state, ActionState.Open);
  } finally {
    await service.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("durable messages keep retrying transient failures and explicit retry resets rejected delivery backoff", async () => {
  const dir = await mkdtemp(join(tmpdir(), "octo-retry-"));
  let permanent = false;
  let at = 1000;
  const store = new Store(dir, () => at);
  const config = defaultTrackingConfig();
  const p = store.tracking.track(url, target);
  store.tracking.observe(p.id, input, config);
  const service = new TrackingService(store.tracking, config, () => at, {
    read: async () => input,
    connect: () =>
      connection({
        prepare: async () => {
          throw new DeliveryError("Offline", false, permanent);
        },
      }),
  });
  try {
    for (let i = 1; i <= 4; i++) {
      service.tick();
      await until(() => store.tracking.attempts().length === i);
      await new Promise((r) => setTimeout(r, 5));
      at += 200000;
    }
    assert.equal(
      store.tracking.deliveries()[0]?.progress.state,
      DeliveryState.Pending,
    );
    permanent = true;
    service.tick();
    await until(() => store.tracking.attempts().length === 5);
    assert.equal(
      store.tracking.deliveries()[0]?.progress.state,
      DeliveryState.Unavailable,
    );
    permanent = false;
    store.tracking.retryDelivery(store.tracking.deliveries()[0]!.id);
    service.tick();
    await until(() => store.tracking.attempts().length === 6);
    assert.equal(
      store.tracking.deliveries()[0]!.progress.state,
      DeliveryState.Pending,
    );
  } finally {
    await service.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("shutdown aborts an in-flight GitHub refresh", async () => {
  const dir = await mkdtemp(join(tmpdir(), "octo-shutdown-"));
  const store = new Store(dir);
  const config = defaultTrackingConfig();
  const p = store.tracking.track(url, target);
  let signal: AbortSignal | undefined;
  const service = new TrackingService(store.tracking, config, Date.now, {
    read: async (_url, s) => {
      signal = s;
      return new Promise((_, reject) =>
        s!.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        }),
      );
    },
  });
  try {
    const refresh = service.refresh(p.id);
    await until(() => signal !== undefined);
    await service.close();
    await refresh;
    assert(signal!.aborted);
  } finally {
    await service.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("queue admission preserves its receipt across restart without acknowledging the action", async () => {
  const dir = await mkdtemp(join(tmpdir(), "octo-queue-"));
  let store = new Store(dir);
  const config = defaultTrackingConfig();
  const pr = store.tracking.track(url, target);
  store.tracking.observe(pr.id, input, config);
  const receipt = { queueId: "queue-receipt", note: "Queue admission only" };
  const service = new TrackingService(store.tracking, config, Date.now, {
    read: () => Promise.resolve(input),
    connect: () => connection({ send: () => Promise.resolve(receipt) }),
  });
  try {
    service.tick();
    await until(
      () =>
        store.tracking.deliveries()[0]?.progress.state ===
        DeliveryState.Delivered,
    );
    await service.close();
    store.close();
    store = new Store(dir);
    const delivery = store.tracking.deliveries()[0];
    assert(delivery?.progress.state === DeliveryState.Delivered);
    assert.equal(delivery.progress.queueId, receipt.queueId);
    assert.equal(delivery.progress.note, receipt.note);
    assert.equal(store.tracking.actions()[0]?.progress.state, ActionState.Open);
    const attempt = store.tracking.attempts()[0];
    assert(attempt?.outcome.state === "accepted");
    assert.equal(attempt.outcome.queueId, receipt.queueId);
  } finally {
    await service.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("optional log enrichment expires during cooldown without starving cached notifications", async () => {
  const dir = await mkdtemp(join(tmpdir(), "octo-enrichment-"));
  const store = new Store(dir, () => 1000);
  const scheduler = new GitHubScheduler(
    store.schedules,
    defaultSchedulerPolicy,
    () => 1000,
    () => Promise.reject(new Error("No review reads expected")),
    () => {},
  );
  scheduler.defer("core", 3601000);
  const config = defaultTrackingConfig();
  const failed: ObservationInput = {
    ...input,
    mergeability: "mergeable",
    checks: {
      state: "complete",
      value: [
        {
          id: "ci",
          key: "CI",
          name: "CI",
          headSha: "head",
          status: "completed",
          conclusion: "failure",
          at: 1000,
          url: "https://github.com/owner/repo/actions/runs/1/job/2",
        },
      ],
    },
  };
  const first = store.tracking.track(url, target);
  store.tracking.observe(first.id, failed, config);
  const second = store.tracking.track(
    "https://github.com/owner/repo/pull/2",
    target,
  );
  store.tracking.observe(second.id, input, config);
  const action = store.tracking
    .actions()
    .find(
      (value) =>
        value.prId === first.id && value.blocker.kind === "check_failed",
    );
  assert.ok(action !== undefined);
  const firstDelivery = store.tracking
    .deliveries()
    .find((value) => value.actionId === action.id);
  assert.ok(firstDelivery !== undefined);
  const other = store.tracking
    .deliveries()
    .find((value) => store.tracking.action(value.actionId).prId === second.id);
  assert.ok(other !== undefined);
  for (const delivery of store.tracking.deliveries())
    if (delivery.id !== firstDelivery.id)
      store.tracking.inbox.record(delivery.id, "Cached notification");
  const completed = Promise.withResolvers<undefined>();
  let dispatched = 0;
  const sent: string[] = [];
  const service = new TrackingService(store.tracking, config, () => 1000, {
    read: (pr) => Promise.resolve(pr === url ? failed : input),
    failureExcerpt: (value, pr, signal) =>
      readFailureExcerpt(value, pr, signal, (_repository, _run, _job, abort) =>
        scheduler.dispatch(
          "core",
          () => {
            dispatched++;
            return Promise.resolve("Error: should not dispatch");
          },
          abort,
        ),
      ).finally(() => {
        completed.resolve(undefined);
      }),
    connect: () =>
      connection({
        send: (_agent, id) => {
          sent.push(id);
          return Promise.resolve({ turnId: "delivered" });
        },
      }),
  });
  try {
    service.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(scheduler.status().queuedRequests, 1);
    await completed.promise;
    await until(() => sent.includes(firstDelivery.id));
    service.tick();
    await until(() => sent.includes(other.id));
    assert.equal(dispatched, 0);
    assert.equal(scheduler.status().queuedRequests, 0);
    assert.equal(scheduler.deadline("core"), 3601000);
  } finally {
    await service.close();
    await scheduler.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 10000);
