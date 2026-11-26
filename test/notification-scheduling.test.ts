import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { assembleApplication } from "../src/application/composition.js";
import { WorkScheduler } from "../src/scheduling/work.js";
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
  const application = await assembleApplication(directory, {
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
  const coordinator = { ...application.services, store: application.store };
  const plans: Array<number | undefined> = [];
  const scheduler = new WorkScheduler(
    () => now,
    undefined,
    (key, work) => {
      const result = work();
      if (key !== "notification-flush") return result;
      return Promise.resolve(result).then((deadline) => {
        plans.push(deadline);
        return deadline;
      });
    },
  );
  try {
    application.services.start(scheduler);
    scheduler.start();
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
    expect(plans.at(-1)).toBeUndefined();
    now += 86400001;
    coordinator.tracking.tick();
    const deadline = Date.now() + 1000;
    while (identities === 0 && Date.now() < deadline) await sleep(5);
    expect(coordinator.store.tracking.pr(pr.id).state).toBe(
      TrackingState.Archived,
    );
    expect(identities).toBe(1);
    await sleep(10);
    expect(plans.at(-1)).toBe(now + 60000);
    const beforeDisable = plans.length;
    coordinator.store.tracking.untrack(pr.id);
    const parkedDeadline = Date.now() + 1000;
    while (plans.length === beforeDisable && Date.now() < parkedDeadline)
      await sleep(5);
    expect(plans.length).toBeGreaterThan(beforeDisable);
    expect(plans.at(-1)).toBeUndefined();
    expect(identities).toBe(1);
  } finally {
    scheduler.stop();
    await application.runtime.close();
    await scheduler.close();
    await rm(directory, { recursive: true, force: true });
  }
});
