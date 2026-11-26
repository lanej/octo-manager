import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/coordinator/store.js";
import { GitHubRateLimitError } from "../src/github/reads.js";
import { RepairService, type RepairOptions } from "../src/repairs/service.js";
import { RepairState, RepairStep, type RepairProfile } from "../src/repairs/types.js";
import { WorkScheduler } from "../src/scheduling/work.js";
import { defaultTrackingConfig } from "../src/tracking/config.js";
import { TrackingService } from "../src/tracking/service.js";
import type { ObservationInput } from "../src/tracking/types.js";

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
async function until(predicate: () => boolean, timeout = 1000) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await sleep(5);
  expect(predicate()).toBe(true);
}
const profile: RepairProfile = {
  repository: "owner/repo",
  harness: "pi",
  model: "fixture",
  instructions: "Controlled repair",
  checks: [["fixture"]],
  githubChecks: ["CI"],
  timeoutMs: 1000,
};
const head = "a".repeat(40),
  base = "b".repeat(40);
async function fixture(options: RepairOptions = {}, now: () => number = Date.now) {
  const directory = await mkdtemp(join(tmpdir(), "octo-repair-scheduling-"));
  const store = new Store(directory, now);
  const tracking = new TrackingService(store.tracking, defaultTrackingConfig(), now);
  const prs = [1, 2, 3].map((number) =>
    tracking.track(`https://github.com/owner/repo/pull/${String(number)}`, {
      harness: "codex",
      endpoint: "local",
      sessionId: "repair-scheduling",
    }),
  );
  const errors: unknown[] = [];
  const scheduler = new WorkScheduler(now, (_key, error) => {
    errors.push(error);
  });
  const service = new RepairService(store.repairs, tracking, { controlled: profile }, directory, now, options);
  const input = (index: number) => {
    const pr = prs[index];
    if (pr === undefined) throw new Error("Missing fixture PR");
    return {
      requestId: `repair-${String(index)}`,
      prUrl: pr.url,
      profile: "controlled",
    };
  };
  return {
    store,
    service,
    scheduler,
    prs,
    errors,
    input,
    start() {
      service.start(scheduler);
      scheduler.start();
    },
    async close() {
      scheduler.stop();
      await service.close();
      await scheduler.close();
      await tracking.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("blocked repair history sleeps, while a new request starts before the former polling interval", async () => {
  let entered = false;
  const f = await fixture({
    source: () => {
      entered = true;
      return Promise.reject(new Error("Controlled source stop"));
    },
  });
  try {
    const pr = f.prs[0];
    if (pr === undefined) throw new Error("Missing fixture PR");
    const old = f.store.repairs.request(f.input(0), profile, pr.id);
    f.store.repairs.save({ ...old, state: RepairState.Blocked });
    f.start();
    await sleep(20);
    const reads = spyOn(f.store.repairs, "list");
    try {
      await sleep(350);
      expect(reads).not.toHaveBeenCalled();
      const startedAt = Date.now();
      const request = f.service.request(f.input(1));
      await until(() => entered, process.env["CI"] === undefined ? 200 : 30000);
      if (process.env["CI"] === undefined) expect(Date.now() - startedAt).toBeLessThan(250);
      await until(() => f.store.repairs.get(request.id).state === RepairState.Blocked);
    } finally {
      reads.mockRestore();
    }
  } finally {
    await f.close();
  }
});

test("repair verification follows its fifteen-second and rate-limit deadlines", async () => {
  let now = 1000;
  let calls = 0;
  const observation: ObservationInput = {
    observedAt: now,
    headSha: head,
    baseSha: base,
    targetBase: { ref: "main", sha: base },
    lifecycle: "open",
    mergeability: "mergeable",
    checks: { state: "complete", value: [] },
    reviews: { state: "complete", value: [] },
  };
  const f = await fixture(
    {
      observe: () => {
        calls++;
        if (calls === 2) return Promise.reject(new GitHubRateLimitError(90000));
        return Promise.resolve(observation);
      },
    },
    () => now,
  );
  try {
    const pr = f.prs[0];
    if (pr === undefined) throw new Error("Missing fixture PR");
    const queued = f.store.repairs.request(f.input(0), profile, pr.id);
    f.store.repairs.save({
      ...queued,
      state: RepairState.AwaitingChecks,
      step: RepairStep.Verify,
      resultHead: head,
      source: {
        repository: "owner/repo",
        headRef: "feature",
        headSha: head,
        targetRef: "main",
        targetSha: base,
      },
    });
    f.start();
    await until(() => calls === 1);
    now = 15999;
    f.service.wake();
    await sleep(15);
    expect(calls).toBe(1);
    now = 16000;
    f.service.wake();
    await until(() => calls === 2);
    now = 89999;
    f.service.wake();
    await sleep(15);
    expect(calls).toBe(2);
    now = 90000;
    f.service.wake();
    await until(() => calls === 3);
    expect(f.store.repairs.get(queued.id).state).toBe(RepairState.AwaitingChecks);
  } finally {
    await f.close();
  }
});

test("repair intake while busy coalesces and preserves newest-first dispatch without overlap", async () => {
  const release = gate();
  const started: string[] = [];
  let active = 0,
    maximum = 0;
  const f = await fixture({
    source: async (url) => {
      started.push(url);
      active++;
      maximum = Math.max(maximum, active);
      try {
        if (started.length === 1) await release.promise;
        throw new Error("Controlled source stop");
      } finally {
        active--;
      }
    },
  });
  try {
    f.start();
    f.service.request(f.input(0));
    await until(() => started.length === 1);
    f.service.request(f.input(1));
    f.service.request(f.input(2));
    await sleep(20);
    expect(started).toHaveLength(1);
    release.release();
    await until(() => started.length === 3);
    expect(started).toEqual([f.input(0).prUrl, f.input(2).prUrl, f.input(1).prUrl]);
    expect(maximum).toBe(1);
  } finally {
    release.release();
    await f.close();
  }
});

test("unexpected repair read failures use the global scheduler cooldown", async () => {
  let now = 1000;
  const f = await fixture({}, () => now);
  const reads = spyOn(f.store.repairs, "list").mockImplementation(() => {
    throw new Error("Controlled repair read failure");
  });
  try {
    f.start();
    await until(() => f.errors.length === 1);
    f.service.wake();
    await sleep(30);
    expect(reads).toHaveBeenCalledTimes(1);
    now = 5999;
    f.service.wake();
    await sleep(15);
    expect(reads).toHaveBeenCalledTimes(1);
    now = 6000;
    f.service.wake();
    await until(() => f.errors.length === 2);
    expect(reads).toHaveBeenCalledTimes(2);
  } finally {
    reads.mockRestore();
    await f.close();
  }
});
