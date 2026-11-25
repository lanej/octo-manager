import { DatabaseSync } from "node:sqlite";
import { MergeDeclined } from "../src/merging/async-merge.js";
import { test, expect, spyOn } from "bun:test";
import { mkdtemp, writeFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordinator } from "../src/coordinator.js";
import {
  EntryState,
  ChainState,
  OperationState,
} from "../src/merging/contracts.js";
import { loadRepositoryConfig as load } from "../src/repository/config.js";
import { NotificationState } from "../src/repository/contracts.js";
import { schedulerClient } from "../src/client.js";
import { unwire } from "../src/api/codec.js";
import { DomainRepositoryAutomationPolicySchema } from "../src/gen/octomanager/v2/domain_pb.js";
const url = "https://github.com/owner/repo/pull/1";
const owner = {
  harness: "codex",
  endpoint: "local",
  sessionId: "policy-owner",
};
const config =
  'schema_version = 1\n[merging]\nauto_merge = "project_stage"\n[notifications.instructions]\nreview_feedback = "Repair the review findings."\n';
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "octo-repository-policy-"));
  const root = join(await realpath(directory), "repo");
  const git = Bun.spawnSync(["git", "init", "-q", root]);
  if (git.exitCode !== 0) throw new Error(git.stderr.toString());
  Bun.spawnSync([
    "git",
    "-C",
    root,
    "remote",
    "add",
    "origin",
    "git@github.com:owner/repo.git",
  ]);
  await writeFile(join(root, "octo-manager.toml"), config);
  await writeFile(
    join(root, ".source-code.json"),
    JSON.stringify({ schema_version: 1, stage: "alpha" }),
  );
  let writes = 0,
    decline = false;
  const options = {
    trackingOptions: {
      read: () => Promise.reject(new Error("Controlled unavailable provider")),
    },
    mergeOptions: {
      provider: {
        inspect: () =>
          Promise.resolve({
            observation: {
              ...coordinator.store.tracking.pr(url).observation,
              observedAt: 1000,
              headSha: "a".repeat(40),
              baseSha: "b".repeat(40),
              targetBase: { ref: "main", sha: "b".repeat(40) },
              lifecycle: "open" as const,
              mergeability: "mergeable" as const,
              checks: {
                state: "complete" as const,
                value: [
                  {
                    id: "ci",
                    key: "ci",
                    name: "CI",
                    headSha: "a".repeat(40),
                    status: "completed" as const,
                    conclusion: "success",
                    at: 1000,
                    url,
                  },
                ],
              },
              workflows: { state: "complete" as const, value: [] },
              reviews: { state: "complete" as const, value: [] },
              feedback: { state: "complete" as const, value: [] },
            },
            draft: false,
            gate: "CLEAN",
            review: null,
            required: [],
            queueRequired: false,
            methods: ["squash" as const],
          }),
        merge: (
          _url: string,
          _head: string,
          _method: string,
          _signal: AbortSignal,
          beforeSend: () => void,
        ) => {
          beforeSend();
          writes++;
          return decline
            ? Promise.reject(
                new MergeDeclined("Branch policy rejected the merge"),
              )
            : Promise.resolve("c".repeat(40));
        },
      },
    },
  };
  let coordinator: Coordinator = new Coordinator(
    join(directory, "state"),
    options,
  );
  const pr = coordinator.tracking.track(url, owner, root);
  coordinator.store.tracking.observe(
    pr.id,
    {
      observedAt: 1000,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      targetBase: { ref: "main", sha: "b".repeat(40) },
      lifecycle: "open",
      mergeability: "mergeable",
      checks: {
        state: "complete",
        value: [
          {
            id: "ci",
            key: "ci",
            name: "CI",
            headSha: "a".repeat(40),
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
    coordinator.tracking.config,
  );
  coordinator.store.repositories.tick();
  const stage = async (value: string) => {
    await writeFile(
      join(root, ".source-code.json"),
      JSON.stringify({ schema_version: 1, stage: value }),
    );
    coordinator.store.repositories.tick();
  };
  return {
    directory,
    root,
    pr,
    stage,
    get writes() {
      return writes;
    },
    decline() {
      decline = true;
    },
    get c() {
      return coordinator;
    },
    async reopen() {
      await coordinator.close();
      coordinator = new Coordinator(join(directory, "state"), options);
    },
    async close() {
      await coordinator.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
test("repository stage inheritance reloads locally, preserves explicit off, and survives restart", async () => {
  const f = await fixture();
  try {
    const entry = () => f.c.store.merging.entry(url);
    expect(entry().autoMerge).toBe(true);
    expect(entry().autoMergeSource).toBe("inherited");
    const ready = {
      epoch: 0,
      head: "a".repeat(40),
      baseRef: "main",
      ownerId: f.pr.ownerAgentId,
      feedback: "f",
      graph: "g",
      at: 1,
    };
    f.c.store.merging.saveEntry({ ...entry(), ready });
    await f.stage("beta");
    expect(entry().autoMerge).toBe(false);
    expect(entry().ready).toBeUndefined();
    await f.stage("research");
    expect(entry().autoMerge).toBe(true);
    f.c.store.merging.autoMerge(url, f.pr.ownerAgentId, false, "explicit-off");
    await f.stage("alpha");
    expect(entry().autoMerge).toBe(false);
    await f.reopen();
    f.c.store.repositories.tick();
    expect(entry().autoMergeSource).toBe("explicit");
    f.c.store.merging.useDefault(url, f.pr.ownerAgentId, "inherit");
    f.c.store.repositories.tick();
    expect(entry().autoMerge).toBe(true);
    await f.stage("production");
    expect(entry().autoMerge).toBe(false);
  } finally {
    await f.close();
  }
});
test("invalid or removed policy suspends inheritance, retains last valid instructions, and deduplicates diagnostics", async () => {
  const f = await fixture();
  try {
    const instructions = () =>
      f.c.store.repositories.instructions(f.pr.id, f.pr.ownerAgentId, [
        NotificationState.ReviewFeedback,
      ]);
    expect(instructions()).toBe("Repair the review findings.");
    await writeFile(join(f.root, "octo-manager.toml"), "invalid [[[");
    f.c.store.repositories.tick();
    expect(f.c.store.merging.entry(url).autoMerge).toBe(false);
    expect(instructions()).toBe("Repair the review findings.");
    const sequence = f.c.store.sequence();
    const inputRevision = f.c.store.inputRevision();
    f.c.store.repositories.tick();
    expect(f.c.store.sequence()).toBe(sequence);
    expect(f.c.store.inputRevision()).toBe(inputRevision);
    await writeFile(join(f.root, "octo-manager.toml"), config);
    f.c.store.repositories.tick();
    expect(f.c.store.merging.entry(url).autoMerge).toBe(true);
    await rm(join(f.root, "octo-manager.toml"));
    f.c.store.repositories.tick();
    expect(f.c.store.merging.entry(url).autoMerge).toBe(false);
    expect(instructions()).toBe("Repair the review findings.");
    expect(f.c.store.repositories.get(f.pr.id)?.error).toContain("missing");
  } finally {
    await f.close();
  }
});
test("enrollment verifies repository identity and typed inspection exposes policy provenance", async () => {
  const f = await fixture();
  try {
    const other = f.c.tracking.track(
      "https://github.com/other/repo/pull/2",
      owner,
      f.root,
    );
    expect(f.c.store.repositories.get(other.id)).toBeUndefined();
    await f.c.start();
    const response = await schedulerClient(
      join(f.directory, "state"),
    ).getTrackedPullRequest({ id: f.pr.id });
    if (response.repositoryPolicy === undefined)
      throw new Error("Missing typed policy");
    expect(
      unwire(DomainRepositoryAutomationPolicySchema, response.repositoryPolicy),
    ).toMatchObject({
      instructions: { review_feedback: "Repair the review findings." },
      status: "valid",
      root: f.root,
      stage: "alpha",
      autoMerge: true,
    });
    await rm(join(f.root, "octo-manager.toml"));
    await symlink(
      join(f.directory, "elsewhere"),
      join(f.root, "octo-manager.toml"),
    );
    expect(() => load(f.root)).toThrow();
  } finally {
    await f.close();
  }
});
test("reload cannot rearm a cancelled inherited chain or enable a project with unknown stage", async () => {
  const f = await fixture();
  try {
    const entry = f.c.store.merging.entry(url);
    f.c.store.merging.control(entry.chainId, ChainState.Cancelled);
    expect(f.c.store.merging.entries()[0]?.state).toBe(EntryState.Cancelled);
    f.c.store.repositories.tick();
    expect(f.c.store.merging.entries()).toHaveLength(1);
    await f.stage("unknown");
    expect(f.c.store.repositories.get(f.pr.id)?.autoMerge).toBe(false);
  } finally {
    await f.close();
  }
});

test("fresh inherited enrollment learns checks and merges only after an exact-head owner assessment", async () => {
  const f = await fixture();
  try {
    expect(f.c.store.merging.entry(url).checks).toEqual(["CI"]);
    await f.c.merging.tick();
    expect(f.writes).toBe(0);
    f.c.store.merging.ready(url, f.pr.ownerAgentId, "a".repeat(40));
    await f.c.merging.tick();
    expect(f.writes).toBe(1);
    expect(f.c.store.merging.entries()[0]?.state).toBe(EntryState.Merged);
    f.c.store.repositories.tick();
    expect(f.c.store.merging.entries()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("explicit chain queue overrides a previous inherited default", async () => {
  const f = await fixture();
  try {
    await f.stage("beta");
    f.c.store.merging.control(
      f.c.store.merging.entry(url).chainId,
      ChainState.Cancelled,
    );
    f.c.store.merging.queue({
      requestId: "explicit-chain",
      actorId: f.pr.ownerAgentId,
      entries: [{ prUrl: url, checks: ["CI"] }],
    });
    f.c.store.repositories.tick();
    expect(f.c.store.merging.entry(url).autoMerge).toBe(true);
    expect(f.c.store.merging.settingSource(f.pr.id)).toBe("explicit");
  } finally {
    await f.close();
  }
});

test("definitive merge failures retain blocker instructions rather than requesting blind readiness", async () => {
  const f = await fixture();
  try {
    f.decline();
    f.c.store.merging.ready(url, f.pr.ownerAgentId, "a".repeat(40));
    await f.c.merging.tick();
    const entry = f.c.store.merging.entry(url);
    expect(entry.state).toBe(EntryState.WaitingOwner);
    const notice = f.c.store.tracking.inbox
      .list(f.pr.ownerAgentId, 0, false, true)
      .messages.find(
        (message) => f.c.store.merging.noticeEntry(message.id)?.id === entry.id,
      );
    if (notice === undefined) throw new Error("Missing failure notice");
    expect(f.c.store.repositories.forMessage(notice)).toContain(
      "merge blocker",
    );
    expect(f.c.store.repositories.forMessage(notice)).not.toContain(
      "record readiness",
    );
  } finally {
    await f.close();
  }
});

test("invalid policy on owner transfer cannot reuse the previous owner's overrides", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "octo-manager.toml"), "invalid [[[");
    const next = f.c.tracking.assign(f.pr.id, {
      ...owner,
      sessionId: "new-owner",
    });
    f.c.store.repositories.tick();
    expect(f.c.store.merging.entry(url).autoMerge).toBe(false);
    expect(f.c.store.merging.entry(url).ready).toBeUndefined();
    f.c.store.repositories.bind(f.pr.id, next.ownerAgentId, f.root);
    expect(
      f.c.store.repositories.instructions(f.pr.id, next.ownerAgentId, [
        NotificationState.ReviewFeedback,
      ]),
    ).not.toBe("Repair the review findings.");
  } finally {
    await f.close();
  }
});

test("a failed same-head check rerun cannot inherit cached Ready instructions", async () => {
  const f = await fixture();
  try {
    await f.c.merging.tick();
    const action = f.c.store.tracking
      .actions()
      .find((value) => value.blocker.kind === "check_results");
    if (action === undefined || action.blocker.kind !== "check_results")
      throw new Error("Missing completion action");
    const failed = {
      ...action,
      blocker: {
        ...action.blocker,
        checks: action.blocker.checks.map((check) => ({
          ...check,
          conclusion: "failure",
        })),
      },
    };
    const original = f.c.store.tracking.action.bind(f.c.store.tracking);
    const read = spyOn(f.c.store.tracking, "action").mockImplementation((id) =>
      id === action.id ? failed : original(id),
    );
    const instructions = f.c.store.repositories.forMessage({
      sequence: 1,
      id: "controlled-notice",
      actionId: action.id,
      recipientAgentId: f.pr.ownerAgentId,
      body: "Controlled check results",
      createdAt: 2000,
      nextCheckAt: 2000,
      applicable: true,
    });
    expect(instructions).toContain("failed run");
    expect(instructions).not.toContain("requested merge workflow");
    read.mockRestore();
  } finally {
    await f.close();
  }
});

test("a resumed tracking epoch suspends inherited authority until it is rebound", async () => {
  const f = await fixture();
  try {
    f.c.store.tracking.untrack(f.pr.id);
    const resumed = f.c.store.tracking.track(url, owner);
    expect(resumed.trackingEpoch).toBeGreaterThan(f.pr.trackingEpoch);
    f.c.store.repositories.tick();
    expect(f.c.store.merging.entry(url).autoMerge).toBe(false);
    expect(f.c.store.repositories.get(f.pr.id)?.error).toContain(
      "tracking epoch",
    );
    f.c.store.repositories.bind(f.pr.id, resumed.ownerAgentId, f.root);
    expect(f.c.store.merging.entry(url).autoMerge).toBe(true);
    expect(f.c.store.merging.entry(url).trackingEpoch).toBe(
      resumed.trackingEpoch,
    );
    f.c.store.merging.control(
      f.c.store.merging.entry(url).chainId,
      ChainState.Cancelled,
    );
    f.c.store.repositories.tick();
    expect(f.c.store.merging.entries()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("invalid inherited contexts stay disabled without replaying revocation, and re-arming is revoked again", async () => {
  const f = await fixture();
  const revoke = spyOn(f.c.store.merging, "autoMerge"),
    full = spyOn(f.c.store.tracking, "pr");
  try {
    f.c.store.tracking.untrack(f.pr.id);
    const current = f.c.store.tracking.track(url, owner);
    f.c.store.repositories.tick();
    revoke.mockClear();
    full.mockClear();
    const revision = f.c.store.inputRevision();
    f.c.store.repositories.tick();
    expect(revoke).not.toHaveBeenCalled();
    expect(full).not.toHaveBeenCalled();
    expect(f.c.store.inputRevision()).toBe(revision);
    f.c.store.merging.autoMerge(
      f.pr.id,
      current.ownerAgentId,
      true,
      "re-arm-inherited",
      undefined,
      "inherited",
    );
    f.c.store.merging.policyStage(f.pr.id, "alpha");
    revoke.mockClear();
    f.c.store.repositories.tick();
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(f.c.store.merging.entry(url).autoMerge).toBe(false);
    expect(f.c.store.merging.entry(url).autoMergeStage).toBeUndefined();
    expect(f.c.store.merging.entry(url).trackingEpoch).toBe(
      current.trackingEpoch,
    );
    f.c.store.merging.autoMerge(
      f.pr.id,
      current.ownerAgentId,
      true,
      "explicit-override",
    );
    revoke.mockClear();
    f.c.store.repositories.tick();
    expect(revoke).not.toHaveBeenCalled();
    expect(f.c.store.merging.entry(url).autoMerge).toBe(true);
  } finally {
    revoke.mockRestore();
    full.mockRestore();
    await f.close();
  }
});

test("current notification instructions isolate unrelated entry and operation history", async () => {
  const f = await fixture();
  const db = new DatabaseSync(join(f.directory, "state", "jobs.sqlite"));
  try {
    f.decline();
    f.c.store.merging.ready(url, f.pr.ownerAgentId, "a".repeat(40));
    await f.c.merging.tick();
    const selected = f.c.store.merging.entry(url);
    const failed = f.c.store.merging
      .operations(f.pr.id)
      .find((operation) => operation.state === OperationState.Failed);
    const action = f.c.store.tracking
      .actions(f.pr.id)
      .find((value) => value.blocker.kind === "check_results");
    const notice = f.c.store.tracking.inbox
      .list(f.pr.ownerAgentId, 0, false, true)
      .messages.find(
        (message) =>
          f.c.store.merging.noticeEntry(message.id)?.id === selected.id,
      );
    if (failed === undefined || action === undefined || notice === undefined)
      throw new Error("Missing failed merge fixture");
    const other = f.c.tracking.track(
      "https://github.com/owner/repo/pull/99",
      owner,
    );
    f.c.store.merging.queue({
      requestId: "other-history",
      actorId: other.ownerAgentId,
      entries: [{ prUrl: other.url, checks: ["CI"] }],
    });
    const otherEntry = f.c.store.merging.entry(other.id);
    f.c.store.merging.saveOperation({
      ...failed,
      id: `operation-${other.id}`,
      entryId: otherEntry.id,
      prId: other.id,
    });
    db.prepare("UPDATE merge_entries SET data='{}' WHERE pr_id=?").run(
      other.id,
    );
    db.prepare("UPDATE merge_operations SET data='{}' WHERE pr_id=?").run(
      other.id,
    );
    expect(
      f.c.store.repositories.forMessage({
        sequence: 1,
        id: "current-check-message",
        actionId: action.id,
        recipientAgentId: f.pr.ownerAgentId,
        body: "Fixture",
        createdAt: 1000,
        nextCheckAt: 1000,
        applicable: true,
      }),
    ).toBe(
      f.c.store.repositories.instructions(f.pr.id, f.pr.ownerAgentId, [
        NotificationState.OwnerReviewRequired,
      ]),
    );
    expect(f.c.store.repositories.forMessage(notice)).toContain(
      "merge blocker",
    );
    expect(() => f.c.store.merging.entries()).toThrow(
      "Invalid merge-chain data",
    );
    expect(() => f.c.store.merging.operations()).toThrow(
      "Invalid merge-chain data",
    );
  } finally {
    db.close();
    await f.close();
  }
});

test("compiled policy reads retain fresh rows, independent values and invalid-data rejection", async () => {
  const f = await fixture();
  const db = new DatabaseSync(join(f.directory, "state", "jobs.sqlite"));
  try {
    const policy = f.c.store.repositories.get(f.pr.id);
    if (policy === undefined) throw new Error("Missing policy");
    policy.root = "caller mutation";
    expect(f.c.store.repositories.get(f.pr.id)?.root).toBe(f.root);
    const original = f.c.store.repositories.get(f.pr.id);
    if (original === undefined) throw new Error("Missing stored policy");
    const save = (value: unknown) =>
      db
        .prepare("UPDATE settings SET value=? WHERE key=?")
        .run(JSON.stringify(value), `repository-policy:${f.pr.id}`);
    save({ ...original, autoMerge: !original.autoMerge });
    expect(f.c.store.repositories.get(f.pr.id)?.autoMerge).toBe(
      !original.autoMerge,
    );
    for (const invalid of [
      { ...original, status: "unknown" },
      { ...original, autoMerge: "true" },
      { ...original, epoch: 0.5 },
      { ...original, instructions: { unexpected: "instruction" } },
    ]) {
      save(invalid);
      expect(() => f.c.store.repositories.get(f.pr.id)).toThrow(
        "Invalid merge-chain data",
      );
    }
    save(original);
    expect(f.c.store.repositories.get(f.pr.id)).toEqual(original);
  } finally {
    db.close();
    await f.close();
  }
});

test("idle policy enforcement batches stale historical contexts while retaining fresh revocation and explicit authority", async () => {
  const f = await fixture();
  const db = new DatabaseSync(join(f.directory, "state", "jobs.sqlite"));
  const contexts = spyOn(f.c.store.tracking, "prContext");
  const policies = spyOn(f.c.store.repositories, "get");
  try {
    const policy = f.c.store.repositories.get(f.pr.id);
    if (policy === undefined) throw new Error("Missing fixture policy");
    const historical = Array.from({ length: 100 }, (_, index) => {
      const pr = f.c.store.tracking.track(
        `https://github.com/owner/repo/pull/${String(index + 100)}`,
        owner,
      );
      db.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run(
        `repository-policy:${pr.id}`,
        JSON.stringify({ ...policy, prId: pr.id, epoch: pr.trackingEpoch + 1 }),
      );
      db.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run(
        `merge-setting:${pr.id}`,
        JSON.stringify({ source: "inherited", epoch: pr.trackingEpoch }),
      );
      return pr;
    });
    f.c.store.tracking.untrack(f.pr.id);
    f.c.store.tracking.track(url, owner);
    f.c.store.repositories.tick();
    contexts.mockClear();
    policies.mockClear();
    const revision = f.c.store.inputRevision();
    f.c.store.repositories.tick();
    expect(contexts).not.toHaveBeenCalled();
    expect(policies).not.toHaveBeenCalled();
    expect(f.c.store.inputRevision()).toBe(revision);
    const selected = historical[0];
    if (selected === undefined) throw new Error("Missing historical context");
    // An external writer can invalidate the normalized setting between ticks.
    db.prepare("UPDATE settings SET value=? WHERE key=?").run(
      JSON.stringify({
        source: "inherited",
        epoch: selected.trackingEpoch - 1,
      }),
      `merge-setting:${selected.id}`,
    );
    f.c.store.repositories.tick();
    expect(
      db
        .prepare("SELECT value FROM settings WHERE key=?")
        .get(`merge-setting:${selected.id}`)?.["value"],
    ).toBe(
      JSON.stringify({ source: "inherited", epoch: selected.trackingEpoch }),
    );
    const normalized = f.c.store.merging.entry(f.pr.id);
    db.prepare(
      "UPDATE merge_entries SET data=json_set(data,'$.prId',?) WHERE pr_id=?",
    ).run(selected.id, f.pr.id);
    expect(() => {
      f.c.store.repositories.tick();
    }).toThrow("PR identity mismatch");
    db.prepare("UPDATE merge_entries SET data=? WHERE id=?").run(
      JSON.stringify(normalized),
      normalized.id,
    );
    f.c.store.merging.autoMerge(
      f.pr.id,
      f.pr.ownerAgentId,
      true,
      "explicit-historical-override",
    );
    const entry = f.c.store.merging.entry(f.pr.id);
    db.prepare("UPDATE merge_entries SET data='{}' WHERE pr_id=?").run(f.pr.id);
    expect(() => {
      f.c.store.repositories.tick();
    }).not.toThrow();
    db.prepare("UPDATE merge_entries SET data=? WHERE id=?").run(
      JSON.stringify(entry),
      entry.id,
    );
    expect(f.c.store.merging.entry(f.pr.id).autoMerge).toBe(true);
  } finally {
    contexts.mockRestore();
    policies.mockRestore();
    db.close();
    await f.close();
  }
});

test("policy file instruction changes invalidate notification inputs independently of merge settings", async () => {
  const f = await fixture();
  const changed = spyOn(f.c, "inputsChanged");
  try {
    const before = f.c.store.merging.entry(url);
    await writeFile(
      join(f.root, "octo-manager.toml"),
      config.replace(
        "Repair the review findings.",
        "Inspect the new policy instructions.",
      ),
    );
    expect(f.c.store.repositories.tick()).toEqual({ monitorFiles: true });
    expect(
      f.c.store.repositories.get(f.pr.id)?.instructions.review_feedback,
    ).toBe("Inspect the new policy instructions.");
    expect(f.c.store.merging.entry(url)).toEqual(before);
    expect(changed).toHaveBeenCalled();
    changed.mockClear();
    f.c.store.repositories.tick();
    expect(changed).not.toHaveBeenCalled();
  } finally {
    changed.mockRestore();
    await f.close();
  }
});
