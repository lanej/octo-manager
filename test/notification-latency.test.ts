import { test, expect, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.js";
import { TrackingService } from "../src/tracking/service.js";
import { defaultTrackingConfig } from "../src/tracking/config.js";
import { DigestService } from "../src/notifications/service.js";
import { SubmissionState } from "../src/submissions/contracts.js";
import type { QueueConnection, QueuedMessage } from "../src/agents/codex.js";

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Recipient made no progress"));
        }, 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
class Queue implements QueueConnection {
  readonly started = gate();
  readonly enqueued = gate();
  readonly unblock = gate();
  slots: QueuedMessage[] = [];
  blocked = false;
  closed = false;
  preparations = 0;
  constructor(
    private entered: () => void,
    private exited: () => void,
  ) {}
  async prepare() {
    this.preparations++;
    this.entered();
    this.started.release();
    try {
      if (this.blocked) await this.unblock.promise;
      if (this.closed) throw new Error("Controlled queue closed");
      return { busy: false };
    } finally {
      this.exited();
    }
  }
  queued() {
    return Promise.resolve(this.slots);
  }
  enqueueQueued(_agent: unknown, clientId: string, body: string) {
    const item = { queueId: clientId, clientId, body };
    this.slots.push(item);
    this.enqueued.release();
    return Promise.resolve(item);
  }
  cancelQueued(_agent: unknown, queueId: string) {
    this.slots = this.slots.filter((item) => item.queueId !== queueId);
    return Promise.resolve(true);
  }
  received() {
    return Promise.resolve({ bodies: [], complete: true });
  }
  close() {
    this.closed = true;
    this.unblock.release();
  }
}
async function fixture(count: number) {
  const directory = await mkdtemp("/tmp/octo-notification-latency-"),
    store = new Store(directory, () => 1000),
    config = defaultTrackingConfig();
  config.endpoints["local"] = {
    delivery: "queue",
    socket: "/fixture/queue.sock",
  };
  const tracking = new TrackingService(store.tracking, config, () => 1000);
  let active = 0,
    maximum = 0,
    notices = 0;
  const agents = Array.from({ length: count }, (_, index) =>
    tracking.registerAgent({
      harness: "codex",
      endpoint: "local",
      sessionId: `latency-${String(index)}`,
    }),
  );
  const queues = agents.map(
    () =>
      new Queue(
        () => {
          active++;
          maximum = Math.max(maximum, active);
        },
        () => {
          active--;
        },
      ),
  );
  let revisionReads = 0;
  const service = new DigestService(
    store.digests,
    tracking,
    store.submissions,
    directory,
    () => 1000,
    {
      intervalMs: 60000,
      inputRevision: () => {
        revisionReads++;
        return JSON.stringify([store.inputRevision(), config.endpoints]);
      },
      connect: (agent) => {
        const queue =
          queues[agents.findIndex((value) => value.id === agent.id)];
        if (queue === undefined) throw new Error("Unexpected recipient");
        return queue;
      },
    },
  );
  return {
    store,
    service,
    queues,
    get revisionReads() {
      return revisionReads;
    },
    get maximum() {
      return maximum;
    },
    notice(index: number) {
      const actor = agents[index];
      if (actor === undefined) throw new Error("Missing recipient");
      const value = store.submissions.request({
        requestId: `notice-${String(++notices)}`,
        repository: "owner/repo",
        headRef: "feature",
        headSha: "a".repeat(40),
        baseRef: "main",
        purpose: "Notification latency fixture",
        validation: [],
        draft: false,
        owner: {
          harness: "codex",
          endpoint: actor.endpoint,
          sessionId: actor.sessionId,
        },
      });
      store.submissions.save({
        ...value,
        state: SubmissionState.NeedsInput,
        detail: "Attention required",
        notificationRevision: 1,
      });
      store.submissions.notify(value, actor.id);
      const notice = store.submissions.notices().at(-1);
      if (notice === undefined) throw new Error("Missing notice");
      return { id: notice.id, agentId: actor.id };
    },
    async close() {
      for (const queue of queues) queue.unblock.release();
      await service.close();
      await tracking.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("a new recipient progresses while another recipient's queue is stalled", async () => {
  const f = await fixture(2);
  try {
    const [slow, fast] = f.queues;
    if (slow === undefined || fast === undefined)
      throw new Error("Missing queues");
    slow.blocked = true;
    f.notice(0);
    f.service.start();
    await within(slow.started.promise);
    await setImmediate();
    f.notice(1);
    f.service.wake();
    await within(fast.enqueued.promise);
    expect(fast.slots).toHaveLength(1);
    expect(slow.slots).toHaveLength(0);
    expect(slow.preparations).toBe(1);
    const flush = f.service.flush();
    await setImmediate();
    expect(slow.preparations).toBe(1);
    slow.unblock.release();
    await within(flush);
    expect(slow.slots).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("recipient concurrency stays bounded and shutdown drains active work without starting queued work", async () => {
  const f = await fixture(7);
  try {
    for (const [index, queue] of f.queues.entries()) {
      queue.blocked = true;
      f.notice(index);
    }
    const flush = f.service.flush();
    await within(
      Promise.all(f.queues.slice(0, 4).map((queue) => queue.started.promise)),
    );
    expect(f.maximum).toBe(4);
    expect(
      f.queues.reduce((total, queue) => total + queue.preparations, 0),
    ).toBe(4);
    await within(f.service.close());
    await within(flush);
    expect(
      f.queues.reduce((total, queue) => total + queue.preparations, 0),
    ).toBe(4);
    expect(f.queues.every((queue) => queue.slots.length === 0)).toBe(true);
  } finally {
    await f.close();
  }
});

test("unchanged recipients skip history reads until inputs change", async () => {
  const f = await fixture(1);
  await f.service.flush();
  const reads = spyOn(f.store.tracking.inbox, "list");
  try {
    for (let i = 0; i < 20; i++) await f.service.flush();
    expect(reads).not.toHaveBeenCalled();
    f.notice(0);
    await f.service.flush();
    expect(reads).toHaveBeenCalled();
    expect(f.queues[0]?.slots).toHaveLength(1);
  } finally {
    reads.mockRestore();
    await f.close();
  }
});
test("legacy messages arriving during queue I/O wait for an independent recovery receipt", async () => {
  const f = await fixture(1);
  const queue = f.queues[0];
  if (queue === undefined) throw new Error("Missing queue");
  const db = new DatabaseSync(`${f.store.directory}/jobs.sqlite`);
  try {
    const first = f.notice(0);
    queue.blocked = true;
    const flush = f.service.flush();
    await within(queue.started.promise);
    const late = f.notice(0);
    db.prepare("DELETE FROM safe_agent_notices WHERE message_id=?").run(
      late.id,
    );
    queue.unblock.release();
    await within(flush);
    const active = f.store.digests.active(first.agentId);
    if (active === undefined) throw new Error("Missing first digest");
    expect(
      f.store.digests.revisions(active.id).flatMap((value) => value.messageIds),
    ).not.toContain(late.id);
    f.service.acknowledge(active.id, active.revision, first.agentId);
    expect(f.store.tracking.inbox.get(late.id)?.acknowledgedAt).toBeUndefined();
    await within(f.service.flush());
    const replacement = f.store.tracking.inbox
      .list(first.agentId, 0, false, true)
      .messages.find((value) => value.id !== late.id);
    if (replacement === undefined)
      throw new Error("Missing independent recovery message");
    expect(replacement.notice).toBeDefined();
    const next = f.store.digests.active(first.agentId);
    if (next === undefined) throw new Error("Missing recovery digest");
    const members = f.store.digests
      .revisions(next.id)
      .flatMap((value) => value.messageIds);
    expect(members).toContain(replacement.id);
    expect(members).not.toContain(late.id);
    f.service.acknowledge(next.id, next.revision, first.agentId);
    expect(f.store.tracking.inbox.get(replacement.id)?.acknowledgedAt).toBe(
      1000,
    );
    expect(f.store.tracking.inbox.get(late.id)?.acknowledgedAt).toBeUndefined();
  } finally {
    db.close();
    await f.close();
  }
});
test("prepared inbox lookups avoid recompilation while observing fresh receipts", async () => {
  const f = await fixture(1);
  const prepare = spyOn(DatabaseSync.prototype, "prepare");
  try {
    const notice = f.notice(0);
    prepare.mockClear();
    for (let index = 0; index < 20; index++) {
      expect(
        f.store.tracking.inbox.get(notice.id)?.acknowledgedAt,
      ).toBeUndefined();
    }
    f.store.tracking.acknowledgeMessage(notice.id, notice.agentId);
    expect(f.store.tracking.inbox.get(notice.id)?.acknowledgedAt).toBe(1000);
    const lookupCompilations = prepare.mock.calls.filter(([sql]) =>
      sql.endsWith("WHERE delivery_id=?"),
    );
    expect(lookupCompilations).toHaveLength(1);
  } finally {
    prepare.mockRestore();
    await f.close();
  }
});

test("idle discovery reads one revision across a retained cohort and still observes external invalidation", async () => {
  const f = await fixture(125);
  const external = new DatabaseSync(`${f.store.directory}/jobs.sqlite`);
  const history = spyOn(f.store.tracking.inbox, "list");
  try {
    await f.service.flush();
    await f.service.flush();
    history.mockClear();
    const before = f.revisionReads;
    await f.service.flush();
    expect(f.revisionReads - before).toBeLessThanOrEqual(2);
    expect(history).not.toHaveBeenCalled();
    external
      .prepare(
        "INSERT INTO settings(key,value) VALUES('fixture-external-input','changed')",
      )
      .run();
    await f.service.flush();
    expect(history).toHaveBeenCalled();
    f.notice(0);
    const pending = f.service.flush();
    await setImmediate();
    f.notice(124);
    await within(pending);
    expect(f.queues[0]?.slots).toHaveLength(1);
    expect(f.queues[124]?.slots).toHaveLength(1);
  } finally {
    history.mockRestore();
    external.close();
    await f.close();
  }
});
