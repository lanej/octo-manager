import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/coordinator/store.js";
import { TrackingService } from "../src/tracking/service.js";
import { defaultTrackingConfig } from "../src/tracking/config.js";
import { GitHubObservationChangedError } from "../src/tracking/github.js";
import { GitHubRequestCancelledError } from "../src/github/errors.js";
import type { ObservationInput } from "../src/tracking/types.js";

const input: ObservationInput = {
  observedAt: 1000,
  headSha: "head",
  baseSha: "base",
  lifecycle: "open",
  mergeability: "mergeable",
  checks: { state: "complete", value: [] },
  reviews: { state: "complete", value: [] },
  feedback: { state: "complete", value: [] },
  workflows: { state: "complete", value: [] },
};
const target = { harness: "codex", endpoint: "local", sessionId: "outcomes" };
const url = "https://github.com/owner/repo/pull/1";

test("refresh deferrals retain genuine failures and recover once, including after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-refresh-outcomes-"));
  let now = 1000;
  let store = new Store(directory, () => now);
  const config = defaultTrackingConfig();
  const pr = store.tracking.track(url, target);
  store.tracking.observe(pr.id, input, config);
  const original = store.tracking.pr(pr.id).observation;
  let failure: Error | undefined = new Error("Access denied");
  const createService = () =>
    new TrackingService(store.tracking, config, () => now, {
      schedules: store.schedules,
      read: () =>
        failure === undefined
          ? Promise.resolve({ ...input, observedAt: now })
          : Promise.reject(failure),
    });
  let service = createService();
  const outcomes = () =>
    store.events().filter((event) => event.kind.startsWith("pr_refresh_"));
  try {
    await service.refresh(pr.id, "poll");
    assert.equal(
      store.tracking.pr(pr.id).lastRefreshError?.message,
      "Access denied",
    );
    assert.equal(store.schedules.get(`tracking:${pr.id}`)?.intervalMs, 60000);
    failure = new GitHubObservationChangedError();
    now += 1000;
    await service.refresh(pr.id, "poll");
    assert.equal(store.schedules.get(`tracking:${pr.id}`)?.intervalMs, 120000);
    assert.equal(
      store.schedules.get(`tracking:${pr.id}`)?.deferredReason,
      failure.message,
    );
    assert.equal(
      store.schedules.get(`tracking:${pr.id}`)?.lastError,
      "Access denied",
    );
    assert.equal(
      store.tracking.pr(pr.id).lastRefreshError?.message,
      "Access denied",
    );
    assert.deepEqual(store.tracking.pr(pr.id).observation, original);
    failure = new GitHubRequestCancelledError();
    await service.refresh(pr.id, "poll");
    assert.equal(
      store.schedules.get(`tracking:${pr.id}`)?.deferredReason,
      failure.message,
    );
    assert.equal(
      store.tracking.pr(pr.id).lastRefreshError?.message,
      "Access denied",
    );
    assert.deepEqual(
      outcomes().map((event) => event.kind),
      [
        "pr_refresh_failed",
        "pr_refresh_retry_scheduled",
        "pr_refresh_cancelled",
      ],
    );
    await service.close();
    store.close();
    store = new Store(directory, () => now);
    service = createService();
    failure = undefined;
    now += 1000;
    await service.refresh(pr.id);
    assert.equal(store.tracking.pr(pr.id).lastRefreshError, undefined);
    assert.equal(
      store.schedules.get(`tracking:${pr.id}`)?.deferredReason,
      undefined,
    );
    assert.equal(
      store.schedules.get(`tracking:${pr.id}`)?.lastError,
      undefined,
    );
    assert.equal(outcomes().at(-1)?.kind, "pr_refresh_recovered");
    await service.refresh(pr.id);
    assert.equal(
      outcomes().filter((event) => event.kind === "pr_refresh_recovered")
        .length,
      1,
    );
  } finally {
    await service.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("shutdown cancellation is recorded without replacing a prior failure or claiming recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-refresh-cancel-"));
  const store = new Store(directory);
  const config = defaultTrackingConfig();
  const pr = store.tracking.track(url, target);
  store.tracking.observe(pr.id, input, config);
  store.tracking.refreshError(pr.id, "Earlier failure");
  const service = new TrackingService(store.tracking, config, Date.now, {
    schedules: store.schedules,
    read: (_url, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            reject(new Error("Aborted read"));
          },
          { once: true },
        );
      }),
  });
  try {
    const work = service.refresh(pr.id);
    await service.close();
    await work;
    assert.equal(
      store.tracking.pr(pr.id).lastRefreshError?.message,
      "Earlier failure",
    );
    const events = store
      .events()
      .filter((event) => event.kind.startsWith("pr_refresh_"));
    assert.deepEqual(
      events.map((event) => event.kind),
      ["pr_refresh_failed", "pr_refresh_cancelled"],
    );
    assert.equal(events.at(-1)?.detail, "Aborted read");
    assert.equal(
      store.schedules.get(`tracking:${pr.id}`)?.deferredReason,
      "Interrupted refresh queued after restart",
    );
  } finally {
    await service.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a read completing after shutdown is discarded rather than reported as recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-refresh-late-"));
  const store = new Store(directory);
  const config = defaultTrackingConfig();
  const pr = store.tracking.track(url, target);
  store.tracking.observe(pr.id, input, config);
  store.tracking.refreshError(pr.id, "Earlier failure");
  const service = new TrackingService(store.tracking, config, Date.now, {
    read: (_url, signal) =>
      new Promise((resolve) => {
        signal?.addEventListener(
          "abort",
          () => {
            resolve({ ...input, headSha: "discarded" });
          },
          { once: true },
        );
      }),
  });
  try {
    const work = service.refresh(pr.id);
    await service.close();
    await work;
    assert.equal(store.tracking.pr(pr.id).observation?.headSha, "head");
    assert.equal(
      store.tracking.pr(pr.id).lastRefreshError?.message,
      "Earlier failure",
    );
    assert.equal(
      store.events().filter((event) => event.kind === "pr_refresh_recovered")
        .length,
      0,
    );
  } finally {
    await service.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("discarded observations from an old epoch cannot produce recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-refresh-epoch-"));
  const store = new Store(directory);
  const config = defaultTrackingConfig();
  const pr = store.tracking.track(url, target);
  store.tracking.observe(pr.id, input, config);
  store.tracking.refreshError(pr.id, "Earlier failure");
  let finish: ((value: ObservationInput) => void) | undefined;
  const service = new TrackingService(store.tracking, config, Date.now, {
    read: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  try {
    const work = service.refresh(pr.id);
    store.tracking.untrack(pr.id);
    assert(finish !== undefined);
    finish({ ...input, headSha: "discarded" });
    await work;
    assert.equal(store.tracking.pr(pr.id).observation?.headSha, "head");
    assert.equal(
      store.tracking.pr(pr.id).lastRefreshError?.message,
      "Earlier failure",
    );
    assert.equal(
      store.events().filter((event) => event.kind === "pr_refresh_recovered")
        .length,
      0,
    );
  } finally {
    await service.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
