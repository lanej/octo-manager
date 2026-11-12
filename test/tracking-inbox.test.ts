import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.js";
import { TrackingService } from "../src/tracking/service.js";
import { defaultTrackingConfig } from "../src/tracking/config.js";
import {
  ActionState,
  DeliveryState,
  type ObservationInput,
} from "../src/tracking/types.js";
import { DeliveryError, type AgentConnection } from "../src/agents/codex.js";

const input: ObservationInput = {
  observedAt: 1000,
  headSha: "head",
  baseSha: "base",
  lifecycle: "open",
  mergeability: "conflicting",
  checks: { state: "complete", value: [] },
  reviews: { state: "complete", value: [] },
};
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Inbox work did not finish");
}
test("immutable inbox survives restart, reconciles before replay and requires a message-specific recipient receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-inbox-"));
  let at = 1000;
  let store = new Store(directory, () => at);
  const config = defaultTrackingConfig();
  const pr = store.tracking.track("https://github.com/owner/repo/pull/1", {
    harness: "codex",
    endpoint: "local",
    sessionId: "owner",
  });
  store.tracking.observe(pr.id, input, config);
  const delivery = store.tracking.deliveries()[0];
  assert(delivery !== undefined);
  let visible = false,
    failLookup = false,
    loseResponse = true,
    lookups = 0;
  const sent: { id: string; body: string }[] = [];
  const connect = (): AgentConnection => ({
    prepare: () => Promise.resolve({ busy: false }),
    send: (_agent, id, body) => {
      const frozen = store.tracking.inbox.get(id);
      assert.equal(frozen?.body, body);
      sent.push({ id, body });
      visible = true;
      if (loseResponse) {
        loseResponse = false;
        return Promise.reject(new DeliveryError("Lost response", true));
      }
      return Promise.resolve({ queueId: "admitted" });
    },
    find: () => {
      lookups++;
      return failLookup
        ? Promise.reject(new Error("lookup offline"))
        : Promise.resolve({ found: visible, queueId: "admitted" });
    },
    close: () => {},
  });
  let service = new TrackingService(store.tracking, config, () => at, {
    read: () => Promise.resolve(input),
    connect,
  });
  try {
    service.tick();
    await until(
      () =>
        store.tracking.deliveries()[0]?.progress.state ===
        DeliveryState.Uncertain,
    );
    assert.equal(sent.length, 1);
    const message = store.tracking.inbox.get(delivery.id);
    assert(message !== undefined);
    assert(message.body.includes("Merge conflict"));
    assert.equal(message.acknowledgedAt, undefined);
    await service.close();
    store.close();
    store = new Store(directory, () => at);
    service = new TrackingService(store.tracking, config, () => at, {
      read: () => Promise.resolve(input),
      connect,
    });
    service.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(lookups, 0);
    at += 60000;
    service.tick();
    await until(
      () =>
        store.tracking.deliveries()[0]?.progress.state ===
        DeliveryState.Delivered,
    );
    assert.equal(sent.length, 1);
    store.tracking.reprofile(delivery.actionId, {
      ...config,
      profiles: {
        ...config.profiles,
        conflict: { name: "changed", instructions: "New profile after send" },
      },
    });
    failLookup = true;
    at += 300000;
    service.tick();
    await until(() => lookups === 2);
    assert.equal(sent.length, 1);
    failLookup = false;
    visible = false;
    at += 60000;
    service.tick();
    await until(() => sent.length === 2);
    assert.deepEqual(sent[0], sent[1]);
    assert.equal(store.tracking.inbox.list(pr.ownerAgentId).messages.length, 1);
    assert.throws(
      () => store.tracking.acknowledgeMessage(delivery.id, "other-agent"),
      /another agent/,
    );
    store.tracking.progress(delivery.actionId, pr.ownerAgentId, false);
    assert.equal(
      store.tracking.inbox.get(delivery.id)?.acknowledgedAt,
      undefined,
    );
    const receipt = store.tracking.acknowledgeMessage(
      delivery.id,
      pr.ownerAgentId,
    );
    assert.equal(receipt.acknowledgedAt, at);
    assert.equal(
      store.tracking.action(delivery.actionId).progress.state,
      ActionState.Acknowledged,
    );
    at += 1;
    assert.equal(
      store.tracking.acknowledgeMessage(delivery.id, pr.ownerAgentId)
        .acknowledgedAt,
      receipt.acknowledgedAt,
    );
    assert.equal(store.tracking.inbox.list(pr.ownerAgentId).messages.length, 0);
    assert.equal(
      store.tracking.inbox.list(pr.ownerAgentId, 0, true).messages.length,
      1,
    );
    const db = new DatabaseSync(join(directory, "jobs.sqlite"));
    try {
      assert.throws(
        () => db.prepare("UPDATE delivery_messages SET body='rewritten'").run(),
        /immutable/,
      );
      assert.throws(
        () =>
          db
            .prepare("UPDATE delivery_messages SET acknowledged_at_ms=NULL")
            .run(),
        /immutable/,
      );
      assert.throws(
        () =>
          db.prepare("UPDATE deliveries SET recipient_agent_id='other'").run(),
        /immutable/,
      );
    } finally {
      db.close();
    }
    at += 3600000;
    service.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sent.length, 2);
    assert.equal(
      store.tracking.action(delivery.actionId).progress.state,
      ActionState.Acknowledged,
    );
  } finally {
    await service.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("typed inbox and CLI expose immutable payloads, page by recipient and record receipt independently of action acceptance", async () => {
  const { Coordinator } = await import("../src/coordinator.js");
  const { schedulerClient } = await import("../src/client.js");
  const directory = await mkdtemp(join(tmpdir(), "octo-inbox-api-"));
  const coordinator = new Coordinator(directory, {
    trackingOptions: {
      read: () => Promise.resolve(input),
      connect: () => ({
        prepare: () => Promise.resolve({ busy: true }),
        send: () => Promise.resolve({}),
        find: () => Promise.resolve({ found: false }),
        close: () => {},
      }),
    },
  });
  try {
    await coordinator.start();
    const pr = coordinator.tracking.track(
      "https://github.com/owner/repo/pull/1",
      { harness: "codex", endpoint: "local", sessionId: "api-owner" },
    );
    await coordinator.tracking.refresh(pr.id);
    coordinator.tracking.tick();
    await until(
      () =>
        coordinator.store.tracking.inbox.list(pr.ownerAgentId).messages
          .length === 1,
    );
    const client = schedulerClient(directory);
    const page = await client.listAgentMessages({ agentId: pr.ownerAgentId });
    const message = page.messages[0];
    assert(message !== undefined);
    assert(message.body.includes(`[octo-delivery:${message.id}]`));
    assert.equal(message.applicable, true);
    assert.equal(page.hasMore, false);
    assert.equal(
      (
        await client.listAgentMessages({
          agentId: pr.ownerAgentId,
          afterSequence: page.nextSequence,
        })
      ).messages.length,
      0,
    );
    await assert.rejects(
      client.acknowledgeMessage({ id: message.id, agentId: "wrong" }),
      /another agent/,
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "src/cli.ts",
        "acknowledge-message",
        message.id,
        "--agent-id",
        pr.ownerAgentId,
        "--state",
        directory,
        "--json",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const body = await new Response(child.stdout).text();
    assert.equal(
      await child.exited,
      0,
      await new Response(child.stderr).text(),
    );
    assert(body.includes(message.id));
    assert.equal(
      (await client.listAgentMessages({ agentId: pr.ownerAgentId })).messages
        .length,
      0,
    );
    const received = (
      await client.listAgentMessages({
        agentId: pr.ownerAgentId,
        includeAcknowledged: true,
      })
    ).messages[0];
    assert(received?.acknowledgedAtMs !== undefined);
    const delivered = (
      await client.getSnapshot({})
    ).snapshot?.tracking?.deliveries.find(
      (delivery) => delivery.id === message.id,
    );
    assert.equal(delivered?.acknowledgedAtMs, received.acknowledgedAtMs);
    assert.equal(
      coordinator.store.tracking.action(message.actionId).progress.state,
      ActionState.Open,
    );
    const cli = Bun.spawn(
      [
        process.execPath,
        "src/cli.ts",
        "inbox",
        "--agent-id",
        pr.ownerAgentId,
        "--include-acknowledged",
        "--state",
        directory,
        "--json",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const listed = await new Response(cli.stdout).text();
    assert.equal(await cli.exited, 0, await new Response(cli.stderr).text());
    assert(listed.includes(message.id));
    assert(
      coordinator.store
        .eventsSince(0)
        .some((event) => event.kind === "message_acknowledged"),
    );
  } finally {
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("busy replay rechecks newly visible history instead of submitting another copy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-inbox-busy-"));
  let at = 1000,
    busy = false,
    visible = false,
    sends = 0,
    lookups = 0;
  const store = new Store(directory, () => at),
    config = defaultTrackingConfig();
  const pr = store.tracking.track("https://github.com/owner/repo/pull/1", {
    harness: "codex",
    endpoint: "local",
    sessionId: "owner",
  });
  store.tracking.observe(pr.id, input, config);
  const service = new TrackingService(store.tracking, config, () => at, {
    read: () => Promise.resolve(input),
    connect: () => ({
      prepare: () => Promise.resolve({ busy }),
      send: () => {
        sends++;
        return Promise.resolve({ queueId: "queue" });
      },
      find: () => {
        lookups++;
        return Promise.resolve({ found: visible });
      },
      close: () => {},
    }),
  });
  try {
    service.tick();
    await until(() => sends === 1);
    await until(
      () =>
        store.tracking.deliveries()[0]?.progress.state ===
        DeliveryState.Delivered,
    );
    at += 300000;
    busy = true;
    service.tick();
    await until(() => lookups === 1);
    assert.equal(sends, 1);
    at += 5000;
    busy = false;
    visible = true;
    service.tick();
    await until(() => lookups === 2);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sends, 1);
  } finally {
    await service.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("receipt arriving during send retains both acknowledged receipt and completed transport evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-inbox-race-"));
  const store = new Store(directory),
    config = defaultTrackingConfig();
  const pr = store.tracking.track("https://github.com/owner/repo/pull/1", {
    harness: "codex",
    endpoint: "local",
    sessionId: "owner",
  });
  store.tracking.observe(pr.id, input, config);
  let finish: ((value: { queueId: string }) => void) | undefined;
  let sends = 0;
  const service = new TrackingService(store.tracking, config, Date.now, {
    read: () => Promise.resolve(input),
    connect: () => ({
      prepare: () => Promise.resolve({ busy: false }),
      send: () => {
        sends++;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      find: () => Promise.resolve({ found: false }),
      close: () => {},
    }),
  });
  try {
    service.tick();
    await until(() => finish !== undefined);
    const message = store.tracking.inbox.list(pr.ownerAgentId).messages[0];
    assert(message !== undefined);
    store.tracking.acknowledgeMessage(message.id, pr.ownerAgentId);
    assert(finish !== undefined);
    finish({ queueId: "accepted-after-receipt" });
    await until(
      () =>
        store.tracking.deliveries()[0]?.progress.state ===
        DeliveryState.Delivered,
    );
    assert(store.tracking.inbox.get(message.id)?.acknowledgedAt !== undefined);
    assert.equal(store.tracking.attempts()[0]?.outcome.state, "accepted");
    assert.equal(
      store.tracking.action(message.actionId).progress.state,
      ActionState.Open,
    );
    service.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sends, 1);
  } finally {
    await service.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("inbox pagination never treats its cursor as receipt and migration retains unknown historical payloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-inbox-pages-"));
  let store = new Store(directory);
  const config = defaultTrackingConfig();
  const pr = store.tracking.track("https://github.com/owner/repo/pull/1", {
    harness: "codex",
    endpoint: "local",
    sessionId: "owner",
  });
  try {
    const checks = Array.from({ length: 201 }, (_, i) => ({
      id: `run:${String(i)}`,
      key: `check:${String(i)}`,
      name: `Check ${String(i)}`,
      headSha: "head",
      status: "completed",
      conclusion: "failure",
      at: 1000,
      url: pr.url,
    }));
    store.tracking.observe(
      pr.id,
      { ...input, checks: { state: "complete", value: checks } },
      config,
    );
    for (const delivery of store.tracking.deliveries())
      store.tracking.inbox.record(delivery.id, `Frozen ${delivery.id}`);
    const first = store.tracking.inbox.list(pr.ownerAgentId);
    assert.equal(first.messages.length, 200);
    assert.equal(first.hasMore, true);
    const last = store.tracking.inbox.list(pr.ownerAgentId, first.nextSequence);
    assert.equal(last.messages.length, 2);
    assert.equal(last.hasMore, false);
    assert.equal(store.tracking.inbox.list("other").messages.length, 0);
    assert.equal(
      store.tracking.inbox.list(pr.ownerAgentId).messages.length,
      200,
    );
    const legacy = store.tracking.deliveries()[0];
    assert(legacy !== undefined);
    store.tracking.saveDelivery(
      {
        ...legacy,
        progress: {
          state: DeliveryState.Delivered,
          at: 1000,
          queueId: "historical",
        },
      },
      "delivery_delivered",
    );
    const identity = store.instanceId();
    store.close();
    const db = new DatabaseSync(join(directory, "jobs.sqlite"));
    db.exec(
      "DROP TABLE check_watches; ALTER TABLE pr_observations DROP COLUMN workflow_runs_json; DROP TRIGGER immutable_message_recipient; DROP TABLE delivery_messages; PRAGMA user_version=6",
    );
    db.close();
    store = new Store(directory);
    assert.equal(store.instanceId(), identity);
    assert.equal(
      store.tracking.deliveries()[0]?.progress.state,
      DeliveryState.Delivered,
    );
    assert.equal(store.tracking.inbox.list(pr.ownerAgentId).messages.length, 0);
    assert.equal(store.tracking.inbox.get(legacy.id), undefined);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("receipt during reconciliation retains the newly confirmed transport receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-inbox-find-race-"));
  let at = 1000;
  const store = new Store(directory, () => at),
    config = defaultTrackingConfig();
  const pr = store.tracking.track("https://github.com/owner/repo/pull/1", {
    harness: "codex",
    endpoint: "local",
    sessionId: "owner",
  });
  store.tracking.observe(pr.id, input, config);
  let finish:
    | ((value: { found: boolean; queueId: string }) => void)
    | undefined;
  let sends = 0;
  const service = new TrackingService(store.tracking, config, () => at, {
    read: () => Promise.resolve(input),
    connect: () => ({
      prepare: () => Promise.resolve({ busy: false }),
      send: () => {
        sends++;
        return Promise.reject(new DeliveryError("lost", true));
      },
      find: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      close: () => {},
    }),
  });
  try {
    service.tick();
    await until(
      () =>
        store.tracking.deliveries()[0]?.progress.state ===
        DeliveryState.Uncertain,
    );
    const message = store.tracking.inbox.list(pr.ownerAgentId).messages[0];
    assert(message !== undefined);
    at += 60000;
    service.tick();
    await until(() => finish !== undefined);
    store.tracking.acknowledgeMessage(message.id, pr.ownerAgentId);
    assert(finish !== undefined);
    finish({ found: true, queueId: "reconciled" });
    await until(
      () =>
        store.tracking.deliveries()[0]?.progress.state ===
        DeliveryState.Delivered,
    );
    assert(store.tracking.inbox.get(message.id)?.acknowledgedAt !== undefined);
    assert.equal(sends, 1);
    assert.equal(
      store.tracking.action(message.actionId).progress.state,
      ActionState.Open,
    );
  } finally {
    await service.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("service confirms exact host receipt once without accepting the action", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-host-receipt-"));
  let at = 1000;
  const store = new Store(directory, () => at);
  const config = defaultTrackingConfig();
  const pr = store.tracking.track("https://github.com/owner/repo/pull/1", {
    harness: "codex",
    endpoint: "local",
    sessionId: "owner",
  });
  store.tracking.observe(pr.id, input, config);
  let body = "";
  let received = false;
  const service = new TrackingService(store.tracking, config, () => at, {
    read: () => Promise.resolve(input),
    connect: () => ({
      prepare: () => Promise.resolve({ busy: false }),
      send: (_agent, _id, message) => {
        body = message;
        return Promise.resolve({ queueId: "queued" });
      },
      find: (_agent, _id, expected) => {
        assert.equal(expected, body);
        return Promise.resolve({ found: true, received, turnId: "host-turn" });
      },
      close: () => {},
    }),
  });
  try {
    service.tick();
    await until(
      () =>
        store.tracking.deliveries()[0]?.progress.state ===
        DeliveryState.Delivered,
    );
    const delivery = store.tracking.deliveries()[0];
    assert(delivery !== undefined);
    at += 300001;
    service.tick();
    await until(
      () => (store.tracking.inbox.get(delivery.id)?.nextCheckAt ?? 0) > at,
    );
    assert.equal(
      store.tracking.inbox.get(delivery.id)?.acknowledgedAt,
      undefined,
    );
    received = true;
    at += 300001;
    service.tick();
    await until(
      () => store.tracking.inbox.get(delivery.id)?.acknowledgedAt !== undefined,
    );
    assert.equal(
      store.tracking.action(delivery.actionId).progress.state,
      ActionState.Open,
    );
    const receipts = () =>
      store
        .eventsSince(0)
        .filter((event) => event.kind === "message_acknowledged").length;
    assert.equal(receipts(), 1);
    at += 300001;
    service.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(receipts(), 1);
  } finally {
    await service.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
