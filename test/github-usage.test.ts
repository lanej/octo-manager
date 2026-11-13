import { test } from "bun:test";
import assert from "node:assert/strict";
import { GitHubUsage } from "../src/github-usage.js";
import { GitHubReads, GitHubRateLimitError } from "../src/github-api.js";
import { wireGitHubUsage } from "../src/github-usage-rpc.js";

test("traffic history fills observed idle minutes, stays bounded, and preserves lifetime totals", () => {
  let at = 125000;
  const usage = new GitHubUsage(() => at);
  usage.attempt("core");
  usage.attempt("core");
  usage.reused();
  at = 245000;
  usage.attempt("graphql");
  const value = usage.snapshot({ core: 900000, graphql: 0 });
  assert.deepEqual(value.minutes, [
    { startedAtMs: 120000, rest: 2, graphql: 0, cacheReuses: 1 },
    { startedAtMs: 180000, rest: 0, graphql: 0, cacheReuses: 0 },
    { startedAtMs: 240000, rest: 0, graphql: 1, cacheReuses: 0 },
  ]);
  assert.equal(value.requests, 3);
  assert.equal(value.restRetryAtMs, 900000);
  assert(value.minutes[0] !== undefined);
  value.minutes[0].rest = 900;
  assert.equal(usage.snapshot({ core: 0, graphql: 0 }).minutes[0]?.rest, 2);
  at += 100 * 60000;
  const later = usage.snapshot({ core: 0, graphql: 0 });
  assert.equal(later.minutes.length, 60);
  assert.equal(later.minutes[0]?.startedAtMs, 2700000);
  assert.equal(
    later.minutes.reduce(
      (sum, minute) => sum + minute.rest + minute.graphql,
      0,
    ),
    0,
  );
  assert.equal(later.requests, 3);
  assert.equal(later.cacheReuses, 1);
});
test("quota observations keep missing and invalid data distinct from exhausted budgets", () => {
  let at = 1000;
  const usage = new GitHubUsage(() => at);
  const headers = new Map([
    ["x-ratelimit-limit", "5000"],
    ["x-ratelimit-remaining", "0"],
    ["x-ratelimit-reset", "100"],
    ["x-ratelimit-resource", "core"],
  ]);
  assert.equal(usage.snapshot({ core: 0, graphql: 0 }).rest, undefined);
  usage.observe("core", headers);
  at = 5000;
  usage.observe("core", new Map([["x-ratelimit-remaining", "not a count"]]));
  usage.observe(
    "core",
    new Map([...headers, ["x-ratelimit-remaining", "5001"]]),
  );
  usage.observe(
    "core",
    new Map([...headers, ["x-ratelimit-resource", "search"]]),
  );
  const value = usage.snapshot({ core: 101000, graphql: 0 });
  assert.deepEqual(value.rest, {
    limit: 5000,
    remaining: 0,
    resetAtMs: 100000,
    observedAtMs: 1000,
  });
  const wire = wireGitHubUsage(value);
  assert(wire.rest !== undefined);
  assert.equal(wire.rest.remaining, 0);
  assert.equal(wire.rest.observedAtMs, 1000n);
  assert.equal(wire.graphql, undefined);
  value.rest.remaining = 5000;
  assert.equal(usage.snapshot({ core: 0, graphql: 0 }).rest?.remaining, 0);
  at = 101000;
  assert.equal(usage.snapshot({ core: 0, graphql: 0 }).rest?.remaining, 0);
});
test("only executed reads count; cache reuse and rate-limit responses remain separate", async () => {
  let at = 1000;
  let calls = 0;
  const reader = new GitHubReads(
    () => {
      calls++;
      const body =
        calls === 1
          ? 'HTTP/2.0 200 OK\r\netag: "one"\r\n\r\n{"ok":true}'
          : calls === 2
            ? "HTTP/2.0 304 Not Modified\r\n\r\n"
            : "HTTP/2.0 429 Limited\r\nretry-after: 90\r\n\r\n{}";
      return Promise.resolve(body);
    },
    () => at,
  );
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(reader.read("aborted", aborted.signal));
  await reader.read("one");
  await reader.read("one");
  await assert.rejects(
    reader.query("query { viewer { login } }"),
    GitHubRateLimitError,
  );
  await assert.rejects(reader.read("paused"), GitHubRateLimitError);
  const value = reader.usage();
  assert.equal(calls, 3);
  assert.equal(value.requests, 3);
  assert.equal(value.cacheReuses, 1);
  assert.equal(value.rateLimits, 1);
  assert.deepEqual(value.minutes, [
    { startedAtMs: 0, rest: 2, graphql: 1, cacheReuses: 1 },
  ]);
  at = 91000;
  assert.equal(reader.usage().minutes.length, 2);
});
test("a failed transport is an attempt and cannot manufacture a quota observation", async () => {
  const reader = new GitHubReads(
    () => Promise.reject(new Error("controlled transport failure")),
    () => 1000,
  );
  await assert.rejects(reader.read("one"), /controlled transport failure/);
  assert.equal(reader.usage().requests, 1);
  assert.equal(reader.usage().rest, undefined);
  assert.equal(reader.usage().cacheReuses, 0);
});
