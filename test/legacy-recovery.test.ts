import assert from "node:assert/strict";
import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.js";
import { TrackingService } from "../src/tracking/service.js";
import { defaultTrackingConfig } from "../src/tracking/config.js";
import { SubmissionService } from "../src/submissions/service.js";
import {
  GitHubSubmissions,
  type SubmissionGitHub,
} from "../src/submissions/github.js";
import {
  SubmissionState,
  Complexity,
  type SubmissionInput,
} from "../src/submissions/contracts.js";
const request: SubmissionInput = {
  requestId: "legacy",
  repository: "owner/repo",
  headRef: "feature",
  headSha: "a".repeat(40),
  baseRef: "main",
  purpose: "Saved publication",
  validation: [],
  draft: false,
  owner: { harness: "codex", endpoint: "local", sessionId: "fixture" },
};
test("automatic legacy recovery is find-only, durably backed off, and enrolls only a verified existing PR", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-legacy-recovery-"));
  let now = 1000,
    finds = 0,
    remoteWrites = 0,
    workers = 0,
    found = false;
  let store = new Store(directory, () => now),
    tracking = new TrackingService(
      store.tracking,
      defaultTrackingConfig(),
      () => now,
    );
  const github: SubmissionGitHub = {
    snapshot: () => Promise.reject(new Error("No snapshot during recovery")),
    verify: () =>
      Promise.reject(new Error("No publication preflight during recovery")),
    publish: () => {
      remoteWrites++;
      return Promise.reject(new Error("Never publish"));
    },
    find: (_input, marker) => {
      finds++;
      return Promise.resolve(
        found
          ? {
              url: "https://github.com/owner/repo/pull/1",
              headSha: request.headSha,
              body: marker,
              state: "open",
            }
          : undefined,
      );
    },
  };
  const options = {
    github,
    run: () => {
      workers++;
      return Promise.reject(new Error("Never run an agent"));
    },
  };
  let service = new SubmissionService(store.submissions, tracking, options);
  const value = store.submissions.request(request);
  store.submissions.save({
    ...value,
    state: SubmissionState.Uncertain,
    brief: {
      schemaVersion: 1,
      request,
      baseSha: "b".repeat(40),
      policyVersion: 1,
      change: {
        tier: Complexity.Routine,
        rationale: "Saved",
        outcome: "Saved publication",
        claims: [],
        limitations: [],
        blockers: [],
      },
      draft: {
        title: "fix: saved",
        body: "Saved outcome",
        requirementChecks: [],
        blockers: [],
      },
    },
  });
  try {
    service.reconcileLegacy(now);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finds).toBe(1);
    expect(store.submissions.get(value.id).state).toBe(
      SubmissionState.Uncertain,
    );
    expect(store.submissions.reconciliation(value.id)).toEqual({
      attempts: 1,
      nextAt: 61000,
    });
    service.reconcileLegacy(now);
    expect(finds).toBe(1);
    await service.close();
    await tracking.close();
    store.close();
    store = new Store(directory, () => now);
    tracking = new TrackingService(
      store.tracking,
      defaultTrackingConfig(),
      () => now,
    );
    service = new SubmissionService(store.submissions, tracking, options);
    service.reconcileLegacy(now);
    expect(finds).toBe(1);
    now = 61000;
    found = true;
    service.reconcileLegacy(now);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finds).toBe(2);
    expect(store.submissions.get(value.id).state).toBe(
      SubmissionState.Succeeded,
    );
    expect(store.tracking.prs()).toHaveLength(1);
    service.reconcileLegacy(now + 3600000);
    expect(finds).toBe(2);
    expect(remoteWrites).toBe(0);
    expect(workers).toBe(0);
  } finally {
    await service.close();
    await tracking.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("legacy publication lookup rejects duplicate markers instead of selecting the first match", async () => {
  const marker = "<!-- octo-submission:fixture -->";
  const provider = new GitHubSubmissions(() =>
    Promise.resolve(
      [1, 2].map((number) => ({
        html_url: `https://github.com/owner/repo/pull/${String(number)}`,
        head: { sha: request.headSha },
        body: marker,
        state: "open",
      })),
    ),
  );
  await assert.rejects(
    () => provider.find(request, marker, new AbortController().signal),
    /ambiguous/u,
  );
});
