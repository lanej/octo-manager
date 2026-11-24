import { Code, ConnectError } from "@connectrpc/connect";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { schedulerClient } from "../src/client.js";
import { Coordinator } from "../src/coordinator.js";
import { EntryState } from "../src/merging/contracts.js";
import type { MergeProvider, MergeSnapshot } from "../src/merging/github.js";
import { defaultTrackingConfig } from "../src/tracking/config.js";
import { trackingOperation } from "../src/tracking/rpc.js";

const url = "https://github.com/owner/repo/pull/75";
const head = "a".repeat(40),
  newer = "b".repeat(40),
  base = "c".repeat(40);
const owner = { harness: "codex", endpoint: "local", sessionId: "readiness" };

function snapshot(): MergeSnapshot {
  return {
    observation: {
      observedAt: 1000,
      headSha: head,
      baseSha: base,
      targetBase: { ref: "main", sha: base },
      lifecycle: "open",
      mergeability: "mergeable",
      checks: {
        state: "complete",
        value: [
          {
            id: "run:1",
            key: "ci",
            name: "CI",
            headSha: head,
            status: "completed",
            conclusion: "success",
            at: 1000,
            url,
          },
        ],
      },
      workflows: { state: "complete", value: [] },
      reviews: { state: "complete", value: [] },
      feedback: { state: "complete", value: [] },
    },
    draft: false,
    gate: "CLEAN",
    review: null,
    required: ["CI"],
    queueRequired: false,
    methods: ["squash"],
  };
}

test("RPC rejects a stale readiness head with a refresh diagnostic and preserves the assessment guard", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-readiness-rpc-"));
  const current = snapshot();
  const coordinator = new Coordinator(directory, {
    mergeOptions: { intervalMs: 600000 },
    trackingOptions: {
      read: () => Promise.resolve(structuredClone(current.observation)),
    },
  });
  try {
    const pr = coordinator.store.tracking.track(url, owner);
    coordinator.store.tracking.observe(
      pr.id,
      current.observation,
      coordinator.tracking.config,
    );
    await coordinator.start();
    const client = schedulerClient(directory);
    const request = { pr: url, actorId: pr.ownerAgentId, head: newer };
    const failure: unknown = await client
      .setMergeReady(request)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConnectError);
    if (!(failure instanceof ConnectError))
      throw new Error("Missing RPC error");
    expect(failure.code).toBe(Code.FailedPrecondition);
    expect(failure.rawMessage).toContain(`Readiness head ${newer}`);
    expect(failure.rawMessage).toContain(`observed head ${head}`);
    expect(failure.rawMessage).toContain(`octo-manager pr refresh ${url}`);
    expect(failure.rawMessage).toContain(
      "wait until the observed head matches",
    );
    expect(coordinator.store.merging.entries()).toHaveLength(0);
    expect(coordinator.store.merging.operations()).toHaveLength(0);

    current.observation.headSha = newer;
    current.observation.checks = { state: "complete", value: [] };
    coordinator.store.tracking.observe(
      pr.id,
      current.observation,
      coordinator.tracking.config,
    );
    const result = await client.setMergeReady(request);
    expect(result.entry?.ready?.head).toBe(newer);
    expect(coordinator.store.merging.operations()).toHaveLength(0);
  } finally {
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("queued merge reports inspection before the actual eligibility gate, then proceeds when that gate clears", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-readiness-gate-"));
  const current = snapshot();
  current.review = "REVIEW_REQUIRED";
  let release: (() => void) | undefined;
  let inspected: (() => void) | undefined;
  const inspectionStarted = new Promise<void>((resolve) => {
    inspected = resolve;
  });
  const inspectionReleased = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true,
    writes = 0,
    now = 1000;
  const provider: MergeProvider = {
    async inspect() {
      if (first) {
        first = false;
        inspected?.();
        await inspectionReleased;
      }
      return structuredClone(current);
    },
    merge(_url, pinned, _method, _signal, beforeSend) {
      beforeSend();
      expect(pinned).toBe(head);
      writes++;
      current.observation.lifecycle = "merged";
      current.mergeCommit = "d".repeat(40);
      return Promise.resolve(current.mergeCommit);
    },
  };
  const coordinator = new Coordinator(directory, {
    now: () => now,
    mergeOptions: { provider },
  });
  const database = new DatabaseSync(join(directory, "jobs.sqlite"), {
    readOnly: true,
  });
  try {
    const pr = coordinator.store.tracking.track(url, owner);
    coordinator.store.tracking.observe(
      pr.id,
      current.observation,
      defaultTrackingConfig(),
    );
    coordinator.store.merging.queue({
      requestId: "readiness-gate",
      actorId: pr.ownerAgentId,
      entries: [{ prUrl: url, checks: ["CI"] }],
    });
    const queued = coordinator.store.merging.ready(url, pr.ownerAgentId, head);
    expect(queued.detail).toContain(
      "queued for fresh GitHub merge eligibility",
    );
    expect(queued.detail).not.toContain("waiting for GitHub checks");
    const tick = coordinator.merging.tick();
    await inspectionStarted;
    expect(coordinator.store.merging.entry(url).detail).toBe(
      "Inspecting current GitHub merge eligibility",
    );
    expect(coordinator.store.merging.operations()).toHaveLength(0);
    release?.();
    await tick;
    const blocked = coordinator.store.merging.entry(url);
    expect(blocked.state).toBe(EntryState.WaitingChecks);
    expect(blocked.detail).toBe("GitHub review gate: REVIEW_REQUIRED");
    expect(writes).toBe(0);

    const notices = database
      .prepare("SELECT count(*) AS total FROM merge_notices")
      .get();
    now += 60000;
    await coordinator.merging.tick();
    expect(coordinator.store.merging.entry(url).version).toBe(blocked.version);
    expect(coordinator.store.merging.entry(url).detail).toBe(blocked.detail);
    expect(
      database.prepare("SELECT count(*) AS total FROM merge_notices").get(),
    ).toEqual(notices);
    expect(writes).toBe(0);

    current.review = null;
    now += 60000;
    await coordinator.merging.tick();
    expect(writes).toBe(1);
    expect(coordinator.store.merging.entries(pr.id)[0]?.state).toBe(
      EntryState.Merged,
    );
  } finally {
    release?.();
    database.close();
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("unexpected tracking failures retain a generic internal diagnostic", async () => {
  const failure: unknown = await trackingOperation(() => {
    throw new Error("private implementation detail");
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ConnectError);
  if (!(failure instanceof ConnectError)) throw new Error("Missing RPC error");
  expect(failure.code).toBe(Code.Internal);
  expect(failure.rawMessage).toBe("Tracking operation failed");
});
