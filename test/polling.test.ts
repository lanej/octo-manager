import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { TrackingService } from "../src/tracking/service.js";
import { defaultTrackingConfig } from "../src/tracking/config.js";
import {
  defaultPollPolicy,
  schedulePoll,
  type PollState,
} from "../src/tracking/polling.js";
import type { ObservationInput } from "../src/tracking/types.js";
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
