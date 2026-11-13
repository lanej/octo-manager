import { test } from "bun:test";
import assert from "node:assert/strict";
import { sdkTransport } from "../src/github-sdk.js";
import { GitHubReads, GitHubRateLimitError } from "../src/github-api.js";

test("official SDK caches credentials and preserves conditional responses and typed payloads", async () => {
  let tokens = 0;
  const calls: Request[] = [];
  const transport = sdkTransport(
    () => {
      tokens++;
      return Promise.resolve("fixture-secret");
    },
    (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      if (calls.length === 1)
        return Promise.resolve(
          new Response('{"head":"one"}', {
            headers: { etag: '"one"', "content-type": "application/json" },
          }),
        );
      if (calls.length === 2)
        return Promise.resolve(new Response(null, { status: 304 }));
      return Promise.resolve(
        new Response('{"uuid":"accepted"}', {
          headers: { "content-type": "application/json" },
        }),
      );
    },
  );
  const reads = new GitHubReads(transport);
  assert.deepEqual(await reads.read("repos/o/r/pulls/1"), { head: "one" });
  assert.deepEqual(await reads.read("repos/o/r/pulls/1"), { head: "one" });
  await reads.write("repos/o/r/pulls/1/merge-async", {
    bypass_rules: false,
    sha: "head",
  });
  assert.equal(tokens, 1);
  assert.equal(calls[0]?.url, "https://api.github.com/repos/o/r/pulls/1");
  assert.equal(calls[0].headers.get("authorization"), "token fixture-secret");
  assert.equal(calls[1]?.headers.get("if-none-match"), '"one"');
  const write = calls[2];
  assert(write !== undefined);
  const payload: unknown = JSON.parse(await write.text());
  assert.deepEqual(payload, { bypass_rules: false, sha: "head" });
});
test("SDK HTTP errors retain quota headers without hidden retries", async () => {
  let calls = 0;
  const reads = new GitHubReads(
    sdkTransport(
      () => Promise.resolve("fixture-secret"),
      () => {
        calls++;
        return Promise.resolve(
          new Response('{"message":"Secondary rate limit"}', {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": "90",
            },
          }),
        );
      },
    ),
    () => 1000,
  );
  await assert.rejects(
    reads.read("user"),
    (e) => e instanceof GitHubRateLimitError && e.retryAtMs === 91000,
  );
  await assert.rejects(
    reads.query("query { viewer { login } }"),
    GitHubRateLimitError,
  );
  assert.equal(calls, 1);
});
test("dispatch authority is rechecked after credential acquisition, and secrets stay out of network errors", async () => {
  let release: ((token: string) => void) | undefined;
  let calls = 0;
  let allowed = true;
  const transport = sdkTransport(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    () => {
      calls++;
      return Promise.reject(new Error("fixture-secret"));
    },
  );
  const work = transport(
    { method: "PUT", path: "repos/o/r/pulls/1/merge-async" },
    undefined,
    () => {
      if (!allowed) throw new Error("Authority withdrawn");
    },
  );
  allowed = false;
  assert(release !== undefined);
  release("fixture-secret");
  await assert.rejects(work, /Authority withdrawn/);
  assert.equal(calls, 0);
  await assert.rejects(
    transport({ method: "GET", path: "user" }),
    (e) => e instanceof Error && !e.message.includes("fixture-secret"),
  );
  await assert.rejects(
    transport({ method: "GET", path: "https://example.invalid/" }),
    /relative/,
  );
});

test("SDK responses stop at the streaming size limit", async () => {
  let cancelled = false;
  let chunks = 0;
  const transport = sdkTransport(
    () => Promise.resolve("fixture-secret"),
    () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              chunks++;
              controller.enqueue(new Uint8Array(1024 * 1024));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ),
  );
  await assert.rejects(transport({ method: "GET", path: "large" }));
  assert.equal(cancelled, true);
  assert(chunks <= 4);
});
