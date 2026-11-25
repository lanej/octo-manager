import assert from "node:assert/strict";
import { test, expect } from "bun:test";
import { updateIssuePR } from "../src/issues/publication.js";
import type { GitHubTransport } from "../src/github/sdk.js";

function fixture() {
  const issue = {
    prUrl: "https://github.com/owner/repo/pull/7",
    prHead: "old",
  };
  const tested = {
    repository: "owner/repo",
    branch: "issue-fix",
    base: "main",
    head: "tested",
  };
  const remote = {
    html_url: issue.prUrl,
    state: "open",
    merged: false,
    head: { sha: "old", ref: "issue-fix", repo: { full_name: "owner/repo" } },
    base: { ref: "main", repo: { full_name: "owner/repo" } },
  };
  let pushes = 0;
  let authorized = false;
  const transport: GitHubTransport = (request, signal) => {
    expect(request).toEqual({
      method: "GET",
      path: "repos/owner/repo/pulls/7",
    });
    expect(signal).toBeDefined();
    return Promise.resolve({
      status: 200,
      headers: new Map(),
      body: JSON.stringify(remote),
    });
  };
  const push = (branch: string) => {
    expect(authorized).toBe(true);
    expect(branch).toBe("issue-fix");
    pushes++;
    remote.head.sha = tested.head;
    return Promise.resolve();
  };
  const authorize = () => {
    authorized = true;
  };
  return {
    issue,
    tested,
    remote,
    transport,
    push,
    authorize,
    pushes: () => pushes,
  };
}

test("remediation updates its existing PR and recovers a lost push acknowledgment without duplication", async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  await assert.rejects(
    updateIssuePR(
      f.issue,
      f.tested,
      f.transport,
      async (branch) => {
        await f.push(branch);
        throw new Error("push acknowledgment lost");
      },
      signal,
      f.authorize,
    ),
    /acknowledgment lost/u,
  );
  expect(
    await updateIssuePR(
      f.issue,
      f.tested,
      f.transport,
      f.push,
      signal,
      f.authorize,
    ),
  ).toEqual({ url: f.issue.prUrl, head: "tested" });
  expect(f.pushes()).toBe(1);
});

test("remediation rejects changed, closed, foreign, or retargeted PRs before pushing", async () => {
  for (const change of [
    "head",
    "closed",
    "fork",
    "base",
    "branch",
    "url",
  ] as const) {
    const f = fixture();
    switch (change) {
      case "head":
        f.remote.head.sha = "unobserved";
        break;
      case "closed":
        f.remote.state = "closed";
        break;
      case "fork":
        f.remote.head.repo.full_name = "someone/fork";
        break;
      case "base":
        f.remote.base.ref = "production";
        break;
      case "branch":
        f.remote.head.ref = "unrelated";
        break;
      case "url":
        f.issue.prUrl = "https://github.com/other/repo/pull/7";
        break;
    }
    await assert.rejects(
      updateIssuePR(
        f.issue,
        f.tested,
        f.transport,
        f.push,
        new AbortController().signal,
        f.authorize,
      ),
    );
    expect(f.pushes()).toBe(0);
  }
});

test("remediation does not confirm an update without the tested remote head", async () => {
  const f = fixture();
  await assert.rejects(
    updateIssuePR(
      f.issue,
      f.tested,
      f.transport,
      () => Promise.resolve(),
      new AbortController().signal,
      f.authorize,
    ),
    /unconfirmed/u,
  );
});
