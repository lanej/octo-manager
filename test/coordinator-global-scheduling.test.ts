import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createApplicationFixture } from "./support/application.js";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

test("one coordinator clock leaves passive assessment and repair history asleep until intake", async () => {
  const directory = await mkdtemp("/tmp/octo-global-work-");
  const coordinator = await createApplicationFixture(directory);
  try {
    await coordinator.start();
    await sleep(25);
    const assessments = spyOn(
      coordinator.store.assessments,
      "reconciliationCandidates",
    );
    const repairs = spyOn(coordinator.store.repairs, "list");
    try {
      await sleep(1100);
      expect(assessments).not.toHaveBeenCalled();
      expect(repairs).not.toHaveBeenCalled();
      coordinator.inputs.changed();
      await sleep(30);
      expect(assessments).toHaveBeenCalled();
      expect(repairs).toHaveBeenCalled();
    } finally {
      assessments.mockRestore();
      repairs.mockRestore();
    }
  } finally {
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the shared coordinator scheduler completes assessments from provider intake and coalesces busy input", async () => {
  const { schedulerClient } = await import("../src/client.js");
  const directory = await mkdtemp("/tmp/octo-global-assessment-");
  let releaseFirst = () => {};
  const firstHeld = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const seen: string[] = [];
  let active = 0;
  let maximum = 0;
  const observation = (
    url: string,
  ): import("../src/tracking/types.js").ObservationInput => ({
    observedAt: 1000,
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    lifecycle: "open",
    mergeability: "mergeable",
    checks: { state: "complete", value: [] },
    reviews: { state: "complete", value: [] },
    feedback: {
      state: "complete",
      value: [
        {
          source: "conversation",
          id: "review-comment",
          revision: "1",
          author: "synthetic-reviewer",
          body: "Inspect the controlled evidence.",
          headSha: "a".repeat(40),
          url: `${url}#issuecomment-1`,
        },
      ],
    },
  });
  const coordinator = await createApplicationFixture(directory, {
    model: "synthetic",
    assess: async (input) => {
      seen.push(input.prUrl);
      active++;
      maximum = Math.max(maximum, active);
      try {
        if (seen.length === 1) await firstHeld;
        return {
          disposition: "no_change_suggested",
          analysis: "Controlled assessment completed.",
        };
      } finally {
        active--;
      }
    },
    trackingOptions: {
      read: (url) => Promise.resolve(observation(url)),
      failureExcerpt: () => Promise.resolve(undefined),
      connect: () => ({
        prepare: () => Promise.resolve({ busy: true }),
        send: () =>
          Promise.reject(new Error("Unexpected synthetic agent send")),
        find: () => Promise.resolve({ found: false }),
        close() {},
      }),
    },
  });
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 1000;
    while (!predicate() && Date.now() < deadline) await sleep(5);
    expect(predicate()).toBe(true);
  };
  try {
    await coordinator.start();
    const client = schedulerClient(directory);
    const firstUrl = "https://github.com/owner/repo/pull/1";
    const secondUrl = "https://github.com/owner/repo/pull/2";
    const owner = {
      harness: "codex",
      endpoint: "local",
      sessionId: "global-assessment",
    };
    const first = await client.trackPullRequest({ url: firstUrl, owner });
    if (first.pr === undefined) throw new Error("Missing first tracked PR");
    await sleep(20);
    coordinator.store.tracking.observe(
      first.pr.id,
      observation(firstUrl),
      coordinator.tracking.config,
    );
    await until(() => seen.length === 1);
    const second = await client.trackPullRequest({ url: secondUrl, owner });
    if (second.pr === undefined) throw new Error("Missing second tracked PR");
    coordinator.store.tracking.observe(
      second.pr.id,
      observation(secondUrl),
      coordinator.tracking.config,
    );
    await sleep(20);
    expect(seen).toEqual([firstUrl]);
    releaseFirst();
    await until(
      () =>
        coordinator.store.assessments
          .list()
          .filter(
            (item) => item.state === "completed" && item.completionNotified,
          ).length === 2,
    );
    const completed = coordinator.store.assessments.list();
    expect(completed.map((item) => item.result)).toEqual([
      {
        disposition: "no_change_suggested",
        analysis: "Controlled assessment completed.",
      },
      {
        disposition: "no_change_suggested",
        analysis: "Controlled assessment completed.",
      },
    ]);
    expect(seen).toEqual([firstUrl, secondUrl]);
    expect(maximum).toBe(1);
    expect(
      completed.every((item) =>
        item.history.some((entry) => entry.state === "running"),
      ),
    ).toBe(true);
  } finally {
    releaseFirst();
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});
