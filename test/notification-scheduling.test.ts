import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createApplicationFixture } from "./support/application.js";
import { TrackingState } from "../src/tracking/retirement.js";
import type { ObservationInput } from "../src/tracking/types.js";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

test("first PR archived by drain expiry wakes the sleeping notification monitor", async () => {
  const directory = await mkdtemp("/tmp/octo-notification-scheduling-");
  let now = 1000;
  let identities = 0;
  const observation: ObservationInput = {
    observedAt: now,
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    lifecycle: "closed",
    mergeability: "mergeable",
    checks: { state: "unavailable", reason: "Controlled incomplete checks" },
    reviews: { state: "complete", value: [] },
  };
  const coordinator = await createApplicationFixture(directory, {
    now: () => now,
    trackingOptions: {
      read: () => Promise.resolve(observation),
      failureExcerpt: () => Promise.resolve(undefined),
    },
    notificationReader: {
      identity: () => {
        identities++;
        return Promise.resolve("controlled");
      },
      page: () =>
        Promise.resolve({
          updates: [],
          more: false,
          notModified: false,
          pollSeconds: 60,
          serverTime: now,
        }),
    },
  });
  try {
    await coordinator.start();
    const pr = coordinator.tracking.track(
      "https://github.com/owner/repo/pull/1",
      { harness: "codex", endpoint: "local", sessionId: "controlled" },
    );
    coordinator.store.tracking.observe(
      pr.id,
      observation,
      coordinator.tracking.config,
    );
    await sleep(30);
    expect(coordinator.store.tracking.pr(pr.id).state).toBe(
      TrackingState.Draining,
    );
    expect(identities).toBe(0);
    now += 86400001;
    coordinator.store.tracking.retirement.expire();
    const deadline = Date.now() + 1000;
    while (identities === 0 && Date.now() < deadline) await sleep(5);
    expect(coordinator.store.tracking.pr(pr.id).state).toBe(
      TrackingState.Archived,
    );
    expect(identities).toBe(1);
  } finally {
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});
