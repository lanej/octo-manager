import { test } from "bun:test";
import assert from "node:assert/strict";
import { GitHubMetadata } from "../src/tracking/metadata.js";

const url = "https://github.com/owner/repo/pull/1";
const repository = {
  isPrivate: true,
  pullRequest: {
    state: "OPEN",
    merged: false,
    mergeable: "CONFLICTING",
    headRefOid: "head",
    baseRefOid: "ancestor",
    baseRefName: "main",
    baseRef: { target: { oid: "current-target" } },
  },
};
test("multiple PR metadata reads use one GraphQL query and retain distinct target and PR base evidence", async () => {
  const queries: string[] = [];
  const reader = new GitHubMetadata((query) => {
    queries.push(query);
    return Promise.resolve({
      data: {
        pr0: repository,
        pr1: {
          ...repository,
          pullRequest: {
            ...repository.pullRequest,
            headRefOid: "second-head",
            mergeable: "UNKNOWN",
          },
        },
      },
      errors: [],
    });
  });
  const [first, second] = await Promise.all([
    reader.read(url),
    reader.read("https://github.com/another/other/pull/2"),
  ]);
  assert.equal(queries.length, 1);
  assert.equal(
    queries[0]?.includes('repository(owner: "owner", name: "repo")'),
    true,
  );
  assert.equal(
    queries[0].includes('repository(owner: "another", name: "other")'),
    true,
  );
  assert.equal(first.pr.base.sha, "ancestor");
  assert.equal(first.pr.mergeable, false);
  assert.deepEqual(first.target, { ref: "main", sha: "current-target" });
  assert.equal(second.pr.head.sha, "second-head");
  assert.equal(second.pr.mergeable, null);
});
test("GraphQL metadata batches are bounded and missing PRs do not fabricate observations", async () => {
  let calls = 0;
  const reader = new GitHubMetadata((query) => {
    calls++;
    const count = [...query.matchAll(/pr\d+: repository/gu)].length;
    assert(count <= 10);
    return Promise.resolve({
      data: Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `pr${String(index)}`,
          index === 0 ? null : repository,
        ]),
      ),
      errors: [],
    });
  });
  const results = await Promise.allSettled(
    Array.from({ length: 11 }, (_, index) =>
      reader.read(`https://github.com/owner/repo/pull/${String(index + 1)}`),
    ),
  );
  assert.equal(calls, 2);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    9,
  );
});
test("closed PRs need no surviving target, while open PRs require target evidence", async () => {
  const reader = new GitHubMetadata(() =>
    Promise.resolve({
      data: {
        pr0: {
          ...repository,
          pullRequest: {
            ...repository.pullRequest,
            state: "MERGED",
            merged: true,
            baseRef: null,
          },
        },
        pr1: {
          ...repository,
          pullRequest: { ...repository.pullRequest, baseRef: null },
        },
      },
      errors: [],
    }),
  );
  const closed = reader.read(url);
  const open = reader.read("https://github.com/owner/repo/pull/2");
  const rejected = assert.rejects(open, /Invalid GitHub metadata/);
  const result = await closed;
  await rejected;
  assert.equal(result.pr.state, "closed");
  assert.equal(result.pr.merged, true);
  assert.equal(result.target, undefined);
});
test("cancellation before dispatch makes no GraphQL request", async () => {
  let calls = 0;
  const reader = new GitHubMetadata(() => {
    calls++;
    return Promise.resolve({ data: {}, errors: [] });
  });
  await assert.rejects(reader.read(url, AbortSignal.abort()), /cancelled/);
  assert.equal(calls, 0);
});
test("a GraphQL error for one PR leaves other PRs in the batch usable", async () => {
  const reader = new GitHubMetadata(() =>
    Promise.resolve({
      data: { pr0: null, pr1: repository },
      errors: [{ message: "Not found", path: ["pr0"] }],
    }),
  );
  const results = await Promise.allSettled([
    reader.read(url),
    reader.read("https://github.com/owner/repo/pull/2"),
  ]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "fulfilled");
});
test("an in-flight shared batch cancels only after every consumer aborts", async () => {
  let batchSignal: AbortSignal | undefined;
  const reader = new GitHubMetadata((_query, signal) => {
    batchSignal = signal;
    assert(signal !== undefined);
    return new Promise((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          reject(new Error("cancelled"));
        },
        { once: true },
      );
    });
  });
  const first = new AbortController(),
    second = new AbortController();
  const firstRead = reader.read(url, first.signal);
  const secondRead = reader.read(
    "https://github.com/owner/repo/pull/2",
    second.signal,
  );
  const results = Promise.allSettled([firstRead, secondRead]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert(batchSignal !== undefined);
  first.abort();
  assert.equal(batchSignal.aborted, false);
  second.abort();
  assert.equal(batchSignal.aborted, true);
  assert((await results).every((result) => result.status === "rejected"));
});
