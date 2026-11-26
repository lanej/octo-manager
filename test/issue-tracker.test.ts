import { test, expect } from "bun:test";
import { GitHubIssueTracker } from "../src/issue-trackers/github.js";
import { GitHubReads } from "../src/github/reads.js";
import type { GitHubRequest } from "../src/github/sdk.js";

test("GitHub issue adapter preserves edits, reconciles marked writes, and closes through scheduled PATCH", async () => {
  const calls: GitHubRequest[] = [];
  let commentBody = "A correction";
  let state = "open";
  const reads = new GitHubReads((request) => {
    calls.push(request);
    let body: unknown = {};
    if (request.method === "GET" && request.path.includes("/comments?"))
      body = [
        {
          id: 7,
          body: commentBody,
          html_url: "https://github.com/owner/repo/issues/1#issuecomment-7",
          updated_at: "revision2",
          user: { login: "reader" },
        },
      ];
    else if (request.method === "GET")
      body = {
        title: "Investigate example",
        body: "Expected result",
        state,
        updated_at: "now",
      };
    else if (request.method === "POST") {
      commentBody = String(request.data?.["body"]);
      body = {
        html_url: "https://github.com/owner/repo/issues/1#issuecomment-7",
      };
    } else if (request.method === "PATCH") {
      state = "closed";
      body = { state };
    }
    return Promise.resolve({
      status: 200,
      headers: new Map(),
      body: JSON.stringify(body),
    });
  });
  const tracker = new GitHubIssueTracker(reads);
  const ref = tracker.identify("https://github.com/owner/repo/issues/1");
  const signal = new AbortController().signal;
  expect((await tracker.observe(ref, signal)).comments[0]?.revision).toBe("revision2");
  await tracker.post(ref, "round-1", "Question and assumptions", signal, () => {});
  expect(await tracker.findPost(ref, "round-1", signal)).toContain("issuecomment-7");
  await tracker.close(ref, signal, () => {});
  expect((await tracker.observe(ref, signal)).closed).toBe(true);
  expect(calls.some((call) => call.method === "PATCH" && call.data?.["state_reason"] === "completed")).toBe(true);
});
