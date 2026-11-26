import { asyncFixture } from "./support/async-fixture.js";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { readPullRequestDetails } from "../src/github/reviews.js";

const url = "https://github.com/owner/repo/pull/12";
test("review reads gate all message sources on public visibility and preserve source, timestamp and truncation", async () => {
  const paths: string[] = [];
  const read = asyncFixture((path: string) => {
    paths.push(path);
    if (path === "repos/owner/repo/pulls/12")
      return { base: { repo: { private: false } }, title: "Example PR", state: "open", head: { sha: "abc" } };
    if (path.includes("/reviews?"))
      return [
        {
          id: 1,
          user: { login: "reviewer" },
          state: "CHANGES_REQUESTED",
          body: "Please fix the race.",
          submitted_at: "2026-11-08T12:00:00Z",
          commit_id: "older",
          html_url: url + "#pullrequestreview-1",
        },
      ];
    if (path.includes("/pulls/12/comments?"))
      return [
        {
          id: 2,
          user: { login: "reviewer" },
          body: "x".repeat(5000),
          created_at: "2026-11-08T12:01:00Z",
          path: "src/worker.ts",
          line: 14,
        },
      ];
    return Array.from({ length: 100 }, (_, i) => ({
      id: i + 3,
      user: { login: "author" },
      body: "Done",
      created_at: "2026-11-08T12:02:00Z",
    }));
  });
  const details = await readPullRequestDetails(url, undefined, read);
  assert.equal(paths[0], "repos/owner/repo/pulls/12");
  assert.equal(paths.length, 4);
  assert.equal(details.headSha, "abc");
  assert.equal(details.state, "open");
  assert.equal(details.mayHaveMoreMessages, true);
  assert.equal(details.messages.length, 102);
  const [first, second] = details.messages;
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.state, "CHANGES_REQUESTED");
  assert.equal(first.commitSha, "older");
  assert.equal(second.path, "src/worker.ts");
  assert.equal(second.line, 14);
  assert.equal(second.bodyMarkdown.length, 4000);
  assert.equal(second.bodyTruncated, true);
  assert(details.messages.every((m) => m.atMs > 0));
  for (const visibility of [true, undefined]) {
    let calls = 0;
    await assert.rejects(
      readPullRequestDetails(
        url,
        undefined,
        asyncFixture(() => {
          calls++;
          return { base: { repo: { private: visibility } } };
        }),
      ),
      /Only confirmed public/,
    );
    assert.equal(calls, 1);
  }
  let called = false;
  await assert.rejects(
    readPullRequestDetails(
      "file:///etc/passwd",
      undefined,
      asyncFixture(() => {
        called = true;
      }),
    ),
  );
  assert.equal(called, false);
});

test("a malformed review item fails the read without inventing a message", async () => {
  await assert.rejects(
    readPullRequestDetails(url, undefined, (path) =>
      Promise.resolve(path === "repos/owner/repo/pulls/12" ? { base: { repo: { private: false } } } : [null]),
    ),
    /invalid review or comment/,
  );
});
