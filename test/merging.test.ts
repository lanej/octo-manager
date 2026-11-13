import {
  checkRunObservation,
  workflowObservation,
} from "../src/tracking/checks.js";
import { mergeProgress } from "../src/merging/async-merge.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RebaseWorkspace } from "../src/repairs/git.js";
import { preparer } from "../src/merging/preparation.js";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { GitHubHTTPError } from "../src/github-api.js";
import { Coordinator } from "../src/coordinator.js";
import { schedulerClient } from "../src/client.js";
import { Store } from "../src/store.js";
import { defaultTrackingConfig } from "../src/tracking/config.js";
import type { ObservationInput } from "../src/tracking/types.js";
import type { MergeProvider, MergeSnapshot } from "../src/merging/github.js";
import {
  ChainState,
  EntryState,
  OperationState,
  ReferenceDecision,
  checked,
  ChainSchema,
  type MergeOperation,
  type PreparationProfile,
} from "../src/merging/contracts.js";
import { repin } from "../src/merging/preparation.js";
import { checkGate } from "../src/merging/policy.js";
const a = "a".repeat(40),
  b = "b".repeat(40),
  c = "c".repeat(40),
  d = "d".repeat(40),
  e = "e".repeat(40);
const first = "https://github.com/owner/library/pull/1",
  second = "https://github.com/owner/application/pull/2";
const agent = {
  harness: "codex",
  endpoint: "local",
  sessionId: "merge-chain-fixture",
};
const profile: PreparationProfile = {
  kind: "toml_revision",
  repository: "owner/application",
  checks: [["git", "diff", "--exit-code"]],
  timeoutMs: 1000,
  path: "versions.toml",
  key: ["tools", "library", "revision"],
  expectedValue: a,
};
function observation(head = a): ObservationInput {
  return {
    observedAt: 1000,
    headSha: head,
    baseSha: b,
    targetBase: { ref: "main", sha: b },
    lifecycle: "open",
    mergeability: "mergeable",
    checks: {
      state: "complete",
      value: [
        {
          id: "run:1",
          key: "run:ci",
          name: "CI",
          headSha: head,
          status: "completed",
          conclusion: "success",
          at: 1000,
          url: first,
        },
      ],
    },
    reviews: { state: "complete", value: [] },
    feedback: { state: "complete", value: [] },
    workflows: { state: "complete", value: [] },
  };
}
function snapshot(head = a): MergeSnapshot {
  return {
    observation: observation(head),
    draft: false,
    gate: "CLEAN",
    review: null,
    required: [],
    queueRequired: false,
    methods: ["squash"],
  };
}
async function fixture(
  run: (
    c: Coordinator,
    advance: () => void,
    snapshots: Map<string, MergeSnapshot>,
    writes: string[],
  ) => Promise<void>,
  options: {
    unknownMerge?: boolean;
    asyncMerge?: boolean;
    unknownPush?: boolean;
    pausedPush?: boolean;
    failMerge?: boolean;
    conflictMerge?: boolean;
    authMerge?: boolean;
    inspect?: (c: Coordinator, url: string) => void;
    beforeSend?: (c: Coordinator) => void;
  } = {},
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "octo-merging-"));
  let now = 1000;
  const snapshots = new Map([
      [first, snapshot()],
      [second, snapshot(c)],
    ]),
    writes: string[] = [];
  const provider: MergeProvider = {
    result() {
      return Promise.resolve({ state: "merged", sha: d });
    },
    inspect(url) {
      options.inspect?.(coordinator, url);
      const value = snapshots.get(url);
      if (value === undefined) throw new Error("Unexpected provider read");
      return Promise.resolve(structuredClone(value));
    },
    merge(url, head, _method, _signal, beforeSend) {
      options.beforeSend?.(coordinator);
      beforeSend();
      writes.push(`${url}@${head}`);
      const value = snapshots.get(url);
      assert(value !== undefined);
      if (options.authMerge === true)
        return Promise.reject(
          new GitHubHTTPError(401, "Authentication required"),
        );
      if (options.conflictMerge === true)
        return Promise.reject(new GitHubHTTPError(409));
      if (options.failMerge === true)
        return Promise.reject(new GitHubHTTPError(405));
      value.observation.lifecycle = "merged";
      value.mergeCommit = url === first ? d : e;
      if (options.unknownMerge === true)
        return Promise.reject(new Error("Connection lost after request"));
      if (options.asyncMerge === true)
        return Promise.resolve({
          state: "pending" as const,
          requestId: "11111111-1111-4111-8111-111111111111",
        });
      return Promise.resolve(value.mergeCommit);
    },
  };
  const config = defaultTrackingConfig();
  config.merging = { pin: profile };
  config.endpoints = {};
  const coordinator = new Coordinator(directory, {
    now: () => now,
    trackingConfig: config,
    trackingOptions: {
      read(url) {
        const value = snapshots.get(url);
        assert(value !== undefined);
        return Promise.resolve(structuredClone(value.observation));
      },
    },
    mergeOptions: {
      provider,
      intervalMs: 3600000,
      prepare(input) {
        writes.push("prepare");
        if (options.pausedPush === true)
          coordinator.merging.command({
            op: "pause",
            id: coordinator.store.merging.chains()[0]?.id,
          });
        input.beforePush(e, "controlled-workspace");
        const value = snapshots.get(second);
        assert(value !== undefined);
        value.observation = observation(e);
        if (options.unknownPush === true)
          return Promise.reject(new Error("Push outcome unknown"));
        return Promise.resolve(e);
      },
    },
  });
  try {
    await run(
      coordinator,
      () => {
        now += 61000;
      },
      snapshots,
      writes,
    );
  } finally {
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
}
function enroll(c: Coordinator, url: string, head = a) {
  const pr = c.store.tracking.track(url, agent);
  return c.store.tracking.observe(pr.id, observation(head), c.tracking.config);
}
test("RPC queues only explicit targets, prepares cross-repository dependency, and merges after renewed owner readiness", () =>
  fixture(async (c, advance, snapshots, writes) => {
    const upstream = enroll(c, first),
      downstream = enroll(c, second, cValue());
    c.merging.command({
      op: "confirm",
      pr: second,
      prerequisite: first,
      actorId: downstream.ownerAgentId,
      reason: "Uses the merged library revision",
      profile: "pin",
    });
    await c.start();
    const client = schedulerClient(c.directory),
      input = {
        requestId: "chain",
        actorId: upstream.ownerAgentId,
        entries: [
          { prUrl: first, checks: ["CI"] },
          { prUrl: second, checks: ["CI"] },
        ],
      };
    await client.listAgentMessages({
      agentId: upstream.ownerAgentId.replaceAll("-", "").slice(0, 8),
      afterSequence: 0n,
    });
    const queued = await client.mergeCommand({
      inputJson: JSON.stringify({ op: "queue", input }),
    });
    const raw: unknown = JSON.parse(queued.resultJson);
    const chain = checked(ChainSchema, raw);
    await client.mergeCommand({
      inputJson: JSON.stringify({
        op: "ready",
        pr: first,
        actorId: upstream.ownerAgentId,
        head: a,
      }),
    });
    await c.merging.tick();
    assert.deepEqual(
      writes,
      [`${first}@${a}`],
      JSON.stringify(c.store.merging.inspect()),
    );
    assert.equal(c.store.merging.entry(second).state, EntryState.Waiting);
    const value = snapshots.get(first);
    assert(value !== undefined);
    c.store.tracking.observe(upstream.id, value.observation, c.tracking.config);
    advance();
    await c.merging.tick();
    assert.deepEqual(writes, [`${first}@${a}`, "prepare"]);
    const prepared = snapshots.get(second);
    assert(prepared !== undefined);
    c.store.tracking.observe(
      downstream.id,
      prepared.observation,
      c.tracking.config,
    );
    advance();
    await c.merging.tick();
    assert.equal(writes.length, 2);
    await client.mergeCommand({
      inputJson: JSON.stringify({
        op: "ready",
        pr: second,
        actorId: downstream.ownerAgentId,
        head: e,
      }),
    });
    await c.merging.tick();
    assert.equal(writes.at(-1), `${second}@${e}`);
    assert.equal(c.store.merging.chain(chain.id).state, ChainState.Completed);
    const messages = c.store.tracking.inbox
      .list(upstream.ownerAgentId, 0, false, true)
      .messages.filter((message) => message.workflowPRId !== undefined);
    assert(messages.length > 0);
    const message = messages[0];
    assert(message !== undefined);
    const receipt = c.store.tracking.acknowledgeMessage(
      message.id,
      upstream.ownerAgentId,
    );
    assert(receipt.acknowledgedAt !== undefined);
    const wire = (await client.getSnapshot({})).snapshot;
    assert(wire !== undefined);
    assert.equal(wire.mergeStatuses.length, 2);
  }));
function cValue(): string {
  return c;
}
test("reference suggestions do not enroll, arm, or lose confirmed edges when source changes", () =>
  fixture((coordinator, _advance, _snapshots, writes) => {
    const upstream = enroll(coordinator, first),
      downstream = enroll(coordinator, second, c);
    coordinator.store.tracking.observe(
      downstream.id,
      {
        ...observation(c),
        description: `Depends on ${first}\nAlso owner/unknown#99`,
      },
      coordinator.tracking.config,
    );
    const store = coordinator.store.merging;
    store.scan(coordinator.store.tracking.pr(second));
    store.scan(coordinator.store.tracking.pr(second));
    assert.equal(store.chains().length, 0);
    assert.equal(coordinator.store.tracking.prs().length, 2);
    assert.equal(store.refs().length, 2);
    const ref = store.refs().find((ref) => ref.targetUrl === first);
    assert(ref !== undefined);
    store.confirm(
      second,
      first,
      downstream.ownerAgentId,
      "Required library",
      ref.id,
    );
    assert.equal(
      store.refs().find((item) => item.id === ref.id)?.decision,
      ReferenceDecision.Confirmed,
    );
    assert.throws(
      () => store.confirm(first, second, upstream.ownerAgentId, "Cycle"),
      /cycle/,
    );
    assert.throws(
      () => store.confirm(first, first, upstream.ownerAgentId, "Self"),
      /Self/,
    );
    coordinator.store.tracking.observe(
      downstream.id,
      { ...observation(c), description: "No links now" },
      coordinator.tracking.config,
    );
    store.scan(coordinator.store.tracking.pr(second));
    assert.equal(store.dependencies().length, 1);
    assert.equal(store.refs().filter((ref) => ref.active).length, 0);
    assert.deepEqual(writes, []);
    return Promise.resolve();
  }));
test("uncertain merge survives restart and only reconciles, never repeats the effect", () =>
  fixture(
    async (c, advance, _snapshots, writes) => {
      const pr = enroll(c, first);
      c.merging.command({
        op: "queue",
        input: {
          requestId: "uncertain",
          actorId: pr.ownerAgentId,
          entries: [{ prUrl: first, checks: ["CI"] }],
        },
      });
      c.merging.command({
        op: "ready",
        pr: first,
        actorId: pr.ownerAgentId,
        head: a,
      });
      await c.merging.tick();
      const op = c.store.merging.operations()[0];
      assert(op !== undefined);
      assert.equal(op.state, OperationState.Uncertain);
      advance();
      await c.merging.tick();
      assert.equal(writes.length, 1);
      c.merging.command({ op: "reconcile", id: op.id });
      await c.merging.tick();
      assert.equal(writes.length, 1);
      assert.equal(
        c.store.merging.operations()[0]?.state,
        OperationState.Succeeded,
      );
    },
    { unknownMerge: true },
  ));
test("pause before preparation push fences the write and keeps graph policy frozen during work", () =>
  fixture(
    async (c, advance, snapshots, writes) => {
      const upstream = enroll(c, first),
        pr = enroll(c, second, cValue());
      const value = snapshots.get(first);
      assert(value !== undefined);
      value.observation.lifecycle = "merged";
      value.mergeCommit = d;
      c.store.tracking.observe(
        upstream.id,
        value.observation,
        c.tracking.config,
      );
      c.merging.command({
        op: "confirm",
        pr: second,
        prerequisite: first,
        actorId: pr.ownerAgentId,
        reason: "Pin library",
        profile: "pin",
      });
      c.merging.command({
        op: "queue",
        input: {
          requestId: "pause",
          actorId: pr.ownerAgentId,
          entries: [{ prUrl: second, checks: ["CI"] }],
        },
      });
      advance();
      await c.merging.tick();
      assert.deepEqual(writes, ["prepare"]);
      assert.equal(
        c.store.merging.operations()[0]?.state,
        OperationState.Failed,
      );
      assert.equal(c.store.merging.chains()[0]?.state, ChainState.Paused);
    },
    { pausedPush: true },
  ));
test("owner assessment is invalidated by actionable feedback and missing check policies wait", () =>
  fixture(async (c, advance, _snapshots, writes) => {
    const pr = enroll(c, first);
    c.merging.command({
      op: "queue",
      input: {
        requestId: "feedback",
        actorId: pr.ownerAgentId,
        entries: [{ prUrl: first }],
      },
    });
    c.merging.command({
      op: "ready",
      pr: first,
      actorId: pr.ownerAgentId,
      head: a,
    });
    await c.merging.tick();
    assert.equal(writes.length, 0);
    assert.match(c.store.merging.entry(first).detail, /declare/);
    c.store.tracking.observe(
      pr.id,
      { ...observation(), headSha: cValue() },
      c.tracking.config,
    );
    advance();
    await c.merging.tick();
    assert.equal(c.store.merging.entry(first).ready, undefined);
    assert.equal(writes.length, 0);
  }));
test("strict check gates exclude advisory failures but do not accept absent, running, or incomplete required evidence", () =>
  fixture((coordinator) => {
    const pr = enroll(coordinator, first);
    coordinator.store.merging.queue({
      requestId: "gates",
      actorId: pr.ownerAgentId,
      entries: [{ prUrl: first, checks: ["CI"] }],
    });
    const entry = coordinator.store.merging.entry(first),
      value = snapshot();
    assert.equal(checkGate(entry, value), undefined);
    value.observation.checks = { state: "complete", value: [] };
    assert.match(checkGate(entry, value) ?? "", /expected check/);
    value.observation.checks = { state: "unavailable", reason: "offline" };
    assert.match(checkGate(entry, value) ?? "", /Complete/);
    value.queueRequired = true;
    assert.match(checkGate(entry, value) ?? "", /merge queue/);
    return Promise.resolve();
  }));
test("TOML pin recipe preserves formatting, checks expected value, and rejects ambiguous forms", () => {
  const source = `# version\r\n[tools.library]\r\nrevision = '${a}' # keep\r\n`;
  assert.equal(repin(source, profile, d), source.replace(a, d));
  assert.equal(repin(source.replace(a, d), profile, d), source.replace(a, d));
  assert.throws(() => repin(source.replace(a, c), profile, d), /changed/);
  assert.throws(
    () => repin(`[tools.library]\nrevision = """${a}"""\n`, profile, d),
    /unambiguous/,
  );
});
test("schema upgrade preserves records and operation leases block policy edits across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-merge-restart-"));
  let store = new Store(directory);
  try {
    const pr = store.tracking.track(first, agent);
    store.tracking.observe(pr.id, observation(), defaultTrackingConfig());
    const chain = store.merging.queue({
      requestId: "restart",
      actorId: pr.ownerAgentId,
      entries: [{ prUrl: first }],
    });
    const entry = store.merging.entry(first);
    const operation: MergeOperation = {
      id: "operation",
      entryId: entry.id,
      prId: pr.id,
      epoch: pr.trackingEpoch,
      kind: "merge",
      state: OperationState.Running,
      phase: "merging",
      head: a,
      baseRef: "main",
      baseSha: b,
      ownerId: pr.ownerAgentId,
      graph: "graph",
      createdAt: 1,
      updatedAt: 1,
      detail: "Request in flight",
    };
    store.merging.saveOperation(operation);
    store.close();
    store = new Store(directory);
    store.merging.recover();
    assert.equal(
      store.merging.operations()[0]?.state,
      OperationState.Uncertain,
    );
    assert.throws(
      () => store.merging.configure(first, pr.ownerAgentId, ["CI"], false),
      /Reconcile/,
    );
    assert.equal(store.merging.chain(chain.id).requestId, "restart");
    const db = new DatabaseSync(join(directory, "jobs.sqlite"));
    try {
      assert.equal(
        db.prepare("PRAGMA user_version").get()?.["user_version"],
        15,
      );
    } finally {
      db.close();
    }
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("policy changes during GitHub inspection revoke the earlier assessment", () =>
  fixture(
    async (c, _advance, _snapshots, writes) => {
      const pr = enroll(c, first);
      c.merging.command({
        op: "queue",
        input: {
          requestId: "race",
          actorId: pr.ownerAgentId,
          entries: [{ prUrl: first, checks: ["CI"] }],
        },
      });
      c.merging.command({
        op: "ready",
        pr: first,
        actorId: pr.ownerAgentId,
        head: a,
      });
      await c.merging.tick();
      assert.deepEqual(writes, []);
      assert.deepEqual(c.store.merging.entry(first).checks, ["Stricter CI"]);
      assert.equal(c.store.merging.entry(first).ready, undefined);
    },
    {
      inspect(c, url) {
        if (url !== first) return;
        const pr = c.store.tracking.pr(first);
        c.store.merging.configure(
          first,
          pr.ownerAgentId,
          ["Stricter CI"],
          false,
        );
      },
    },
  ));
test("definite merge failure requires renewed owner assessment before another write", () =>
  fixture(
    async (c, advance, _snapshots, writes) => {
      const pr = enroll(c, first);
      c.merging.command({
        op: "queue",
        input: {
          requestId: "failure",
          actorId: pr.ownerAgentId,
          entries: [{ prUrl: first, checks: ["CI"] }],
        },
      });
      c.merging.command({
        op: "ready",
        pr: first,
        actorId: pr.ownerAgentId,
        head: a,
      });
      await c.merging.tick();
      advance();
      await c.merging.tick();
      assert.equal(writes.length, 1);
      assert.equal(c.store.merging.entry(first).ready, undefined);
      assert.equal(
        c.store.merging.operations()[0]?.state,
        OperationState.Failed,
      );
    },
    { failMerge: true },
  ));
test("pause at GitHub dispatch prevents the queued write", () =>
  fixture(
    async (c, _advance, _snapshots, writes) => {
      const pr = enroll(c, first);
      const chain = c.store.merging.queue({
        requestId: "dispatch",
        actorId: pr.ownerAgentId,
        entries: [{ prUrl: first, checks: ["CI"] }],
      });
      c.store.merging.ready(first, pr.ownerAgentId, a);
      await c.merging.tick();
      assert.deepEqual(writes, []);
      assert.equal(c.store.merging.chain(chain.id).state, ChainState.Paused);
      assert.equal(
        c.store.merging.operations()[0]?.state,
        OperationState.Failed,
      );
    },
    {
      beforeSend(c) {
        const chain = c.store.merging.chains()[0];
        assert(chain !== undefined);
        c.store.merging.control(chain.id, ChainState.Paused);
      },
    },
  ));
test("resume republishes the current owner handoff once while preserving withdrawn receipts", () =>
  fixture(async (c, advance) => {
    const pr = enroll(c, first);
    const chain = c.store.merging.queue({
      requestId: "notice",
      actorId: pr.ownerAgentId,
      entries: [{ prUrl: first }],
    });
    await c.merging.tick();
    const pending = () =>
      c.store.tracking.inbox
        .list(pr.ownerAgentId, 0, false, true)
        .messages.filter((message) => message.workflowPRId === pr.id);
    assert.equal(pending().length, 1);
    const old = pending()[0];
    assert(old !== undefined);
    c.store.merging.control(chain.id, ChainState.Paused);
    assert.equal(pending().length, 0);
    c.store.merging.control(chain.id, ChainState.Active);
    assert.equal(pending().length, 1);
    assert.notEqual(pending()[0]?.id, old.id);
    advance();
    await c.merging.tick();
    assert.equal(pending().length, 1);
    assert.equal(c.store.tracking.inbox.get(old.id)?.applicable, false);
  }));
test("real local Git preparation rebases, repins and pushes under the original source lease", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-merge-git-")),
    seed = join(directory, "seed"),
    remote = join(directory, "remote.git"),
    work = join(directory, "work");
  const exec = promisify(execFile);
  const git = async (args: string[], cwd = seed) => {
    const result = await exec(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@localhost",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      { cwd },
    );
    return result.stdout.trim();
  };
  await mkdir(seed);
  await mkdir(work);
  const store = new Store(join(directory, "state"));
  try {
    await git(["init", "-b", "main"]);
    await writeFile(
      join(seed, "versions.toml"),
      `[tools.library]\nrevision = "${a}"\n`,
    );
    await git(["add", "."]);
    await git(["commit", "-m", "Base"]);
    await git(["checkout", "-b", "feature"]);
    await writeFile(join(seed, "feature.txt"), "Feature\n");
    await git(["add", "."]);
    await git(["commit", "-m", "Feature"]);
    const head = await git(["rev-parse", "HEAD"]);
    await git(["checkout", "main"]);
    await writeFile(join(seed, "target.txt"), "Main progressed\n");
    await git(["add", "."]);
    await git(["commit", "-m", "Target"]);
    const target = await git(["rev-parse", "HEAD"]);
    await git(["clone", "--bare", seed, remote], directory);
    const pr = store.tracking.track(second, agent);
    store.tracking.observe(
      pr.id,
      { ...observation(head), targetBase: { ref: "main", sha: target } },
      defaultTrackingConfig(),
    );
    store.merging.queue({
      requestId: "local-git",
      actorId: pr.ownerAgentId,
      entries: [{ prUrl: second, checks: ["CI"] }],
    });
    const entry = store.merging.entry(second),
      op: MergeOperation = {
        id: "git-prepare",
        epoch: pr.trackingEpoch,
        entryId: entry.id,
        prId: pr.id,
        kind: "prepare",
        state: OperationState.Running,
        phase: "local",
        head,
        baseRef: "main",
        baseSha: target,
        graph: "fixture",
        ownerId: pr.ownerAgentId,
        createdAt: 1,
        updatedAt: 1,
        detail: "Local Git acceptance",
        preparation: { ...profile, timeoutMs: 10000 },
        prerequisiteCommit: d,
      };
    store.merging.saveOperation(op);
    const source = {
      repository: "owner/application",
      headRef: "feature",
      headSha: head,
      targetRef: "main",
      targetSha: target,
    };
    let recorded = "";
    const prepare = preparer(work, store.mergeConflicts, {
      source: () => Promise.resolve(source),
      workspace: (path, value, signal) =>
        new RebaseWorkspace(path, value, signal, remote),
    });
    const result = await prepare({
      url: second,
      operation: op,
      signal: new AbortController().signal,
      beforePush: (value) => {
        recorded = value;
        assert.equal(store.merging.busy(pr.id), true);
      },
    });
    assert.equal(recorded, result);
    assert.notEqual(result, head);
    assert.equal(
      await git(["--git-dir", remote, "rev-parse", "feature"], directory),
      result,
    );
    assert.equal(
      await git(
        ["--git-dir", remote, "show", "feature:versions.toml"],
        directory,
      ),
      `[tools.library]\nrevision = "${d}"`,
    );
    assert.equal(
      await git(["--git-dir", remote, "merge-base", target, result], directory),
      target,
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("cancellation during Git target preflight prevents subsequent push dispatch", async () => {
  let active = true,
    pushes = 0;
  const source = {
    repository: "owner/application",
    headRef: "feature",
    headSha: a,
    targetRef: "main",
    targetSha: b,
  };
  const workspace = new (class extends RebaseWorkspace {
    override remoteHead(): Promise<string> {
      active = false;
      return Promise.resolve(b);
    }
    override git(args: string[]): Promise<string> {
      if (args[0] === "push") pushes++;
      return Promise.resolve("");
    }
  })("unused", source, new AbortController().signal);
  await assert.rejects(
    workspace.push(c, () => {
      if (!active) throw new Error("Cancelled before push");
    }),
    /Cancelled/,
  );
  assert.equal(pushes, 0);
});
test("cancelled uncertain preparation reconciles its result and releases the PR for a new chain", () =>
  fixture(
    async (c, _advance, snapshots) => {
      const upstream = enroll(c, first),
        pr = enroll(c, second, cValue()),
        value = snapshots.get(first);
      assert(value !== undefined);
      value.observation.lifecycle = "merged";
      value.mergeCommit = d;
      c.store.tracking.observe(
        upstream.id,
        value.observation,
        c.tracking.config,
      );
      c.merging.command({
        op: "confirm",
        pr: second,
        prerequisite: first,
        actorId: pr.ownerAgentId,
        reason: "Pin library",
        profile: "pin",
      });
      const chain = c.store.merging.queue({
        requestId: "cancel-uncertain",
        actorId: pr.ownerAgentId,
        entries: [{ prUrl: second, checks: ["CI"] }],
      });
      await c.merging.tick();
      const operation = c.store.merging.operations()[0];
      assert(operation !== undefined);
      assert.equal(operation.state, OperationState.Uncertain);
      c.store.merging.control(chain.id, ChainState.Cancelled);
      c.merging.command({ op: "reconcile", id: operation.id });
      await c.merging.tick();
      assert.equal(c.store.merging.entries()[0]?.state, EntryState.Cancelled);
      assert.equal(c.store.merging.busy(pr.id), false);
      assert.doesNotThrow(() =>
        c.store.merging.queue({
          requestId: "after-cancel",
          actorId: pr.ownerAgentId,
          entries: [{ prUrl: second, checks: ["CI"] }],
        }),
      );
    },
    { unknownPush: true },
  ));
test("live acceptance runner refuses provider effects without explicit opt-in", async () => {
  const child = Bun.spawn(
    [process.execPath, "scripts/test-merge-acceptance.ts"],
    {
      cwd: process.cwd(),
      env: { ...process.env, OCTO_LIVE_MERGE_ACCEPTANCE: "0" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  assert.notEqual(code, 0);
  assert.equal(output, "");
  assert.match(error, /Opt in with/);
});
test("auto-merge is opt-in, owner-controlled and can be turned off before dispatch", () =>
  fixture(async (c, _advance, _snapshots, writes) => {
    const pr = enroll(c, first);
    await c.merging.tick();
    assert.equal(c.store.merging.entries().length, 0);
    await c.start();
    const client = schedulerClient(c.directory);
    await client.mergeCommand({
      inputJson: JSON.stringify({
        op: "auto_merge",
        pr: first,
        enabled: true,
        actorId: pr.ownerAgentId,
        requestId: "switch-on",
      }),
    });
    assert.equal(c.store.merging.entry(first).autoMerge, true);
    assert.equal(
      (await client.getSnapshot({})).snapshot?.mergeStatuses[0]?.autoMerge,
      true,
    );
    const chainId = c.store.merging.entry(first).chainId;
    c.store.merging.control(chainId, ChainState.Paused);
    const paused = (await client.getSnapshot({})).snapshot?.mergeStatuses[0];
    assert.ok(paused !== undefined);
    assert.equal(paused.chainState, "paused");
    assert.equal(paused.state, "waiting");
    assert.equal(paused.autoMerge, true);
    c.store.merging.control(chainId, ChainState.Active);
    c.store.merging.ready(first, pr.ownerAgentId, a);
    c.merging.command({
      op: "auto_merge",
      pr: first,
      enabled: false,
      actorId: pr.ownerAgentId,
      requestId: "switch-off",
    });
    await c.merging.tick();
    assert.deepEqual(writes, []);
    assert.equal(c.store.merging.entry(first).ready, undefined);
  }));
test("accepted asynchronous merges retain their identity and reconcile even after the switch is off", () =>
  fixture(
    async (c, advance, _snapshots, writes) => {
      const pr = enroll(c, first);
      c.store.merging.autoMerge(first, pr.ownerAgentId, true, "async-on");
      c.store.merging.ready(first, pr.ownerAgentId, a);
      await c.merging.tick();
      assert.equal(
        c.store.merging.operations()[0]?.state,
        OperationState.Running,
      );
      assert.equal(
        c.store.merging.operations()[0]?.requestId,
        "11111111-1111-4111-8111-111111111111",
      );
      c.store.merging.autoMerge(first, pr.ownerAgentId, false, "async-off");
      advance();
      await c.merging.tick();
      assert.equal(writes.length, 1);
      assert.equal(c.store.merging.entries()[0]?.state, EntryState.Merged);
      assert.equal(c.store.merging.entries()[0]?.autoMerge, false);
    },
    { asyncMerge: true },
  ));
test("native stack prerequisites block unintended downstack merges", () =>
  fixture((c) => {
    const pr = enroll(c, first);
    c.store.merging.autoMerge(first, pr.ownerAgentId, true, "native");
    const entry = c.store.merging.entry(first),
      value = snapshot();
    value.nativePrerequisites = [second];
    assert.match(checkGate(entry, value) ?? "", /native stack predecessor/);
    return Promise.resolve();
  }));
test("asynchronous result decoding preserves pending identity and final failures", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(
    mergeProgress({ status: "pending", details: { uuid: id } }),
    { state: "pending", requestId: id },
  );
  assert.deepEqual(mergeProgress({ uuid: id }), {
    state: "pending",
    requestId: id,
  });
  assert.deepEqual(mergeProgress({ status: "merged", details: { sha: d } }), {
    state: "merged",
    sha: d,
  });
  assert.equal(
    mergeProgress({
      status: "failed",
      details: { message: "Required check failed" },
    }).state,
    "failed",
  );
  assert.throws(() => mergeProgress({ status: "merged" }), /revision/);
});
test("schema13 upgrades preserve explicit queue intent and known async requests recover without replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-auto-upgrade-"));
  let store = new Store(directory);
  try {
    const pr = store.tracking.track(first, agent);
    store.tracking.observe(pr.id, observation(), defaultTrackingConfig());
    store.merging.queue({
      requestId: "upgrade",
      actorId: pr.ownerAgentId,
      entries: [{ prUrl: first, checks: ["CI"] }],
    });
    const entry = store.merging.entry(first),
      operation: MergeOperation = {
        id: "known-async",
        epoch: pr.trackingEpoch,
        entryId: entry.id,
        prId: pr.id,
        kind: "merge",
        state: OperationState.Running,
        phase: "merging",
        head: a,
        baseRef: "main",
        baseSha: b,
        graph: "fixture",
        ownerId: pr.ownerAgentId,
        createdAt: 1,
        updatedAt: 1,
        detail: "Accepted",
        requestId: "11111111-1111-4111-8111-111111111111",
        nextCheckAt: 1000,
      };
    store.merging.saveOperation(operation);
    store.close();
    const db = new DatabaseSync(join(directory, "jobs.sqlite"));
    db.exec(
      "UPDATE merge_entries SET data=json_remove(data,'$.autoMerge'); PRAGMA user_version=13",
    );
    db.close();
    store = new Store(directory);
    store.merging.recover();
    assert.equal(store.merging.entry(first).autoMerge, true);
    assert.equal(store.merging.operations()[0]?.state, OperationState.Running);
    assert.equal(store.merging.operations()[0]?.requestId, operation.requestId);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("independent production-shaped jobs with the same name cannot hide a failure", () =>
  fixture((c) => {
    const pr = enroll(c, first);
    c.store.merging.autoMerge(first, pr.ownerAgentId, true, "independent");
    const value = snapshot(),
      entry = c.store.merging.entry(first);
    value.observation.checks = {
      state: "complete",
      value: [
        checkRunObservation(
          {
            id: 1,
            name: "CI",
            app: { id: 15368 },
            check_suite: { id: 1 },
            head_sha: a,
            status: "completed",
            conclusion: "failure",
            started_at: "2026-11-13T00:00:00Z",
          },
          first,
        ),
        checkRunObservation(
          {
            id: 2,
            name: "CI",
            app: { id: 15368 },
            check_suite: { id: 2 },
            head_sha: a,
            status: "completed",
            conclusion: "success",
            started_at: "2026-11-13T00:01:00Z",
          },
          first,
        ),
      ],
    };
    assert.match(checkGate(entry, value) ?? "", /passing check/);
    return Promise.resolve();
  }));
test("cancelled workflow suites are superseded only by a successful invocation of that workflow and trigger", () =>
  fixture((c) => {
    const pr = enroll(c, first);
    c.store.merging.autoMerge(first, pr.ownerAgentId, true, "cancelled");
    const value = snapshot(),
      entry = c.store.merging.entry(first);
    value.observation.checks = {
      state: "complete",
      value: [
        checkRunObservation(
          {
            id: 1,
            name: "CI",
            app: { id: 15368 },
            check_suite: { id: 1 },
            head_sha: a,
            status: "completed",
            conclusion: "cancelled",
            started_at: "2026-11-13T00:00:00Z",
          },
          first,
        ),
        checkRunObservation(
          {
            id: 2,
            name: "CI",
            app: { id: 15368 },
            check_suite: { id: 2 },
            head_sha: a,
            status: "completed",
            conclusion: "success",
            started_at: "2026-11-13T00:01:00Z",
          },
          first,
        ),
      ],
    };
    const raw = {
      name: "Checks",
      head_sha: a,
      workflow_id: 10,
      event: "pull_request",
      status: "completed",
      html_url: first,
    };
    value.observation.workflows = {
      state: "complete",
      value: [
        workflowObservation({
          ...raw,
          id: 1,
          check_suite_id: 1,
          conclusion: "cancelled",
          run_started_at: "2026-11-13T00:00:00Z",
        }),
        workflowObservation({
          ...raw,
          id: 2,
          check_suite_id: 2,
          conclusion: "success",
          run_started_at: "2026-11-13T00:01:00Z",
        }),
      ],
    };
    assert.equal(checkGate(entry, value), undefined);
    const original = value.observation.workflows.value[1];
    assert(original !== undefined);
    value.observation.workflows.value[1] = { ...original, suiteId: 1 };
    assert.match(checkGate(entry, value) ?? "", /passing check/);
    const missing = { ...original };
    delete missing.suiteId;
    value.observation.workflows.value[1] = missing;
    assert.match(checkGate(entry, value) ?? "", /passing check/);
    value.observation.workflows.value[1] = original;
    const child = value.observation.checks.value[0];
    assert(child !== undefined);
    value.observation.checks.value[0] = { ...child, conclusion: "failure" };
    assert.match(checkGate(entry, value) ?? "", /passing check/);
    value.observation.checks.value[0] = {
      ...child,
      conclusion: "",
      status: "in_progress",
    };
    assert.match(checkGate(entry, value) ?? "", /passing check/);
    value.observation.checks.value[0] = child;
    const replacement = value.observation.workflows.value[1];
    value.observation.workflows.value[1] = { ...replacement, workflowId: 11 };
    assert.match(checkGate(entry, value) ?? "", /passing check/);
    return Promise.resolve();
  }));
test("an existing remote async merge keeps its uncertainty lease", () =>
  fixture(
    async (c, advance, _snapshots, writes) => {
      const pr = enroll(c, first);
      c.store.merging.autoMerge(first, pr.ownerAgentId, true, "conflict");
      c.store.merging.ready(first, pr.ownerAgentId, a);
      await c.merging.tick();
      assert.equal(
        c.store.merging.operations()[0]?.state,
        OperationState.Uncertain,
      );
      advance();
      await c.merging.tick();
      assert.equal(writes.length, 1);
      assert.equal(c.store.merging.busy(pr.id), true);
    },
    { conflictMerge: true },
  ));
test("external commit-status contexts use their latest proven state without collapsing check runs", () =>
  fixture((c) => {
    const pr = enroll(c, first);
    c.store.merging.autoMerge(first, pr.ownerAgentId, true, "statuses");
    const value = snapshot(),
      entry = c.store.merging.entry(first),
      status = {
        key: "status:CI",
        name: "CI",
        headSha: a,
        at: 1000,
        url: first,
      };
    value.observation.checks = {
      state: "complete",
      value: [
        {
          ...status,
          id: "status:10",
          status: "pending",
          conclusion: "pending",
        },
        {
          ...status,
          id: "status:11",
          status: "success",
          conclusion: "success",
        },
      ],
    };
    assert.equal(checkGate(entry, value), undefined);
    value.observation.checks.value.push({
      ...status,
      id: "status:12",
      status: "failure",
      conclusion: "failure",
    });
    assert.match(checkGate(entry, value) ?? "", /passing check/);
    return Promise.resolve();
  }));
test("dependency edits during prerequisite inspection cannot execute a captured preparation recipe", () =>
  fixture(
    async (c, _advance, snapshots, writes) => {
      const upstream = enroll(c, first),
        pr = enroll(c, second, cValue()),
        value = snapshots.get(first);
      assert(value !== undefined);
      value.observation.lifecycle = "merged";
      value.mergeCommit = d;
      c.store.tracking.observe(
        upstream.id,
        value.observation,
        c.tracking.config,
      );
      c.store.merging.confirm(
        second,
        first,
        pr.ownerAgentId,
        "Initial recipe",
        undefined,
        profile,
      );
      c.store.merging.autoMerge(second, pr.ownerAgentId, true, "graph-race");
      await c.merging.tick();
      assert.deepEqual(writes, []);
      assert.equal(c.store.merging.operations().length, 0);
    },
    {
      inspect(c, url) {
        if (url !== first) return;
        const edge = c.store.merging.dependencies()[0];
        if (edge !== undefined)
          c.store.merging.removeDependency(
            edge.id,
            c.store.tracking.pr(second).ownerAgentId,
          );
      },
    },
  ));
test("authentication rejection is a definite failure and releases the operation lease", () =>
  fixture(
    async (c, _advance, _snapshots, writes) => {
      const pr = enroll(c, first);
      c.store.merging.autoMerge(first, pr.ownerAgentId, true, "auth");
      c.store.merging.ready(first, pr.ownerAgentId, a);
      await c.merging.tick();
      assert.equal(writes.length, 1);
      assert.equal(
        c.store.merging.operations()[0]?.state,
        OperationState.Failed,
      );
      assert.equal(c.store.merging.busy(pr.id), false);
      assert.equal(c.store.merging.entry(first).ready, undefined);
    },
    { authMerge: true },
  ));
test("workflow invocation numbers establish replacement when timestamps tie", () =>
  fixture((c) => {
    const pr = enroll(c, first);
    c.store.merging.autoMerge(first, pr.ownerAgentId, true, "same-second");
    const entry = c.store.merging.entry(first),
      value = snapshot(),
      at = "2026-11-13T00:00:00Z",
      raw = {
        name: "CI",
        head_sha: a,
        workflow_id: 10,
        event: "pull_request",
        status: "completed",
        html_url: first,
        run_started_at: at,
      };
    value.observation.checks = {
      state: "complete",
      value: [
        checkRunObservation(
          {
            id: 1,
            name: "CI",
            app: { id: 1 },
            check_suite: { id: 1 },
            head_sha: a,
            status: "completed",
            conclusion: "cancelled",
            started_at: at,
          },
          first,
        ),
        checkRunObservation(
          {
            id: 2,
            name: "CI",
            app: { id: 1 },
            check_suite: { id: 2 },
            head_sha: a,
            status: "completed",
            conclusion: "success",
            started_at: at,
          },
          first,
        ),
      ],
    };
    value.observation.workflows = {
      state: "complete",
      value: [
        workflowObservation({
          ...raw,
          id: 1,
          run_number: 10,
          check_suite_id: 1,
          conclusion: "cancelled",
        }),
        workflowObservation({
          ...raw,
          id: 2,
          run_number: 11,
          check_suite_id: 2,
          conclusion: "success",
        }),
      ],
    };
    assert.equal(checkGate(entry, value), undefined);
    const replacement = value.observation.workflows.value[1];
    assert(replacement !== undefined);
    value.observation.workflows.value[1] = { ...replacement, runNumber: 9 };
    assert.match(checkGate(entry, value) ?? "", /passing check/);
    return Promise.resolve();
  }));
