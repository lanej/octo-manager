import assert from "node:assert/strict";
import { test, expect } from "bun:test";
import { mkdtemp, mkdir, copyFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { schedulerClient } from "../src/client.js";
import { JobStatus } from "../src/gen/octomanager/v2/scheduler_pb.js";
import { readLifecycle } from "../src/lifecycle-rpc.js";
import { LifecycleAction } from "../src/gen/octomanager/v2/lifecycle_pb.js";

test("native v2 checkpoint preserves pending work and fences all RPC admission before normal retirement on environment Bun", async () => {
  const directory = await mkdtemp("/tmp/octo-native-v2-"),
    release = join(directory, "releases", "current"),
    state = join(directory, "state");
  await mkdir(join(release, "dist"), { recursive: true, mode: 0o700 });
  await mkdir(join(release, "node_modules"), { mode: 0o700 });
  await mkdir(state, { mode: 0o700 });
  const build = await Bun.build({
    entrypoints: [resolve("src/cli.ts")],
    target: "bun",
    outdir: join(release, "dist"),
  });
  expect(build.success).toBe(true);
  for (const name of ["package.json", "bun.lock"]) await copyFile(resolve(name), join(release, name));
  const executable = join(release, "dist", "cli.js"),
    environment = {
      ...process.env,
      HOME: directory,
      XDG_CONFIG_HOME: join(directory, "config"),
      CODEX_HOME: join(directory, "codex"),
      OCTO_MANAGER_STATE: state,
      PROJECT_UPDATE_RETIREMENT_POLICY: "successful-exit",
    };
  const child = Bun.spawn([process.execPath, executable, "serve"], {
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const client = schedulerClient(state),
    operation = randomUUID();
  async function cli(action: string, nativeId = ""): Promise<{ code: number; report: unknown }> {
    const invocation = Bun.spawn([process.execPath, executable, "lifecycle", action], {
      env: {
        ...environment,
        PROJECT_UPDATE_RUN_ID: operation,
        PROJECT_UPDATE_INSTANCE_ID: nativeId,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(invocation.stdout).text();
    return { code: await invocation.exited, report: JSON.parse(output) };
  }
  try {
    const deadline = Date.now() + 5000;
    let report;
    for (;;) {
      try {
        report = readLifecycle((await client.runtimeLifecycle({ action: LifecycleAction.INVENTORY })).report);
        break;
      } catch {
        if (Date.now() >= deadline) throw new Error("Disposable native coordinator did not start");
        await Bun.sleep(20);
      }
    }
    const target = report.targets[0];
    expect(target.ready).toBe(true);
    expect(target.running_identity).toMatch(/^[0-9a-f]{64}$/u);
    expect(target.retirement_policy).toBe("successful-exit");
    expect((await cli("verify")).code).toBe(0);
    await client.setPaused({ paused: true });
    const submitted = await client.submitJob({
      requestId: randomUUID(),
      task: {
        kind: {
          case: "summarizePullRequest",
          value: { url: "https://github.com/example/example/pull/1" },
        },
      },
    });
    if (submitted.job === undefined) throw new Error("Fixture job not retained");
    expect((await cli("checkpoint", target.process.native_id)).code).toBe(3);
    const retained = await client.getJob({ id: submitted.job.id });
    expect(retained.job?.status).toBe(JobStatus.QUEUED);
    expect(retained.job?.attempts).toHaveLength(0);
    await client.cancelJob({ id: submitted.job.id });
    let checkpoint;
    const idleDeadline = Date.now() + 5000;
    for (;;) {
      checkpoint = await cli("checkpoint", target.process.native_id);
      if (checkpoint.code === 0) break;
      if (Date.now() >= idleDeadline) throw new Error("Disposable native owner could not checkpoint idle services");
      await Bun.sleep(20);
    }
    expect((await cli("checkpoint", target.process.native_id)).code).toBe(0);
    await assert.rejects(
      client.submitJob({
        requestId: randomUUID(),
        task: { kind: { case: "resolveConflict", value: {} } },
      }),
      /Coordinator is stopping/u,
    );
    expect((await cli("stop", target.process.native_id)).code).toBe(0);
    expect((await cli("restore", target.process.native_id)).code).toBe(3);
    expect(await child.exited).toBe(0);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await child.exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);
