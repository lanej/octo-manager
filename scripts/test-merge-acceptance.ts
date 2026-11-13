import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordinator } from "../src/coordinator.js";
import { defaultTrackingConfig } from "../src/tracking/config.js";
import { ChainState, EntryState } from "../src/merging/contracts.js";
import { githubReads } from "../src/github-api.js";
const owner = process.env["OCTO_ACCEPTANCE_OWNER"];
if (
  process.env["OCTO_LIVE_MERGE_ACCEPTANCE"] !== "1" ||
  owner === undefined ||
  !/^[A-Za-z0-9-]+$/u.test(owner)
)
  throw new Error(
    "Opt in with OCTO_LIVE_MERGE_ACCEPTANCE=1 and OCTO_ACCEPTANCE_OWNER=YOUR_LOGIN; this creates and merges PRs in two new private fixture repositories",
  );
const exec = promisify(execFile),
  directory = await mkdtemp(join(tmpdir(), "octo-live-merge-")),
  stamp = String(Date.now());
const repositories = [
  `${owner}/octo-merge-library-${stamp}`,
  `${owner}/octo-merge-application-${stamp}`,
];
const created: string[] = [];
let coordinator: Coordinator | undefined;
let passed = false;
async function command(
  binary: string,
  args: string[],
  cwd = directory,
): Promise<string> {
  const result = await exec(binary, args, {
    cwd,
    timeout: 120000,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
}
async function fixture(
  repository: string,
  revision?: string,
): Promise<{ url: string; initial: string }> {
  const path = join(directory, repository.split("/").at(-1) ?? "fixture");
  await mkdir(path);
  const git = (args: string[]) =>
    command(
      "git",
      [
        "-c",
        "user.name=Octo Acceptance",
        "-c",
        "user.email=octo-acceptance@localhost",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      path,
    );
  await git(["init", "-b", "main"]);
  await writeFile(
    join(path, "README.md"),
    "Disposable Octo merge-chain acceptance fixture.\n",
  );
  if (revision !== undefined)
    await writeFile(
      join(path, "versions.toml"),
      `[tools.library]\nrevision = "${revision}"\n`,
    );
  await git(["add", "."]);
  await git(["commit", "-m", "Fixture base"]);
  const initial = await git(["rev-parse", "HEAD"]);
  await command("gh", [
    "repo",
    "create",
    repository,
    "--private",
    "--source",
    path,
    "--remote",
    "origin",
    "--push",
  ]);
  created.push(repository);
  await git(["checkout", "-b", "fixture-change"]);
  await writeFile(join(path, "feature.txt"), "Fixture feature.\n");
  await git(["add", "."]);
  await git(["commit", "-m", "Fixture change"]);
  await git(["push", "-u", "origin", "HEAD"]);
  const url = await command(
    "gh",
    [
      "pr",
      "create",
      "--repo",
      repository,
      "--base",
      "main",
      "--head",
      "fixture-change",
      "--title",
      "test: disposable merge-chain fixture",
      "--body",
      "Temporary provider acceptance fixture. Explicitly queued only in an isolated local coordinator.",
    ],
    path,
  );
  return { url, initial };
}
try {
  const library = repositories[0],
    application = repositories[1];
  assert(library !== undefined && application !== undefined);
  const upstream = await fixture(library),
    downstream = await fixture(application, upstream.initial);
  const config = defaultTrackingConfig();
  config.endpoints = {};
  config.merging = {
    pin: {
      kind: "toml_revision",
      repository: application,
      path: "versions.toml",
      key: ["tools", "library", "revision"],
      expectedValue: upstream.initial,
      checks: [["git", "diff", "--exit-code"]],
      timeoutMs: 10000,
    },
  };
  coordinator = new Coordinator(join(directory, "state"), {
    trackingConfig: config,
  });
  const tracking = coordinator.store.tracking,
    agent = {
      harness: "codex",
      endpoint: "local",
      sessionId: `acceptance-${stamp}`,
      label: "Disposable merge-chain acceptance",
    };
  const first = tracking.track(upstream.url, agent),
    second = tracking.track(downstream.url, agent);
  await coordinator.tracking.refresh(first.id);
  await coordinator.tracking.refresh(second.id);
  coordinator.merging.command({
    op: "confirm",
    pr: second.id,
    prerequisite: first.id,
    actorId: second.ownerAgentId,
    reason: "Provider fixture uses actual merged library commit",
    profile: "pin",
  });
  const chain = coordinator.store.merging.queue({
    requestId: `acceptance-${stamp}`,
    actorId: first.ownerAgentId,
    entries: [
      { prUrl: upstream.url, noCi: true },
      { prUrl: downstream.url, noCi: true },
    ],
  });
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    for (const entry of coordinator.store.merging.entries()) {
      if (
        entry.state === EntryState.Uncertain ||
        entry.state === EntryState.Blocked
      )
        throw new Error(`Acceptance needs inspection: ${entry.detail}`);
      await coordinator.tracking.refresh(entry.prId);
      if (entry.state === EntryState.Merged) continue;
      const pr = tracking.pr(entry.prId);
      if (
        pr.observation !== undefined &&
        entry.ready === undefined &&
        entry.preparationHold !== true
      )
        coordinator.merging.command({
          op: "ready",
          pr: pr.id,
          actorId: pr.ownerAgentId,
          head: pr.observation.headSha,
        });
      coordinator.store.merging.saveEntry({
        ...coordinator.store.merging.entry(entry.prId),
        nextAt: 0,
      });
    }
    await coordinator.merging.tick();
    if (
      coordinator.store.merging.chain(chain.id).state === ChainState.Completed
    ) {
      const entries = coordinator.store.merging.entries(),
        merged = entries.find((entry) => entry.prId === first.id)?.mergeCommit;
      assert(merged !== undefined);
      const result: unknown = await githubReads.read(
        `repos/${application}/contents/versions.toml?ref=main`,
      );
      assert(
        typeof result === "object" &&
          result !== null &&
          "content" in result &&
          typeof result.content === "string",
      );
      assert(
        Buffer.from(result.content, "base64").toString("utf8").includes(merged),
      );
      console.log(
        JSON.stringify({
          result: "passed",
          repositories: created,
          chainId: chain.id,
          entries: entries.map((entry) => ({
            prUrl: tracking.pr(entry.prId).url,
            mergeCommit: entry.mergeCommit,
          })),
        }),
      );
      passed = true;
      break;
    }
    await delay(61000);
  }
  assert.equal(
    coordinator.store.merging.chain(chain.id).state,
    ChainState.Completed,
    "Acceptance timed out",
  );
} finally {
  await coordinator?.close();
  console.error(
    `Disposable repositories retained for inspection: ${created.join(", ")}`,
  );
  if (passed) await rm(directory, { recursive: true, force: true });
  else console.error(`Acceptance evidence retained at ${directory}`);
}
