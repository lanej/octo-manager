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
          assert(message.includes("triage and reporting only"));
          assert(message.includes(`[octo-delivery:${id}]`));
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
  let store = new Store(dir);
  const config = defaultTrackingConfig();
  const p = store.tracking.track(url, target);
  store.tracking.observe(p.id, input, config);
  let sends = 0;
  let service = new TrackingService(store.tracking, config, Date.now, {
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
    store = new Store(dir);
    service = new TrackingService(store.tracking, config, Date.now, {
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
test("bounded retries restart their budget after an explicit retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "octo-retry-"));
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
          throw new DeliveryError("Offline");
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
      store.tracking.deliveries()[0]!.progress.state,
      DeliveryState.Unavailable,
    );
    store.tracking.retryDelivery(store.tracking.deliveries()[0]!.id);
    service.tick();
    await until(() => store.tracking.attempts().length === 5);
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
