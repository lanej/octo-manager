import {
  defaultTrackingConfig,
  loadTrackingConfig,
} from "../src/tracking/config.js";
import { WorkScheduler } from "../src/scheduling/work.js";
import { GitHubRequestCancelledError } from "../src/github/errors.js";
import { sdkTransport } from "../src/github/sdk.js";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/coordinator/store.js";
import { GitHubScheduler } from "../src/scheduling/service.js";
import {
  defaultSchedulerPolicy,
  RefreshKind,
  ScheduleState,
} from "../src/scheduling/contracts.js";
import { GitHubReads } from "../src/github/reads.js";
import {
  createApplicationFixture,
  type ApplicationFixture,
} from "./support/application.js";
import { schedulerClient } from "../src/client.js";
import type { WatchDashboardResponse } from "../src/gen/octomanager/v2/scheduler_pb.js";

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
    const rejected = assert.rejects(cancelled, GitHubRequestCancelledError);
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
test("dashboard frames update automatically and cached refresh RPCs share request admission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-dashboard-stream-"));
  let calls = 0;
  let finish: ((value: typeof details) => void) | undefined;
  const config = defaultTrackingConfig();
  config.polling = {
    minimumMs: 60000,
    maximumMs: 900000,
    activeMaximumMs: 120000,
    tickMs: 100,
    requestSpacingMs: 100,
  };
  const coordinator: ApplicationFixture = await createApplicationFixture(
    directory,
    {
      trackingConfig: config,
      reviewReader: () =>
        coordinator.githubScheduler.dispatch("core", () => {
          calls++;
          return new Promise<typeof details>((resolve) => {
            finish = resolve;
          });
        }),
    },
  );
  const controller = new AbortController();
  try {
    coordinator.store.schedules.saveDispatch({
      ...coordinator.store.schedules.dispatch(),
      nextAtMs: Date.now() + 60000,
    });
    await coordinator.start();
    const client = schedulerClient(directory);
    const initial = await client.getPullRequest({ url, refresh: true });
    assert.equal(initial.pullRequest, undefined);
    assert.equal(calls, 0);
    const queuedDeadline = Date.now() + 1000;
    while (
      coordinator.githubScheduler.status().queuedRequests === 0 &&
      Date.now() < queuedDeadline
    )
      await Bun.sleep(5);
    assert.equal(coordinator.githubScheduler.status().queuedRequests, 1);
    for (let i = 0; i < 3; i++) {
      const response = await client.getPullRequest({ url, refresh: true });
      assert.equal(response.pullRequest, undefined);
    }
    const frames = client.watchDashboard(
      { url, reviews: true },
      {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1500)]),
      },
    );
    const stream = frames[Symbol.asyncIterator]();
    const first = await stream.next();
    assert.equal(first.done, false);
    assert.equal(first.value.pullRequest, undefined);
    coordinator.store.schedules.saveDispatch({
      ...coordinator.store.schedules.dispatch(),
      nextAtMs: Date.now(),
    });
    await client.getPullRequest({ url, refresh: true });
    const deadline = Date.now() + 1000;
    while (finish === undefined && Date.now() < deadline) await Bun.sleep(5);
    assert.equal(calls, 1);
    assert(
      finish !== undefined,
      "shared dispatcher did not admit the queued request",
    );
    finish(details);
    let frame = await stream.next();
    while (frame.done !== true && frame.value.pullRequest === undefined)
      frame = await stream.next();
    assert.equal(frame.done, false);
    assert.equal(frame.value.pullRequest?.title, "Stored review");
    assert((frame.value.snapshot?.githubScheduler?.tickSequence ?? 0n) > 0n);
    controller.abort();
    await stream.return?.();
    await settle();
    const cached = await client.getPullRequest({ url });
    assert.equal(cached.pullRequest?.title, "Stored review");
    assert.equal(calls, 1);
    assert.equal(coordinator.githubScheduler.status().queuedRequests, 0);
  } finally {
    controller.abort();
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

test("review ticks isolate tracking history and run newly queued work without dashboard interest", () =>
  fixture(async (store, scheduler) => {
    const db = new DatabaseSync(join(store.directory, "jobs.sqlite"));
    try {
      for (let index = 0; index < 96; index++)
        store.schedules.save({
          key: `tracking:archived-${String(index)}`,
          kind: RefreshKind.Tracking,
          subject: `archived-${String(index)}`,
          dueAtMs: 0,
          intervalMs: 60000,
          state: ScheduleState.Deferred,
        });
      db.prepare(
        "UPDATE github_schedules SET data=json_remove(data,'$.intervalMs') WHERE kind='tracking'",
      ).run();
      assert.throws(
        () => store.schedules.list(),
        /Invalid stored GitHub schedule data/,
      );
      assert.deepEqual(store.schedules.reviews(), []);
      scheduler.tick();
      await settle();
      scheduler.ensureReviews(url);
      scheduler.tick();
      await settle();
      assert.equal(store.schedules.view(url)?.title, "Stored review");
      assert.equal(store.schedules.reviews().length, 1);
      const key = `reviews:${url}`;
      db.prepare(
        "UPDATE github_schedules SET data=json_remove(data,'$.intervalMs') WHERE key=?",
      ).run(key);
      assert.throws(() => {
        scheduler.tick();
      }, /Invalid stored GitHub schedule data/);
    } finally {
      db.close();
    }
  }));

test("review selection preserves payload kind authority across mismatched normalized kinds", () =>
  fixture(async (store, scheduler) => {
    const db = new DatabaseSync(join(store.directory, "jobs.sqlite"));
    const key = `reviews:${url}`;
    try {
      scheduler.ensureReviews(url);
      db.prepare("UPDATE github_schedules SET kind='tracking' WHERE key=?").run(
        key,
      );
      assert.equal(store.schedules.reviews()[0]?.kind, RefreshKind.Reviews);
      scheduler.tick();
      await settle();
      assert.equal(store.schedules.view(url)?.title, "Stored review");
      assert.equal(store.schedules.get(key)?.state, ScheduleState.Deferred);
      db.prepare(
        "UPDATE github_schedules SET kind='reviews',data=json_remove(data,'$.kind') WHERE key=?",
      ).run(key);
      assert.throws(() => {
        scheduler.tick();
      }, /Invalid stored GitHub schedule data/);
    } finally {
      db.close();
    }
  }));

test("shared work scheduler wakes GitHub requests and rearms their spacing deadline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-shared-dispatch-"));
  const store = new Store(directory);
  const work = new WorkScheduler();
  const scheduler = new GitHubScheduler(
    store.schedules,
    { ...defaultSchedulerPolicy, requestSpacingMs: 20 },
    Date.now,
    () => Promise.resolve(details),
    () => {},
  );
  const starts: number[] = [];
  try {
    scheduler.start(work);
    work.start();
    await Promise.all(
      [1, 2, 3].map((value) =>
        scheduler.dispatch("core", () => {
          starts.push(Date.now());
          return Promise.resolve(value);
        }),
      ),
    );
    assert.equal(starts.length, 3);
    assert((starts[1] ?? 0) - (starts[0] ?? 0) >= 20);
    assert((starts[2] ?? 0) - (starts[1] ?? 0) >= 20);
  } finally {
    work.stop();
    await scheduler.close();
    await work.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("heartbeat defaults to five seconds independently of request pacing", async () => {
  assert.equal(defaultSchedulerPolicy.tickMs, 5000);
  const directory = await mkdtemp(join(tmpdir(), "octo-heartbeat-config-"));
  const path = join(directory, "config.json");
  try {
    await writeFile(path, JSON.stringify({ polling: {} }));
    assert.equal(loadTrackingConfig(path).polling?.tickMs, 5000);
    assert.equal(loadTrackingConfig(path).polling?.requestSpacingMs, 2000);
    await writeFile(
      path,
      JSON.stringify({ polling: { tickMs: 100, requestSpacingMs: 200 } }),
    );
    assert.equal(loadTrackingConfig(path).polling?.tickMs, 100);
    for (const requestSpacingMs of [-1, 0, 99]) {
      await writeFile(path, JSON.stringify({ polling: { requestSpacingMs } }));
      assert.throws(
        () => loadTrackingConfig(path),
        /Invalid scheduler cadence/,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "dashboard subscribers share retained state across heartbeats and stop liveness work when disconnected",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "octo-dashboard-retained-"));
    const config = defaultTrackingConfig();
    config.polling = {
      minimumMs: 60000,
      maximumMs: 900000,
      activeMaximumMs: 120000,
      tickMs: 25,
      requestSpacingMs: 100,
    };
    const application = await createApplicationFixture(directory, {
      trackingConfig: config,
    });
    const controller = new AbortController();
    const nextFrame = async (stream: AsyncIterator<WatchDashboardResponse>) => {
      const result = await stream.next();
      if (result.done === true)
        throw new Error("Dashboard stream ended before its next frame");
      return result.value;
    };
    try {
      await application.start();
      application.command({ op: "pause" });
      await Bun.sleep(20);
      const original = application.store.jobs.bind(application.store);
      let reads = 0;
      application.store.jobs = () => {
        reads++;
        return original();
      };
      const client = schedulerClient(directory);
      const firstUpdates = client.watchDashboard(
        {},
        { signal: controller.signal },
      );
      const secondUpdates = client.watchDashboard(
        {},
        { signal: controller.signal },
      );
      const first = firstUpdates[Symbol.asyncIterator]();
      const second = secondUpdates[Symbol.asyncIterator]();
      await nextFrame(first);
      await nextFrame(second);
      assert.equal(
        reads,
        1,
        "a second subscriber must reuse the full projection",
      );
      const frame = await nextFrame(first);
      await nextFrame(second);
      assert.equal(
        reads,
        1,
        "liveness frames must not reread full dashboard state",
      );
      assert((frame.snapshot?.githubScheduler?.tickSequence ?? 0n) > 0n);
      application.store.event(
        "",
        "dashboard_event",
        "invalidate the retained projection",
      );
      let changed = await nextFrame(first);
      while (
        changed.snapshot?.recentEvents.every(
          (event) => event.kind !== "dashboard_event",
        ) === true
      )
        changed = await nextFrame(first);
      const secondChanged = await nextFrame(second);
      assert(
        secondChanged.snapshot?.recentEvents.some(
          (event) => event.kind === "dashboard_event",
        ) === true,
      );
      assert.equal(
        reads,
        2,
        "one committed change needs one shared projection rebuild",
      );
      controller.abort();
      await first.return?.();
      await second.return?.();
      const deadline = Date.now() + 1000;
      while (
        application.githubScheduler.status().nextTickAtMs !== 0 &&
        Date.now() < deadline
      )
        await Bun.sleep(5);
      assert.equal(application.githubScheduler.status().nextTickAtMs, 0);
      const sequence = application.githubScheduler.status().tickSequence;
      await Bun.sleep(75);
      assert.equal(application.githubScheduler.status().tickSequence, sequence);
    } finally {
      controller.abort();
      await application.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  process.env["CI"] === undefined ? 2500 : 10000,
);
