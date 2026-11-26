import { asyncFixture } from "./support/async-fixture.js";
import { present } from "./support/present.js";
import { Handoffs } from "../src/integrations/handoffs.js";
import { WorkScheduler } from "../src/scheduling/work.js";
import { actionNotice, renderNotice } from "../src/security/notifications.js";
import { GitHubScheduler } from "../src/scheduling/service.js";
import { defaultSchedulerPolicy } from "../src/scheduling/contracts.js";
import { readFailureExcerpt } from "../src/tracking/messages.js";
import { shortId } from "../src/tracking/identifiers.js";
import { test, spyOn } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/coordinator/store.js";
import { TrackingService } from "../src/tracking/service.js";
import { DeliveryError, type AgentConnection } from "../src/agents/codex.js";
import { ActionState, DeliveryState, type ObservationInput } from "../src/tracking/types.js";
import { defaultTrackingConfig } from "../src/tracking/config.js";

const input: ObservationInput = {
  observedAt: 1000,
  headSha: "head",
  baseSha: "base",
  lifecycle: "open",
  mergeability: "conflicting",
  checks: { state: "complete", value: [] },
  reviews: { state: "complete", value: [] },
};
const target = { harness: "codex", endpoint: "local", sessionId: "owner" };
const url = "https://github.com/owner/repo/pull/1";

async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail("Timed out waiting for delivery");
}

function connection(patch: Partial<AgentConnection> = {}): AgentConnection {
  return {
    prepare: asyncFixture(() => ({ busy: false, version: "0.167.0" })),
    send: asyncFixture(() => ({ turnId: "triage-turn" })),
    find: asyncFixture(() => ({ found: false })),
    close: () => {},
    ...patch,
  };
}

test("busy threads wait, delivery acceptance is not acknowledgment, and origin settings are untouched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "octo-delivery-"));
  let at = 1000;
  const store = new Store(dir, () => at);
  const config = defaultTrackingConfig();
  let busy = true,
    sends = 0;
  const p = store.tracking.track(url, target);
  store.tracking.observe(p.id, input, config);
  const service = new TrackingService(store.tracking, config, () => at, {
    read: asyncFixture(() => input),
    connect: () =>
      connection({
        prepare: asyncFixture(() => ({ busy, version: "0.167.0" })),
        send: asyncFixture((agent, id, message) => {
          sends++;
          assert.equal(agent.sessionId, "owner");
          assert(message.includes("Merge conflict"));
          assert(message.includes(`octo-manager read ${shortId(id)}`));
          return { turnId: "turn" };
        }),
      }),
  });
  try {
    service.tick();
    await until(
      () =>
        present(store.tracking.deliveries()[0]).progress.state === DeliveryState.Pending &&
        present(store.tracking.deliveries()[0]).updatedAt === at,
    );
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(sends, 0);
    busy = false;
    at += 5000;
    service.tick();
    await until(() => present(store.tracking.deliveries()[0]).progress.state === DeliveryState.Delivered);
    assert.equal(present(store.tracking.actions()[0]).progress.state, ActionState.Open);
    assert.equal(sends, 1);
    assert.equal(present(store.tracking.attempts()[0]).harnessVersion, "0.167.0");
    store.tracking.progress(present(store.tracking.actions()[0]).id, p.ownerAgentId, false);
    assert.equal(present(store.tracking.actions()[0]).progress.state, ActionState.Acknowledged);
  } finally {
    await service.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("reassignment during an ambiguous send preserves attempt evidence and does not notify the old owner again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "octo-race-"));
  const store = new Store(dir);
  const config = defaultTrackingConfig();
  const p = store.tracking.track(url, target);
  store.tracking.observe(p.id, input, config);
  let rejectSend!: (e: Error) => void;
  let entered = false;
  const service = new TrackingService(store.tracking, config, Date.now, {
    read: asyncFixture(() => input),
    connect: () =>
      connection({
        send: asyncFixture(() => {
          entered = true;
          return new Promise<never>((_, reject) => {
            rejectSend = reject;
          });
        }),
      }),
  });
  try {
    service.tick();
    await until(() => entered);
    store.tracking.assign(p.id, { ...target, sessionId: "new-owner" });
    rejectSend(new DeliveryError("Lost response", true));
    await until(() => present(store.tracking.attempts()[0]).outcome.state === "uncertain");
    assert.equal(present(store.tracking.deliveries()[0]).progress.state, DeliveryState.Cancelled);
    assert.equal(present(store.tracking.deliveries()[1]).progress.state, DeliveryState.Pending);
  } finally {
    await service.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("uncertain sends are reconciled after restart without blindly resending", async () => {
  const dir = await mkdtemp(join(tmpdir(), "octo-unknown-"));
  let at = 1000;
  let store = new Store(dir, () => at);
  const config = defaultTrackingConfig();
  const p = store.tracking.track(url, target);
  store.tracking.observe(p.id, input, config);
  let sends = 0;
  let service = new TrackingService(store.tracking, config, () => at, {
    read: asyncFixture(() => input),
    connect: () =>
      connection({
        send: asyncFixture(() => {
          sends++;
          throw new DeliveryError("Lost acceptance", true);
        }),
      }),
  });
  try {
    service.tick();
    await until(() => present(store.tracking.deliveries()[0]).progress.state === DeliveryState.Uncertain);
    await service.close();
    store.close();
    store = new Store(dir, () => at);
    service = new TrackingService(store.tracking, config, () => at, {
      read: asyncFixture(() => input),
      connect: () =>
        connection({
          find: asyncFixture(() => ({
            found: true,
            queueId: "accepted-before-restart",
            note: "Queue admission only",
          })),
          send: asyncFixture(() => {
            sends++;
            return {};
          }),
        }),
    });
    at += 60000;
    service.tick();
    await until(() => present(store.tracking.deliveries()[0]).progress.state === DeliveryState.Delivered);
    assert.equal(sends, 1);
    const progress = store.tracking.deliveries()[0]?.progress;
    assert(progress?.state === DeliveryState.Delivered);
    assert.equal(progress.queueId, "accepted-before-restart");
    assert.equal(progress.note, "Queue admission only");
    assert.equal(store.tracking.actions()[0]?.progress.state, ActionState.Open);
  } finally {
    await service.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("durable messages keep retrying transient failures and explicit retry resets rejected delivery backoff", async () => {
  const dir = await mkdtemp(join(tmpdir(), "octo-retry-"));
  let permanent = false;
  let at = 1000;
  const store = new Store(dir, () => at);
  const config = defaultTrackingConfig();
  const p = store.tracking.track(url, target);
  store.tracking.observe(p.id, input, config);
  const service = new TrackingService(store.tracking, config, () => at, {
    read: asyncFixture(() => input),
    connect: () =>
      connection({
        prepare: asyncFixture(() => {
          throw new DeliveryError("Offline", false, permanent);
        }),
      }),
  });
  try {
    for (let i = 1; i <= 4; i++) {
      service.tick();
      await until(() => store.tracking.attempts().length === i);
      await new Promise((r) => setTimeout(r, 5));
      at += 200000;
    }
    assert.equal(store.tracking.deliveries()[0]?.progress.state, DeliveryState.Pending);
    permanent = true;
    service.tick();
    await until(() => store.tracking.attempts().length === 5);
    assert.equal(store.tracking.deliveries()[0]?.progress.state, DeliveryState.Unavailable);
    permanent = false;
    store.tracking.retryDelivery(present(store.tracking.deliveries()[0]).id);
    service.tick();
    await until(() => store.tracking.attempts().length === 6);
    assert.equal(present(store.tracking.deliveries()[0]).progress.state, DeliveryState.Pending);
  } finally {
    await service.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("shutdown aborts an in-flight GitHub refresh", async () => {
  const dir = await mkdtemp(join(tmpdir(), "octo-shutdown-"));
  const store = new Store(dir);
  const config = defaultTrackingConfig();
  const p = store.tracking.track(url, target);
  let signal: AbortSignal | undefined;
  const service = new TrackingService(store.tracking, config, Date.now, {
    read: async (_url, s) => {
      signal = s;
      return new Promise((_, reject) => {
        present(s).addEventListener(
          "abort",
          () => {
            reject(new Error("aborted"));
          },
          {
            once: true,
          },
        );
      });
    },
  });
  try {
    const refresh = service.refresh(p.id);
    await until(() => signal !== undefined);
    await service.close();
    await refresh;
    assert(present(signal).aborted);
  } finally {
    await service.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("queue admission preserves its receipt across restart without acknowledging the action", async () => {
  const dir = await mkdtemp(join(tmpdir(), "octo-queue-"));
  let store = new Store(dir);
  const config = defaultTrackingConfig();
  const pr = store.tracking.track(url, target);
  store.tracking.observe(pr.id, input, config);
  const receipt = { queueId: "queue-receipt", note: "Queue admission only" };
  const service = new TrackingService(store.tracking, config, Date.now, {
    read: () => Promise.resolve(input),
    connect: () => connection({ send: () => Promise.resolve(receipt) }),
  });
  try {
    service.tick();
    await until(() => store.tracking.deliveries()[0]?.progress.state === DeliveryState.Delivered);
    await service.close();
    store.close();
    store = new Store(dir);
    const delivery = store.tracking.deliveries()[0];
    assert(delivery?.progress.state === DeliveryState.Delivered);
    assert.equal(delivery.progress.queueId, receipt.queueId);
    assert.equal(delivery.progress.note, receipt.note);
    assert.equal(store.tracking.actions()[0]?.progress.state, ActionState.Open);
    const attempt = store.tracking.attempts()[0];
    assert(attempt?.outcome.state === "accepted");
    assert.equal(attempt.outcome.queueId, receipt.queueId);
  } finally {
    await service.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("automatic notices do not request external log enrichment during cooldown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "octo-enrichment-"));
  const store = new Store(dir, () => 1000);
  const scheduler = new GitHubScheduler(
    store.schedules,
    defaultSchedulerPolicy,
    () => 1000,
    () => Promise.reject(new Error("No review reads expected")),
    () => {},
  );
  scheduler.defer("core", 3601000);
  const config = defaultTrackingConfig();
  const failed: ObservationInput = {
    ...input,
    mergeability: "mergeable",
    checks: {
      state: "complete",
      value: [
        {
          id: "ci",
          key: "CI",
          name: "CI",
          headSha: "head",
          status: "completed",
          conclusion: "failure",
          at: 1000,
          url: "https://github.com/owner/repo/actions/runs/1/job/2",
        },
      ],
    },
  };
  const first = store.tracking.track(url, target);
  store.tracking.observe(first.id, failed, config);
  const second = store.tracking.track("https://github.com/owner/repo/pull/2", target);
  store.tracking.observe(second.id, input, config);
  const action = store.tracking
    .actions()
    .find((value) => value.prId === first.id && value.blocker.kind === "check_failed");
  assert.ok(action !== undefined);
  const firstDelivery = store.tracking.deliveries().find((value) => value.actionId === action.id);
  assert.ok(firstDelivery !== undefined);
  const other = store.tracking.deliveries().find((value) => store.tracking.action(value.actionId).prId === second.id);
  assert.ok(other !== undefined);
  for (const delivery of store.tracking.deliveries())
    if (delivery.id !== firstDelivery.id) {
      const cachedAction = store.tracking.action(delivery.actionId);
      const notice = actionNotice(cachedAction, store.tracking.pr(cachedAction.prId).url);
      store.tracking.inbox.freezeNotice(delivery.id, notice);
      store.tracking.inbox.record(delivery.id, renderNotice(notice, delivery.id, cachedAction.id));
    }
  const completed = Promise.withResolvers<undefined>();
  let dispatched = 0;
  const sent: string[] = [];
  const service = new TrackingService(store.tracking, config, () => 1000, {
    read: (pr) => Promise.resolve(pr === url ? failed : input),
    failureExcerpt: (value, pr, signal) =>
      readFailureExcerpt(value, pr, signal, (_repository, _run, _job, abort) =>
        scheduler.dispatch(
          "core",
          () => {
            dispatched++;
            return Promise.resolve("Error: should not dispatch");
          },
          abort,
        ),
      ).finally(() => {
        completed.resolve(undefined);
      }),
    connect: () =>
      connection({
        send: (_agent, id) => {
          sent.push(id);
          return Promise.resolve({ turnId: "delivered" });
        },
      }),
  });
  try {
    service.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(scheduler.status().queuedRequests, 0);
    await until(() => sent.includes(firstDelivery.id));
    service.tick();
    await until(() => sent.includes(other.id));
    assert.equal(dispatched, 0);
    assert.equal(scheduler.status().queuedRequests, 0);
    assert.equal(scheduler.deadline("core"), 3601000);
  } finally {
    await service.close();
    await scheduler.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 10000);

test("local Pi tracking stores an inbox message without opening a Codex connection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "octo-pi-inbox-"));
  const store = new Store(dir, () => 1000);
  const config = defaultTrackingConfig();
  let connections = 0;
  const service = new TrackingService(store.tracking, config, () => 1000, {
    read: () => Promise.resolve(input),
    connect: () => {
      connections++;
      throw new Error("Pi messages must stay in the pull inbox");
    },
  });
  try {
    const pi = {
      harness: "pi",
      endpoint: "local",
      sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    };
    assert.throws(() => service.track(url, { ...pi, endpoint: "remote" }), /Unsupported/u);
    const tracked = service.track(url, pi);
    assert.equal(store.tracking.agent(tracked.ownerAgentId).harness, "pi");
    store.tracking.observe(tracked.id, input, config);
    service.tick();
    await until(() => store.tracking.inbox.list(tracked.ownerAgentId).messages.length > 0);
    const [notice] = store.tracking.inbox.list(tracked.ownerAgentId).messages;
    assert(notice !== undefined);
    assert.equal(connections, 0);
    assert.equal(notice.acknowledgedAt, undefined);
    store.tracking.acknowledgeMessage(notice.id, tracked.ownerAgentId);
    assert.equal(store.tracking.inbox.get(notice.id)?.acknowledgedAt, 1000);
  } finally {
    await service.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("shared tracking work rearms a busy delivery at its five-second deadline without idle completion loops", async () => {
  const dir = await mkdtemp(join(tmpdir(), "octo-delivery-deadline-"));
  let at = 1000;
  const store = new Store(dir, () => at);
  const config = defaultTrackingConfig();
  const p = store.tracking.track(url, target);
  store.tracking.observe(p.id, input, config);
  let preparations = 0;
  const plans: number[] = [];
  const scheduler = new WorkScheduler(
    () => at,
    undefined,
    (key, work) => {
      const result = work();
      if (key === "tracking" && typeof result === "number") plans.push(result);
      return result;
    },
  );
  const service = new TrackingService(store.tracking, config, () => at, {
    read: () => Promise.resolve(input),
    connect: () =>
      connection({
        prepare: () => {
          preparations++;
          return Promise.resolve({ busy: true });
        },
      }),
  });
  try {
    service.start(scheduler);
    scheduler.start();
    await until(() => plans.includes(6000));
    assert.equal(preparations, 1);
    const settled = plans.length;
    await Bun.sleep(30);
    assert.equal(plans.length, settled);
    assert.equal(preparations, 1);
    at = 6000;
    service.wake();
    await until(() => plans.includes(11000));
    assert.equal(preparations, 2);
  } finally {
    scheduler.stop();
    await service.close();
    await scheduler.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("tracking sleeps without work and preserves unrelated delivery throttles across input wakes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "octo-tracking-input-wake-"));
  const at = 1000;
  const store = new Store(dir, () => at);
  const config = defaultTrackingConfig();
  const attempts = new Map<string, number>();
  const scheduler = new WorkScheduler(() => at);
  const service = new TrackingService(store.tracking, config, () => at, {
    read: () => Promise.resolve(input),
    connect: () =>
      connection({
        prepare: (agent) => {
          attempts.set(agent.sessionId, (attempts.get(agent.sessionId) ?? 0) + 1);
          return Promise.resolve({ busy: false });
        },
      }),
  });
  try {
    assert.equal(service.tick(), undefined);
    const first = store.tracking.track(url, target);
    const second = store.tracking.track("https://github.com/owner/repo/pull/2", {
      ...target,
      sessionId: "second-owner",
    });
    for (const pr of [first, second]) store.tracking.observe(pr.id, input, config);
    // A retained legacy body without a typed notice cannot advance through direct delivery.
    for (const delivery of store.tracking.deliveries())
      store.tracking.inbox.record(delivery.id, "Retained legacy notification");
    service.start(scheduler);
    scheduler.start();
    await until(() => attempts.get("owner") === 1 && attempts.get("second-owner") === 1);
    await Bun.sleep(20);
    service.wake();
    await Bun.sleep(20);
    assert.deepEqual(
      [...attempts],
      [
        ["owner", 1],
        ["second-owner", 1],
      ],
    );
    service.inputsChanged(second.id);
    await until(() => attempts.get("second-owner") === 2);
    assert.equal(attempts.get("owner"), 1);
  } finally {
    scheduler.stop();
    await service.close();
    await scheduler.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a handoff arriving during an active drain coalesces a prompt follow-up", async () => {
  const dir = await mkdtemp(join(tmpdir(), "octo-handoff-during-drain-"));
  const store = new Store(dir);
  const scheduler = new WorkScheduler();
  let release: (() => void) | undefined;
  let watching = false;
  let notify: (() => void) | undefined;
  const handoffs = new Handoffs(dir);
  const originalWatch = handoffs.watch.bind(handoffs);
  const watch = spyOn(Handoffs.prototype, "watch").mockImplementation(async (changed, failed) => {
    notify = changed;
    const watcher = await originalWatch(changed, failed);
    watching = true;
    return watcher;
  });
  const drain = spyOn(Handoffs.prototype, "drain").mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const service = new TrackingService(store.tracking, defaultTrackingConfig(), Date.now, {
    stateDirectory: dir,
    read: () => Promise.reject(new Error("Controlled unavailable provider")),
  });
  try {
    service.start(scheduler);
    scheduler.start();
    await until(() => watching && release !== undefined);
    await Bun.sleep(20);
    await new Handoffs(dir).enqueue(url, target, "/tmp");
    assert(notify !== undefined);
    notify();
    await Bun.sleep(20);
    assert(release !== undefined);
    release();
    await until(() => store.tracking.prs().length === 1);
    assert.equal(store.tracking.prs()[0]?.url, url);
  } finally {
    release?.();
    scheduler.stop();
    await service.close();
    await scheduler.close();
    drain.mockRestore();
    watch.mockRestore();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
