import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordinator } from "../src/coordinator.js";
import { defaultTrackingConfig } from "../src/tracking/config.js";
import { GitHubRateLimitError } from "../src/github-api.js";
import {
  ChainState,
  EntryState,
  OperationState,
  type MergeEntry,
} from "../src/merging/contracts.js";
import type { MergeProvider, MergeSnapshot } from "../src/merging/github.js";
import type { ObservationInput } from "../src/tracking/types.js";

const head = "a".repeat(40),
  base = "b".repeat(40),
  changed = "c".repeat(40),
  commit = "d".repeat(40);
const first = "https://github.com/owner/repo/pull/1",
  second = "https://github.com/owner/repo/pull/2";
const target = {
  harness: "codex",
  endpoint: "local",
  sessionId: "external-merge",
};
function snapshot(sha = head): MergeSnapshot {
  const observation: ObservationInput = {
    observedAt: 1000,
    headSha: sha,
    baseSha: base,
    targetBase: { ref: "main", sha: base },
    lifecycle: "open",
    mergeability: "mergeable",
    checks: {
      state: "complete",
      value: [
        {
          id: "run:1",
          key: "run:ci",
          name: "CI",
          headSha: sha,
          status: "completed",
          conclusion: "success",
          at: 1000,
          url: first,
        },
      ],
    },
    workflows: { state: "complete", value: [] },
    reviews: { state: "complete", value: [] },
    feedback: { state: "complete", value: [] },
  };
  return {
    observation,
    draft: false,
    gate: "CLEAN",
    review: null,
    required: [],
    queueRequired: false,
    methods: ["squash"],
  };
}
async function fixture(
  run: (f: {
    current: () => Coordinator;
    remote: Map<string, MergeSnapshot>;
    ready: (url?: string) => MergeEntry;
    closePR: (url?: string) => void;
    restart: () => Promise<void>;
    advance: (milliseconds: number) => void;
    intercept: (hook: (() => void) | undefined) => void;
    reads: () => number;
    readinessReads: () => number;
    preferReadiness: () => void;
    effects: () => number;
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "octo-external-merge-"));
  let now = 1000,
    reads = 0,
    readinessReads = 0,
    effects = 0;
  let hook: (() => void) | undefined;
  const remote = new Map([
    [first, snapshot()],
    [second, snapshot()],
  ]);
  const config = defaultTrackingConfig();
  config.endpoints = {};
  const provider: MergeProvider = {
    inspect(url) {
      reads++;
      hook?.();
      const value = remote.get(url);
      assert(value !== undefined);
      return Promise.resolve(structuredClone(value));
    },
    merge() {
      effects++;
      return Promise.reject(new Error("Unexpected merge effect"));
    },
  };
  const create = () =>
    new Coordinator(directory, {
      now: () => now,
      trackingConfig: config,
      mergeOptions: {
        provider,
        prepare: () => {
          effects++;
          return Promise.reject(new Error("Unexpected preparation effect"));
        },
      },
    });
  let coordinator = create();
  const ready = (url = first) => {
    const pr = coordinator.store.tracking.track(url, target);
    const value = remote.get(url);
    assert(value !== undefined);
    coordinator.store.tracking.observe(pr.id, value.observation, config);
    return coordinator.store.merging.ready(
      pr.id,
      pr.ownerAgentId,
      value.observation.headSha,
    );
  };
  const closePR = (url = first) => {
    const value = remote.get(url);
    assert(value !== undefined);
    value.observation.lifecycle = "merged";
    value.mergeCommit = commit;
    const pr = coordinator.store.tracking.pr(url);
    coordinator.store.tracking.observe(pr.id, value.observation, config);
    coordinator.store.tracking.observe(pr.id, value.observation, config);
  };
  try {
    await run({
      current: () => coordinator,
      remote,
      ready,
      closePR,
      restart: async () => {
        await coordinator.close();
        coordinator = create();
      },
      advance: (milliseconds) => {
        now += milliseconds;
      },
      intercept: (value) => {
        hook = value;
      },
      reads: () => reads,
      readinessReads: () => readinessReads,
      preferReadiness: () => {
        provider.readiness = (url, observation) => {
          readinessReads++;
          assert.notEqual(observation.lifecycle, "open");
          hook?.();
          const value = remote.get(url);
          assert(value !== undefined);
          return Promise.resolve(structuredClone(value));
        };
      },
      effects: () => effects,
    });
  } finally {
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("persisted manual assessments reconcile externally merged heads and complete without effects", () =>
  fixture(async (f) => {
    const entry = f.ready();
    f.closePR();
    await f.restart();
    assert.equal(f.current().store.tracking.pr(first).state, "archived");
    await f.current().merging.tick();
    const merged = f.current().store.merging.entryById(entry.id);
    assert.equal(merged?.state, EntryState.Merged);
    assert.equal(merged.mergeCommit, commit);
    assert.equal(merged.autoMerge, false);
    assert.equal(
      f.current().store.merging.chain(entry.chainId).state,
      ChainState.Completed,
    );
    const reads = f.reads();
    await f.current().merging.tick();
    assert.equal(f.reads(), reads);
    assert.equal(f.effects(), 0);
  }));

test("different assessed heads and closed unmerged PRs cancel entries without implying a merge", () =>
  fixture(async (f) => {
    const coordinator = f.current();
    for (const url of [first, second]) {
      const pr = coordinator.store.tracking.track(url, target);
      const value = f.remote.get(url);
      assert(value !== undefined);
      coordinator.store.tracking.observe(
        pr.id,
        value.observation,
        coordinator.tracking.config,
      );
    }
    const owner = coordinator.store.tracking.pr(first).ownerAgentId;
    const chain = coordinator.store.merging.queue(
      {
        requestId: "mixed",
        actorId: owner,
        entries: [
          { prUrl: first, checks: ["CI"] },
          { prUrl: second, checks: ["CI"] },
        ],
      },
      false,
    );
    coordinator.store.merging.ready(first, owner, head);
    coordinator.store.merging.ready(second, owner, head);
    f.closePR(first);
    const other = f.remote.get(second);
    assert(other !== undefined);
    other.observation.headSha = changed;
    f.closePR(second);
    await coordinator.merging.tick();
    const entries = coordinator.store.merging.entriesForChain(chain.id);
    assert.equal(
      entries.find((e) => e.prId === coordinator.store.tracking.pr(first).id)
        ?.state,
      EntryState.Merged,
    );
    const cancelled = entries.find(
      (e) => e.prId === coordinator.store.tracking.pr(second).id,
    );
    assert.equal(cancelled?.state, EntryState.Cancelled);
    assert.equal(cancelled.mergeCommit, undefined);
    assert.equal(
      coordinator.store.merging.chain(chain.id).state,
      ChainState.Cancelled,
    );
    assert.equal(f.effects(), 0);
  }));

test("a confirmed closed-unmerged PR cancels its manual entry and chain", () =>
  fixture(async (f) => {
    const entry = f.ready(),
      value = f.remote.get(first);
    assert(value !== undefined);
    value.observation.lifecycle = "closed";
    f.current().store.tracking.observe(
      entry.prId,
      value.observation,
      f.current().tracking.config,
    );
    await f.current().merging.tick();
    assert.equal(
      f.current().store.merging.entryById(entry.id)?.state,
      EntryState.Cancelled,
    );
    assert.equal(
      f.current().store.merging.chain(entry.chainId).state,
      ChainState.Cancelled,
    );
    assert.equal(f.effects(), 0);
  }));

test("unconfirmed merge commits and rate limits retain unknown outcomes with bounded retries", () =>
  fixture(async (f) => {
    const entry = f.ready();
    f.closePR();
    const value = f.remote.get(first);
    assert(value !== undefined);
    delete value.mergeCommit;
    await f.current().merging.tick();
    const blocked = f.current().store.merging.entryById(entry.id);
    assert(blocked !== undefined);
    assert.equal(blocked.state, EntryState.Blocked);
    assert.equal(blocked.nextAt, 61000);
    const reads = f.reads();
    await f.current().merging.tick();
    assert.equal(f.reads(), reads);
    f.advance(61000);
    f.intercept(() => {
      throw new Error("x".repeat(2000));
    });
    await f.current().merging.tick();
    const failure = f.current().store.merging.entryById(entry.id);
    assert(failure !== undefined);
    assert.equal(failure.state, EntryState.Blocked);
    assert(failure.detail.length <= 1000);
    f.advance(61000);
    f.intercept(() => {
      throw new GitHubRateLimitError(600000);
    });
    await f.current().merging.tick();
    assert.equal(f.current().store.merging.entryById(entry.id)?.nextAt, 600000);
    f.advance(600000);
    f.intercept(undefined);
    value.mergeCommit = commit;
    await f.current().merging.tick();
    assert.equal(
      f.current().store.merging.entryById(entry.id)?.state,
      EntryState.Merged,
    );
    assert.equal(f.effects(), 0);
  }));

for (const change of [
  "pause",
  "cancel",
  "owner",
  "receipt",
  "rearm",
  "operation",
  "observation",
] as const)
  test(`external inspection cannot overwrite concurrent ${change} changes`, () =>
    fixture(async (f) => {
      const entry = f.ready();
      f.closePR();
      const coordinator = f.current(),
        store = coordinator.store.merging;
      f.intercept(() => {
        switch (change) {
          case "pause":
            store.control(entry.chainId, ChainState.Paused);
            break;
          case "cancel":
            store.control(entry.chainId, ChainState.Cancelled);
            break;
          case "owner":
            coordinator.store.tracking.assign(entry.prId, {
              ...target,
              sessionId: "new-owner",
            });
            break;
          case "receipt":
            store.saveEntry({
              ...entry,
              receiptId: "new-receipt",
              receiptContext: "new-context",
            });
            break;
          case "rearm":
            store.autoMerge(
              first,
              coordinator.store.tracking.pr(first).ownerAgentId,
              true,
              "rearm",
            );
            break;
          case "observation":
            coordinator.store.tracking.observe(
              entry.prId,
              {
                ...snapshot().observation,
                lifecycle: "merged",
                headSha: changed,
              },
              coordinator.tracking.config,
            );
            break;
          case "operation":
            store.saveOperation({
              id: "unknown",
              entryId: entry.id,
              prId: entry.prId,
              epoch: 0,
              kind: "merge",
              state: OperationState.Uncertain,
              phase: "merging",
              head,
              baseRef: "main",
              baseSha: base,
              graph: "fixture",
              ownerId: coordinator.store.tracking.pr(first).ownerAgentId,
              createdAt: 1000,
              updatedAt: 1000,
              detail: "Unconfirmed external effect",
            });
            break;
        }
      });
      await coordinator.merging.tick();
      assert.notEqual(store.entryById(entry.id)?.state, EntryState.Merged);
      assert.notEqual(store.chain(entry.chainId).state, ChainState.Completed);
      if (change === "cancel")
        assert.equal(store.chain(entry.chainId).state, ChainState.Cancelled);
      if (change === "pause")
        assert.equal(store.chain(entry.chainId).state, ChainState.Paused);
      if (change === "operation")
        assert.equal(
          store.operations(entry.prId)[0]?.state,
          OperationState.Uncertain,
        );
      if (["pause", "cancel", "operation"].includes(change)) {
        const reads = f.reads();
        await coordinator.merging.tick();
        assert.equal(f.reads(), reads);
      }
      assert.equal(f.effects(), 0);
    }));

test("shutdown during external confirmation does not report a terminal outcome", () =>
  fixture(async (f) => {
    const entry = f.ready();
    f.closePR();
    let shutdown: Promise<void> | undefined;
    f.intercept(() => {
      shutdown = f.current().merging.close();
    });
    await f.current().merging.tick();
    await shutdown;
    assert.equal(
      f.current().store.merging.entryById(entry.id)?.state,
      EntryState.WaitingChecks,
    );
    assert.equal(
      f.current().store.merging.chain(entry.chainId).state,
      ChainState.Active,
    );
    assert.equal(f.effects(), 0);
  }));

test("entry-level uncertainty remains unconfirmed without an operation lease", () =>
  fixture(async (f) => {
    const entry = f.ready();
    f.closePR();
    f.current().store.merging.state(
      entry,
      EntryState.Uncertain,
      "Historical effect remains unconfirmed",
    );
    await f.current().merging.tick();
    assert.equal(
      f.current().store.merging.entryById(entry.id)?.state,
      EntryState.Uncertain,
    );
    assert.equal(f.reads(), 0);
    assert.equal(f.effects(), 0);
  }));

test("closed reconciliation prefers fresh readiness proof and rejects mismatching heads", () =>
  fixture(async (f) => {
    const entry = f.ready();
    f.closePR();
    f.preferReadiness();
    const value = f.remote.get(first);
    assert(value !== undefined);
    value.observation.headSha = changed;
    await f.current().merging.tick();
    assert.equal(
      f.current().store.merging.entryById(entry.id)?.state,
      EntryState.Blocked,
    );
    assert.equal(f.reads(), 0);
    f.advance(61000);
    value.observation.headSha = head;
    await f.current().merging.tick();
    assert.equal(
      f.current().store.merging.entryById(entry.id)?.state,
      EntryState.Merged,
    );
    assert.equal(f.readinessReads(), 2);
    assert.equal(f.reads(), 0);
    assert.equal(f.effects(), 0);
  }));
