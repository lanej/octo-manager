import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import type { QueueConnection, QueuedMessage } from "../src/agents/codex.js";
import { Store } from "../src/coordinator/store.js";
import { DigestService } from "../src/notifications/service.js";
import { WorkScheduler } from "../src/scheduling/work.js";
import { defaultTrackingConfig } from "../src/tracking/config.js";
import { TrackingService } from "../src/tracking/service.js";
import type { ObservationInput } from "../src/tracking/types.js";

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function until(predicate: () => boolean) {
  const end = Date.now() + 1000;
  while (!predicate() && Date.now() < end)
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  expect(predicate()).toBe(true);
}
class Queue implements QueueConnection {
  slots: QueuedMessage[] = [];
  blockNext = false;
  readonly entered = gate();
  readonly release = gate();
  active = 0;
  maximum = 0;
  prepare() {
    return Promise.resolve({ busy: false });
  }
  queued() {
    return Promise.resolve(structuredClone(this.slots));
  }
  async enqueueQueued(_agent: unknown, clientId: string, body: string) {
    const item = { queueId: clientId, clientId, body };
    this.slots.push(item);
    this.active++;
    this.maximum = Math.max(this.maximum, this.active);
    try {
      if (this.blockNext) {
        this.blockNext = false;
        this.entered.release();
        await this.release.promise;
      }
      return item;
    } finally {
      this.active--;
    }
  }
  cancelQueued(_agent: unknown, id: string) {
    const before = this.slots.length;
    this.slots = this.slots.filter((item) => item.queueId !== id);
    return Promise.resolve(before !== this.slots.length);
  }
  received() {
    return Promise.resolve({ bodies: [], complete: true });
  }
  close() {}
}
async function fixture() {
  const directory = await mkdtemp("/tmp/octo-digest-scope-");
  const store = new Store(directory, () => 1000);
  const config = defaultTrackingConfig();
  config.endpoints["local"] = { delivery: "queue", socket: "/controlled" };
  const tracking = new TrackingService(store.tracking, config, () => 1000);
  const target = (sessionId: string) => ({
    harness: "codex",
    endpoint: "local",
    sessionId,
  });
  const owner = tracking.registerAgent(target("owner"));
  const observer = tracking.registerAgent(target("observer"));
  const unrelated = tracking.registerAgent(target("unrelated"));
  for (let index = 0; index < 8; index++)
    tracking.registerAgent(target(`idle-${String(index)}`));
  const prs = [
    tracking.track("https://github.com/owner/repo/pull/1", target("owner")),
    tracking.track("https://github.com/owner/repo/pull/2", target("owner")),
    tracking.track("https://github.com/other/repo/pull/3", target("unrelated")),
  ];
  const selected = prs[0];
  if (selected === undefined) throw new Error("Missing scoped PR");
  store.tracking.subscribe(selected.id, target("observer"));
  const queues = new Map(
    [owner, observer, unrelated].map((agent) => [agent.id, new Queue()]),
  );
  let broadRevision = 0;
  const scheduler = new WorkScheduler(() => 1000);
  const service = new DigestService(
    store.digests,
    tracking,
    store.submissions,
    directory,
    () => 1000,
    {
      inputRevision: () => String(broadRevision),
      connect: (agent) => {
        const queue = queues.get(agent.id);
        if (queue === undefined) throw new Error("Unexpected recipient queue");
        return queue;
      },
    },
  );
  const queue = (id: string) => {
    const value = queues.get(id);
    if (value === undefined) throw new Error("Missing recipient queue");
    return value;
  };
  return {
    store,
    service,
    owner,
    observer,
    unrelated,
    prs,
    selected,
    queue,
    members(agentId: string) {
      const digest = store.digests.active(agentId);
      return digest === undefined
        ? []
        : store.digests.version(digest.id, digest.revision).messageIds;
    },
    pendingIds(agentId: string) {
      return store.tracking.inbox
        .list(agentId, 0, false, true)
        .messages.map((message) => message.id);
    },
    observe(index: number, comments = 1) {
      const pr = prs[index];
      if (pr === undefined) throw new Error("Missing fixture PR");
      const input: ObservationInput = {
        observedAt: 1000,
        headSha: "a".repeat(40),
        baseSha: "b".repeat(40),
        lifecycle: "open",
        mergeability: "mergeable",
        checks: { state: "complete", value: [] },
        reviews: { state: "complete", value: [] },
        feedback: {
          state: "complete",
          value: Array.from({ length: comments }, (_, comment) => ({
            source: "conversation",
            id: `comment-${String(comment)}`,
            revision: "1",
            author: "synthetic",
            body: "Controlled finding",
            headSha: "a".repeat(40),
            url: `${pr.url}#issuecomment-${String(comment)}`,
          })),
        },
      };
      store.tracking.observe(pr.id, input, config);
      for (const delivery of store.tracking.deliveries()) {
        const action = store.tracking.action(delivery.actionId);
        if (
          action.prId !== pr.id ||
          store.tracking.inbox.get(delivery.id) !== undefined
        )
          continue;
        const notice = store.tracking.noticeForAction(
          action,
          delivery.recipientAgentId,
        );
        store.tracking.inbox.freezeNotice(delivery.id, notice);
        store.tracking.inbox.record(
          delivery.id,
          store.tracking.inbox.render(delivery.id, notice),
        );
      }
    },
    async start() {
      service.start(scheduler);
      scheduler.start();
      await service.flush();
    },
    fullWake() {
      broadRevision++;
      service.wake();
    },
    async close() {
      for (const value of queues.values()) value.release.release();
      scheduler.stop();
      await service.close();
      await scheduler.close();
      await tracking.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("a PR input wakes its owner and observer without roster or unrelated history reads", async () => {
  const f = await fixture();
  try {
    f.observe(1);
    f.observe(2);
    await f.start();
    const sibling = f.prs[1];
    if (sibling === undefined) throw new Error("Missing sibling PR");
    const siblingIds = f.store.tracking
      .deliveries()
      .filter(
        (delivery) =>
          f.store.tracking.action(delivery.actionId).prId === sibling.id,
      )
      .map((delivery) => delivery.id);
    const roster = spyOn(f.store.tracking, "agents");
    const recovery = spyOn(f.store.tracking, "prepareSafeRecovery");
    const history = spyOn(f.store.tracking.inbox, "list");
    const contexts = spyOn(f.store.tracking, "prContext");
    try {
      f.observe(0);
      f.service.wake(f.selected.id);
      f.service.wake(f.selected.id);
      await until(
        () =>
          f.queue(f.observer.id).slots.length === 1 &&
          (f.store.digests.active(f.owner.id)?.revision ?? 0) > 1,
      );
      await setImmediate();
      await setImmediate();
      expect(roster).not.toHaveBeenCalled();
      expect(recovery).not.toHaveBeenCalled();
      expect(contexts).toHaveBeenCalledTimes(1);
      expect(
        history.mock.calls.every(
          ([id]) => id === f.owner.id || id === f.observer.id,
        ),
      ).toBe(true);
      const digest = f.store.digests.active(f.owner.id);
      if (digest === undefined) throw new Error("Missing current owner digest");
      const members = f.store.digests.version(
        digest.id,
        digest.revision,
      ).messageIds;
      expect(siblingIds.length).toBeGreaterThan(0);
      for (const id of siblingIds) expect(members).toContain(id);
      expect(f.queue(f.unrelated.id).slots).toHaveLength(1);
    } finally {
      contexts.mockRestore();
      history.mockRestore();
      recovery.mockRestore();
      roster.mockRestore();
    }
  } finally {
    await f.close();
  }
});

test("scoped intake during admission queues one follow-up for each affected recipient", async () => {
  const f = await fixture();
  try {
    await f.start();
    const ownerQueue = f.queue(f.owner.id);
    ownerQueue.blockNext = true;
    f.observe(0);
    f.service.wake(f.selected.id);
    await ownerQueue.entered.promise;
    const held = f.store.digests.active(f.owner.id);
    if (held === undefined) throw new Error("Missing held owner digest");
    const contexts = spyOn(f.store.tracking, "prContext");
    try {
      f.observe(0, 2);
      const expectedOwner = f.pendingIds(f.owner.id);
      const expectedObserver = f.pendingIds(f.observer.id);
      f.service.wake(f.selected.id);
      await until(() => contexts.mock.calls.length === 1);
      await setImmediate();
      await setImmediate();
      expect(ownerQueue.maximum).toBe(1);
      ownerQueue.release.release();
      await until(
        () =>
          (f.store.digests.active(f.owner.id)?.revision ?? 0) > held.revision &&
          f.members(f.observer.id).length === expectedObserver.length,
      );
      expect(f.members(f.owner.id)).toEqual(expectedOwner);
      expect(f.members(f.observer.id)).toEqual(expectedObserver);
      expect(ownerQueue.maximum).toBe(1);
      expect(ownerQueue.slots).toHaveLength(1);
      expect(f.queue(f.observer.id).slots).toHaveLength(1);
    } finally {
      contexts.mockRestore();
    }
  } finally {
    await f.close();
  }
});

test("an unscoped roster change still cleans a removed observer without receipting the owner", async () => {
  const f = await fixture();
  try {
    f.observe(0);
    await f.start();
    const ownerDigest = f.store.digests.active(f.owner.id);
    const observerDigest = f.store.digests.active(f.observer.id);
    if (ownerDigest === undefined || observerDigest === undefined)
      throw new Error("Missing participant digests");
    const ownerIds = f.store.digests.version(
      ownerDigest.id,
      ownerDigest.revision,
    ).messageIds;
    f.service.acknowledge(
      observerDigest.id,
      observerDigest.revision,
      f.observer.id,
    );
    f.store.tracking.unsubscribe(f.selected.id, f.observer.id);
    const roster = spyOn(f.store.tracking, "agents");
    try {
      f.fullWake();
      await until(() => f.queue(f.observer.id).slots.length === 0);
      expect(roster).toHaveBeenCalled();
      expect(
        ownerIds.every(
          (id) => f.store.tracking.inbox.get(id)?.acknowledgedAt === undefined,
        ),
      ).toBe(true);
      expect(f.queue(f.owner.id).slots).toHaveLength(1);
    } finally {
      roster.mockRestore();
    }
  } finally {
    await f.close();
  }
});

test("a recipient input follows admission in flight without PR or roster discovery", async () => {
  const f = await fixture();
  try {
    await f.start();
    const queue = f.queue(f.owner.id);
    const observerSlots = structuredClone(f.queue(f.observer.id).slots);
    queue.blockNext = true;
    f.observe(0);
    f.service.wakeRecipient(f.owner.id);
    await queue.entered.promise;
    const held = f.store.digests.active(f.owner.id);
    if (held === undefined) throw new Error("Missing held owner digest");
    const roster = spyOn(f.store.tracking, "agents");
    const contexts = spyOn(f.store.tracking, "prContext");
    try {
      f.observe(0, 2);
      const expectedOwner = f.pendingIds(f.owner.id);
      f.service.wakeRecipient(f.owner.id);
      await setImmediate();
      await setImmediate();
      await setImmediate();
      expect(queue.maximum).toBe(1);
      queue.release.release();
      await until(
        () =>
          (f.store.digests.active(f.owner.id)?.revision ?? 0) > held.revision,
      );
      expect(f.members(f.owner.id)).toEqual(expectedOwner);
      expect(queue.maximum).toBe(1);
      expect(queue.slots).toHaveLength(1);
      expect(f.queue(f.observer.id).slots).toEqual(observerSlots);
      expect(roster).not.toHaveBeenCalled();
      expect(contexts).not.toHaveBeenCalled();
    } finally {
      contexts.mockRestore();
      roster.mockRestore();
    }
  } finally {
    await f.close();
  }
});

test("a late recipient input still cleans a former observer's queue", async () => {
  const f = await fixture();
  try {
    f.observe(0);
    await f.start();
    f.store.tracking.unsubscribe(f.selected.id, f.observer.id);
    const roster = spyOn(f.store.tracking, "agents");
    const contexts = spyOn(f.store.tracking, "prContext");
    try {
      f.service.wakeRecipient(f.observer.id);
      await until(() => f.queue(f.observer.id).slots.length === 0);
      expect(f.queue(f.owner.id).slots).toHaveLength(1);
      expect(roster).not.toHaveBeenCalled();
      expect(contexts).not.toHaveBeenCalled();
    } finally {
      contexts.mockRestore();
      roster.mockRestore();
    }
  } finally {
    await f.close();
  }
});
