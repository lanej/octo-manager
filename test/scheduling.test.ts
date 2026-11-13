import { sdkTransport } from "../src/github-sdk.js";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { GitHubScheduler } from "../src/scheduling/service.js";
import {
  defaultSchedulerPolicy,
  RefreshKind,
  ScheduleState,
} from "../src/scheduling/contracts.js";
import { GitHubReads } from "../src/github-api.js";
import { Coordinator } from "../src/coordinator.js";
import { schedulerClient } from "../src/client.js";

const url = "https://github.com/owner/repo/pull/31";
const details = {
  url,
  title: "Stored review",
  state: "open",
  headSha: "abc",
  observedAtMs: 100,
  messages: [],
  mayHaveMoreMessages: false,
};
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
async function fixture(
  run: (
    store: Store,
    scheduler: GitHubScheduler,
    time: (at: number) => void,
  ) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "octo-scheduler-"));
  let at = 0;
  const store = new Store(directory, () => at);
  const scheduler = new GitHubScheduler(
    store.schedules,
    defaultSchedulerPolicy,
    () => at,
    () => Promise.resolve(details),
    () => {},
  );
  try {
    await run(store, scheduler, (value) => {
      at = value;
    });
  } finally {
    await scheduler.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}
test("one shared dispatch gate spaces all physical requests, honors cancellation and never catches up in bursts", () =>
  fixture(async (_store, scheduler, time) => {
    const starts: number[] = [];
    let at = 0;
    const reader = new GitHubReads(
      () => {
        starts.push(at);
        return Promise.resolve({ status: 200, headers: new Map(), body: "{}" });
      },
      () => at,
    );
    reader.setDispatcher(scheduler);
    const first = reader.read("first");
    const second = reader.raw("second", {});
    const third = reader.write("third", {});
    scheduler.tick();
    await settle();
    await first;
    at = 1000;
    time(at);
    scheduler.tick();
    await settle();
    assert.deepEqual(starts, [0]);
    at = 2000;
    time(at);
    scheduler.tick();
    await settle();
    await second;
    at = 100000;
    time(at);
    scheduler.tick();
    await settle();
    await third;
    assert.deepEqual(starts, [0, 2000, 100000]);
    const controller = new AbortController();
    const cancelled = reader.read("cancelled", controller.signal);
    const rejected = assert.rejects(cancelled, /cancelled/);
    controller.abort();
    await rejected;
    at = 200000;
    time(at);
    scheduler.tick();
    await settle();
    assert.equal(starts.length, 3);
  }));
test("interactive work alternates fairly with background work and resource cooldowns do not block other budgets", () =>
  fixture(async (_store, scheduler, time) => {
    const order: string[] = [];
    const enqueue = (name: string, interactive: boolean) => {
      const work = () =>
        scheduler.dispatch("core", () => {
          order.push(name);
          return Promise.resolve();
        });
      return interactive ? scheduler.interactive(work) : work();
    };
    const pending = [
      enqueue("i1", true),
      enqueue("i2", true),
      enqueue("b1", false),
      enqueue("b2", false),
    ];
    for (const at of [0, 2000, 4000, 6000]) {
      time(at);
      scheduler.tick();
      await settle();
    }
    await Promise.all(pending);
    assert.deepEqual(order, ["i1", "b1", "i2", "b2"]);
    scheduler.defer("core", 20000);
    const rest = enqueue("rest", false);
    const query = scheduler.dispatch("graphql", () => {
      order.push("graphql");
      return Promise.resolve();
    });
    time(8000);
    scheduler.tick();
    await settle();
    await query;
    assert.equal(order.at(-1), "graphql");
    time(20000);
    scheduler.tick();
    await rest;
  }));
test("queued writes validate current authority at dispatch and slow requests do not stop scheduler ticks", () =>
  fixture(async (_store, scheduler, time) => {
    let authority = true;
    let finished: (() => void) | undefined;
    const slow = scheduler.dispatch(
      "core",
      () =>
        new Promise<void>((resolve) => {
          finished = resolve;
        }),
    );
    let ticks = 0;
    scheduler.on("tick", () => {
      ticks++;
    });
    scheduler.tick();
    await settle();
    const write = scheduler.dispatch("core", () => {
      if (!authority) return Promise.reject(new Error("Authority revoked"));
      return Promise.resolve();
    });
    const rejected = assert.rejects(write, /revoked/);
    authority = false;
    time(10000);
    scheduler.tick();
    assert.equal(ticks, 2);
    assert.equal(scheduler.status().queuedRequests, 1);
    assert.ok(finished !== undefined);
    finished();
    await slow;
    await settle();
    time(12000);
    scheduler.tick();
    await rejected;
  }));
test("persistent review cache, interrupted schedules and dispatch cooldowns survive restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-schedule-restart-"));
  let store = new Store(directory, () => 1000);
  try {
    store.schedules.saveView(details);
    store.schedules.save({
      key: `reviews:${url}`,
      kind: RefreshKind.Reviews,
      subject: url,
      dueAtMs: 9000,
      intervalMs: 120000,
      state: ScheduleState.Running,
    });
    store.schedules.saveDispatch({
      nextAtMs: 3000,
      coreRetryAtMs: 4000,
      graphqlRetryAtMs: 5000,
    });
    store.close();
    store = new Store(directory, () => 2000);
    assert.deepEqual(store.schedules.view(url), details);
    const schedule = store.schedules.get(`reviews:${url}`);
    assert.equal(schedule?.state, ScheduleState.Queued);
    assert.equal(schedule.dueAtMs, 9000);
    assert.equal(schedule.intervalMs, 120000);
    assert.equal(store.schedules.dispatch().coreRetryAtMs, 4000);
    assert.equal(store.schedules.dispatch().nextAtMs, 3000);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("dashboard frames follow coordinator ticks and cached refresh RPCs never fetch GitHub directly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-dashboard-stream-"));
  let calls = 0;
  let at = 1000;
  const coordinator = new Coordinator(directory, {
    now: () => at,
    reviewReader: () => {
      calls++;
      return Promise.resolve(details);
    },
  });
  try {
    await coordinator.start();
    const client = schedulerClient(directory);
    for (let i = 0; i < 8; i++) {
      const response = await client.getPullRequest({ url, refresh: true });
      assert.equal(response.pullRequest, undefined);
    }
    assert.equal(calls, 0);
    const controller = new AbortController();
    const frames = client.watchDashboard(
      { url, reviews: true },
      { signal: controller.signal },
    );
    const stream = frames[Symbol.asyncIterator]();
    const first = await stream.next();
    assert.equal(first.done, false);
    assert.equal(first.value.pullRequest, undefined);
    assert.equal(calls, 0);
    const second = stream.next();
    at = 2000;
    coordinator.githubScheduler.tick();
    await second;
    await settle();
    assert.equal(calls, 1);
    const third = stream.next();
    at = 3000;
    coordinator.githubScheduler.tick();
    const frame = await third;
    assert.equal(frame.done, false);
    assert.equal(frame.value.pullRequest?.title, "Stored review");
    assert.equal(frame.value.snapshot?.githubScheduler?.tickSequence, 3n);
    controller.abort();
    await stream.return?.();
    await settle();
    const cached = await client.getPullRequest({ url });
    assert.equal(cached.pullRequest?.title, "Stored review");
    assert.equal(calls, 1);
    at = 200000;
    coordinator.githubScheduler.tick();
    await settle();
    assert.equal(calls, 1);
  } finally {
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("paced overlapping reads choose conditional headers at actual dispatch", () =>
  fixture(async (_store, scheduler, time) => {
    const headers: (Record<string, string> | undefined)[] = [];
    const reader = new GitHubReads((request) => {
      headers.push(request.headers);
      return Promise.resolve({
        status: headers.length === 1 ? 200 : 304,
        headers: new Map([["etag", '"one"']]),
        body: headers.length === 1 ? "{}" : "null",
      });
    });
    reader.setDispatcher(scheduler);
    const first = reader.read("same"),
      second = reader.read("same");
    scheduler.tick();
    await first;
    await settle();
    time(2000);
    scheduler.tick();
    await second;
    assert.equal(headers[0]?.["if-none-match"], undefined);
    assert.equal(headers[1]?.["if-none-match"], '"one"');
  }));
test("opening an evicted view queues a fresh read without enrolling the PR", () =>
  fixture(async (store, scheduler) => {
    store.schedules.save({
      key: `reviews:${url}`,
      kind: RefreshKind.Reviews,
      subject: url,
      dueAtMs: 900000,
      intervalMs: 900000,
      state: ScheduleState.Deferred,
    });
    const release = scheduler.interest(url);
    assert.equal(
      store.schedules.get(`reviews:${url}`)?.state,
      ScheduleState.Queued,
    );
    scheduler.tick();
    await settle();
    assert.equal(store.schedules.view(url)?.title, "Stored review");
    assert.equal(store.tracking.prs().length, 0);
    release();
  }));
test("shutdown aborts an in-flight GitHub call and leaves its closed gate installed until release", () =>
  fixture(async (_store, scheduler) => {
    let starts = 0;
    const reader = new GitHubReads(
      (_request, signal) =>
        new Promise((_resolve, reject) => {
          starts++;
          signal?.addEventListener(
            "abort",
            () => {
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    );
    const release = reader.setDispatcher(scheduler);
    const call = reader.read("slow");
    const rejected = assert.rejects(call, /aborted/);
    scheduler.tick();
    await settle();
    await scheduler.close();
    await rejected;
    await assert.rejects(reader.read("late"), /stopping/);
    assert.equal(starts, 1);
    release();
  }));

test("reopening a failed uncached view preserves its retry deadline; explicit refresh can request a slot", () =>
  fixture(async (store, scheduler) => {
    store.schedules.save({
      key: `reviews:${url}`,
      kind: RefreshKind.Reviews,
      subject: url,
      dueAtMs: 60000,
      intervalMs: 60000,
      state: ScheduleState.Deferred,
      lastError: "Access unavailable",
    });
    const release = scheduler.interest(url);
    scheduler.tick();
    await settle();
    assert.equal(store.schedules.get(`reviews:${url}`)?.dueAtMs, 60000);
    assert.equal(store.schedules.view(url), undefined);
    scheduler.ensureReviews(url, true);
    assert.equal(
      store.schedules.get(`reviews:${url}`)?.state,
      ScheduleState.Queued,
    );
    release();
  }));
test("completed refresh records its latest attempt and retains old content on the next failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-review-error-"));
  let at = 1000;
  let fail = false;
  const store = new Store(directory, () => at);
  const scheduler = new GitHubScheduler(
    store.schedules,
    defaultSchedulerPolicy,
    () => at,
    () =>
      fail ? Promise.reject(new Error("Offline")) : Promise.resolve(details),
    () => {},
  );
  try {
    scheduler.ensureReviews(url);
    scheduler.tick();
    await settle();
    assert.equal(store.schedules.get(`reviews:${url}`)?.lastAttemptAtMs, 1000);
    fail = true;
    at = 2000;
    scheduler.ensureReviews(url, true);
    scheduler.tick();
    await settle();
    assert.equal(store.schedules.view(url)?.title, "Stored review");
    assert.equal(store.schedules.get(`reviews:${url}`)?.lastAttemptAtMs, 2000);
    assert.equal(store.schedules.get(`reviews:${url}`)?.lastError, "Offline");
  } finally {
    await scheduler.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("cold authentication cannot compress physical HTTP sends below the configured spacing", () =>
  fixture(async (_store, scheduler, time) => {
    let at = 0;
    let authenticate: ((token: string) => void) | undefined;
    const sent: number[] = [];
    const transport = sdkTransport(
      () =>
        new Promise<string>((resolve) => {
          authenticate = resolve;
        }),
      () => {
        sent.push(at);
        return Promise.resolve(
          new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      },
    );
    const reader = new GitHubReads(transport, () => at);
    reader.setDispatcher(scheduler);
    const first = reader.read("repos/o/r/pulls/1"),
      second = reader.read("repos/o/r/pulls/2");
    scheduler.tick();
    await settle();
    at = 3000;
    time(at);
    assert.ok(authenticate !== undefined);
    authenticate("synthetic-token");
    await first;
    await settle();
    at = 4000;
    time(at);
    scheduler.tick();
    await settle();
    assert.deepEqual(sent, [3000]);
    at = 5000;
    time(at);
    scheduler.tick();
    await second;
    assert.deepEqual(sent, [3000, 5000]);
  }));
