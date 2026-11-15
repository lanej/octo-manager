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
    forecast: {
      state: "exhausted",
      reason: "GitHub reported no quota remaining",
      windowMs: 0,
      sampledAtMs: 1000,
      projectedRemainingAtReset: 0,
      exhaustAtMs: 1000,
    },
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
          ? {
              status: 200,
              headers: new Map([["etag", '"one"']]),
              body: '{"ok":true}',
            }
          : calls === 2
            ? { status: 304, headers: new Map<string, string>(), body: "" }
            : {
                status: 429,
                headers: new Map([["retry-after", "90"]]),
                body: "{}",
              };
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

test("hourly traffic survives hour and day rollover independently of minute and quota windows", () => {
  const hour = 3600000;
  let at = Date.UTC(2026, 10, 14, 23, 59, 59);
  const usage = new GitHubUsage(() => at);
  usage.attempt("core");
  usage.reused();
  at = Date.UTC(2026, 10, 15, 0, 0);
  usage.attempt("graphql");
  usage.observe(
    "core",
    new Map([
      ["x-ratelimit-limit", "5000"],
      ["x-ratelimit-remaining", "5000"],
      ["x-ratelimit-reset", String((at + hour) / 1000)],
    ]),
  );
  const value = usage.snapshot({ core: 0, graphql: 0 });
  assert.deepEqual(value.hours, [
    {
      startedAtMs: Date.UTC(2026, 10, 14, 23),
      rest: 1,
      graphql: 0,
      cacheReuses: 1,
    },
    { startedAtMs: at, rest: 0, graphql: 1, cacheReuses: 0 },
  ]);
  const first = value.hours[0];
  assert(first !== undefined);
  first.rest = 900;
  assert.equal(usage.snapshot({ core: 0, graphql: 0 }).hours[0]?.rest, 1);
  const wire = wireGitHubUsage(usage.snapshot({ core: 0, graphql: 0 }));
  const wireFirst = wire.hours[0];
  assert(wireFirst !== undefined);
  assert.equal(wireFirst.rest, 1n);
  assert.equal(wireFirst.startedAtMs, BigInt(Date.UTC(2026, 10, 14, 23)));
  at += 2 * hour;
  const idle = usage.snapshot({ core: 0, graphql: 0 });
  assert.equal(idle.hours.length, 4);
  assert.equal(idle.hours[0]?.rest, 1);
  assert.equal(idle.hours[2]?.rest, 0);
  assert.equal(idle.hours[3]?.graphql, 0);
  assert.equal(
    idle.minutes.reduce((sum, bucket) => sum + bucket.rest + bucket.graphql, 0),
    0,
  );
  at += 200 * hour;
  const bounded = usage.snapshot({ core: 0, graphql: 0 });
  assert.equal(bounded.hours.length, 168);
  assert.equal(bounded.hours[0]?.startedAtMs, at - 167 * hour);
  assert.equal(
    bounded.hours.reduce(
      (sum, bucket) => sum + bucket.rest + bucket.graphql,
      0,
    ),
    0,
  );
  assert.equal(bounded.requests, 2);
  assert.equal(bounded.cacheReuses, 1);
});
