import assert from "node:assert/strict";
import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.js";
import { GitHubReads } from "../src/github-api.js";
import { GitHubScheduler } from "../src/scheduling/service.js";
import { defaultSchedulerPolicy } from "../src/scheduling/contracts.js";
import { readMergeReadiness } from "../src/merging/github.js";
import type { ObservationInput } from "../src/tracking/types.js";
test("readiness reuses tracking evidence and fits default request spacing with only eligibility reads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-readiness-dispatch-"));
  let now = 0;
  const store = new Store(directory, () => now);
  const scheduler = new GitHubScheduler(
    store.schedules,
    defaultSchedulerPolicy,
    () => now,
    () => Promise.reject(new Error("No review refresh expected")),
    () => {},
  );
  const starts: { path: string; at: number }[] = [];
  const head = "a".repeat(40),
    base = "b".repeat(40);
  const observation: ObservationInput = {
    observedAt: 0,
    headSha: head,
    baseSha: base,
    targetBase: { ref: "main", sha: base },
    lifecycle: "open",
    mergeability: "mergeable",
    checks: { state: "complete", value: [] },
    reviews: { state: "complete", value: [] },
  };
  const reader = new GitHubReads(
    (request) => {
      starts.push({ path: request.path, at: now });
      const body =
        request.path === "graphql"
          ? {
              data: {
                repository: {
                  squashMergeAllowed: true,
                  mergeCommitAllowed: false,
                  rebaseMergeAllowed: false,
                  pullRequest: {
                    headRefOid: head,
                    baseRefOid: base,
                    baseRefName: "main",
                    merged: false,
                    state: "OPEN",
                    isDraft: false,
                    mergeable: "MERGEABLE",
                    mergeStateStatus: "CLEAN",
                    reviewDecision: null,
                    mergeCommit: null,
                    baseRef: {
                      target: { oid: base },
                      branchProtectionRule: null,
                    },
                  },
                },
              },
              errors: [],
            }
          : [];
      return Promise.resolve({
        status: 200,
        headers: new Map<string, string>(),
        body: JSON.stringify(body),
      });
    },
    () => now,
  );
  reader.setDispatcher(scheduler);
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  try {
    const work = readMergeReadiness(
      "https://github.com/owner/repo/pull/38",
      observation,
      AbortSignal.timeout(15000),
      reader,
    );
    await settle();
    scheduler.tick();
    await settle();
    expect(starts).toHaveLength(1);
    now = defaultSchedulerPolicy.requestSpacingMs - 1;
    scheduler.tick();
    await settle();
    expect(starts).toHaveLength(1);
    now++;
    scheduler.tick();
    await settle();
    const result = await work;
    expect(result.observation).toBe(observation);
    expect(starts).toEqual([
      { path: "graphql", at: 0 },
      {
        path: "repos/owner/repo/rules/branches/main",
        at: defaultSchedulerPolicy.requestSpacingMs,
      },
    ]);
    expect(now).toBeLessThan(15000);
  } finally {
    await scheduler.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("fresh GitHub closure or mergeability changes cannot reuse cached Ready facts", async () => {
  const head = "a".repeat(40),
    base = "b".repeat(40);
  const observation: ObservationInput = {
    observedAt: 0,
    headSha: head,
    baseSha: base,
    targetBase: { ref: "main", sha: base },
    lifecycle: "open",
    mergeability: "mergeable",
    checks: { state: "complete", value: [] },
    reviews: { state: "complete", value: [] },
  };
  for (const change of [
    { state: "CLOSED" },
    { state: "MERGED", merged: true },
    { mergeable: "CONFLICTING" },
    { mergeable: "UNKNOWN" },
  ]) {
    let requests = 0;
    const reader = new GitHubReads(() => {
      requests++;
      return Promise.resolve({
        status: 200,
        headers: new Map<string, string>(),
        body: JSON.stringify({
          data: {
            repository: {
              squashMergeAllowed: true,
              mergeCommitAllowed: false,
              rebaseMergeAllowed: false,
              pullRequest: {
                headRefOid: head,
                baseRefOid: base,
                baseRefName: "main",
                merged: false,
                state: "OPEN",
                isDraft: false,
                mergeable: "MERGEABLE",
                mergeStateStatus: "CLEAN",
                reviewDecision: null,
                mergeCommit: null,
                baseRef: { target: { oid: base }, branchProtectionRule: null },
                ...change,
              },
            },
          },
          errors: [],
        }),
      });
    });
    await assert.rejects(
      readMergeReadiness(
        "https://github.com/owner/repo/pull/38",
        observation,
        new AbortController().signal,
        reader,
      ),
      /changed/u,
    );
    expect(requests).toBe(1);
  }
});
