import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Coordinator } from "../src/coordinator.js";
test("real CLI derives different operation identities for changed contract inputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-contract-cli-")),
    config = join(directory, "octo-manager.toml");
  await writeFile(config, "schema_version = 1\n");
  const coordinator = new Coordinator(join(directory, "state"), {
    submissionOptions: {
      github: {
        snapshot: () =>
          Promise.reject(new Error("Controlled boundary: no GitHub access")),
        verify: () => Promise.resolve(),
        find: () => Promise.resolve(undefined),
        publish: () => Promise.reject(new Error("Unexpected publication")),
      },
    },
  });
  const run = async (extra: string[], fails = false) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "src/cli.ts",
        "pr",
        "prepare",
        "--repo",
        "owner/repo",
        "--base",
        "main",
        "--head",
        "HEAD",
        "--purpose",
        "Normalize intent identity",
        "--thread-id",
        "fixture",
        "--no-wait",
        "--state",
        join(directory, "state"),
        "--json",
        ...extra,
      ],
      {
        env: { ...process.env, OCTO_MANAGER_AGENT: "0" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    if (fails) {
      expect(stderr).toMatch(/TOML|parse|Expected/iu);
      expect(code).toBe(1);
    } else {
      expect(stderr).toBe("");
      expect(code).toBe(0);
    }
  };
  try {
    await coordinator.start();
    await run([]);
    await run(["--config", config]);
    const values = coordinator.store.submissions.list();
    expect(values).toHaveLength(2);
    expect(values[0]?.request.requestId).not.toBe(values[1]?.request.requestId);
    expect(values[0]?.request.contractToml).toBeUndefined();
    expect(values[1]?.request.contractToml).toBeUndefined();
    expect(values[1]?.request.contract?.schema_version).toBe(1);
    expect(values[1]?.request.contractSource?.path).toBe(config);
    const invalid = join(directory, "invalid-legacy-input.json");
    await writeFile(
      invalid,
      JSON.stringify({
        ...values[0]?.request,
        requestId: "invalid-selected-config",
        contractToml: "not = [ valid",
      }),
    );
    await run(["--input", invalid], true);
    expect(coordinator.store.submissions.list()).toHaveLength(2);
  } finally {
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});
