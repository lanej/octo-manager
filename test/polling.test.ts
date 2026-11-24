import { test, spyOn } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.js";
import { TrackingService } from "../src/tracking/service.js";
import { defaultTrackingConfig } from "../src/tracking/config.js";
import {
  defaultPollPolicy,
  schedulePoll,
  type PollState,
} from "../src/tracking/polling.js";
import type { ObservationInput } from "../src/tracking/types.js";
import { RefreshKind, ScheduleState } from "../src/scheduling/contracts.js";
import { TrackingState } from "../src/tracking/retirement.js";
const url = "https://github.com/owner/repo/pull/1";
function observation(head = "head"): ObservationInput {
  return {
    observedAt: 1,
    headSha: head,
    baseSha: "base",
    targetBase: { ref: "main", sha: "base" },
    lifecycle: "open",
    mergeability: "mergeable",
    checks: { state: "complete", value: [] },
    reviews: { state: "complete", value: [] },
    feedback: { state: "complete", value: [] },
    workflows: { state: "complete", value: [] },
  };
}
test("idle polling doubles to a bounded ceiling and resets on meaningful changes", () => {
  let state: PollState | undefined;
  for (const expected of [60000, 120000, 240000, 480000, 900000, 900000]) {
    state = schedulePoll(
      state,
      0,
      observation(),
      0,
      defaultPollPolicy,
      "poll",
      0,
    );
    assert.equal(state.intervalMs, expected);
  }
  state = schedulePoll(
    state,
    0,
    { ...observation(), observedAt: 99 },
    0,
    defaultPollPolicy,
    "poll",
    0,
  );
  assert.equal(state.intervalMs, 900000);
  state = schedulePoll(
    state,
    0,
    observation("new-head"),
    0,
    defaultPollPolicy,
    "poll",
    0,
  );
  assert.equal(state.intervalMs, 60000);
  state = schedulePoll(
    state,
    1,
    observation("new-head"),
    0,
    defaultPollPolicy,
    "poll",
    0,
  );
  assert.equal(state.intervalMs, 60000);
});
test("pending checks cap backoff while manual refresh and hard rate cooldown remain distinct", () => {
  const input = observation();
  input.checks = {
    state: "complete",
    value: [
      {
        id: "run:1",
        key: "run:CI",
        name: "CI",
        headSha: "head",
        status: "in_progress",
        conclusion: "",
        at: 1,
        url,
      },
    ],
  };
  let state: PollState | undefined;
  for (let i = 0; i < 8; i++)
    state = schedulePoll(state, 0, input, 0, defaultPollPolicy, "poll", 0);
  assert.equal(state?.intervalMs, 120000);
  state = schedulePoll(state, 0, input, 0, defaultPollPolicy, "manual", 999999);
  assert.equal(state.intervalMs, 60000);
  assert.equal(state.nextAt, 999999);
  state = schedulePoll(state, 0, undefined, 0, defaultPollPolicy, "poll", 0);
  assert.equal(state.intervalMs, 120000);
  state = schedulePoll(state, 0, undefined, 0, defaultPollPolicy, "poll", 0);
  assert.equal(state.intervalMs, 120000);
  state = schedulePoll(state, 0, undefined, 0, defaultPollPolicy, "manual", 0);
  assert.equal(state.intervalMs, 60000);
});
test("the real tracker skips unchanged PRs until their schedule is due and refreshes hints immediately", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-polling-"));
  let now = 0,
    calls = 0;
  const store = new Store(directory, () => now),
    config = defaultTrackingConfig();
  config.endpoints = {};
  const pr = store.tracking.track(url, {
    harness: "codex",
    endpoint: "local",
    sessionId: "polling",
  });
  let current = observation();
  const service = new TrackingService(store.tracking, config, () => now, {
    read() {
      calls++;
      return Promise.resolve({ ...current, observedAt: now });
    },
  });
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  try {
    service.tick();
    await settle();
    assert.equal(calls, 1);
    now = 60000;
    service.tick();
    await settle();
    assert.equal(calls, 2);
    now = 120000;
    service.tick();
    await settle();
    assert.equal(calls, 2);
    now = 180000;
    service.tick();
    await settle();
    assert.equal(calls, 3);
    now = 240000;
    await service.refresh(pr.id);
    assert.equal(calls, 4);
    now = 300000;
    service.tick();
    await settle();
    assert.equal(calls, 5);
    current = observation("changed");
    now = 420000;
    service.tick();
    await settle();
    assert.equal(calls, 6);
    now = 480000;
    service.tick();
    await settle();
    assert.equal(calls, 7);
  } finally {
    await service.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("idle tracking schedule reads stay bounded by active PRs and see freshly queued archived work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-idle-schedules-"));
  const store = new Store(directory, () => 1000);
  const external = new DatabaseSync(join(directory, "jobs.sqlite"));
  const config = defaultTrackingConfig();
  config.endpoints = {};
  const owner = { harness: "codex", endpoint: "local", sessionId: "idle" };
  const archived: string[] = [];
  let reads = 0;
  const service = new TrackingService(store.tracking, config, () => 1000, {
    schedules: store.schedules,
    read: () => {
      reads++;
      return Promise.resolve({ ...observation(), lifecycle: "closed" });
    },
  });
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const prepare = spyOn(DatabaseSync.prototype, "prepare");
  try {
    for (let number = 1; number <= 96; number++) {
      const pr = store.tracking.track(
        `https://github.com/owner/repo/pull/${String(number)}`,
        owner,
      );
      const closed = { ...observation(), lifecycle: "closed" } as const;
      store.tracking.observe(pr.id, closed, config);
      store.tracking.observe(pr.id, closed, config);
      assert.equal(store.tracking.pr(pr.id).state, TrackingState.Archived);
      archived.push(pr.id);
      store.schedules.save({
        key: `tracking:${pr.id}`,
        kind: RefreshKind.Tracking,
        subject: pr.id,
        dueAtMs: 1000,
        intervalMs: 60000,
        epoch: store.tracking.pr(pr.id).trackingEpoch,
        state: ScheduleState.Deferred,
      });
    }
    const idleReads = async (expected: number) => {
      prepare.mockClear();
      service.tick();
      await settle();
      assert.equal(
        prepare.mock.calls.filter(([sql]) =>
          /SELECT .* FROM github_schedules/.test(sql),
        ).length,
        expected,
      );
    };
    await idleReads(1);
    assert.equal(reads, 0);
    const active = store.tracking.track(
      "https://github.com/owner/repo/pull/97",
      owner,
    );
    store.schedules.save({
      key: `tracking:${active.id}`,
      kind: RefreshKind.Tracking,
      subject: active.id,
      dueAtMs: 999999,
      intervalMs: 60000,
      epoch: active.trackingEpoch,
      state: ScheduleState.Deferred,
    });
    await idleReads(2);
    assert.equal(reads, 0);
    const id = archived[0];
    if (id === undefined) throw new Error("Missing archived fixture PR");
    external
      .prepare(
        "UPDATE github_schedules SET state='queued',data=json_set(data,'$.state','queued','$.subject','unrelated') WHERE key=?",
      )
      .run(`tracking:${id}`);
    service.tick();
    await settle();
    assert.equal(reads, 1);
    assert.equal(
      store.schedules.get(`tracking:${id}`)?.state,
      ScheduleState.Deferred,
    );
    await idleReads(2);
    assert.equal(reads, 1);
    external
      .prepare(
        "UPDATE github_schedules SET data=json_remove(data,'$.intervalMs') WHERE key=?",
      )
      .run(`tracking:${active.id}`);
    assert.throws(() => {
      service.tick();
    }, /Invalid stored GitHub schedule data/);
    external
      .prepare(
        "UPDATE github_schedules SET state='queued',data=json_set(json_remove(data,'$.intervalMs'),'$.state','queued') WHERE key=?",
      )
      .run(`tracking:${id}`);
    store.tracking.untrack(active.id);
    assert.throws(() => {
      service.tick();
    }, /Invalid stored GitHub schedule data/);
    assert.equal(
      external
        .prepare("SELECT state FROM github_schedules WHERE key=?")
        .get(`tracking:${id}`)?.["state"],
      ScheduleState.Queued,
    );
    external
      .prepare(
        "UPDATE github_schedules SET state='deferred',data=json_set(data,'$.state','deferred','$.intervalMs',60000) WHERE key=?",
      )
      .run(`tracking:${id}`);
    external
      .prepare(
        "UPDATE github_schedules SET state='queued',data=json_set(data,'$.state','queued') WHERE key=?",
      )
      .run(`tracking:${active.id}`);
    await idleReads(1);
    assert.equal(reads, 1);
  } finally {
    prepare.mockRestore();
    await service.close();
    external.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
