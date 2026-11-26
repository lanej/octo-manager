import { afterEach, beforeEach, expect, jest, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/coordinator/store.js";
import { MergeService } from "../src/merging/service.js";
import { EntryState, OperationState } from "../src/merging/contracts.js";
import type { MergeProvider, MergeSnapshot } from "../src/merging/github.js";
import { WorkScheduler } from "../src/scheduling/work.js";
import { defaultTrackingConfig } from "../src/tracking/config.js";
import { TrackingService } from "../src/tracking/service.js";
import { agentMessage } from "../src/tracking/messages.js";

beforeEach(() => {
  jest.useFakeTimers({ now: 1000 });
});
afterEach(() => {
  mock.restore();
  jest.useRealTimers();
});

async function settle() {
  for (let i = 0; i < 30; i++) {
    jest.advanceTimersByTime(0);
    await Promise.resolve();
  }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "octo-merge-readiness-clock-"));
  const config = defaultTrackingConfig();
  config.endpoints["local"] = { delivery: "queue", socket: "/controlled" };
  let now = 1000;
  const clock = () => now;
  const store = new Store(directory, clock);
  const tracking = new TrackingService(store.tracking, config, clock);
  const scheduler = new WorkScheduler(clock);
  const url = "https://github.com/owner/repo/pull/38",
    head = "a".repeat(40),
    base = "b".repeat(40);
  const current: MergeSnapshot = {
    observation: {
      observedAt: 1000,
      headSha: head,
      baseSha: base,
      targetBase: { ref: "main", sha: base },
      lifecycle: "open",
      mergeability: "mergeable",
      checks: {
        state: "complete",
        value: [
          {
            id: "run:1",
            key: "ci",
            name: "CI",
            headSha: head,
            status: "completed",
            conclusion: "success",
            at: 1000,
            url,
          },
        ],
      },
      workflows: { state: "complete", value: [] },
      reviews: { state: "complete", value: [] },
      feedback: { state: "complete", value: [] },
    },
    draft: false,
    gate: "CLEAN",
    review: null,
    required: ["CI"],
    queueRequired: false,
    methods: ["squash"],
  };
  const inspect = mock(() => Promise.resolve(structuredClone(current)));
  const merge = mock(() => Promise.reject(new Error("No merge effect is authorized in this fixture")));
  const provider: MergeProvider = { inspect, merge };
  const service = new MergeService(store.merging, tracking, {}, directory, store.mergeConflicts, clock, {
    provider,
    referenceInputRevision: () => "fixture",
  });
  const pr = store.tracking.track(url, {
    harness: "codex",
    endpoint: "local",
    sessionId: "readiness-clock-owner",
  });
  store.tracking.observe(pr.id, current.observation, config);
  const action = store.tracking.actions(pr.id).find((value) => value.blocker.kind === "check_results");
  if (action === undefined) throw new Error("Missing completion action");
  const delivery = store.tracking.deliveries().find((value) => value.actionId === action.id);
  if (delivery === undefined) throw new Error("Missing completion delivery");
  store.tracking.inbox.record(delivery.id, agentMessage(action, url, delivery.id));
  const initial = service.tick();
  await settle();
  await initial;
  return {
    service,
    store,
    tracking,
    scheduler,
    config,
    current,
    pr,
    inspect,
    merge,
    provider,
    get message() {
      const value = store.tracking.inbox
        .list(pr.ownerAgentId, 0, false, true)
        .messages.find((item) => store.merging.readinessAction(item.id) === action.id);
      if (value === undefined) throw new Error("Missing readiness offer");
      return value;
    },
    advance(milliseconds: number) {
      now += milliseconds;
      jest.advanceTimersByTime(milliseconds);
    },
    setTime(value: number) {
      now = value;
      jest.setSystemTime(value);
    },
    async close() {
      const stopped = service.close();
      await settle();
      await stopped;
      await scheduler.close();
      await tracking.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("readiness offers refresh after five minutes even without a queued merge entry", async () => {
  const f = await fixture();
  const ticks = spyOn(f.service, "tick");
  try {
    const initial = f.store.merging.noticeReadiness(f.pr.id);
    expect(initial?.eligible).toBe(true);
    expect(initial?.retryAt).toBe(301000);
    expect(f.store.merging.unfinishedEntries()).toEqual([]);
    expect(f.store.merging.unfinishedOperations()).toEqual([]);
    expect(f.service.receipts.presentation(f.message).status).toBe("ready");
    f.service.start(f.scheduler);
    f.scheduler.start();
    await settle();
    f.current.draft = true;
    f.advance(299999);
    await settle();
    expect(f.inspect).toHaveBeenCalledTimes(1);
    expect(ticks).toHaveBeenCalledTimes(1);
    expect(f.store.merging.noticeReadiness(f.pr.id)?.eligible).toBe(true);
    f.advance(1);
    await settle();
    expect(f.inspect).toHaveBeenCalledTimes(2);
    expect(f.store.merging.noticeReadiness(f.pr.id)?.checkedAt).toBe(301000);
    expect(f.store.merging.noticeReadiness(f.pr.id)?.reason).toBe("draft");
    expect(f.service.receipts.presentation(f.message).status).toBe("blocked");
    expect(f.merge).not.toHaveBeenCalled();
    expect(f.store.merging.unfinishedEntries()).toEqual([]);
  } finally {
    ticks.mockRestore();
    await f.close();
  }
});

test("an expired readiness cache without eligible recipients sleeps until input changes", async () => {
  const f = await fixture();
  const ticks = spyOn(f.service, "tick");
  try {
    f.setTime(301001);
    f.config.endpoints["local"] = { delivery: "turn" };
    f.service.start(f.scheduler);
    f.scheduler.start();
    await settle();
    expect(f.store.merging.noticeReadiness(f.pr.id)?.retryAt).toBe(301000);
    expect(ticks).toHaveBeenCalledTimes(1);
    f.advance(29999);
    await settle();
    expect(ticks).toHaveBeenCalledTimes(1);
    f.advance(1);
    await settle();
    expect(ticks).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    f.config.endpoints["local"] = { delivery: "queue", socket: "/controlled" };
    f.service.wake();
    await settle();
    expect(ticks).toHaveBeenCalledTimes(2);
    expect(f.inspect).toHaveBeenCalledTimes(2);
    expect(f.merge).not.toHaveBeenCalled();
  } finally {
    ticks.mockRestore();
    await f.close();
  }
});

test("an accepted asynchronous merge sleeps until its result deadline", async () => {
  const f = await fixture();
  const ticks = spyOn(f.service, "tick");
  const result = mock(() =>
    Promise.resolve({
      state: "pending" as const,
      requestId: "accepted-request",
    }),
  );
  f.provider.result = result;
  try {
    f.store.merging.queue({
      requestId: "async-clock",
      actorId: f.pr.ownerAgentId,
      entries: [{ prUrl: f.pr.url, checks: ["CI"] }],
    });
    const entry = f.store.merging.unfinishedEntries()[0];
    if (entry === undefined) throw new Error("Missing queued entry");
    f.store.merging.state(entry, EntryState.Merging, "GitHub request accepted");
    f.store.merging.saveOperation({
      id: "async-operation",
      epoch: f.pr.trackingEpoch,
      entryId: entry.id,
      prId: f.pr.id,
      kind: "merge",
      state: OperationState.Running,
      phase: "merging",
      head: "a".repeat(40),
      baseRef: "main",
      baseSha: "b".repeat(40),
      graph: "fixture-graph",
      ownerId: f.pr.ownerAgentId,
      createdAt: 1000,
      updatedAt: 1000,
      detail: "Accepted",
      requestId: "accepted-request",
      nextCheckAt: 61000,
    });
    f.service.start(f.scheduler);
    f.scheduler.start();
    await settle();
    f.advance(59999);
    await settle();
    expect(ticks).toHaveBeenCalledTimes(1);
    expect(result).not.toHaveBeenCalled();
    f.advance(1);
    await settle();
    expect(ticks).toHaveBeenCalledTimes(2);
    expect(result).toHaveBeenCalledTimes(1);
    expect(f.store.merging.unfinishedOperations()[0]?.nextCheckAt).toBe(121000);
    expect(f.merge).not.toHaveBeenCalled();
  } finally {
    ticks.mockRestore();
    await f.close();
  }
});
