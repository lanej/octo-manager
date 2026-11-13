import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  GitHubReads,
  GitHubRateLimitError,
  type GitHubCommand,
} from "../src/github-api.js";

function http(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): string {
  return [
    `HTTP/2.0 ${String(status)} Response`,
    ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
    "",
    JSON.stringify(body),
  ].join("\r\n");
}
test("conditional reads reuse only server-confirmed evidence and replace changed responses", async () => {
  const calls: string[][] = [];
  const replies = [
    http(200, { head: "one" }, { ETag: '"one"' }),
    http(304, null),
    http(200, { head: "two" }, { ETag: '"two"' }),
    http(304, null),
    http(200, { head: "three" }),
    http(200, { head: "four" }),
  ];
  const reader = new GitHubReads((args) => {
    calls.push(args);
    const reply = replies.shift();
    assert(reply !== undefined);
    return Promise.resolve(reply);
  });
  const first = await reader.read("repos/owner/repo/pulls/1");
  assert.deepEqual(first, { head: "one" });
  first.head = "caller mutation";
  assert.deepEqual(await reader.read("repos/owner/repo/pulls/1"), {
    head: "one",
  });
  assert.deepEqual(await reader.read("repos/owner/repo/pulls/1"), {
    head: "two",
  });
  assert.deepEqual(await reader.read("repos/owner/repo/pulls/1"), {
    head: "two",
  });
  await reader.read("repos/owner/repo/pulls/1");
  await reader.read("repos/owner/repo/pulls/1");
  assert.equal(calls.length, 6);
  assert.equal(calls[0]?.includes("--header"), false);
  assert.equal(calls[1]?.includes('If-None-Match: "one"'), true);
  assert.equal(calls[3]?.includes('If-None-Match: "two"'), true);
  assert.equal(calls[5]?.includes("--header"), false);
});
test("all read clients share a serial queue; cancellation and failure release the queue", async () => {
  let finish: ((value: string) => void) | undefined;
  const calls: string[][] = [];
  const reader = new GitHubReads((args) => {
    calls.push(args);
    if (calls.length === 1)
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    return Promise.resolve(http(200, { data: { ok: true } }));
  });
  const first = reader.read("first");
  const aborted = new AbortController();
  const second = reader.read("cancelled", aborted.signal);
  const cancelled = assert.rejects(second);
  const third = reader.query("query { viewer { login } }");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  aborted.abort();
  assert(finish !== undefined);
  finish(http(503, {}));
  await assert.rejects(first, /temporarily unavailable/);
  await cancelled;
  assert.deepEqual(await third, { data: { ok: true }, errors: [] });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.includes("graphql"), true);
});
test("primary rate limits pause REST reads until reset without blocking the separate GraphQL budget", async () => {
  let at = 1000;
  let calls = 0;
  const reader = new GitHubReads(
    (args) => {
      calls++;
      if (calls === 1)
        return Promise.resolve(
          http(
            403,
            { message: "API rate limit exceeded" },
            {
              "X-Ratelimit-Remaining": "0",
              "X-Ratelimit-Reset": "100",
            },
          ),
        );
      return Promise.resolve(
        args.includes("graphql")
          ? http(200, { data: { ok: true } })
          : http(200, { fresh: true }),
      );
    },
    () => at,
  );
  const limited = (error: unknown) =>
    error instanceof GitHubRateLimitError && error.retryAtMs === 101000;
  await assert.rejects(reader.read("first"), limited);
  at = 100000;
  await assert.rejects(reader.read("other"), limited);
  assert.equal(calls, 1);
  assert.deepEqual(await reader.query("query { viewer { login } }"), {
    data: { ok: true },
    errors: [],
  });
  at = 101000;
  assert.deepEqual(await reader.read("other"), { fresh: true });
  assert.equal(calls, 3);
});
test("secondary limits honor retry-after and repeated limits back off exponentially", async () => {
  let at = 1000;
  let calls = 0;
  const reader = new GitHubReads(
    () => {
      calls++;
      return Promise.resolve(
        calls === 1
          ? http(429, {}, { "Retry-After": "120" })
          : http(403, { message: "Secondary rate limit" }),
      );
    },
    () => at,
  );
  await assert.rejects(
    reader.read("first"),
    (error: unknown) =>
      error instanceof GitHubRateLimitError && error.retryAtMs === 121000,
  );
  at = 120000;
  await assert.rejects(reader.read("other"), GitHubRateLimitError);
  assert.equal(calls, 1);
  at = 121000;
  await assert.rejects(
    reader.read("other"),
    (error: unknown) =>
      error instanceof GitHubRateLimitError && error.retryAtMs === 241000,
  );
  at = 241000;
  await assert.rejects(
    reader.read("other"),
    (error: unknown) =>
      error instanceof GitHubRateLimitError && error.retryAtMs === 481000,
  );
});
test("the last successful REST response is usable but pauses subsequent reads", async () => {
  let calls = 0;
  const reader = new GitHubReads(
    () => {
      calls++;
      return Promise.resolve(
        http(
          200,
          { last: true },
          {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "100",
          },
        ),
      );
    },
    () => 1000,
  );
  assert.deepEqual(await reader.read("first"), { last: true });
  await assert.rejects(reader.read("second"), GitHubRateLimitError);
  assert.equal(calls, 1);
});
test("invalid, missing, partial, and forbidden responses cannot become cached evidence", async () => {
  const run: GitHubCommand = () => Promise.resolve(http(304, null));
  await assert.rejects(
    new GitHubReads(run).read("first"),
    /without cached evidence/,
  );
  await assert.rejects(
    new GitHubReads(() => Promise.resolve(http(403, {}))).read("first"),
    /HTTP 403/,
  );
  await assert.rejects(
    new GitHubReads(() =>
      Promise.resolve("HTTP/2.0 200 OK\r\n\r\nprivate invalid response"),
    ).read("first"),
    /^Error: Invalid GitHub JSON response$/,
  );
  assert.deepEqual(
    await new GitHubReads(() =>
      Promise.resolve(
        http(200, {
          data: { pr0: null },
          errors: [{ message: "Unavailable" }],
        }),
      ),
    ).query("query { repository { name } }"),
    { data: { pr0: null }, errors: [{ message: "Unavailable" }] },
  );
});
test("HTTP 200 GraphQL secondary rate-limit errors pause both API resources", async () => {
  let calls = 0;
  const reader = new GitHubReads(
    () => {
      calls++;
      return Promise.resolve(
        http(
          200,
          {
            data: null,
            errors: [
              {
                type: "RATE_LIMITED",
                message: "Secondary rate limit exceeded",
              },
            ],
          },
          { "x-ratelimit-remaining": "4900", "retry-after": "90" },
        ),
      );
    },
    () => 1000,
  );
  await assert.rejects(
    reader.query("query { viewer { login } }"),
    (error: unknown) =>
      error instanceof GitHubRateLimitError && error.retryAtMs === 91000,
  );
  await assert.rejects(reader.read("rest"), GitHubRateLimitError);
  assert.equal(calls, 1);
});
test("the REST cache evicts older objects within its bounded entry count", async () => {
  const calls: string[][] = [];
  const reader = new GitHubReads((args) => {
    calls.push(args);
    return Promise.resolve(http(200, {}, { etag: '"one"' }));
  });
  for (let index = 0; index < 129; index++)
    await reader.read(`object/${String(index)}`);
  await reader.read("object/0");
  assert.equal(calls.at(-1)?.includes("--header"), false);
});
