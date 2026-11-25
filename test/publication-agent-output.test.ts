import { test, expect, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { parseCommand } from "../src/cli/arguments.js";
import { publicationCLI } from "../src/publication/cli.js";
import { initialize } from "../src/publication/contract.js";
import { PublicationStore } from "../src/publication/store.js";

test("publisher launch failure keeps agent stdout empty and preserves the failed receipt in stderr", async () => {
  const directory = await mkdtemp("/tmp/octo-agent-launch-"),
    previousExitCode = process.exitCode;
  const writeOut = spyOn(console, "log").mockImplementation(() => {});
  const writeError = spyOn(console, "error").mockImplementation(() => {});
  let restoreLaunch: (() => void) | undefined;
  try {
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", "-C", directory, ...args], {
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
      });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    };
    git("init", "-q", "-b", "feature/example");
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
    initialize(directory);
    const launch = spyOn(childProcess, "spawn").mockImplementation(() => {
      throw new Error("Controlled publisher launch failure");
    });
    restoreLaunch = () => {
      launch.mockRestore();
    };
    await publicationCLI(
      parseCommand(
        [
          "pr",
          "publish",
          "--title",
          "feat: example",
          "--body",
          "Explain the new behavior.",
          "--repo",
          "o/r",
          "--base",
          "main",
          "--no-track",
          "--cwd",
          directory,
          "--state",
          directory,
          "--request-id",
          "launch-failure",
        ],
        { OCTO_MANAGER_AGENT: "1" },
      ),
    );
    expect(process.exitCode).toBe(1);
    expect(writeOut).not.toHaveBeenCalled();
    expect(writeError).toHaveBeenCalledTimes(1);
    const store = new PublicationStore(directory);
    try {
      const receipt = store.list(Number.MAX_SAFE_INTEGER).items[0];
      if (receipt === undefined) throw new Error("Missing failed receipt");
      expect(receipt.state).toBe("failed");
      const failure: unknown = JSON.parse(
        String(writeError.mock.calls[0]?.[0]),
      );
      expect(failure).toHaveProperty("error.code", "publication_failed");
      expect(failure).toHaveProperty(
        "error.fix",
        `Receipt ${receipt.id} is failed; inspect with octo-manager publication show ${receipt.id}`,
      );
    } finally {
      store.close();
    }
  } finally {
    restoreLaunch?.();
    writeOut.mockRestore();
    writeError.mockRestore();
    process.exitCode = previousExitCode ?? 0;
    await rm(directory, { recursive: true, force: true });
  }
});
