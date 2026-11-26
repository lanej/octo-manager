import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QueueConnection, QueuedMessage } from "../src/agents/codex.js";
import { Store } from "../src/coordinator/store.js";
import { WorkScheduler } from "../src/scheduling/work.js";
import { DigestService } from "../src/notifications/service.js";
import { DigestState } from "../src/notifications/types.js";
import { SubmissionState } from "../src/submissions/contracts.js";
import { defaultTrackingConfig } from "../src/tracking/config.js";
import { TrackingService } from "../src/tracking/service.js";

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate() && Date.now() < deadline)
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  expect(predicate()).toBe(true);
}

async function fixture(intervalMs?: number) {
  const directory = await mkdtemp(join(tmpdir(), "octo-digest-deadline-"));
  let now = 1000;
  const scheduler = new WorkScheduler(() => now);
  let revision = 0;
  let service: DigestService | undefined;
  const store = new Store(
    directory,
    () => now,
    () => {
      revision++;
      service?.wake();
    },
  );
  const config = defaultTrackingConfig();
  config.endpoints["local"] = { delivery: "queue", socket: "/controlled" };
  const tracking = new TrackingService(store.tracking, config, () => now);
  const actor = tracking.registerAgent({
    harness: "codex",
    endpoint: "local",
    sessionId: "deadline-owner",
  });
  let inspections = 0;
  let admissions = 0;
  let loseAdmission = false;
  let slots: QueuedMessage[] = [];
  const history: string[] = [];
  const queue: QueueConnection = {
    prepare: () => Promise.resolve({ busy: false }),
    queued: () => {
      inspections++;
      return Promise.resolve(structuredClone(slots));
    },
    enqueueQueued: (_agent, clientId, body) => {
      admissions++;
      const item = { queueId: clientId, clientId, body };
      slots.push(item);
      if (loseAdmission) {
        loseAdmission = false;
        return Promise.reject(new Error("Controlled admission response loss"));
      }
      return Promise.resolve(item);
    },
    cancelQueued: (_agent, id) => {
      const before = slots.length;
      slots = slots.filter((item) => item.queueId !== id);
      return Promise.resolve(slots.length < before);
    },
    received: () => Promise.resolve({ bodies: [...history], complete: true }),
    close() {},
  };
  const digests = (service = new DigestService(store.digests, tracking, store.submissions, directory, () => now, {
    inputRevision: () => String(revision),
    connect: (_agent, socket) =>
      socket === "/controlled"
        ? queue
        : {
            ...queue,
            queued: () => {
              inspections++;
              return Promise.resolve([]);
            },
          },
    ...(intervalMs === undefined ? {} : { intervalMs }),
  }));
  let serial = 0;
  return {
    store,
    actor,
    digests,
    start() {
      digests.start(scheduler);
      scheduler.start();
    },
    get inspections() {
      return inspections;
    },
    get admissions() {
      return admissions;
    },
    get slots() {
      return slots;
    },
    get now() {
      return now;
    },
    loseAdmission() {
      loseAdmission = true;
    },
    consume() {
      for (const item of slots) {
        if (item.body === undefined) throw new Error("Queued fixture message has no body");
        history.push(item.body);
      }
      slots = [];
    },
    notice() {
      const value = store.submissions.request({
        requestId: `deadline-${String(++serial)}`,
        repository: "owner/repo",
        headRef: "feature",
        headSha: "a".repeat(40),
        baseRef: "main",
        purpose: "Deadline fixture",
        validation: [],
        draft: false,
        owner: {
          harness: "codex",
          endpoint: "local",
          sessionId: "deadline-owner",
        },
      });
      store.submissions.save({
        ...value,
        state: SubmissionState.NeedsInput,
        detail: "Input needed",
        notificationRevision: 1,
      });
      store.submissions.notify(value, actor.id);
      const message = store.submissions.notices().at(-1);
      if (message === undefined) throw new Error("Missing fixture notice");
      return message.id;
    },
    async advance(milliseconds: number) {
      now += milliseconds;
      await digests.flush();
    },
    async close() {
      scheduler.stop();
      await digests.close();
      await scheduler.close();
      await tracking.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("confirmed admission sleeps for sixty seconds while external consumption remains bounded", async () => {
  const f = await fixture();
  try {
    f.notice();
    await f.digests.flush();
    expect(f.inspections).toBe(1);
    expect(f.store.digests.active(f.actor.id)?.nextCheckAt).toBe(f.now + 60000);
    f.consume();
    for (let second = 1; second < 60; second++) await f.advance(1000);
    expect(f.inspections).toBe(1);
    expect(f.store.digests.active(f.actor.id)?.state).toBe(DigestState.Queued);
    await f.advance(1000);
    expect(f.inspections).toBe(2);
    expect(f.store.digests.active(f.actor.id)).toBeUndefined();
    expect(f.admissions).toBe(1);
  } finally {
    await f.close();
  }
});

test("new notices and receipts wake confirmed queues before their housekeeping deadline", async () => {
  const f = await fixture();
  try {
    f.start();
    f.notice();
    await until(() => f.slots.length === 1);
    const first = f.store.digests.active(f.actor.id);
    if (first === undefined) throw new Error("Missing admitted digest");
    expect(first.nextCheckAt).toBe(f.now + 60000);
    f.notice();
    await until(() => (f.store.digests.active(f.actor.id)?.revision ?? 0) > first.revision && f.admissions === 2);
    const current = f.store.digests.active(f.actor.id);
    if (current === undefined) throw new Error("Missing revised digest");
    f.digests.acknowledge(current.id, current.revision, f.actor.id);
    await until(() => f.slots.length === 0);
    expect(f.now).toBe(1000);
    expect(f.store.digests.active(f.actor.id)).toBeUndefined();
  } finally {
    await f.close();
  }
});

test("uncertain admission retries after five seconds instead of the confirmed queue deadline", async () => {
  const f = await fixture();
  try {
    f.notice();
    f.loseAdmission();
    await f.digests.flush();
    expect(f.store.digests.active(f.actor.id)?.state).toBe(DigestState.Uncertain);
    expect(f.store.digests.active(f.actor.id)?.nextCheckAt).toBe(6000);
    await f.advance(4999);
    expect(f.inspections).toBe(1);
    await f.advance(1);
    expect(f.inspections).toBe(2);
    expect(f.store.digests.active(f.actor.id)?.state).toBe(DigestState.Queued);
    expect(f.admissions).toBe(1);
  } finally {
    await f.close();
  }
});

test("explicit queue inspection intervals retain their clock boundary", async () => {
  const f = await fixture(25);
  try {
    f.notice();
    await f.digests.flush();
    expect(f.store.digests.active(f.actor.id)?.nextCheckAt).toBe(1025);
    await f.advance(24);
    expect(f.inspections).toBe(1);
    await f.advance(1);
    expect(f.inspections).toBe(2);
  } finally {
    await f.close();
  }
});

test("queued housekeeping does not delay cleanup on other transport routes", async () => {
  const f = await fixture();
  try {
    const messageId = f.notice();
    const history = ["/old-route-one", "/old-route-two"].map((socket) => {
      const value = f.store.digests.create(f.actor.id, { kind: "codex_queue", socket }, () => ({
        body: "Historical fixture",
        messageIds: [messageId],
      }));
      return f.store.digests.save({ ...value, state: DigestState.Cancelled, cleanupPending: false }, "fixture_settled");
    });
    await f.digests.flush();
    expect(f.store.digests.active(f.actor.id)?.state).toBe(DigestState.Queued);
    for (const value of history) f.store.digests.save({ ...value, cleanupPending: true }, "fixture_cleanup_required");
    f.notice();
    await f.digests.flush();
    expect(f.store.digests.cleanup(f.actor.id)).toHaveLength(1);
    expect(f.inspections).toBe(2);
    await f.advance(999);
    expect(f.store.digests.cleanup(f.actor.id)).toHaveLength(1);
    expect(f.inspections).toBe(2);
    await f.advance(1);
    expect(f.store.digests.cleanup(f.actor.id)).toHaveLength(0);
    expect(f.inspections).toBe(3);
    expect(f.store.digests.active(f.actor.id)?.state).toBe(DigestState.Queued);
    expect(f.admissions).toBe(1);
    await f.advance(999);
    expect(f.admissions).toBe(1);
    await f.advance(1);
    expect(f.admissions).toBe(2);
    expect(f.store.digests.active(f.actor.id)?.revision).toBe(2);
  } finally {
    await f.close();
  }
});
