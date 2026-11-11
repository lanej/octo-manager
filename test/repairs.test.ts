import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Coordinator } from "../src/coordinator.js";
import { schedulerClient } from "../src/client.js";
import { defaultTrackingConfig } from "../src/tracking/config.js";
import {
  repairProfile,
  RepairState,
  RepairStep,
  type RebaseSource,
} from "../src/repairs/types.js";
import { parse as parseYaml } from "yaml";
import { expandInlineSequences } from "../src/repairs/yaml.js";
import { RecipeDecision } from "../src/repairs/cases.js";
import { RebaseWorkspace } from "../src/repairs/git.js";
import type { ObservationInput } from "../src/tracking/types.js";
const exec = promisify(execFile);
const url = "https://github.com/owner/repo/pull/42";
async function git(cwd: string, args: string[]): Promise<string> {
  const r = await exec(
    "git",
    [
      "-c",
      "user.name=Repair Test",
      "-c",
      "user.email=repair@localhost",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd },
  );
  return r.stdout.trim();
}
async function fixture(conflicting = false) {
  const root = await mkdtemp(join(tmpdir(), "octo-rebase-"));
  const remote = join(root, "remote.git"),
    seed = join(root, "seed");
  await mkdir(seed);
  await git(seed, ["init", "-b", "main"]);
  await writeFile(join(seed, "policy.txt"), "timeout=30\n");
  await writeFile(join(seed, "readme.txt"), "base\n");
  await git(seed, ["add", "."]);
  await git(seed, ["commit", "-m", "base"]);
  await git(seed, ["branch", "feature"]);
  await writeFile(join(seed, "policy.txt"), "timeout=60\n");
  await git(seed, ["commit", "-am", "target timeout"]);
  await git(seed, ["switch", "feature"]);
  await writeFile(
    join(seed, conflicting ? "policy.txt" : "readme.txt"),
    conflicting ? "timeout=90\n" : "feature docs\n",
  );
  await git(seed, ["commit", "-am", "feature change"]);
  await git(seed, ["clone", "--bare", seed, remote]);
  const source = async (): Promise<RebaseSource> => ({
    repository: "owner/repo",
    headRef: "feature",
    headSha: await git(remote, ["rev-parse", "feature"]),
    targetRef: "main",
    targetSha: await git(remote, ["rev-parse", "main"]),
  });
  const config = defaultTrackingConfig();
  config.repairs["rebase"] = repairProfile({
    repository: "owner/repo",
    harness: "pi",
    model: "test-model",
    instructions: "Preserve the feature timeout of 90 seconds.",
    checks: [["git", "diff", "--check"]],
    timeoutMs: 10000,
    githubChecks: ["Policy"],
  });
  const observe = async (): Promise<ObservationInput> => {
    const s = await source();
    return {
      observedAt: Date.now(),
      headSha: s.headSha,
      baseSha: s.targetSha,
      targetBase: { ref: s.targetRef, sha: s.targetSha },
      lifecycle: "open",
      mergeability: "mergeable",
      checks: {
        state: "complete",
        value: [
          {
            id: "run:1",
            key: "policy",
            name: "Policy",
            headSha: s.headSha,
            status: "completed",
            conclusion: "success",
            at: Date.now(),
            url,
          },
        ],
      },
      reviews: { state: "complete", value: [] },
    };
  };
  const workspace = (
    directory: string,
    s: RebaseSource,
    signal: AbortSignal,
  ) => {
    const w = new RebaseWorkspace(directory, s, signal, remote);
    const prepare = w.prepare.bind(w);
    w.prepare = async () => {
      await prepare();
      await w.git(["config", "user.name", "Repair Test"]);
      await w.git(["config", "user.email", "repair@localhost"]);
      await w.git(["config", "commit.gpgsign", "false"]);
    };
    return w;
  };
  return { root, remote, source, config, observe, workspace };
}
async function wait(coordinator: Coordinator, id: string, state?: RepairState) {
  for (let i = 0; i < 400; i++) {
    const a = coordinator.store.repairs.get(id);
    if (
      state === undefined
        ? ![
            RepairState.Queued,
            RepairState.Running,
            RepairState.AwaitingChecks,
          ].includes(a.state)
        : a.state === state
    )
      return a;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(
    `Repair did not settle: ${JSON.stringify(coordinator.store.repairs.get(id))}`,
  );
}
function enroll(coordinator: Coordinator) {
  return coordinator.store.tracking.track(url, {
    harness: "codex",
    endpoint: "local",
    sessionId: "owner",
    label: "Original agent",
  });
}

test("RPC rebase uses Git without an agent, pushes the linear result, verifies GitHub, and replays once", async () => {
  const f = await fixture();
  let agents = 0;
  const before = await f.source();
  const c = new Coordinator(join(f.root, "state"), {
    trackingConfig: f.config,
    trackingOptions: { read: f.observe },
    repairOptions: {
      source: f.source,
      workspace: f.workspace,
      observe: f.observe,
      resolve: () => {
        agents++;
        return Promise.reject(new Error("Clean rebase must not use an agent"));
      },
    },
  });
  try {
    enroll(c);
    await c.start();
    const client = schedulerClient(c.directory);
    const request = { requestId: "clean", url, profile: "rebase" };
    const response = await client.requestRebase(request);
    const id = response.repair?.id;
    assert(id !== undefined);
    const done = await wait(c, id);
    assert.equal(done.state, RepairState.Succeeded, done.detail);
    assert.equal(agents, 0);
    assert.notEqual(done.resultHead, before.headSha);
    assert.equal(
      await git(f.remote, ["rev-parse", "feature"]),
      done.resultHead,
    );
    await git(f.remote, [
      "merge-base",
      "--is-ancestor",
      before.targetSha,
      "feature",
    ]);
    assert.equal((await client.requestRebase(request)).repair?.id, id);
    assert.equal(c.store.repairs.list().length, 1);
    assert.equal(c.store.tracking.agents()[0]?.sessionId, "owner");
    await assert.rejects(
      client.requestRebase({ ...request, profile: "different" }),
    );
    assert((await client.getSnapshot({})).snapshot?.repairs.length === 1);
  } finally {
    await c.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("conflicts escalate only unresolved text, then checks gate the exact leased push", async () => {
  const f = await fixture(true);
  let agents = 0;
  const c = new Coordinator(join(f.root, "state"), {
    trackingConfig: f.config,
    trackingOptions: { read: f.observe },
    repairOptions: {
      source: f.source,
      workspace: f.workspace,
      observe: f.observe,
      resolve: async (w, paths, profile) => {
        agents++;
        assert.deepEqual(paths, ["policy.txt"]);
        assert.equal(profile.model, "test-model");
        assert.match(await w.read("policy.txt"), /<<<<<<< /u);
        await assert.rejects(w.write("readme.txt", "unrelated"));
        await assert.rejects(w.read(".git/config"));
        await assert.rejects(w.read("../secret"));
        await w.git(["config", "user.name", "Repair Test"]);
        await w.git(["config", "user.email", "repair@localhost"]);
        await w.git(["config", "commit.gpgsign", "false"]);
        await w.write("policy.txt", "timeout=90\n");
      },
    },
  });
  try {
    enroll(c);
    await c.start();
    const a = c.repairs.request({
      requestId: "conflict",
      prUrl: url,
      profile: "rebase",
    });
    const done = await wait(c, a.id);
    assert.equal(done.state, RepairState.Succeeded, done.detail);
    assert.equal(agents, 1);
    assert.equal(
      await git(f.remote, ["show", "feature:policy.txt"]),
      "timeout=90",
    );
    assert.equal(done.profile.model, "test-model");
    assert.equal(
      await git(f.remote, ["rev-list", "--merges", "main..feature"]),
      "",
    );
  } finally {
    await c.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("failed local validation preserves the remote source branch", async () => {
  const f = await fixture();
  const profile = f.config.repairs["rebase"];
  assert(profile !== undefined);
  profile.checks = [[process.execPath, "-e", "process.exit(1)"]];
  const before = await f.source();
  const c = new Coordinator(join(f.root, "state"), {
    trackingConfig: f.config,
    trackingOptions: { read: f.observe },
    repairOptions: {
      source: f.source,
      workspace: f.workspace,
      observe: f.observe,
    },
  });
  try {
    enroll(c);
    await c.start();
    const a = c.repairs.request({
      requestId: "bad-check",
      prUrl: url,
      profile: "rebase",
    });
    const done = await wait(c, a.id);
    assert.equal(done.state, RepairState.Blocked);
    assert.match(done.detail, /Validation failed/u);
    assert.equal((await f.source()).headSha, before.headSha);
  } finally {
    await c.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("exact Git lease refuses a competing source update and file tools reject symlinks", async () => {
  const f = await fixture();
  const source = await f.source();
  const w = f.workspace(
    join(f.root, "checkout"),
    source,
    new AbortController().signal,
  );
  try {
    await w.prepare();
    await w.rebase();
    const head = await w.git(["rev-parse", "HEAD"]);
    await git(f.remote, ["update-ref", "refs/heads/feature", source.targetSha]);
    await assert.rejects(w.push(head));
    assert.equal((await f.source()).headSha, source.targetSha);
    await unlink(join(w.directory, "policy.txt"));
    await symlink(join(f.root, "secret"), join(w.directory, "policy.txt"));
    await assert.rejects(w.read("policy.txt"), /Symlinks/u);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("unknown push completion survives restart without repeating the repair", async () => {
  const f = await fixture();
  let pushes = 0;
  const directory = join(f.root, "state");
  const options = {
    source: f.source,
    observe: f.observe,
    workspace: (path: string, source: RebaseSource, signal: AbortSignal) => {
      const w = f.workspace(path, source, signal);
      const push = w.push.bind(w);
      w.push = async (head: string) => {
        pushes++;
        await push(head);
        throw new Error("Connection lost after push");
      };
      return w;
    },
  };
  let c = new Coordinator(directory, {
    trackingConfig: f.config,
    trackingOptions: { read: f.observe },
    repairOptions: options,
  });
  try {
    enroll(c);
    await c.start();
    const a = c.repairs.request({
      requestId: "unknown-push",
      prUrl: url,
      profile: "rebase",
    });
    assert.equal((await wait(c, a.id)).state, RepairState.Uncertain);
    await c.close();
    c = new Coordinator(directory, {
      trackingConfig: f.config,
      trackingOptions: { read: f.observe },
      repairOptions: options,
    });
    await c.start();
    assert.equal(c.repairs.request(a.request).id, a.id);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(pushes, 1);
    assert.equal(c.store.repairs.get(a.id).state, RepairState.Uncertain);
  } finally {
    await c.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("empty and pending hosted checks cannot pass; transient reads retry without a second push", async () => {
  const f = await fixture();
  let now = Date.now();
  let mode = "empty";
  let pushes = 0;
  const directory = join(f.root, "state");
  const observe = async (): Promise<ObservationInput> => {
    if (mode === "unavailable") throw new Error("Temporary GitHub read race");
    const o = await f.observe();
    if (mode === "empty") o.checks = { state: "complete", value: [] };
    if (mode === "pending" && o.checks.state === "complete")
      o.checks.value = o.checks.value.map((c) => ({
        ...c,
        status: "in_progress",
        conclusion: "",
      }));
    if (mode === "failed" && o.checks.state === "complete")
      o.checks.value = o.checks.value.map((c) => ({
        ...c,
        conclusion: "failure",
      }));
    return o;
  };
  const c = new Coordinator(directory, {
    now: () => now,
    trackingConfig: f.config,
    trackingOptions: { read: f.observe },
    repairOptions: {
      source: f.source,
      observe,
      workspace: (path, source, signal) => {
        const w = f.workspace(path, source, signal);
        const push = w.push.bind(w);
        w.push = async (head) => {
          pushes++;
          await push(head);
        };
        return w;
      },
    },
  });
  try {
    enroll(c);
    await c.start();
    const a = c.repairs.request({
      requestId: "checks",
      prUrl: url,
      profile: "rebase",
    });
    await wait(c, a.id, RepairState.AwaitingChecks);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(c.store.repairs.get(a.id).state, RepairState.AwaitingChecks);
    mode = "pending";
    now += 16000;
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(c.store.repairs.get(a.id).state, RepairState.AwaitingChecks);
    mode = "unavailable";
    now += 16000;
    await new Promise((r) => setTimeout(r, 350));
    assert.match(c.store.repairs.get(a.id).detail, /verification unavailable/u);
    assert.equal(c.store.repairs.get(a.id).state, RepairState.AwaitingChecks);
    mode = "success";
    now += 16000;
    const done = await wait(c, a.id);
    assert.equal(done.state, RepairState.Succeeded, done.detail);
    assert.equal(pushes, 1);
    assert(done.history.some((h) => h.step === RepairStep.Push));
    assert(
      done.history.some((h) => h.detail.includes("verification unavailable")),
    );
  } finally {
    await c.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("awaiting GitHub verification survives restart and a failing hosted check fails the repair", async () => {
  const f = await fixture();
  const directory = join(f.root, "state");
  let failed = false;
  const observe = async () => {
    const o = await f.observe();
    if (o.checks.state === "complete")
      o.checks.value = o.checks.value.map((c) => ({
        ...c,
        status: failed ? "completed" : "in_progress",
        conclusion: failed ? "failure" : "",
      }));
    return o;
  };
  let c = new Coordinator(directory, {
    trackingConfig: f.config,
    trackingOptions: { read: f.observe },
    repairOptions: { source: f.source, workspace: f.workspace, observe },
  });
  try {
    enroll(c);
    await c.start();
    const a = c.repairs.request({
      requestId: "restart-checks",
      prUrl: url,
      profile: "rebase",
    });
    await wait(c, a.id, RepairState.AwaitingChecks);
    await c.close();
    failed = true;
    c = new Coordinator(directory, {
      trackingConfig: f.config,
      trackingOptions: { read: f.observe },
      repairOptions: { source: f.source, workspace: f.workspace, observe },
    });
    await c.start();
    const done = await wait(c, a.id);
    assert.equal(done.state, RepairState.Failed);
    assert.match(done.detail, /failing GitHub checks/u);
    assert.equal(done.resultHead, (await f.source()).headSha);
  } finally {
    await c.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("successful named commit statuses satisfy verification as well as completed check runs", async () => {
  const f = await fixture();
  const observe = async () => {
    const o = await f.observe();
    if (o.checks.state === "complete")
      o.checks.value = o.checks.value.map((c) => ({
        ...c,
        id: "status:1",
        status: "success",
        conclusion: "success",
      }));
    return o;
  };
  const c = new Coordinator(join(f.root, "state"), {
    trackingConfig: f.config,
    trackingOptions: { read: f.observe },
    repairOptions: { source: f.source, workspace: f.workspace, observe },
  });
  try {
    enroll(c);
    await c.start();
    const a = c.repairs.request({
      requestId: "legacy-status",
      prUrl: url,
      profile: "rebase",
    });
    const done = await wait(c, a.id);
    assert.equal(done.state, RepairState.Succeeded, done.detail);
  } finally {
    await c.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

async function yamlFixture(ambiguous = false) {
  const f = await fixture();
  const seed = join(f.root, "seed");
  const base = await git(seed, ["merge-base", "main", "feature"]);
  await git(seed, ["switch", "-c", "yaml-main", base]);
  await writeFile(join(seed, "config.yaml"), "ports: [80, 443, 8080]\n");
  await git(seed, ["add", "config.yaml"]);
  await git(seed, ["commit", "-m", "base YAML"]);
  await git(seed, ["branch", "yaml-feature"]);
  await writeFile(join(seed, "config.yaml"), "ports: [81, 443, 8080]\n");
  await git(seed, ["commit", "-am", "target first port"]);
  await git(seed, ["push", f.remote, "yaml-main"]);
  await git(seed, ["switch", "yaml-feature"]);
  await writeFile(
    join(seed, "config.yaml"),
    ambiguous ? "ports: [82, 443, 8080]\n" : "ports: [80, 443, 9090]\n",
  );
  await git(seed, ["commit", "-am", "source port"]);
  await git(seed, ["push", f.remote, "yaml-feature"]);
  const source = async (): Promise<RebaseSource> => ({
    repository: "owner/repo",
    headRef: "yaml-feature",
    headSha: await git(f.remote, ["rev-parse", "yaml-feature"]),
    targetRef: "yaml-main",
    targetSha: await git(f.remote, ["rev-parse", "yaml-main"]),
  });
  const observe = async (): Promise<ObservationInput> => {
    const s = await source();
    const o = await f.observe();
    return {
      ...o,
      headSha: s.headSha,
      targetBase: { ref: s.targetRef, sha: s.targetSha },
      checks: {
        state: "complete",
        value:
          o.checks.state === "complete"
            ? o.checks.value.map((check) => ({ ...check, headSha: s.headSha }))
            : [],
      },
    };
  };
  return { ...f, source, observe };
}

test("inline YAML conflicts resolve through expansion and Git without an agent; evidence survives workspace deletion", async () => {
  const f = await yamlFixture();
  const directory = join(f.root, "state");
  let agents = 0;
  let c = new Coordinator(directory, {
    trackingConfig: f.config,
    trackingOptions: { read: f.observe },
    repairOptions: {
      source: f.source,
      workspace: f.workspace,
      observe: f.observe,
      resolve: () => {
        agents++;
        return Promise.reject(
          new Error("Mechanical recipe must precede the agent"),
        );
      },
    },
  });
  try {
    enroll(c);
    await c.start();
    const attempt = c.repairs.request({
      requestId: "yaml-mechanical",
      prUrl: url,
      profile: "rebase",
    });
    const done = await wait(c, attempt.id);
    assert.equal(done.state, RepairState.Succeeded, done.detail);
    assert.equal(agents, 0);
    assert.equal(done.usedAgent, false);
    assert.equal(done.mechanicalRepairs, 1);
    const output = await git(f.remote, ["show", "yaml-feature:config.yaml"]);
    const parsed: unknown = parseYaml(output);
    assert.deepEqual(parsed, { ports: [81, 443, 9090] });
    assert.match(output, /- 81/u);
    const client = schedulerClient(directory);
    const cases = await client.listConflictCases({});
    assert.equal(cases.cases.length, 1);
    const summary = cases.cases[0];
    assert(summary !== undefined);
    assert.equal(summary.baseText, undefined);
    const detail = (await client.getConflictCase({ id: summary.id }))
      .conflictCase;
    assert(detail !== undefined);
    assert.equal(detail.baseText, "ports: [80, 443, 8080]\n");
    assert.equal(detail.targetText, "ports: [81, 443, 8080]\n");
    assert.equal(detail.replayedText, "ports: [80, 443, 9090]\n");
    assert(detail.candidate !== undefined);
    assert.equal(detail.agentResult, undefined);
    assert.match(detail.baseBlob ?? "", /^[0-9a-f]{40}$/u);
    await c.close();
    await rm(join(directory, "repairs"), { recursive: true, force: true });
    c = new Coordinator(directory, {
      trackingConfig: f.config,
      trackingOptions: { read: f.observe },
    });
    assert.equal(
      c.store.conflicts.get(Number(summary.id)).inputs?.base,
      detail.baseText,
    );
    assert.equal(
      c.store.conflicts.get(Number(summary.id)).candidate,
      detail.candidate,
    );
  } finally {
    await c.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("ambiguous YAML is retained as a declined recipe and escalates with its original three versions", async () => {
  const f = await yamlFixture(true);
  let agents = 0;
  const c = new Coordinator(join(f.root, "state"), {
    trackingConfig: f.config,
    trackingOptions: { read: f.observe },
    repairOptions: {
      source: f.source,
      workspace: f.workspace,
      observe: f.observe,
      resolve: async (w, paths) => {
        agents++;
        assert.deepEqual(paths, ["config.yaml"]);
        await w.git(["config", "user.name", "Repair Test"]);
        await w.git(["config", "user.email", "repair@localhost"]);
        await w.git(["config", "commit.gpgsign", "false"]);
        await w.write("config.yaml", "ports: [82, 443, 8080]\n");
      },
    },
  });
  try {
    enroll(c);
    await c.start();
    const a = c.repairs.request({
      requestId: "yaml-ambiguous",
      prUrl: url,
      profile: "rebase",
    });
    const done = await wait(c, a.id);
    assert.equal(done.state, RepairState.Succeeded, done.detail);
    assert.equal(agents, 1);
    const summary = c.store.conflicts.list()[0];
    assert(summary !== undefined);
    const detail = c.store.conflicts.get(summary.id);
    assert.equal(detail.decision, RecipeDecision.Declined);
    assert.match(detail.reason, /same sequence element/u);
    assert.equal(detail.candidate, undefined);
    assert.equal(detail.agentResult, "ports: [82, 443, 8080]\n");
    assert(detail.inputs?.base !== undefined);
  } finally {
    await c.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("sequence additions, reorders, duplicates, aliases and invalid YAML remain agent work", () => {
  for (const versions of [
    {
      base: "a: [a, b]\n",
      target: "a: [a, b, c]\n",
      replayed: "a: [a, b, d]\n",
    },
    {
      base: "a: [a, b, c]\n",
      target: "a: [b, a, c]\n",
      replayed: "a: [a, b, d]\n",
    },
    {
      base: "a: [a, a, c]\n",
      target: "a: [b, a, c]\n",
      replayed: "a: [a, a, d]\n",
    },
    {
      base: "a: &list [a, b, c]\n",
      target: "a: &list [x, b, c]\n",
      replayed: "a: &list [a, b, y]\n",
    },
    { base: "a: [a,b,c]\n", target: "a: [x,b,c\n", replayed: "a: [a,b,y]\n" },
  ])
    assert.throws(() => expandInlineSequences(versions));
});

test("large inline sequences decline within the explicit comparison budget", () => {
  const base = Array.from({ length: 10000 }, (_, index) => String(index)).join(
    ", ",
  );
  assert.throws(
    () =>
      expandInlineSequences({
        base: `a: [${base}]\n`,
        target: `a: [${base}, 10001]\n`,
        replayed: `a: [${base}, 10002]\n`,
      }),
    /Sequence entry limit/u,
  );
});

test("multiline execution failures remain readable through storage and RPC", async () => {
  const f = await fixture();
  const message = "Source unavailable\nRetry after the remote recovers";
  const c = new Coordinator(join(f.root, "state"), {
    trackingConfig: f.config,
    trackingOptions: { read: f.observe },
    repairOptions: { source: () => Promise.reject(new Error(message)) },
  });
  try {
    enroll(c);
    await c.start();
    const a = c.repairs.request({
      requestId: "multiline-error",
      prUrl: url,
      profile: "rebase",
    });
    const done = await wait(c, a.id);
    assert.equal(done.state, RepairState.Blocked);
    assert.equal(done.detail, message);
    const response = await schedulerClient(join(f.root, "state")).listRepairs(
      {},
    );
    assert.equal(response.repairs[0]?.detail, message);
  } finally {
    await c.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
