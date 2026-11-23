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
import type { GitHubGate } from "../src/merging/github.js";
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

test("closed readiness confirms facts without open mergeability or native-stack prerequisites", async () => {
  const head = "a".repeat(40),
    base = "b".repeat(40),
    commit = "c".repeat(40);
  const observation: ObservationInput = {
    observedAt: 0,
    headSha: head,
    baseSha: base,
    lifecycle: "merged",
    mergeability: "unknown",
    checks: { state: "complete", value: [] },
    reviews: { state: "complete", value: [] },
  };
  const gate: GitHubGate = {
    headRefOid: head,
    baseRefOid: base,
    baseRefName: "old-stack-branch",
    merged: true,
    state: "MERGED",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
    mergeCommit: { oid: commit },
    baseRef: null,
    stack: {
      baseRefName: "main",
      entries: { nodes: [], pageInfo: { hasNextPage: true } },
    },
  };
  const inspect = async (fresh: GitHubGate, cached = observation) => {
    const paths: string[] = [];
    const reader = new GitHubReads((request) => {
      paths.push(request.path);
      return Promise.resolve({
        status: 200,
        headers: new Map<string, string>(),
        body: JSON.stringify(
          request.path === "graphql"
            ? {
                data: {
                  repository: {
                    squashMergeAllowed: true,
                    mergeCommitAllowed: false,
                    rebaseMergeAllowed: false,
                    pullRequest: fresh,
                  },
                },
                errors: [],
              }
            : [],
        ),
      });
    });
    const result = await readMergeReadiness(
      "https://github.com/owner/repo/pull/38",
      cached,
      new AbortController().signal,
      reader,
    );
    assert.deepEqual(paths, ["graphql"]);
    return result;
  };
  const merged = await inspect(gate);
  assert.equal(merged.mergeCommit, commit);
  assert.deepEqual(merged.nativePrerequisites, []);
  const closed = await inspect(
    { ...gate, state: "CLOSED", merged: false, mergeCommit: null },
    { ...observation, lifecycle: "closed" },
  );
  assert.equal(closed.mergeCommit, undefined);
  await assert.rejects(
    inspect({ ...gate, headRefOid: "d".repeat(40) }),
    /changed/u,
  );
  await assert.rejects(
    inspect({ ...gate, state: "CLOSED", merged: false, mergeCommit: null }),
    /changed/u,
  );
  await assert.rejects(inspect({ ...gate, mergeCommit: { oid: "invalid" } }));
  const openObservation: ObservationInput = {
    ...observation,
    lifecycle: "open",
    mergeability: "mergeable",
    targetBase: { ref: "old-stack-branch", sha: base },
  };
  const openGate: GitHubGate = {
    ...gate,
    merged: false,
    state: "OPEN",
    mergeCommit: null,
    baseRef: { target: { oid: base }, branchProtectionRule: null },
  };
  await assert.rejects(
    inspect(openGate, openObservation),
    /Native stack exceeds/u,
  );
  await assert.rejects(
    inspect(
      {
        ...openGate,
        stack: {
          baseRefName: "main",
          entries: { nodes: [], pageInfo: { hasNextPage: false } },
        },
      },
      openObservation,
    ),
    /missing from native stack/u,
  );
  await assert.rejects(
    inspect(
      {
        ...openGate,
        stack: {
          baseRefName: "main",
          entries: {
            nodes: [
              {
                pullRequest: {
                  url: "https://github.com/owner/repo/pull/38",
                  state: "OPEN",
                },
              },
            ],
            pageInfo: { hasNextPage: false },
          },
        },
      },
      openObservation,
    ),
    /target branch has not settled/u,
  );
});
