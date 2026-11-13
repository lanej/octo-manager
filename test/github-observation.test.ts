import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubMetadata } from "../src/tracking/metadata.js";
import { readObservation } from "../src/tracking/github.js";
import { GitHubRateLimitError } from "../src/github-api.js";
import { TrackingService } from "../src/tracking/service.js";
import { Store } from "../src/store.js";
import { defaultTrackingConfig } from "../src/tracking/config.js";
import type { ObservationInput } from "../src/tracking/types.js";

const url = "https://github.com/owner/repo/pull/1";
const repository = {
  isPrivate: true,
  pullRequest: {
    state: "OPEN",
    merged: false,
    mergeable: "MERGEABLE",
    headRefOid: "head",
    baseRefOid: "ancestor",
    baseRefName: "main",
    baseRef: { target: { oid: "current-target" } },
  },
};
const collections = (path: string): Promise<unknown> => {
  assert(!path.includes("/git/ref/"));
  assert(!/\/pulls\/\d+$/u.test(path));
  if (path.includes("check-runs")) return Promise.resolve({ check_runs: [] });
  if (path.includes("/actions/runs"))
    return Promise.resolve({ workflow_runs: [] });
  return Promise.resolve([]);
};
test("production metadata batching brackets all REST collection evidence across concurrent PR refreshes", async () => {
  let queries = 0;
  const paths: string[] = [];
  const metadata = new GitHubMetadata((query) => {
    queries++;
    const data: Record<string, unknown> = {};
    for (const match of query.matchAll(/(pr\d+): repository/gu)) {
      const alias = match[1];
      assert(alias !== undefined);
      data[alias] = repository;
    }
    return Promise.resolve({
      data,
      errors: [],
    });
  });
  const read = (path: string) => {
    paths.push(path);
    return collections(path);
  };
  const results = await Promise.all([
    readObservation(
      url,
      undefined,
      read,
      () => 1000,
      (url, signal) => metadata.read(url, signal),
    ),
    readObservation(
      "https://github.com/owner/repo/pull/2",
      undefined,
      read,
      () => 1000,
      (url, signal) => metadata.read(url, signal),
    ),
  ]);
  assert.equal(queries, 2);
  assert.equal(paths.length, 12);
  assert(
    results.every(
      (result) =>
        result.baseSha === "ancestor" &&
        result.targetBase?.sha === "current-target" &&
        result.checks.state === "complete" &&
        result.feedback?.state === "complete" &&
        result.workflows?.state === "complete",
    ),
  );
});
test("changed GraphQL head, target, lifecycle, base branch, and mergeability reject the entire observation", async () => {
  for (const patch of [
    { headRefOid: "new-head" },
    { baseRef: { target: { oid: "new-target" } } },
    { state: "CLOSED" },
    { baseRefName: "release" },
    { mergeable: "CONFLICTING" },
  ]) {
    let calls = 0;
    const metadata = new GitHubMetadata(() => {
      calls++;
      return Promise.resolve({
        data: {
          pr0: {
            ...repository,
            pullRequest: {
              ...repository.pullRequest,
              ...(calls === 2 ? patch : {}),
            },
          },
        },
        errors: [],
      });
    });
    await assert.rejects(
      readObservation(
        url,
        undefined,
        collections,
        () => 1000,
        (url, signal) => metadata.read(url, signal),
      ),
      /revisions changed/,
    );
    assert.equal(calls, 2);
  }
});
test("GraphQL metadata does not turn an incomplete REST collection into complete evidence", async () => {
  const metadata = new GitHubMetadata(() =>
    Promise.resolve({ data: { pr0: repository }, errors: [] }),
  );
  const result = await readObservation(
    url,
    undefined,
    (path) => {
      if (path.includes("/reviews")) throw new Error("offline");
      return collections(path);
    },
    () => 1000,
    (url, signal) => metadata.read(url, signal),
  );
  assert.equal(result.reviews.state, "unavailable");
  assert.equal(result.feedback?.state, "partial");
});
test("automatic and explicit tracking refreshes honor a shared rate-limit deadline and preserve prior evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-github-cooldown-"));
  let at = 1000,
    reads = 0;
  const store = new Store(directory, () => at);
  const config = defaultTrackingConfig();
  const prior: ObservationInput = {
    observedAt: 1000,
    headSha: "head",
    baseSha: "base",
    lifecycle: "open",
    mergeability: "mergeable",
    checks: { state: "complete", value: [] },
    reviews: { state: "complete", value: [] },
  };
  const service = new TrackingService(store.tracking, config, () => at, {
    read: () => {
      reads++;
      if (reads === 1) return Promise.reject(new GitHubRateLimitError(121000));
      return Promise.resolve({ ...prior, observedAt: at });
    },
  });
  try {
    const first = store.tracking.track(url, {
      harness: "codex",
      endpoint: "local",
      sessionId: "one",
    });
    const second = store.tracking.track(
      "https://github.com/owner/repo/pull/2",
      {
        harness: "codex",
        endpoint: "local",
        sessionId: "two",
      },
    );
    store.tracking.observe(first.id, prior, config);
    await service.refresh(first.id);
    assert.equal(store.tracking.pr(first.id).observation?.observedAt, 1000);
    assert.match(
      store.tracking.pr(first.id).lastRefreshError?.message ?? "",
      /rate limit/,
    );
    at = 120000;
    service.tick();
    await assert.rejects(service.refresh(second.id), GitHubRateLimitError);
    assert.equal(reads, 1);
    at = 121000;
    service.tick();
    await Promise.all([service.refresh(first.id), service.refresh(second.id)]);
    assert.equal(reads, 3);
    assert.equal(store.tracking.pr(first.id).observation?.observedAt, 121000);
  } finally {
    await service.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
