import { test, expect } from "bun:test";
import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  mkdir,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import {
  initialize,
  readContract,
  validateDraft,
  contractPath,
  type Contract,
  githubRepository,
} from "../src/publication/contract.js";
import {
  PublicationStore,
  receipt,
  type PublicationInput,
} from "../src/publication/store.js";
import {
  GitHubPublisher,
  publishRequest,
  type PublisherGitHub,
  type RemotePR,
} from "../src/publication/publisher.js";
import type { GitHubTransport } from "../src/github/sdk.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "octo-publication-"));
  const root = join(directory, "repo");
  await mkdir(root);
  initialize(root);
  const configured = readContract(root);
  const input: PublicationInput = {
    root,
    repository: "owner/repo",
    headRef: "feature/example",
    headSha: "a".repeat(40),
    baseRef: "main",
    title: "feat: explain the behavior",
    body: "Explain the behavior so callers can use it.",
    draft: false,
    contract: configured.contract,
    contractHash: configured.hash,
  };
  const store = new PublicationStore(directory);
  return {
    directory,
    root,
    input,
    store,
    async close() {
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
class GitHub implements PublisherGitHub {
  writes = 0;
  lostReply = false;
  found: RemotePR | undefined;
  revisions() {
    return Promise.resolve({ head: "a".repeat(40), base: "b".repeat(40) });
  }
  find() {
    return Promise.resolve(this.found);
  }
  create(input: PublicationInput, marker: string, dispatched: () => void) {
    dispatched();
    this.writes++;
    this.found = {
      url: "https://github.com/owner/repo/pull/1",
      repository: input.repository,
      headRepository: input.repository,
      headRef: input.headRef,
      headSha: input.headSha,
      baseRef: input.baseRef,
      title: input.title,
      body: input.body + "\n\n" + marker,
      state: "open",
    };
    if (this.lostReply) return Promise.reject(new Error("Lost response"));
    return Promise.resolve(this.found);
  }
}
test("local contract initialization preserves authored templates and validates explicit format without semantic gates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-contract-"));
  try {
    await mkdir(join(directory, ".github"));
    const authored = "## Outcome\n\nExplain the outcome.\n";
    await writeFile(
      join(directory, ".github/pull_request_template.md"),
      authored,
    );
    initialize(directory);
    expect(
      await readFile(
        join(directory, ".github/pull_request_template.md"),
        "utf8",
      ),
    ).toBe(authored);
    const contract: Contract = {
      schemaVersion: 1,
      template: ".github/pull_request_template.md",
      title: { prefixes: ["feat:"], maxLength: 40 },
      body: { requiredHeadings: ["Outcome"], requiredText: ["migration"] },
    };
    expect(
      validateDraft(
        { title: "fix: change", body: "```md\n## Outcome\n```" },
        contract,
      ).map((item) => item.code),
    ).toEqual(["title_prefix", "heading_missing", "text_missing"]);
    expect(
      validateDraft(
        { title: "feat: change", body: "## Outcome\n\nA migration is needed." },
        contract,
      ),
    ).toEqual([]);
    expect(
      validateDraft(
        { title: "anything", body: "A short factual description." },
        { schemaVersion: 1, template: "template.md" },
      ),
    ).toEqual([]);
    expect(
      validateDraft({ title: "", body: "" }, contract).length,
    ).toBeGreaterThan(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("initialization reuses a saved choice among multiple authored templates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-templates-"));
  try {
    const folder = ".github/PULL_REQUEST_TEMPLATE";
    await mkdir(join(directory, folder), { recursive: true });
    await writeFile(join(directory, folder, "feature.md"), "## Feature\n");
    await writeFile(join(directory, folder, "fix.md"), "## Fix\n");
    expect(() => initialize(directory)).toThrow("Multiple PR templates exist");
    const selected = folder + "/feature.md";
    expect(initialize(directory, selected).template).toBe(selected);
    const saved = await readFile(join(directory, contractPath), "utf8");
    expect(initialize(directory).template).toBe(selected);
    expect(await readFile(join(directory, contractPath), "utf8")).toBe(saved);
    expect(await readFile(join(directory, selected), "utf8")).toBe(
      "## Feature\n",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("launch failure cannot erase another worker's attempted or published state; retries return pending", async () => {
  const h = await fixture(),
    duplicate = new PublicationStore(h.directory);
  try {
    const accepted = h.store.accept(h.input);
    const lock = h.store.lock(accepted.id);
    if (lock === undefined) throw new Error("Missing fixture lock");
    h.store.save({ ...accepted, attempted: true });
    expect(duplicate.launchFailure(accepted.id).attempted).toBe(true);
    lock.close();
    expect(duplicate.launchFailure(accepted.id).attempted).toBe(true);
    const failed = h.store.accept({ ...h.input, title: "feat: failure" });
    expect(h.store.launchFailure(failed.id).state).toBe("failed");
    expect(h.store.retry(failed.id).state).toBe("pending");
    h.store.save({
      ...h.store.get(accepted.id),
      state: "published",
      url: "https://github.com/owner/repo/pull/1",
    });
    expect(duplicate.launchFailure(accepted.id).url).toBe(
      "https://github.com/owner/repo/pull/1",
    );
  } finally {
    duplicate.close();
    await h.close();
  }
});
test("repository inference accepts only real GitHub hosts and uncertain launch failure stays uncertain", async () => {
  expect(
    githubRepository("https://notgithub.com/owner/repo.git"),
  ).toBeUndefined();
  expect(
    githubRepository("https://github.com.attacker.invalid/owner/repo"),
  ).toBeUndefined();
  expect(githubRepository("git@github.com:owner/repo.git")).toBe("owner/repo");
  expect(githubRepository("https://github.com/owner/repo.git")).toBe(
    "owner/repo",
  );
  const h = await fixture();
  try {
    const value = h.store.accept(h.input);
    h.store.save({ ...value, attempted: true, state: "uncertain" });
    expect(h.store.retry(value.id).state).toBe("pending");
    const failed = h.store.launchFailure(value.id);
    expect(failed.state).toBe("uncertain");
    expect(failed.attempted).toBe(true);
    expect(failed.error?.code).toBe("publisher_start");
  } finally {
    await h.close();
  }
});
test("a non-closing fence cannot satisfy a required heading", () => {
  const configured: Contract = {
    schemaVersion: 1,
    template: "template.md",
    body: { requiredHeadings: ["Required"] },
  };
  expect(
    validateDraft(
      { title: "Valid", body: "```\n```not-a-close\n## Required" },
      configured,
    ).map((item) => item.code),
  ).toContain("heading_missing");
});
test("pending receipts are idempotent and concurrent publishers create one exact caller-written PR", async () => {
  const h = await fixture();
  const second = new PublicationStore(h.directory);
  try {
    const a = h.store.accept(h.input, "one"),
      b = second.accept(h.input, "one");
    expect(a.id).toBe(b.id);
    expect(receipt(a)).toEqual({ id: a.id, state: "pending" });
    expect(() =>
      second.accept({ ...h.input, body: "Different" }, "one"),
    ).toThrow();
    const github = new GitHub();
    await Promise.all([
      publishRequest(h.store, a.id, github),
      publishRequest(second, a.id, github),
    ]);
    expect(github.writes).toBe(1);
    expect(h.store.get(a.id).state).toBe("published");
    expect(github.found?.title).toBe(h.input.title);
    expect(github.found?.body).toBe(
      h.input.body + "\n\n<!-- octo-submission:" + a.id + " -->",
    );
  } finally {
    second.close();
    await h.close();
  }
});
test("lost create response remains uncertain and retry reconciles without creating twice", async () => {
  const h = await fixture();
  try {
    const accepted = h.store.accept(h.input),
      github = new GitHub();
    github.lostReply = true;
    await publishRequest(h.store, accepted.id, github);
    expect(h.store.get(accepted.id).state).toBe("uncertain");
    await publishRequest(h.store, accepted.id, github);
    expect(h.store.get(accepted.id).state).toBe("published");
    expect(github.writes).toBe(1);
  } finally {
    await h.close();
  }
});
test("legacy import only reconciles its original marker and cannot create another PR", async () => {
  const h = await fixture(),
    imported = new PublicationStore(join(h.directory, "reconciler"));
  try {
    const original = h.store.accept(h.input),
      github = new GitHub();
    github.lostReply = true;
    await publishRequest(h.store, original.id, github);
    imported.adoptLegacy(original.id, h.input);
    await publishRequest(imported, original.id, github);
    expect(imported.get(original.id).state).toBe("published");
    expect(github.writes).toBe(1);
    const absent = h.store.accept({
      ...h.input,
      title: "feat: legacy absence",
    });
    imported.adoptLegacy(absent.id, {
      ...h.input,
      title: "feat: legacy absence",
    });
    const offline = new GitHub();
    await publishRequest(imported, absent.id, offline);
    expect(imported.get(absent.id).state).toBe("uncertain");
    expect(offline.writes).toBe(0);
  } finally {
    imported.close();
    await h.close();
  }
});
test("contract and pushed revision changes prevent publication; absent confirmation never republishes", async () => {
  const h = await fixture();
  try {
    const accepted = h.store.accept(h.input),
      github = new GitHub();
    await writeFile(
      join(h.root, contractPath),
      JSON.stringify({ ...h.input.contract, title: { maxLength: 10 } }),
    );
    await publishRequest(h.store, accepted.id, github);
    expect(h.store.get(accepted.id).error?.code).toBe("contract_changed");
    expect(github.writes).toBe(0);
    await writeFile(
      join(h.root, contractPath),
      JSON.stringify(h.input.contract),
    );
    const changed = h.store.accept({ ...h.input, headSha: "c".repeat(40) });
    await publishRequest(h.store, changed.id, github);
    expect(h.store.get(changed.id).error?.code).toBe("head_changed");
    const uncertain = h.store.accept({ ...h.input, title: "feat: uncertain" });
    h.store.save({ ...uncertain, attempted: true, state: "uncertain" });
    await publishRequest(h.store, uncertain.id, github);
    expect(h.store.get(uncertain.id).state).toBe("uncertain");
    expect(github.writes).toBe(0);
  } finally {
    await h.close();
  }
});
test("GitHub rejection and transport uncertainty differ, while tracking failure preserves publication", async () => {
  const h = await fixture();
  try {
    const transport =
      (status: number): GitHubTransport =>
      (request, _signal, beforeSend) => {
        if (request.method === "POST") {
          beforeSend?.();
          return Promise.resolve({ status, headers: new Map(), body: "{}" });
        }
        return Promise.resolve({
          status: 200,
          headers: new Map(),
          body: request.path.includes("/pulls?")
            ? "[]"
            : JSON.stringify({
                object: {
                  sha: request.path.endsWith("main")
                    ? "b".repeat(40)
                    : "a".repeat(40),
                },
              }),
        });
      };
    const rejected = h.store.accept(h.input, "rejected");
    await publishRequest(
      h.store,
      rejected.id,
      new GitHubPublisher(transport(422)),
    );
    expect(h.store.get(rejected.id).state).toBe("failed");
    expect(h.store.get(rejected.id).error?.code).toBe("github_rejected");
    const unknown = h.store.accept(h.input, "unknown");
    await publishRequest(
      h.store,
      unknown.id,
      new GitHubPublisher(transport(503)),
    );
    expect(h.store.get(unknown.id).state).toBe("uncertain");
    const tracked = h.store.accept({
      ...h.input,
      track: { sessionId: "session", endpoint: "local" },
    });
    expect(receipt(tracked)).toMatchObject({
      state: "pending",
      tracking: "pending",
    });
    const github = new GitHub();
    await publishRequest(h.store, tracked.id, github, () =>
      Promise.reject(new Error("Daemon unavailable")),
    );
    expect(h.store.get(tracked.id).state).toBe("published");
    expect(h.store.get(tracked.id).tracking).toBe("unavailable");
    await publishRequest(h.store, tracked.id, github, (publication) => {
      expect(publication.input.track).toEqual({
        sessionId: "session",
        endpoint: "local",
      });
      expect(publication.url).toBe(h.store.get(tracked.id).url);
      return Promise.resolve();
    });
    expect(h.store.get(tracked.id).tracking).toBe("active");
    expect(github.writes).toBe(1);
  } finally {
    await h.close();
  }
});
test("recovered publication must match the exact draft, repository and branch identity", async () => {
  const h = await fixture();
  try {
    const accepted = h.store.accept(h.input),
      github = new GitHub();
    await publishRequest(h.store, accepted.id, github);
    const current = h.store.get(accepted.id);
    h.store.save({ ...current, state: "uncertain" });
    if (github.found === undefined) throw new Error("Missing fixture PR");
    github.found = { ...github.found, title: "Changed remotely" };
    await publishRequest(h.store, accepted.id, github);
    expect(h.store.get(accepted.id).state).toBe("uncertain");
    expect(github.writes).toBe(1);
  } finally {
    await h.close();
  }
});
async function run(
  args: string[],
  cwd: string,
  state: string,
  extra: Record<string, string> = {},
) {
  const child = Bun.spawn(
    [
      process.execPath,
      resolve("src/cli.ts"),
      ...args,
      "--json",
      "--state",
      state,
      "--cwd",
      cwd,
    ],
    {
      cwd,
      env: { ...process.env, ...extra },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const value: unknown = JSON.parse(stdout === "" ? stderr : stdout);
  return { code, stdout, stderr, value };
}
test("real CLI validates offline and rejects invalid drafts before storing a receipt; valid input returns pending without a daemon", async () => {
  const h = await fixture();
  try {
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", "-C", h.root, ...args], {
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
      });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    };
    git("init", "-q", "-b", "feature/example");
    git("remote", "add", "origin", "https://github.com/owner/repo.git");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-qm",
      "Fixture",
    );
    const description = join(h.root, "description.md");
    await writeFile(description, "Explain the new behavior.");
    const bin = join(h.directory, "bin");
    await mkdir(bin);
    const gh = join(bin, "gh"),
      called = join(h.directory, "gh-called");
    await writeFile(
      gh,
      "#!/bin/sh\nprintf called > '" + called + "'\nexit 1\n",
    );
    await chmod(gh, 0o700);
    const env = {
      PATH: bin + ":" + (process.env["PATH"] ?? ""),
      CODEX_THREAD_ID: "",
    };
    const invalid = await run(
      [
        "submit-pr",
        "--title",
        "",
        "--body-file",
        description,
        "--base",
        "main",
      ],
      h.root,
      h.directory,
      env,
    );
    expect(invalid.code).toBe(1);
    expect(JSON.stringify(invalid.value)).toContain("title_empty");
    expect(h.store.list(Number.MAX_SAFE_INTEGER).items).toHaveLength(0);
    expect(existsSync(called)).toBe(false);
    const agentInvalid = await run(
      ["pr", "validate", "--title", "", "--body", ""],
      h.root,
      h.directory,
      { ...env, OCTO_MANAGER_AGENT: "1" },
    );
    expect(agentInvalid.code).toBe(1);
    expect(agentInvalid.stdout).toBe("");
    expect(agentInvalid.stderr.trim().split("\n")).toHaveLength(1);
    expect(agentInvalid.value).toMatchObject({
      error: { code: "validation_failed" },
    });
    expect(agentInvalid.value).toHaveProperty(
      "error.message",
      expect.stringContaining("title_empty"),
    );
    const agentFailure = await run(
      ["publication", "show", "missing"],
      h.root,
      h.directory,
      { ...env, OCTO_MANAGER_AGENT: "1" },
    );
    expect(agentFailure.code).toBe(1);
    expect(agentFailure.stdout).toBe("");
    expect(agentFailure.value).toMatchObject({ error: { code: "not_found" } });
    expect(agentFailure.value).toHaveProperty("error.message");
    const valid = await run(
      [
        "pr",
        "validate",
        "--title",
        "feat: explain",
        "--body-file",
        description,
      ],
      h.root,
      h.directory,
      env,
    );
    expect(valid.code).toBe(0);
    expect(valid.value).toEqual({ valid: true });
    expect(existsSync(called)).toBe(false);
    const unsupported = await run(
      [
        "submit-pr",
        "--title",
        "feat: explain",
        "--body-file",
        description,
        "--base",
        "main",
        "--track",
        "--harness",
        "claude",
        "--thread-id",
        "claude-session",
      ],
      h.root,
      h.directory,
      env,
    );
    expect(unsupported.code).toBe(1);
    expect(JSON.stringify(unsupported.value)).toContain("tracking_harness");
    expect(h.store.list(Number.MAX_SAFE_INTEGER).items).toHaveLength(0);
    expect(existsSync(called)).toBe(false);
    const moved = await run(
      [
        "submit-pr",
        "--title",
        "feat: explain",
        "--body-file",
        description,
        "--base",
        "main",
        "--expected-head",
        "a".repeat(40),
      ],
      h.root,
      h.directory,
      env,
    );
    expect(moved.code).toBe(1);
    expect(JSON.stringify(moved.value)).toContain("head_changed");
    expect(h.store.list(Number.MAX_SAFE_INTEGER).items).toHaveLength(0);
    const accepted = await run(
      [
        "submit-pr",
        "--title",
        "feat: explain",
        "--body-file",
        description,
        "--base",
        "main",
      ],
      h.root,
      h.directory,
      env,
    );
    expect(accepted.code).toBe(0);
    expect(accepted.stdout.length).toBeLessThan(1024);
    const pending = h.store.list(Number.MAX_SAFE_INTEGER).items[0];
    if (pending === undefined) throw new Error("Missing durable receipt");
    expect(JSON.stringify(accepted.value)).toContain("pending");
    const deadline = Date.now() + 5000;
    while (h.store.get(pending.id).state === "pending" && Date.now() < deadline)
      await Bun.sleep(20);
    expect(h.store.get(pending.id).state).toBe("failed");
    expect(existsSync(called)).toBe(true);
    const publish = [
      "pr",
      "publish",
      "--title",
      "feat: explain",
      "--body-file",
      description,
      "--base",
      "main",
    ];
    const missing = await run(
      [...publish, "--track"],
      h.root,
      h.directory,
      env,
    );
    expect(missing.code).toBe(1);
    expect(JSON.stringify(missing.value)).toContain("tracking_owner");
    for (const [request, flags, thread, expected] of [
      ["inferred", [], "current-session", "current-session"],
      [
        "explicit",
        ["--thread-id", "selected-session"],
        "current-session",
        "selected-session",
      ],
      ["opt-out", ["--no-track"], "current-session", undefined],
      ["other-harness", ["--harness", "claude"], "current-session", undefined],
      ["pi-opt-in-only", ["--harness", "pi"], "current-session", undefined],
      [
        "explicit-pi",
        [
          "--track",
          "--harness",
          "pi",
          "--thread-id",
          "00000000-0000-4000-8000-000000000211",
        ],
        "current-session",
        "00000000-0000-4000-8000-000000000211",
      ],
    ] as const) {
      const response = await run(
        [...publish, ...flags, "--request-id", request],
        h.root,
        h.directory,
        { ...env, CODEX_THREAD_ID: thread },
      );
      expect(response.code).toBe(0);
      const item = h.store.list(Number.MAX_SAFE_INTEGER).items[0];
      if (item === undefined) throw new Error("Missing durable receipt");
      expect(response.value).toMatchObject({ id: item.id, state: "pending" });
      expect(item.input.track).toEqual(
        expected === undefined
          ? undefined
          : {
              sessionId: expected,
              endpoint: "local",
              ...(request === "explicit-pi" ? { harness: "pi" } : {}),
            },
      );
      if (expected !== undefined)
        expect(response.value).toMatchObject({ tracking: "pending" });
      const until = Date.now() + 5000;
      while (h.store.get(item.id).state === "pending" && Date.now() < until)
        await Bun.sleep(20);
      expect(h.store.get(item.id).state).toBe("failed");
    }
    for (let i = 0; i < 12; i++)
      h.store.accept({
        ...h.input,
        body: "large ".repeat(5000),
        title: String(i),
      });
    git("remote", "remove", "origin");
    const targeted = await run(
      [
        "submit-pr",
        "--repo",
        "owner/repo",
        "--title",
        "feat: explicit target",
        "--body-file",
        description,
        "--base",
        "main",
      ],
      h.root,
      h.directory,
      env,
    );
    expect(targeted.code).toBe(0);
    const targetedRequest = h.store.list(Number.MAX_SAFE_INTEGER).items[0];
    if (targetedRequest === undefined)
      throw new Error("Missing explicit-target receipt");
    while (
      h.store.get(targetedRequest.id).state === "pending" &&
      Date.now() < deadline + 5000
    )
      await Bun.sleep(20);
    await writeFile(
      join(h.root, contractPath),
      JSON.stringify({
        schemaVersion: 1,
        template: ".github/pull_request_template.md",
        body: {
          requiredText: Array.from(
            { length: 20 },
            (_, i) => '\\"\u0000'.repeat(15) + String(i),
          ),
        },
      }),
    );
    const escaped = await run(
      ["pr", "validate", "--title", "Valid", "--body-file", description],
      h.root,
      h.directory,
      env,
    );
    expect(escaped.code).toBe(1);
    expect(Buffer.byteLength(escaped.stdout)).toBeLessThanOrEqual(1025);
    const page = await run(
      ["history", "submissions"],
      h.root,
      h.directory,
      env,
    );
    expect(Buffer.byteLength(page.stdout)).toBeLessThan(4096);
    expect(page.stdout).not.toContain("large ");
    await writeFile(
      join(h.root, contractPath),
      JSON.stringify(h.input.contract),
    );
    const nativeGit = Bun.which("git");
    if (nativeGit === null) throw new Error("Missing fixture Git");
    const strict = JSON.stringify({
      ...h.input.contract,
      body: { requiredText: ["required-migration"] },
    });
    await writeFile(
      join(bin, "git"),
      '#!/bin/sh\nif [ "$1 $2" = "branch --show-current" ]; then printf \'%s\' \'' +
        strict +
        "' > '" +
        join(h.root, contractPath) +
        "'; fi\nexec '" +
        nativeGit +
        '\' "$@"\n',
    );
    await chmod(join(bin, "git"), 0o700);
    const beforeRace = h.store
      .list(Number.MAX_SAFE_INTEGER)
      .items.map((item) => item.id);
    const changedContract = await run(
      [
        "submit-pr",
        "--repo",
        "owner/repo",
        "--title",
        "feat: racing contract",
        "--body-file",
        description,
        "--base",
        "main",
      ],
      h.root,
      h.directory,
      env,
    );
    expect(changedContract.code).toBe(1);
    expect(JSON.stringify(changedContract.value)).toContain("text_missing");
    expect(
      h.store.list(Number.MAX_SAFE_INTEGER).items.map((item) => item.id),
    ).toEqual(beforeRace);
  } finally {
    await h.close();
  }
});
