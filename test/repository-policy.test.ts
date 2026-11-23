import { MergeDeclined } from "../src/merging/async-merge.js";
import { test, expect, spyOn } from "bun:test";
import { mkdtemp, writeFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordinator } from "../src/coordinator.js";
import { EntryState, ChainState } from "../src/merging/contracts.js";
import { load } from "../src/repository/policy.js";
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
