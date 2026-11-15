import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RebaseWorkspace } from "../src/repairs/git.js";
import { createConflictResolver } from "../src/repairs/resolver.js";
import { Type } from "typebox";
import { createStageRunner } from "../src/submissions/worker.js";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

for (const type of ["done", "failure"])
  test(`worker ${type} waits for the matching receipt before exiting`, async () => {
    const child = fork(
      fileURLToPath(new URL("./result-worker.mjs", import.meta.url)),
      [],
      {
        execArgv: [],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    try {
      const received = once(child, "message");
      const payload = "x".repeat(64000);
      child.send({
        attempt: 7,
        result:
          type === "done" ? { type, text: payload } : { type, error: payload },
      });
      const message: unknown = (await received)[0];
      assert.deepEqual(message, {
        ...(type === "done"
          ? { type, text: payload }
          : { type, error: payload }),
        attempt: 7,
      });
      child.send({ type: "result_ack", attempt: 8 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(child.exitCode, null);
      assert.equal(child.signalCode, null);
      const exited = once(child, "exit");
      child.send({ type: "result_ack", attempt: 7 });
      assert.deepEqual(await exited, [0, null]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
    }
  });

test("worker exits with failure when the coordinator disconnects before receipt", async () => {
  const child = fork(
    fileURLToPath(new URL("./result-worker.mjs", import.meta.url)),
    [],
    {
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  try {
    const received = once(child, "message");
    child.send({ attempt: 1, result: { type: "done", text: "result" } });
    await received;
    const exited = once(child, "exit");
    child.disconnect();
    assert.deepEqual(await exited, [1, null]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }
});

test("worker exits with failure when no receipt arrives", async () => {
  const child = fork(
    fileURLToPath(new URL("./result-worker.mjs", import.meta.url)),
    [],
    {
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const exited = once(child, "exit");
    child.send({ attempt: 1, result: { type: "done", text: "result" } });
    const result = await Promise.race([
      exited,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => {
          reject(new Error("Worker did not expire its receipt wait"));
        }, 7000);
      }),
    ]);
    assert.deepEqual(result, [1, null]);
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }
});

test("stage coordinator acknowledges a complete result before worker exit", async () => {
  const runner = createStageRunner(
    fileURLToPath(new URL("./result-worker.mjs", import.meta.url)),
  );
  const active: boolean[] = [];
  const value = "x".repeat(64000);
  const result = await runner(
    "writer",
    { result: { type: "done", text: JSON.stringify({ value }) } },
    Type.Object({ value: Type.String() }),
    "controlled worker",
    "controlled",
    new AbortController().signal,
    (_pid, running) => active.push(running),
  );
  assert.deepEqual(result.result, { value });
  assert.deepEqual(active, [true, false]);
});

test("stage coordinator cancellation rejects and releases its worker", async () => {
  const runner = createStageRunner(
    fileURLToPath(new URL("./result-worker.mjs", import.meta.url)),
  );
  const controller = new AbortController();
  const active: boolean[] = [];
  await assert.rejects(
    runner(
      "writer",
      { result: { type: "done", text: "{}" } },
      Type.Object({}),
      "controlled worker",
      "controlled",
      controller.signal,
      (_pid, running) => {
        active.push(running);
        if (running) controller.abort();
      },
    ),
    /interrupted/,
  );
  assert.deepEqual(active, [true, false]);
});

test("repair coordinator acknowledges completion before worker exit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-receipt-"));
  const signal = new AbortController().signal;
  const workspace = new RebaseWorkspace(
    directory,
    {
      repository: "owner/repo",
      headRef: "feature",
      headSha: "a".repeat(40),
      targetRef: "main",
      targetSha: "b".repeat(40),
    },
    signal,
  );
  const resolver = createConflictResolver(
    fileURLToPath(new URL("./result-worker.mjs", import.meta.url)),
  );
  try {
    await resolver(
      workspace,
      [],
      {
        repository: "owner/repo",
        harness: "pi",
        model: "controlled",
        instructions: "controlled worker",
        checks: [],
        githubChecks: [],
        timeoutMs: 10000,
      },
      signal,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
