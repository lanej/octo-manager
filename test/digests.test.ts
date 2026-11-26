import { DatabaseSync } from "node:sqlite";
import { migrateDigestMembership } from "../src/notifications/schema.js";
import { test, expect, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/coordinator/store.js";
import { TrackingService } from "../src/tracking/service.js";
import { defaultTrackingConfig } from "../src/tracking/config.js";
import { SubmissionState } from "../src/submissions/contracts.js";
import { DigestService } from "../src/notifications/service.js";
import { DigestState } from "../src/notifications/types.js";
import type { AgentRef } from "../src/tracking/types.js";
import {
  DeliveryError,
  type QueueConnection,
  type QueuedMessage,
} from "../src/agents/codex.js";
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
  archived = false;
  inspections = 0;
  onCancel: (() => void) | undefined;
  onInspect: (() => void) | undefined;
  prepare(): Promise<{ busy: boolean }> {
    return Promise.resolve({ busy: false });
  }
  queued(): Promise<QueuedMessage[]> {
    this.inspections++;
    this.onInspect?.();
    if (this.archived)
      return Promise.reject(
        new DeliveryError(
          "Codex thread/queue/list rejected (RPC -32600): session synthetic-agent is archived.",
          false,
          true,
          true,
        ),
      );
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
      {
        connect,
        intervalMs: 1000,
        inputRevision: () =>
          JSON.stringify([store.inputRevision(), config.endpoints]),
      },
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
        detail: label,
        notificationRevision: 1,
      });
      store.submissions.notify(value, actor.id);
      const message = store.submissions.notices().at(-1);
      if (message === undefined) throw new Error("Missing fixture notice");
      return { id: message.id, submissionId: value.id };
    },
    async flush() {
      now += 6000;
      await service.flush();
    },
    async advance(milliseconds: number) {
      now += milliseconds;
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
        {
          connect,
          intervalMs: 1000,
          inputRevision: () =>
            JSON.stringify([store.inputRevision(), config.endpoints]),
        },
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
    const frozen = f.store.digests.version(value.id, value.revision);
    await f.reopen();
    expect(f.store.digests.delivery(frozen.dispatchId.slice(0, 8))).toEqual(
      frozen,
    );
    expect(
      f.store.digests.delivery(frozen.dispatchId.replaceAll("-", "")),
    ).toEqual(frozen);
    expect(f.store.digests.delivery(frozen.dispatchId)).toEqual(frozen);
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
test("idle queue recipients are not inspected, while new unread work and cleanup still run", async () => {
  const f = await fixture();
  try {
    f.queue.inspectFailure = true;
    for (let i = 0; i < 20; i++) await f.flush();
    expect(f.queue.inspections).toBe(0);
    expect(f.store.eventsSince(0)).toEqual([]);
    f.notice("A");
    await f.flush();
    expect(f.queue.inspections).toBe(1);
    expect(f.store.digests.active(f.actor.id)?.state).toBe(
      DigestState.Unavailable,
    );
    f.queue.inspectFailure = false;
    await f.flush();
    const active = f.store.digests.active(f.actor.id);
    if (active === undefined) throw new Error("No active digest");
    f.service.acknowledge(active.id, active.revision, f.actor.id);
    await f.flush();
    expect(f.queue.slots).toHaveLength(0);
    const inspections = f.queue.inspections;
    await f.flush();
    await f.reopen();
    await f.flush();
    expect(f.queue.inspections).toBe(inspections);
  } finally {
    await f.close();
  }
});
test("unchanged inspection failures back off without repeating events, then recover", async () => {
  const f = await fixture();
  try {
    const notice = f.notice("A");
    f.queue.inspectFailure = true;
    await f.advance(0);
    const active = f.store.digests.active(f.actor.id);
    if (active === undefined) throw new Error("No active digest");
    await f.advance(4999);
    expect(f.queue.inspections).toBe(1);
    await f.advance(1);
    expect(f.queue.inspections).toBe(2);
    await f.advance(9999);
    expect(f.queue.inspections).toBe(2);
    await f.advance(1);
    expect(f.queue.inspections).toBe(3);
    const failures = f.store.digests
      .events(active.id)
      .filter((event) => event.kind === "digest_uncertain");
    expect(failures).toHaveLength(1);
    expect(
      f.store.eventsSince(0).find((event) => event.kind === "digest_uncertain")
        ?.detail,
    ).toContain("Queue coverage incomplete");
    expect(
      f.store.tracking.inbox.get(notice.id)?.acknowledgedAt,
    ).toBeUndefined();
    f.queue.inspectFailure = false;
    await f.advance(20000);
    expect(f.queue.operations).toEqual(["add"]);
    expect(f.store.digests.get(active.id).state).toBe(DigestState.Queued);
    expect(f.store.digests.get(active.id).error).toBeUndefined();
  } finally {
    await f.close();
  }
});
test("archived legacy cleanup keeps its bounded retry and warning identity across restart", async () => {
  const f = await fixture();
  try {
    const notice = f.notice("Legacy");
    const message = f.store.tracking.inbox.get(notice.id);
    if (message === undefined) throw new Error("Missing fixture message");
    f.store.tracking.acknowledgeMessage(notice.id, f.actor.id);
    f.queue.slots.push({
      queueId: "legacy",
      clientId: notice.id,
      body: message.body,
    });
    f.queue.archived = true;
    await f.advance(0);
    expect(f.queue.inspections).toBe(1);
    expect(f.store.digests.active(f.actor.id)).toBeUndefined();
    const retry = f.store.digests.archivedInspection(f.actor.id);
    expect(retry?.at).toBe(901000);
    expect(retry?.signature).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(retry)).not.toContain("Legacy");
    await f.reopen();
    await f.advance(899999);
    expect(f.queue.inspections).toBe(1);
    expect(f.queue.slots).toHaveLength(1);
    expect(
      f.store
        .eventsSince(0)
        .filter((event) => event.kind === "queue_inspection_unavailable"),
    ).toHaveLength(1);
    f.queue.archived = false;
    await f.advance(1);
    expect(f.queue.inspections).toBe(2);
    expect(f.queue.operations).toContain("cancel");
    expect(f.queue.slots).toHaveLength(0);
    expect(f.store.digests.archivedInspection(f.actor.id)).toBeUndefined();
    expect(
      f.store
        .eventsSince(0)
        .filter((event) => event.kind === "queue_inspection_recovered"),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});
test("archived active digests retain unconfirmed members and changed routes bypass persisted retry", async () => {
  const f = await fixture();
  try {
    const notice = f.notice("Unread");
    f.queue.archived = true;
    await f.advance(0);
    await f.advance(1);
    const active = f.store.digests.active(f.actor.id);
    if (active === undefined) throw new Error("Missing active digest");
    expect(active.state).toBe(DigestState.Unavailable);
    expect(
      f.store.tracking.inbox.get(notice.id)?.acknowledgedAt,
    ).toBeUndefined();
    const inspections = f.queue.inspections;
    await f.reopen();
    await f.advance(60000);
    expect(f.queue.inspections).toBe(inspections);
    expect(f.store.digests.get(active.id).state).toBe(DigestState.Unavailable);
    f.config.endpoints["local"] = {
      delivery: "queue",
      socket: "/new/queue.sock",
    };
    await f.advance(0);
    // The old route still owns unknown queue state and must be reconciled before another queue can be used.
    expect(f.queue.inspections).toBe(inspections + 1);
    expect(f.queues.get("/new/queue.sock")).toBeUndefined();
    expect(
      f.store.tracking.inbox.get(notice.id)?.acknowledgedAt,
    ).toBeUndefined();
    f.queue.archived = false;
    await f.advance(900000);
    expect(f.store.digests.archivedInspection(f.actor.id)).toBeUndefined();
    expect(
      f.store.tracking.inbox.get(notice.id)?.acknowledgedAt,
    ).toBeUndefined();
  } finally {
    await f.close();
  }
});
test("an archived rejection cannot back off a route changed during inspection", async () => {
  const f = await fixture();
  try {
    f.notice("Unread");
    f.queue.archived = true;
    await f.advance(0);
    await f.advance(1);
    const before = f.queue.inspections;
    f.queue.onInspect = () => {
      f.queue.onInspect = undefined;
      f.config.endpoints["local"] = {
        delivery: "queue",
        socket: "/changed-during-inspection.sock",
      };
    };
    await f.advance(900000);
    expect(f.queue.inspections).toBe(before + 1);
    await f.advance(0);
    expect(f.queue.inspections).toBe(before + 2);
    expect(f.queues.get("/changed-during-inspection.sock")).toBeUndefined();
  } finally {
    await f.close();
  }
});
test("persisted archived inspection records reject unexpected fields", async () => {
  const f = await fixture();
  const db = new DatabaseSync(join(f.directory, "jobs.sqlite"));
  try {
    const notice = f.notice("Legacy");
    f.store.tracking.acknowledgeMessage(notice.id, f.actor.id);
    f.queue.archived = true;
    await f.advance(0);
    db.prepare(
      "UPDATE settings SET value=json_set(value,'$.unknown',1) WHERE key=?",
    ).run(`digest-archive-check:${f.actor.id}`);
    expect(() => f.store.digests.archivedInspection(f.actor.id)).toThrow(
      "Invalid archived queue inspection",
    );
  } finally {
    db.close();
    await f.close();
  }
});
test("standalone acknowledged and superseded legacy queue entries still receive cleanup", async () => {
  for (const kind of ["acknowledged", "superseded"]) {
    const f = await fixture();
    try {
      const notice = f.notice("Legacy"),
        message = f.store.tracking.inbox.get(notice.id);
      if (message === undefined) throw new Error("No notice");
      f.queue.slots.push({
        queueId: "legacy",
        clientId: notice.id,
        body: message.body,
      });
      if (kind === "acknowledged")
        f.store.tracking.acknowledgeMessage(notice.id, f.actor.id);
      else f.store.submissions.invalidateNotices(notice.submissionId);
      await f.flush();
      expect(f.queue.operations).toEqual(["cancel"]);
      expect(f.queue.slots).toHaveLength(0);
      expect(f.store.digests.active(f.actor.id)).toBeUndefined();
      const inspections = f.queue.inspections;
      await f.flush();
      expect(f.queue.inspections).toBe(inspections);
    } finally {
      await f.close();
    }
  }
});
test("idle legacy cleanup reinspects late admission without polling unused recipients", async () => {
  const f = await fixture();
  try {
    const notice = f.notice("Legacy"),
      message = f.store.tracking.inbox.get(notice.id);
    if (message === undefined) throw new Error("No notice");
    f.store.tracking.acknowledgeMessage(notice.id, f.actor.id);
    await f.advance(0);
    expect(f.queue.inspections).toBe(1);
    f.queue.slots.push({
      queueId: "late-legacy",
      clientId: notice.id,
      body: message.body,
    });
    await f.advance(59999);
    expect(f.queue.inspections).toBe(1);
    await f.advance(1);
    expect(f.queue.operations).toEqual(["cancel"]);
    expect(f.queue.slots).toHaveLength(0);
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
test("failed-run prose and links stay out of automatic digest rendering", async () => {
  const f = await fixture();
  try {
    f.notice(
      "macOS failed\n> Error: build failed\n[Failed run](https://github.com/owner/repo/actions/runs/123/job/456)\nAction: abcdef12",
    );
    await f.flush();
    expect(f.queue.slots[0]?.body).not.toContain(
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
test("consumed legacy notification reconciles before the first digest admission after restart", async () => {
  const f = await fixture();
  try {
    const a = f.notice("Legacy A"),
      b = f.notice("New B"),
      message = f.store.tracking.inbox.get(a.id);
    if (message === undefined) throw new Error("Missing notice");
    f.queue.slots.push({
      queueId: "legacy",
      clientId: a.id,
      body: message.body,
    });
    f.queue.cancelMode = "consume";
    await f.flush();
    expect(f.queue.operations).toEqual(["cancel"]);
    await f.reopen();
    await f.flush();
    const value = f.store.digests.active(f.actor.id);
    if (value === undefined) throw new Error("No digest");
    expect(f.store.tracking.inbox.get(a.id)?.acknowledgedAt).toBeDefined();
    expect(f.store.tracking.inbox.get(b.id)?.acknowledgedAt).toBeUndefined();
    expect(
      f.store.digests.version(value.id, value.revision).messageIds,
    ).toEqual([b.id]);
    expect(f.queue.operations).toEqual(["cancel", "add"]);
    expect(
      f.store.digests
        .events(value.id)
        .some((event) => event.kind === "queue_cancel_reconciled"),
    ).toBe(true);
  } finally {
    await f.close();
  }
});
test("legacy withdrawal stays uncertain without positive receipt and recovers from explicit canonical receipt", async () => {
  const f = await fixture();
  try {
    const a = f.notice("Legacy A");
    f.notice("New B");
    const message = f.store.tracking.inbox.get(a.id);
    if (message === undefined) throw new Error("Missing notice");
    f.queue.slots.push({
      queueId: "legacy",
      clientId: a.id,
      body: message.body,
    });
    f.queue.cancelMode = "lose_after";
    await f.flush();
    f.queue.coverage = false;
    await f.flush();
    expect(f.queue.operations).toEqual(["cancel"]);
    expect(f.store.tracking.inbox.get(a.id)?.acknowledgedAt).toBeUndefined();
    f.store.tracking.acknowledgeMessage(a.id, f.actor.id);
    await f.reopen();
    await f.flush();
    expect(f.queue.operations).toEqual(["cancel", "add"]);
  } finally {
    await f.close();
  }
});
test("digest recovery selects event kinds without losing chronology or full history", async () => {
  const f = await fixture();
  try {
    f.notice("Retained finding");
    await f.flush();
    const value = f.store.digests.active(f.actor.id);
    if (value === undefined) throw new Error("No digest");
    f.store.digests.event(f.actor.id, value.id, "queue_cancel_started", {
      queueId: "old",
    });
    f.store.digests.event(
      f.actor.id,
      value.id,
      "queue_inspection_unavailable",
      { reason: "offline" },
    );
    f.store.digests.event(f.actor.id, value.id, "queue_cancel_confirmed", {
      queueId: "old",
    });
    const kinds = ["queue_cancel_started", "queue_cancel_confirmed"];
    const all = f.store.digests.events(value.id);
    expect(f.store.digests.events(value.id, kinds)).toEqual(
      all.filter((event) => kinds.includes(event.kind)),
    );
    expect(
      f.store.digests.events(value.id, kinds).map((event) => event.kind),
    ).toEqual(kinds);
    expect(f.store.digests.events(value.id, [])).toEqual([]);
    expect(f.store.digests.events(value.id, ["absent"])).toEqual([]);
    expect(f.store.digests.hasEvent(value.id, "queue_enqueue_started")).toBe(
      true,
    );
    expect(f.store.digests.hasEvent(value.id, "absent")).toBe(false);
    expect(
      f.store.digests.hasEvent("other-digest", "queue_enqueue_started"),
    ).toBe(false);
    expect(f.store.digests.events(value.id, undefined, 2)).toEqual(
      all.slice(-2),
    );
    expect(f.store.digests.events(value.id, kinds, 1)).toEqual(
      all.filter((event) => kinds.includes(event.kind)).slice(-1),
    );
    expect(f.store.digests.events(value.id, undefined, 0)).toEqual([]);
    expect(f.store.digests.events(value.id)).toEqual(all);
  } finally {
    await f.close();
  }
});

test("membership projection preserves every revision and filters before inbox pagination without hiding other recipients", async () => {
  const f = await fixture();
  try {
    const ids = Array.from(
      { length: 205 },
      (_, index) => f.notice(`Notice ${String(index)}`).id,
    );
    let current = f.store.digests.create(
      f.actor.id,
      { kind: "codex_queue", socket: "/fixture/queue.sock" },
      () => ({ body: "First revision", messageIds: ids.slice(0, 20) }),
    );
    for (let index = 20; index < 201; index += 20)
      current = f.store.digests.revise(current, () => ({
        body: `Revision ${String(index)}`,
        messageIds: ids.slice(index, Math.min(index + 20, 201)),
      }));
    const last = ids.at(-1);
    if (last === undefined) throw new Error("Missing message");
    f.store.tracking.acknowledgeMessage(last, f.actor.id);
    const other = f.store.tracking.registerAgent({
      ...target,
      sessionId: "other-recipient",
    });
    f.store.digests.create(
      other.id,
      { kind: "codex_queue", socket: "/fixture/queue.sock" },
      () => ({ body: "Other recipient", messageIds: [last] }),
    );
    const page = f.store.tracking.inbox.uncovered(f.actor.id);
    expect(page.messages.map((value) => value.id)).toEqual(ids.slice(201));
    expect(page.messages.at(-1)?.acknowledgedAt).toBeDefined();
    expect(page.hasMore).toBe(false);
    expect(f.store.digests.coveredMessageIds(f.actor.id)).toEqual(
      new Set(ids.slice(0, 201)),
    );
    expect(
      f.store.tracking.inbox.list(f.actor.id, 0, true).messages,
    ).toHaveLength(200);
    const versions = f.store.digests.revisions(current.id);
    const db = new DatabaseSync(join(f.directory, "jobs.sqlite"));
    try {
      db.exec(
        "DROP TRIGGER index_digest_members; DROP TABLE agent_digest_members",
      );
      migrateDigestMembership(db);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
    } finally {
      db.close();
    }
    expect(f.store.digests.revisions(current.id)).toEqual(versions);
    expect(
      f.store.tracking.inbox
        .uncovered(f.actor.id)
        .messages.map((value) => value.id),
    ).toEqual(ids.slice(201));
    expect(f.store.digests.coveredMessageIds(f.actor.id)).toHaveProperty(
      "size",
      201,
    );
  } finally {
    await f.close();
  }
});

test("membership migration rolls back invalid history and rejects malformed or duplicate new memberships", async () => {
  const f = await fixture();
  const db = new DatabaseSync(join(f.directory, "jobs.sqlite"));
  try {
    const message = f.notice("Membership fixture");
    const value = f.store.digests.create(
      f.actor.id,
      { kind: "codex_queue", socket: "/fixture/queue.sock" },
      () => ({ body: "Immutable fixture", messageIds: [message.id] }),
    );
    const version = f.store.digests.version(value.id, 1);
    expect(
      f.store.digests.get(value.id.replaceAll("-", "").slice(0, 8)),
    ).toEqual(value);
    expect(() => f.store.digests.get("00000000")).toThrow("Digest not found");
    expect(() => f.store.digests.version(value.id, 99)).toThrow(
      "Digest revision not found",
    );

    db.exec(
      "DROP TRIGGER index_digest_members; DROP TABLE agent_digest_members",
    );
    db.prepare("INSERT INTO agent_digest_revisions VALUES(?,?,?)").run(
      value.id,
      2,
      JSON.stringify({ ...version, revision: 2, body: 0 }),
    );
    expect(() => {
      migrateDigestMembership(db);
    }).toThrow("Invalid digest revision");
    expect(
      db
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE name='agent_digest_members'",
        )
        .get(),
    ).toBeUndefined();
    db.prepare(
      "DELETE FROM agent_digest_revisions WHERE digest_id=? AND revision=2",
    ).run(value.id);
    migrateDigestMembership(db);
    for (const messageIds of [
      null,
      {},
      [],
      [1],
      [""],
      [message.id, message.id],
      Array.from({ length: 21 }, (_, index) => String(index)),
    ]) {
      expect(() =>
        db
          .prepare("INSERT INTO agent_digest_revisions VALUES(?,?,?)")
          .run(
            value.id,
            2,
            JSON.stringify({ ...version, revision: 2, messageIds }),
          ),
      ).toThrow();
    }
    expect(f.store.digests.coveredMessageIds(f.actor.id)).toEqual(
      new Set([message.id]),
    );
    expect(f.store.digests.revisions(value.id)).toHaveLength(1);
  } finally {
    db.close();
    await f.close();
  }
});

test("cleanup candidate reads follow persisted terminal cleanup state without removing audit history", async () => {
  const f = await fixture();
  try {
    const message = f.notice("Cleanup fixture");
    const value = f.store.digests.create(
      f.actor.id,
      { kind: "codex_queue", socket: "/fixture/queue.sock" },
      () => ({ body: "Fixture", messageIds: [message.id] }),
    );
    expect(f.store.digests.cleanup(f.actor.id)).toHaveLength(0);
    const received = f.store.digests.save(
      { ...value, state: DigestState.Received },
      "fixture_received",
    );
    expect(f.store.digests.cleanup(f.actor.id)).toEqual([received]);
    expect(f.store.digests.active(f.actor.id)).toBeUndefined();
    f.store.digests.save(
      { ...received, cleanupPending: false },
      "fixture_cleaned",
    );
    expect(f.store.digests.cleanup(f.actor.id)).toHaveLength(0);
    expect(f.store.digests.list(f.actor.id)).toHaveLength(1);
    const unavailable = f.store.digests.save(
      { ...received, state: DigestState.Unavailable },
      "fixture_unavailable",
    );
    expect(f.store.digests.cleanup(f.actor.id)).toHaveLength(0);
    expect(f.store.digests.active(f.actor.id)).toEqual(unavailable);
  } finally {
    await f.close();
  }
});

test("queue probes use exact owned revisions and unresolved withdrawals without rereading settled history", async () => {
  const f = await fixture();
  try {
    const route = {
      kind: "codex_queue" as const,
      socket: "/fixture/queue.sock",
    };
    for (let index = 0; index < 120; index++) {
      const value = f.store.digests.create(f.actor.id, route, () => ({
        body: `Historical ${String(index)}`,
        messageIds: [`historical-${String(index)}`],
      }));
      f.store.digests.save(
        { ...value, state: DigestState.Cancelled, cleanupPending: false },
        "fixture_terminal",
      );
      f.store.digests.event(f.actor.id, value.id, "queue_cancel_started", {
        queueId: `old-${String(index)}`,
        clientId: `old-client-${String(index)}`,
      });
      f.store.digests.event(f.actor.id, value.id, "queue_cancel_confirmed", {
        queueId: `old-${String(index)}`,
      });
    }
    const legacy = f.notice("Consumed legacy"),
      legacyMessage = f.store.tracking.inbox.get(legacy.id);
    if (legacyMessage === undefined) throw new Error("Missing legacy message");
    f.store.tracking.acknowledgeMessage(legacy.id, f.actor.id);
    const uncertain = f.store.digests.create(f.actor.id, route, () => ({
      body: "Legacy collapse",
      messageIds: [legacy.id],
    }));
    f.store.digests.save(
      { ...uncertain, state: DigestState.Cancelled, cleanupPending: false },
      "fixture_terminal",
    );
    f.store.digests.event(f.actor.id, uncertain.id, "queue_cancel_started", {
      queueId: "consumed-legacy",
      clientId: legacy.id,
    });
    expect(
      f.store.digests
        .withdrawalDigests(f.actor.id, route.socket)
        .map((value) => value.id),
    ).toEqual([uncertain.id]);
    f.notice("Current work");
    await f.flush();
    expect(f.store.digests.withdrawalDigests(f.actor.id, route.socket)).toEqual(
      [],
    );
    expect(f.store.digests.events(uncertain.id).at(-1)?.kind).toBe(
      "queue_cancel_reconciled",
    );
    const current = f.store.digests.active(f.actor.id);
    if (current === undefined) throw new Error("Missing active digest");
    const owned = f.store.digests.version(current.id, current.revision);
    const otherAgent = f.store.tracking.registerAgent({
      harness: "codex",
      endpoint: "direct",
      sessionId: "foreign-queue-owner",
    });
    const foreign = f.store.digests.create(otherAgent.id, route, () => ({
      body: "Foreign digest",
      messageIds: ["foreign-message"],
    }));
    f.store.digests.save(
      { ...foreign, state: DigestState.Cancelled, cleanupPending: false },
      "fixture_terminal",
    );
    const foreignRevision = f.store.digests.version(
      foreign.id,
      foreign.revision,
    );
    const foreignSlots = [
      {
        queueId: "foreign-owner",
        clientId: foreignRevision.dispatchId,
        body: foreignRevision.body,
      },
      {
        queueId: "same-prefix",
        clientId: owned.dispatchId.slice(0, 8) + "-foreign-suffix",
        body: owned.body,
      },
      ...Array.from({ length: 30 }, (_, index) => ({
        queueId: `foreign-${String(index)}`,
        clientId: `foreign-client-${String(index)}`,
        body: "Unowned queue content",
      })),
    ];
    f.queue.slots.push(...foreignSlots);
    const versions = spyOn(f.store.digests, "revisions"),
      events = spyOn(f.store.digests, "events"),
      list = spyOn(f.store.digests, "list"),
      points = spyOn(f.store.digests, "queuedRevision");
    try {
      const expectedPointReads = f.queue.slots.length;
      await f.flush();
      expect(
        list.mock.calls.filter(([agentId]) => agentId === f.actor.id),
      ).toEqual([]);
      expect(versions.mock.calls.length).toBeLessThanOrEqual(2);
      expect(events.mock.calls.length).toBeLessThanOrEqual(2);
      expect(points).toHaveBeenCalledTimes(expectedPointReads);
      for (const item of foreignSlots)
        expect(f.queue.slots).toContainEqual(item);
      expect(
        f.store.tracking.inbox.get(legacy.id)?.acknowledgedAt,
      ).toBeDefined();
    } finally {
      versions.mockRestore();
      events.mockRestore();
      list.mockRestore();
      points.mockRestore();
    }
  } finally {
    await f.close();
  }
});

test("settled withdrawals with malformed identities still fail closed during queue recovery", async () => {
  const f = await fixture();
  try {
    const route = {
      kind: "codex_queue" as const,
      socket: "/fixture/queue.sock",
    };
    const history = f.store.digests.create(f.actor.id, route, () => ({
      body: "Malformed withdrawal history",
      messageIds: ["historical-message"],
    }));
    f.store.digests.save(
      { ...history, state: DigestState.Cancelled, cleanupPending: false },
      "fixture_terminal",
    );
    f.store.digests.event(f.actor.id, history.id, "queue_cancel_started", {
      queueId: "missing-client",
    });
    f.store.digests.event(f.actor.id, history.id, "queue_cancel_confirmed", {
      queueId: "missing-client",
    });
    expect(
      f.store.digests
        .withdrawalDigests(f.actor.id, route.socket)
        .map((value) => value.id),
    ).toEqual([history.id]);
    f.notice("Unrelated new work");
    await f.flush();
    expect(f.store.digests.active(f.actor.id)?.error).toBe(
      "Invalid withdrawal identity",
    );
    expect(f.queue.operations).toEqual([]);
  } finally {
    await f.close();
  }
});

test("terminal withdrawals with canonical receipts need no conversation history", async () => {
  const f = await fixture();
  const history = spyOn(f.queue, "received").mockRejectedValue(
    new Error("History must not be needed for a canonical receipt"),
  );
  try {
    const notice = f.notice("Already received");
    const digest = f.store.digests.create(
      f.actor.id,
      { kind: "codex_queue", socket: "/fixture/queue.sock" },
      () => ({ body: "Canonically received digest", messageIds: [notice.id] }),
    );
    const version = f.store.digests.version(digest.id, 1);
    f.service.acknowledge(digest.id, 1, f.actor.id);
    f.store.digests.event(f.actor.id, digest.id, "queue_cancel_started", {
      queueId: "uncertain-old-slot",
      clientId: version.dispatchId,
    });
    f.notice("New work");
    await f.flush();
    expect(history).not.toHaveBeenCalled();
    expect(f.store.digests.get(digest.id).cleanupPending).toBe(false);
    expect(
      f.store.digests.receipts(digest.id).map((value) => value.revision),
    ).toEqual([1]);
    expect(f.queue.operations).toEqual(["add"]);
    expect(f.queue.slots).toHaveLength(1);
  } finally {
    history.mockRestore();
    await f.close();
  }
});

test("terminal cleanup reads only unresolved withdrawal bodies and requires positive history before replacement", async () => {
  const f = await fixture();
  const history = spyOn(f.queue, "received");
  try {
    const a = f.notice("Received A"),
      b = f.notice("Unconfirmed B");
    let digest = f.store.digests.create(
      f.actor.id,
      { kind: "codex_queue", socket: "/fixture/queue.sock" },
      () => ({ body: "Canonically received A", messageIds: [a.id] }),
    );
    digest = f.store.digests.revise(digest, () => ({
      body: "Unconfirmed withdrawal B",
      messageIds: [b.id],
    }));
    digest = f.store.digests.revise(digest, () => ({
      body: "Unrelated retained revision",
      messageIds: [a.id],
    }));
    f.service.acknowledge(digest.id, 1, f.actor.id);
    for (const revision of [1, 2]) {
      const version = f.store.digests.version(digest.id, revision);
      f.store.digests.event(f.actor.id, digest.id, "queue_cancel_started", {
        queueId: `uncertain-slot-${String(revision)}`,
        clientId: version.dispatchId,
      });
    }
    f.notice("Replacement work");
    await f.flush();
    expect(history).toHaveBeenCalledTimes(1);
    expect(history.mock.calls[0]?.[1]).toEqual(["Unconfirmed withdrawal B"]);
    expect(f.store.digests.get(digest.id).cleanupPending).toBe(true);
    expect(f.store.tracking.inbox.get(b.id)?.acknowledgedAt).toBeUndefined();
    expect(f.store.digests.active(f.actor.id)?.error).toContain(
      "withdrawal is unconfirmed",
    );
    expect(f.queue.operations).toEqual([]);
    f.queue.history.push("Unconfirmed withdrawal B");
    await f.flush();
    expect(history).toHaveBeenCalledTimes(2);
    expect(history.mock.calls[1]?.[1]).toEqual(["Unconfirmed withdrawal B"]);
    expect(f.store.digests.get(digest.id).cleanupPending).toBe(false);
    expect(f.store.tracking.inbox.get(b.id)?.acknowledgedAt).toBeDefined();
    expect(
      f.store.digests.receipts(digest.id).map((value) => value.revision),
    ).toEqual([1, 2]);
    expect(f.queue.operations).toEqual(["add"]);
  } finally {
    history.mockRestore();
    await f.close();
  }
});
