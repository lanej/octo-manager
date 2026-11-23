import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { releaseIdentity } from "../src/startup-context.js";

const Ready = Type.Object({
  ready: Type.Literal(true),
  state: Type.String(),
  at: Type.String(),
  pid: Type.Integer(),
  runtime: Type.Object({ name: Type.Literal("bun"), version: Type.String() }),
  release: Type.Object({
    status: Type.Literal("unavailable"),
    reason: Type.Literal("missing"),
  }),
});

test("real serve readiness retains its contract and identifies the running process without using cwd metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-startup-"));
  await writeFile(
    join(directory, "release.json"),
    JSON.stringify({ revision: "f".repeat(40) }),
  );
  const state = join(directory, "state");
  const child = spawn(
    process.execPath,
    [resolve("src/cli.ts"), "--state", state, "serve"],
    {
      cwd: directory,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const lines = createInterface({ input: child.stdout });
  let error = "";
  child.stderr.on("data", (chunk) => {
    error += String(chunk);
  });
  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
  }, 10000);
  try {
    const line: unknown = (
      await once(lines, "line", {
        signal: AbortSignal.timeout(8000),
      })
    )[0];
    if (typeof line !== "string") throw new Error("Missing readiness record");
    const value: unknown = JSON.parse(line);
    if (!Check(Ready, value))
      throw new Error(`Invalid readiness record: ${line}`);
    expect(value.state).toBe(state);
    const pid = child.pid;
    if (pid === undefined) throw new Error("Missing child process identity");
    expect(value.pid).toBe(pid);
    expect(Math.abs(Date.now() - Date.parse(value.at))).toBeLessThan(10000);
    expect(value.runtime.version).toBe(Bun.version);
    child.kill("SIGTERM");
    const code: unknown = (await once(child, "exit"))[0];
    expect(code).toBe(0);
    expect(error).toBe("");
  } finally {
    clearTimeout(timeout);
    lines.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("release identity reads bounded metadata beside its own module and rejects malformed identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-release-context-"));
  const root = join(directory, "release");
  await mkdir(join(root, "dist"), { recursive: true });
  const moduleUrl = pathToFileURL(
    join(root, "dist", "startup-context.js"),
  ).href;
  const metadata = join(root, "release.json");
  try {
    expect(releaseIdentity(moduleUrl)).toEqual({
      status: "unavailable",
      reason: "missing",
    });
    for (const value of [
      null,
      { revision: 5 },
      { revision: "main" },
      { revision: "a".repeat(41) },
    ]) {
      await writeFile(metadata, JSON.stringify(value));
      expect(releaseIdentity(moduleUrl)).toEqual({
        status: "unavailable",
        reason: "invalid",
      });
    }
    await writeFile(metadata, "{not JSON");
    expect(releaseIdentity(moduleUrl)).toEqual({
      status: "unavailable",
      reason: "invalid",
    });
    await writeFile(
      metadata,
      JSON.stringify({ revision: "a".repeat(40), padding: "x".repeat(4096) }),
    );
    expect(releaseIdentity(moduleUrl)).toEqual({
      status: "unavailable",
      reason: "invalid",
    });
    for (const revision of ["a".repeat(40), "b".repeat(64)]) {
      await writeFile(
        metadata,
        JSON.stringify({
          revision,
          bun: "1.4.4",
          platform: "darwin",
          architecture: "arm64",
        }),
      );
      expect(releaseIdentity(moduleUrl)).toEqual({
        status: "available",
        revision,
      });
    }
    await rm(metadata);
    await mkdir(metadata);
    expect(releaseIdentity(moduleUrl)).toEqual({
      status: "unavailable",
      reason: "unreadable",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
