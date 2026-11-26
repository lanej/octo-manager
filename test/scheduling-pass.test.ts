import { afterEach, expect, jest, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/coordinator/store.js";
import { GitHubScheduler } from "../src/scheduling/service.js";
import { WorkScheduler } from "../src/scheduling/work.js";
import {
  defaultSchedulerPolicy,
  RefreshKind,
  ScheduleState,
} from "../src/scheduling/contracts.js";

const url = "https://github.com/owner/repo/pull/31";
afterEach(() => jest.useRealTimers());

async function fixture(
  run: (value: {
    store: Store;
    work: WorkScheduler;
    scheduler: GitHubScheduler;
    reads: () => number;
    passes: () => number;
  }) => Promise<void>,
) {
  jest.useFakeTimers({ now: 1000 });
  const directory = await mkdtemp(join(tmpdir(), "octo-scheduling-pass-"));
  const store = new Store(directory);
  let reads = 0,
    passes = 0;
  const work = new WorkScheduler(Date.now, undefined, (key, callback) => {
    if (key === "github-dispatch") passes++;
    return callback();
  });
  const scheduler = new GitHubScheduler(
    store.schedules,
    defaultSchedulerPolicy,
    Date.now,
    () => {
      reads++;
      return Promise.resolve({
        url,
        title: "Reviews",
        state: "open",
        headSha: "abc",
        observedAtMs: Date.now(),
        messages: [],
        mayHaveMoreMessages: false,
      });
    },
    () => {},
  );
  try {
    await run({
      store,
      work,
      scheduler,
      reads: () => reads,
      passes: () => passes,
    });
  } finally {
    work.stop();
    await scheduler.close();
    await work.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("idle dispatch checks read schedules once and never read the dispatch gate", () =>
  fixture(async ({ store, work, scheduler, passes }) => {
    const reviews = spyOn(store.schedules, "reviews");
    const dispatch = spyOn(store.schedules, "dispatch");
    try {
      scheduler.start(work);
      work.start();
      jest.advanceTimersByTime(0);
      await Promise.resolve();
      expect(passes()).toBe(1);
      expect(reviews).toHaveBeenCalledTimes(1);
      expect(dispatch).not.toHaveBeenCalled();
      jest.advanceTimersByTime(10000);
      await Promise.resolve();
      expect(passes()).toBe(1);
      expect(reviews).toHaveBeenCalledTimes(1);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      reviews.mockRestore();
      dispatch.mockRestore();
    }
  }));

test("a shared schedule snapshot retains the next review deadline and completion wake", () =>
  fixture(async ({ store, work, scheduler, reads, passes }) => {
    store.schedules.save({
      key: `reviews:${url}`,
      kind: RefreshKind.Reviews,
      subject: url,
      dueAtMs: 1100,
      intervalMs: 60000,
      state: ScheduleState.Queued,
    });
    const reviews = spyOn(store.schedules, "reviews");
    try {
      scheduler.start(work);
      work.start();
      jest.advanceTimersByTime(99);
      expect(reads()).toBe(0);
      jest.advanceTimersByTime(1);
      expect(reads()).toBe(1);
      for (let step = 0; step < 8; step++) await Promise.resolve();
      jest.advanceTimersByTime(0);
      await Promise.resolve();
      expect(passes()).toBeGreaterThanOrEqual(3);
      expect(reviews).toHaveBeenCalledTimes(passes());
      expect(store.schedules.get(`reviews:${url}`)?.state).toBe(
        ScheduleState.Deferred,
      );
      jest.advanceTimersByTime(60000);
      expect(reads()).toBe(1);
    } finally {
      reviews.mockRestore();
    }
  }));
