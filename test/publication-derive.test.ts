import { Coordinator } from "../src/coordinator.js";
import { schedulerClient } from "../src/client.js";
import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initialize, readContract } from "../src/publication/contract.js";
import { deriveGuidance, sampleStatistics } from "../src/publication/derive.js";
import type { RunStage } from "../src/submissions/worker.js";
import type { GitHubTransport } from "../src/github-sdk.js";
import { Store } from "../src/store.js";
import { TrackingService } from "../src/tracking/service.js";
import { defaultTrackingConfig } from "../src/tracking/config.js";
import { SubmissionService } from "../src/submissions/service.js";
import { SubmissionState } from "../src/submissions/contracts.js";

test("bounded derivation uses the chosen remote and caches advisory proposals without activating inferred rules", async () => {
  const root = await mkdtemp(join(tmpdir(), "octo-derive-"));
  try {
    for (const args of [
      ["init", "-q"],
      ["remote", "add", "upstream", "https://github.com/upstream/project.git"],
    ]) {
      const command = Bun.spawnSync(["git", "-C", root, ...args]);
      expect(command.exitCode).toBe(0);
    }
    initialize(root);
    await writeFile(
      join(root, "CONTRIBUTING.md"),
      "Explain outcomes. Historical word counts are not requirements.",
    );
    const before = readContract(root);
    let invocations = 0,
      requestPath = "";
    const run: RunStage = (role, input, _schema, _instructions, model) => {
      invocations++;
      expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThan(50000);
      const result = {
        guidance: ["Explain outcomes; sampled word counts are advisory."],
        proposedContract: {
          schemaVersion: 1,
          template: "untrusted-template.md",
          title: { maxLength: 10 },
        },
      };
      return Promise.resolve({
        role,
        model,
        promptDigest: "fixture",
        raw: JSON.stringify(result),
        result,
        at: Date.now(),
      });
    };
    const transport: GitHubTransport = (request) => {
      requestPath = request.path;
      return Promise.resolve({
        status: 200,
        headers: new Map(),
        body: JSON.stringify([
          {
            title: "Short",
            body: "one two",
            html_url: "https://github.com/upstream/project/pull/1",
            merged_at: "2026-01-01",
          },
          {
            title: "Long title",
            body: "one two three four",
            html_url: "https://github.com/upstream/project/pull/2",
            merged_at: "2026-01-01",
          },
        ]),
      });
    };
    const first = await deriveGuidance(
      root,
      { remote: "upstream", count: 20, model: "fixture" },
      run,
      transport,
    );
    expect(first.sampleCount).toBe(2);
    expect(first.cached).toBe(false);
    expect(requestPath).toContain("repos/upstream/project/pulls?");
    expect(readContract(root).hash).toBe(before.hash);
    const output = await readFile(join(root, first.path), "utf8");
    expect(output).toContain('"advisory": true');
    expect(output).toContain('"medianBodyWords": 3');
    expect(output).not.toContain("untrusted-template.md");
    const second = await deriveGuidance(
      root,
      { remote: "upstream", count: 20, model: "fixture" },
      run,
      transport,
    );
    expect(second.cached).toBe(true);
    expect(invocations).toBe(1);
    const changedModel = await deriveGuidance(
      root,
      { remote: "upstream", count: 20, model: "different-fixture" },
      run,
      transport,
    );
    expect(changedModel.cached).toBe(false);
    expect(invocations).toBe(2);
    expect(sampleStatistics([]).medianBodyWords).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("default service retires queued legacy analysis and rejects new model requests; legacy listing projects before pagination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-legacy-cutover-"));
  await mkdir(join(directory, "state"));
  const store = new Store(join(directory, "state"));
  const tracking = new TrackingService(
    store.tracking,
    defaultTrackingConfig(),
    Date.now,
    { read: () => Promise.reject(new Error("Offline")) },
  );
  const request = {
    requestId: "legacy",
    repository: "owner/repo",
    headRef: "feature/legacy",
    headSha: "a".repeat(40),
    baseRef: "main",
    purpose: "Legacy",
    validation: [],
    draft: false,
    owner: {
      harness: "codex" as const,
      endpoint: "local",
      sessionId: "fixture",
    },
  };
  let calls = 0;
  const service = new SubmissionService(store.submissions, tracking, {
    run: () => {
      calls++;
      return Promise.reject(new Error("Must not run"));
    },
  });
  try {
    const legacy = store.submissions.request(request);
    service.start();
    expect(store.submissions.get(legacy.id).state).toBe(
      SubmissionState.NeedsInput,
    );
    expect(() => service.submit(request)).toThrow("Legacy drafting retired");
    expect(calls).toBe(0);
    for (let i = 0; i < 40; i++)
      store.submissions.request({
        ...request,
        requestId: "legacy-" + String(i),
        purpose: "large ".repeat(2000),
      });
    const page = store.submissions.summaryPage(Number.MAX_SAFE_INTEGER, 4);
    expect(page.items).toHaveLength(4);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(4096);
    expect(JSON.stringify(page)).not.toContain("large ");
    if (page.next === undefined) throw new Error("Missing next cursor");
    const next = store.submissions.summaryPage(page.next, 4);
    expect(next.items).toHaveLength(4);
    expect(next.items[0]?.["id"]).not.toBe(page.items[0]?.["id"]);
  } finally {
    await service.close();
    await tracking.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy submission RPC returns clear migration feedback instead of an internal tracking error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-legacy-rpc-"));
  const coordinator = new Coordinator(directory);
  try {
    await coordinator.start();
    let message = "";
    try {
      await schedulerClient(directory).submitPullRequest({ inputJson: "{}" });
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toContain("Legacy drafting retired");
    expect(coordinator.store.submissions.list()).toHaveLength(0);
  } finally {
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});
