import assert from "node:assert/strict";
import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Coordinator } from "../src/coordinator.js";
import { trackedCodeHost } from "../src/issues/composition.js";
test("coordinator commits cannot execute agent-edited hooks or content filters", async () => {
  const directory = await mkdtemp("/tmp/octo-issue-git-");
  const root = join(directory, "repo");
  const state = join(directory, "state");
  const workspace = join(root, ".worktrees", "agent");
  const escaped = join(directory, "escaped");
  await mkdir(root, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 10000,
    }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Issue acceptance");
  git("config", "user.email", "issue-test@example.invalid");
  git("remote", "add", "origin", "https://github.com/owner/repo.git");
  await mkdir(join(root, ".githooks"));
  await writeFile(
    join(root, ".githooks", "pre-commit"),
    "#!/bin/sh\nexit 0\n",
    { mode: 0o755 },
  );
  await writeFile(join(root, ".gitignore"), ".worktrees/\n");
  await writeFile(join(root, "answer.txt"), "before\n");
  await writeFile(
    join(root, "octo-manager.toml"),
    "schema_version = 1\n" +
      ["investigation", "implementation", "verification"]
        .map(
          (role) =>
            `[issues.profiles.${role}]\nharness = "codex"\nmodel = "controlled"\n`,
        )
        .join("\n"),
  );
  git("add", ".");
  git("-c", "core.hooksPath=/dev/null", "commit", "-m", "Seed fixture");
  git("config", "core.hooksPath", ".githooks");
  git("worktree", "add", "-b", "issue-feature", workspace);
  const coordinator = new Coordinator(state);
  try {
    const issue = coordinator.issues.enroll(
      "github",
      "https://github.com/owner/repo/issues/1",
      root,
      "fixture-owner",
      "fixture-enroll",
    );
    issue.workspace = workspace;
    await writeFile(
      join(workspace, ".githooks", "pre-commit"),
      `#!/bin/sh\ntouch '${escaped}'\n`,
      { mode: 0o755 },
    );
    await writeFile(join(workspace, "answer.txt"), "after\n");
    const host = trackedCodeHost(coordinator.tracking, state);
    const signal = new AbortController().signal;
    expect(await host.commit(issue, signal, () => {})).toMatch(
      /^[a-f0-9]{40}$/u,
    );
    expect(existsSync(escaped)).toBe(false);
    git("config", "filter.evil.clean", `touch '${escaped}'; cat`);
    await writeFile(
      join(workspace, ".gitattributes"),
      "answer.txt filter=evil\n",
    );
    await writeFile(join(workspace, "answer.txt"), "another change\n");
    await assert.rejects(
      host.commit(issue, signal, () => {}),
      /content filters/u,
    );
    expect(existsSync(escaped)).toBe(false);
  } finally {
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the code-host adapter reconciles a linked remediation PR without opening another publication", async () => {
  const directory = await mkdtemp("/tmp/octo-issue-republish-");
  const root = join(directory, "repo");
  const state = join(directory, "state");
  const workspace = join(root, ".worktrees", "agent");
  await mkdir(root, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 10000,
    }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Issue acceptance");
  git("config", "user.email", "issue-test@example.invalid");
  git("remote", "add", "origin", "https://github.com/owner/repo.git");
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  await writeFile(join(root, ".gitignore"), ".worktrees/\n");
  await writeFile(
    join(root, "octo-manager.toml"),
    "schema_version = 1\n" +
      ["investigation", "implementation", "verification"]
        .map(
          (role) =>
            `[issues.profiles.${role}]\nharness = "codex"\nmodel = "controlled"\n`,
        )
        .join("\n"),
  );
  git("add", ".");
  git("-c", "core.hooksPath=/dev/null", "commit", "-m", "Seed fixture");
  git("worktree", "add", "-b", "issue-feature", workspace);
  const head = git("rev-parse", "HEAD");
  const coordinator = new Coordinator(state);
  let reads = 0;
  try {
    const issue = coordinator.issues.enroll(
      "github",
      "https://github.com/owner/repo/issues/1",
      root,
      "fixture-owner",
      "fixture-enroll",
    );
    issue.workspace = workspace;
    issue.prUrl = "https://github.com/owner/repo/pull/7";
    issue.prHead = "previous";
    const host = trackedCodeHost(coordinator.tracking, state, (request) => {
      expect(request).toEqual({
        method: "GET",
        path: "repos/owner/repo/pulls/7",
      });
      reads++;
      return Promise.resolve({
        status: 200,
        headers: new Map(),
        body: JSON.stringify({
          html_url: issue.prUrl,
          state: "open",
          merged: false,
          head: {
            sha: head,
            ref: "issue-feature",
            repo: { full_name: "owner/repo" },
          },
          base: { ref: "main", repo: { full_name: "owner/repo" } },
        }),
      });
    });
    expect(
      await host.publish(
        "remediation",
        issue,
        {
          disposition: "tested",
          summary: "Retested",
          evidence: ["test output"],
          head,
          draft: { title: "Repair", body: "Preserve compatibility" },
        },
        new AbortController().signal,
        () => {},
      ),
    ).toEqual({ url: issue.prUrl, head });
    expect(reads).toBe(2);
    expect(existsSync(join(state, "publications"))).toBe(false);
  } finally {
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});
