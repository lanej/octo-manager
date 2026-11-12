import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.js";
import { TrackingService } from "../src/tracking/service.js";
import { defaultTrackingConfig } from "../src/tracking/config.js";
import { SubmissionState } from "../src/submissions/contracts.js";
import { DigestService } from "../src/notifications/service.js";
import { DigestState } from "../src/notifications/types.js";
import type { AgentRef } from "../src/tracking/types.js";
import type { QueueConnection, QueuedMessage } from "../src/agents/codex.js";
const target = {
  harness: "codex",
  endpoint: "local",
  sessionId: "synthetic-agent",
  label: "/fixture/project",
};
class Queue implements QueueConnection {
  slots: QueuedMessage[] = [];
  history: string[] = [];
  operations: string[] = [];
  serial = 0;
  loseAdd = false;
  cancelMode: "normal" | "consume" | "lose_before" | "lose_after" = "normal";
  coverage = true;
  inspectFailure = false;
  onCancel: (() => void) | undefined;
  prepare(): Promise<{ busy: boolean }> {
    return Promise.resolve({ busy: false });
  }
  queued(): Promise<QueuedMessage[]> {
    return this.inspectFailure
      ? Promise.reject(new Error("Queue coverage incomplete"))
      : Promise.resolve(structuredClone(this.slots));
  }
  enqueueQueued(
    _agent: AgentRef,
    clientId: string,
    body: string,
  ): Promise<QueuedMessage> {
    this.operations.push("add");
    const item = { queueId: `queue-${String(++this.serial)}`, clientId, body };
    this.slots.push(item);
    if (this.loseAdd) {
      this.loseAdd = false;
      return Promise.reject(new Error("Lost add response"));
    }
    return Promise.resolve(item);
  }
  cancelQueued(_agent: AgentRef, id: string): Promise<boolean> {
    this.operations.push("cancel");
    this.onCancel?.();
    const item = this.slots.find((item) => item.queueId === id),
      mode = this.cancelMode;
    this.cancelMode = "normal";
    if (mode === "lose_before")
      return Promise.reject(
        new Error("Lost withdrawal response before effect"),
      );
    this.slots = this.slots.filter((item) => item.queueId !== id);
    if (mode === "consume") {
      if (item?.body !== undefined) this.history.push(item.body);
      return Promise.resolve(false);
    }
    if (mode === "lose_after")
      return Promise.reject(new Error("Lost withdrawal response after effect"));
    return Promise.resolve(item !== undefined);
  }
  received(
    _agent: AgentRef,
    bodies: string[],
  ): Promise<{ bodies: string[]; complete: boolean }> {
    return Promise.resolve({
      bodies: this.history.filter((body) => bodies.includes(body)),
      complete: this.coverage,
    });
  }
  close(): void {}
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "octo-digest-"));
  let now = 1000;
  const config = defaultTrackingConfig();
  config.endpoints["local"] = {
    delivery: "queue",
    socket: "/fixture/queue.sock",
  };
  const queues = new Map<string, Queue>();
  const connect = (_agent: AgentRef, socket: string) => {
    let queue = queues.get(socket);
    if (queue === undefined) {
      queue = new Queue();
      queues.set(socket, queue);
    }
    return queue;
  };
  let store = new Store(directory, () => now),
    tracking = new TrackingService(store.tracking, config, () => now, {
      read: () => Promise.reject(new Error("No GitHub in fixture")),
    }),
    service = new DigestService(
      store.digests,
      tracking,
      store.submissions,
      directory,
      () => now,
      { connect },
    );
  const actor = tracking.registerAgent(target),
    queue = connect(actor, "/fixture/queue.sock");
  let serial = 0;
  return {
    directory,
    config,
    actor,
    queue,
    queues,
    get store() {
      return store;
    },
    get service() {
      return service;
    },
    notice(label: string) {
      const value = store.submissions.request({
        requestId: `notice-${String(++serial)}`,
        repository: "owner/repo",
        headRef: "feature",
        headSha: "a".repeat(40),
        baseRef: "main",
        purpose: "Synthetic notification fixture",
        validation: [],
        draft: false,
        owner: { ...target, harness: "codex" },
      });
      store.submissions.save({
        ...value,
        state: SubmissionState.NeedsInput,
        detail: "Synthetic fixture",
        notificationRevision: 1,
      });
      store.submissions.notify(
        value,
        actor.id,
        `[PR #1](https://github.com/owner/repo/pull/1) · ${label}`,
      );
      const message = store.submissions.notices().at(-1);
      if (message === undefined) throw new Error("Missing fixture notice");
      return { id: message.id, submissionId: value.id };
    },
    async flush() {
      now += 6000;
      await service.flush();
    },
    async reopen() {
      await service.close();
      await tracking.close();
      store.close();
      store = new Store(directory, () => now);
      tracking = new TrackingService(store.tracking, config, () => now, {
        read: () => Promise.reject(new Error("No GitHub in fixture")),
      });
      service = new DigestService(
        store.digests,
        tracking,
        store.submissions,
        directory,
        () => now,
        { connect },
      );
    },
    async close() {
      await service.close();
      await tracking.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
test("one digest per agent, immutable revisions, and withdrawal occurs before replacement", async () => {
  const f = await fixture();
  try {
    const a = f.notice("First finding"),
      b = f.notice("Second finding");
    await f.flush();
    expect(f.queue.slots).toHaveLength(1);
    const initial = f.store.digests.active(f.actor.id);
    if (initial === undefined) throw new Error("No digest");
    const first = f.store.digests.version(initial.id, 1),
      firstQueue = f.queue.slots[0]?.queueId;
    expect(first.messageIds).toEqual([a.id, b.id]);
    const c = f.notice("Third finding");
    await f.flush();
    expect(f.queue.slots).toHaveLength(1);
    expect(f.queue.operations).toEqual(["add", "cancel", "add"]);
    expect(f.queue.slots[0]?.queueId).not.toBe(firstQueue);
    const next = f.store.digests.version(initial.id, 2);
    expect(next.dispatchId).not.toBe(first.dispatchId);
    expect(next.messageIds).toEqual([a.id, b.id, c.id]);
    expect(f.store.digests.version(initial.id, 1)).toEqual(first);
  } finally {
    await f.close();
  }
});
test("superseded entries are withdrawn without receipt or action resolution", async () => {
  const f = await fixture();
  try {
    const a = f.notice("Obsolete failure");
    await f.flush();
    const value = f.store.digests.active(f.actor.id);
    if (value === undefined) throw new Error("No digest");
    f.store.submissions.invalidateNotices(a.submissionId);
    await f.flush();
    expect(f.queue.slots).toHaveLength(0);
    expect(f.store.digests.get(value.id).state).toBe(DigestState.Cancelled);
    expect(f.store.tracking.inbox.get(a.id)?.acknowledgedAt).toBeUndefined();
    expect(f.store.digests.receipts(value.id)).toEqual([]);
  } finally {
    await f.close();
  }
});
test("old-revision receipt covers only its immutable members and remaining items advance", async () => {
  const f = await fixture();
  try {
    const a = f.notice("A");
    await f.flush();
    const value = f.store.digests.active(f.actor.id);
    if (value === undefined) throw new Error("No digest");
    const first = f.store.digests.version(value.id, 1);
    const b = f.notice("B");
    await f.flush();
    expect(() => f.service.acknowledge(value.id, 1, "another-agent")).toThrow(
      "another agent",
    );
    f.service.acknowledge(value.id, 1, f.actor.id, first.body);
    expect(f.store.tracking.inbox.get(a.id)?.acknowledgedAt).toBeDefined();
    expect(f.store.tracking.inbox.get(b.id)?.acknowledgedAt).toBeUndefined();
    await f.flush();
    const next = f.store.digests.active(f.actor.id);
    if (next === undefined) throw new Error("No next digest");
    expect(next.id).not.toBe(value.id);
    expect(f.store.digests.version(next.id, 1).messageIds).toEqual([b.id]);
    expect(f.queue.slots).toHaveLength(1);
    expect(f.store.digests.receipts(value.id)).toHaveLength(1);
  } finally {
    await f.close();
  }
});
test("consumed-during-withdrawal reconciles old receipt before adding new information", async () => {
  const f = await fixture();
  try {
    const a = f.notice("A");
    await f.flush();
    const value = f.store.digests.active(f.actor.id);
    if (value === undefined) throw new Error("No digest");
    const b = f.notice("B");
    f.queue.cancelMode = "consume";
    await f.flush();
    expect(f.store.digests.get(value.id).state).toBe(DigestState.Uncertain);
    expect(f.queue.operations).toEqual(["add", "cancel"]);
    await f.flush();
    expect(f.store.digests.get(value.id).state).toBe(DigestState.Received);
    expect(f.store.tracking.inbox.get(a.id)?.acknowledgedAt).toBeDefined();
    expect(f.store.tracking.inbox.get(b.id)?.acknowledgedAt).toBeUndefined();
    await f.flush();
    expect(f.queue.slots).toHaveLength(1);
    const next = f.store.digests.active(f.actor.id);
    if (next === undefined) throw new Error("No next digest");
    expect(f.store.digests.version(next.id, next.revision).messageIds).toEqual([
      b.id,
    ]);
  } finally {
    await f.close();
  }
});
test("response loss and restart reconcile an admitted digest without duplicating it", async () => {
  const f = await fixture();
  try {
    f.notice("A");
    f.queue.loseAdd = true;
    await f.flush();
    const value = f.store.digests.active(f.actor.id);
    if (value === undefined) throw new Error("No digest");
    expect(value.state).toBe(DigestState.Uncertain);
    await f.reopen();
    await f.flush();
    expect(f.queue.operations).toEqual(["add"]);
    expect(f.queue.slots).toHaveLength(1);
    expect(f.store.digests.get(value.id).state).toBe(DigestState.Queued);
  } finally {
    await f.close();
  }
});
test("uncertain withdrawal never adds a conflicting replacement", async () => {
  const f = await fixture();
  try {
    const a = f.notice("A");
    await f.flush();
    const value = f.store.digests.active(f.actor.id);
    if (value === undefined) throw new Error("No digest");
    f.notice("B");
    f.queue.cancelMode = "lose_after";
    await f.flush();
    await f.reopen();
    await f.flush();
    expect(f.queue.operations).toEqual(["add", "cancel"]);
    expect(f.queue.slots).toHaveLength(0);
    expect(f.store.digests.get(value.id).state).toBe(DigestState.Uncertain);
    f.service.acknowledge(value.id, 1, f.actor.id);
    expect(f.store.tracking.inbox.get(a.id)?.acknowledgedAt).toBeDefined();
    await f.flush();
    expect(f.queue.slots).toHaveLength(1);
  } finally {
    await f.close();
  }
});
test("retry of an unconfirmed withdrawal removes the old entry before replacement", async () => {
  const f = await fixture();
  try {
    f.notice("A");
    await f.flush();
    f.notice("B");
    f.queue.cancelMode = "lose_before";
    await f.flush();
    expect(f.queue.operations).toEqual(["add", "cancel"]);
    await f.reopen();
    await f.flush();
    expect(f.queue.operations).toEqual(["add", "cancel", "cancel", "add"]);
    expect(f.queue.slots).toHaveLength(1);
  } finally {
    await f.close();
  }
});
test("foreign and observed client-edited queue content is preserved", async () => {
  const f = await fixture();
  try {
    f.queue.slots.push({
      queueId: "foreign",
      clientId: "user-message",
      body: "User text",
    });
    f.notice("A");
    await f.flush();
    expect(f.queue.slots).toHaveLength(2);
    const own = f.queue.slots.find((value) => value.queueId !== "foreign");
    if (own === undefined) throw new Error("No own entry");
    own.body = "Manual edit";
    await f.flush();
    expect(f.queue.operations).toEqual(["add"]);
    expect(f.queue.slots.map((value) => value.body)).toContain("Manual edit");
    expect(f.queue.slots.map((value) => value.body)).toContain("User text");
  } finally {
    await f.close();
  }
});
test("bounded digests eventually deliver every remaining item", async () => {
  const f = await fixture();
  try {
    const notices = Array.from({ length: 25 }, (_, index) =>
      f.notice(`Finding ${String(index)}`),
    );
    await f.flush();
    const first = f.store.digests.active(f.actor.id);
    if (first === undefined) throw new Error("No digest");
    const version = f.store.digests.version(first.id, 1);
    expect(version.messageIds.length).toBeLessThanOrEqual(20);
    expect(Buffer.byteLength(version.body)).toBeLessThanOrEqual(6000);
    f.service.acknowledge(first.id, 1, f.actor.id);
    await f.flush();
    const next = f.store.digests.active(f.actor.id);
    if (next === undefined) throw new Error("No next digest");
    f.service.acknowledge(next.id, next.revision, f.actor.id);
    expect(
      notices.every(
        (notice) =>
          f.store.tracking.inbox.get(notice.id)?.acknowledgedAt !== undefined,
      ),
    ).toBe(true);
    await f.flush();
    expect(f.queue.slots).toHaveLength(0);
  } finally {
    await f.close();
  }
});
test("incomplete queue inspection fails closed", async () => {
  const f = await fixture();
  try {
    f.notice("A");
    f.queue.inspectFailure = true;
    await f.flush();
    expect(f.queue.operations).toEqual([]);
    expect(f.store.digests.active(f.actor.id)?.state).toBe(
      DigestState.Unavailable,
    );
  } finally {
    await f.close();
  }
});
test("transport changes withdraw from the pinned old socket before using the new one", async () => {
  const f = await fixture();
  try {
    f.notice("A");
    await f.flush();
    f.config.endpoints["local"] = {
      delivery: "queue",
      socket: "/fixture/new.sock",
    };
    await f.flush();
    expect(f.queue.slots).toHaveLength(0);
    await f.flush();
    await f.flush();
    expect(f.queues.get("/fixture/new.sock")?.slots).toHaveLength(1);
  } finally {
    await f.close();
  }
});
test("restart between confirmed withdrawal and replacement preserves the next revision", async () => {
  const f = await fixture();
  try {
    f.notice("A");
    await f.flush();
    const value = f.store.digests.active(f.actor.id);
    if (value === undefined) throw new Error("No digest");
    f.notice("B");
    f.queue.loseAdd = true;
    await f.flush();
    expect(f.queue.operations).toEqual(["add", "cancel", "add"]);
    await f.reopen();
    await f.flush();
    expect(f.queue.operations).toEqual(["add", "cancel", "add"]);
    expect(f.queue.slots).toHaveLength(1);
    expect(f.store.digests.get(value.id).revision).toBe(2);
    expect(f.store.digests.get(value.id).state).toBe(DigestState.Queued);
  } finally {
    await f.close();
  }
});
test("incomplete receipt history prevents replay of an absent admitted message", async () => {
  const f = await fixture();
  try {
    f.notice("A");
    await f.flush();
    f.queue.slots = [];
    f.queue.coverage = false;
    f.notice("B");
    await f.flush();
    expect(f.queue.operations).toEqual(["add"]);
    expect(f.store.digests.active(f.actor.id)?.state).toBe(
      DigestState.Uncertain,
    );
  } finally {
    await f.close();
  }
});
test("withdrawal rechecks applicability before rendering the replacement", async () => {
  const f = await fixture();
  try {
    const a = f.notice("A");
    await f.flush();
    const b = f.notice("B");
    f.queue.onCancel = () => {
      f.store.submissions.invalidateNotices(a.submissionId);
    };
    await f.flush();
    const value = f.store.digests.active(f.actor.id);
    if (value === undefined) throw new Error("No digest");
    expect(
      f.store.digests.version(value.id, value.revision).messageIds,
    ).toEqual([b.id]);
    expect(f.queue.operations).toEqual(["add", "cancel", "add"]);
  } finally {
    await f.close();
  }
});
test("consumption during terminal revision cleanup reconciles before a fresh digest", async () => {
  const f = await fixture();
  try {
    f.notice("A");
    await f.flush();
    const value = f.store.digests.active(f.actor.id);
    if (value === undefined) throw new Error("No digest");
    const b = f.notice("B");
    await f.flush();
    f.service.acknowledge(value.id, 1, f.actor.id);
    f.queue.cancelMode = "consume";
    await f.flush();
    await f.flush();
    expect(f.store.tracking.inbox.get(b.id)?.acknowledgedAt).toBeDefined();
    expect(f.queue.operations).toEqual(["add", "cancel", "add", "cancel"]);
    expect(f.queue.slots).toHaveLength(0);
  } finally {
    await f.close();
  }
});
test("failed-run evidence survives compact digest rendering", async () => {
  const f = await fixture();
  try {
    f.notice(
      "macOS failed\n> Error: build failed\n[Failed run](https://github.com/owner/repo/actions/runs/123/job/456)\nAction: abcdef12",
    );
    await f.flush();
    expect(f.queue.slots[0]?.body).toContain(
      "[Failed run](https://github.com/owner/repo/actions/runs/123/job/456)",
    );
  } finally {
    await f.close();
  }
});
test("batch receipt rolls back all member receipts on an invalid member", async () => {
  const f = await fixture();
  try {
    const a = f.notice("A"),
      value = f.store.digests.create(
        f.actor.id,
        { kind: "codex_queue", socket: "/fixture/queue.sock" },
        () => ({
          body: "Synthetic corrupt membership",
          messageIds: [a.id, "missing"],
        }),
      );
    expect(() => f.service.acknowledge(value.id, 1, f.actor.id)).toThrow();
    expect(f.store.tracking.inbox.get(a.id)?.acknowledgedAt).toBeUndefined();
    expect(f.store.digests.receipts(value.id)).toEqual([]);
  } finally {
    await f.close();
  }
});
test("terminal queue cleanup stays pinned after switching the agent to direct delivery", async () => {
  const f = await fixture();
  try {
    f.notice("A");
    await f.flush();
    const value = f.store.digests.active(f.actor.id);
    if (value === undefined) throw new Error("No digest");
    f.service.acknowledge(value.id, 1, f.actor.id);
    f.config.endpoints["local"] = { delivery: "turn" };
    expect(f.service.managed(f.actor.id)).toBe(true);
    await f.flush();
    expect(f.queue.slots).toHaveLength(0);
    expect(f.store.digests.get(value.id).cleanupPending).toBe(false);
    expect(f.service.managed(f.actor.id)).toBe(false);
  } finally {
    await f.close();
  }
});
test("terminal cleanup precedes dispatch on a new queue socket", async () => {
  const f = await fixture();
  try {
    f.notice("A");
    await f.flush();
    const value = f.store.digests.active(f.actor.id);
    if (value === undefined) throw new Error("No digest");
    f.service.acknowledge(value.id, 1, f.actor.id);
    f.notice("B");
    f.config.endpoints["local"] = {
      delivery: "queue",
      socket: "/fixture/new.sock",
    };
    await f.flush();
    expect(f.queue.slots).toHaveLength(0);
    expect(f.queues.has("/fixture/new.sock")).toBe(false);
    await f.flush();
    expect(f.queues.get("/fixture/new.sock")?.slots).toHaveLength(1);
  } finally {
    await f.close();
  }
});
test("receipt during a legacy withdrawal cannot orphan the previously observed digest slot", async () => {
  const f = await fixture();
  try {
    const a = f.notice("A");
    await f.flush();
    const value = f.store.digests.active(f.actor.id),
      message = f.store.tracking.inbox.get(a.id);
    if (value === undefined || message === undefined)
      throw new Error("Missing fixture");
    f.queue.slots.push({
      queueId: "legacy",
      clientId: a.id,
      body: message.body,
    });
    f.queue.onCancel = () => {
      f.service.acknowledge(value.id, 1, f.actor.id);
    };
    f.config.endpoints["local"] = { delivery: "turn" };
    await f.flush();
    expect(f.queue.slots).toHaveLength(0);
    expect(f.service.managed(f.actor.id)).toBe(false);
    expect(f.queue.operations).toEqual(["add", "cancel", "cancel"]);
  } finally {
    await f.close();
  }
});
