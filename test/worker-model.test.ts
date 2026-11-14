import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkerRuntime } from "../src/auth.js";
import { workerModel } from "../src/worker-model.js";
import { fork, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { schedulerClient } from "../src/client.js";
import { JobStatus } from "../src/gen/octomanager/v1/scheduler_pb.js";

test("worker selectors retain existing models and identify the Bedrock provider", () => {
  assert.deepEqual(workerModel("gpt-6.1-terra"), {
    provider: "openai-codex",
    id: "gpt-6.1-terra",
  });
  assert.deepEqual(workerModel("openai-codex/gpt-6.1-terra"), {
    provider: "openai-codex",
    id: "gpt-6.1-terra",
  });
  assert.deepEqual(
    workerModel("amazon-bedrock/us.anthropic.claude-opus-4-6-v1"),
    { provider: "amazon-bedrock", id: "us.anthropic.claude-opus-4-6-v1" },
  );
  for (const invalid of [
    "",
    " gpt-6.1-terra",
    "amazon-bedrock/",
    "other/model",
  ]) {
    assert.throws(() => workerModel(invalid), /worker (model|provider)/u);
  }
});

test("serve uses the retained worker model and an explicit CLI model takes precedence", async () => {
  for (const override of [false, true]) {
    const directory = await mkdtemp(join(tmpdir(), "octo-bedrock-serve-"));
    const config = join(directory, "config.json");
    await writeFile(
      config,
      JSON.stringify({
        workerModel: "amazon-bedrock/model-that-does-not-exist",
      }),
    );
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
        "serve",
        "--state",
        directory,
        "--config",
        config,
        ...(override ? ["--model", "model-that-does-not-exist"] : []),
      ],
      {
        stdio: ["ignore", "pipe", "ignore"],
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: join(directory, "pi"),
          CODEX_HOME: join(directory, "absent-codex"),
          AWS_BEARER_TOKEN_BEDROCK: "synthetic-bedrock-token",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      },
    );
    try {
      await once(child.stdout, "data", { signal: AbortSignal.timeout(10000) });
      const client = schedulerClient(directory);
      const submitted = await client.submitJob({
        requestId: "model-selection",
        task: { kind: { case: "resolveConflict", value: {} } },
      });
      const job = submitted.job;
      if (job === undefined) throw new Error("No submitted job");
      const deadline = Date.now() + 10000;
      let result = (await client.getJob({ id: job.id })).job;
      if (result === undefined) throw new Error("No job result");
      while (result.status !== JobStatus.FAILED && Date.now() < deadline) {
        await Bun.sleep(20);
        result = (await client.getJob({ id: job.id })).job;
        if (result === undefined) throw new Error("No job result");
      }
      assert.equal(result.status, JobStatus.FAILED);
      assert.match(
        result.error ?? "",
        override
          ? /Authentication required/u
          : /Configured worker model is unavailable/u,
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, "exit");
        child.kill();
        await exit;
      }
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("the real worker selects Bedrock before looking up its model and does not require Codex", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-bedrock-worker-"));
  const messages: unknown[] = [];
  const child = fork(
    fileURLToPath(new URL("../src/worker.ts", import.meta.url)),
    [],
    {
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: directory,
        CODEX_HOME: join(directory, "absent-codex"),
        AWS_BEARER_TOKEN_BEDROCK: "synthetic-bedrock-token",
      },
    },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        child.kill();
        reject(new Error("Worker did not finish"));
      }, 10000);
      child.on("message", (message: unknown) => {
        messages.push(message);
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          (message.type === "done" || message.type === "failure") &&
          "attempt" in message &&
          message.attempt === 1
        )
          child.send({ type: "result_ack", attempt: 1 }, () => {});
      });
      child.once("error", (error) => {
        clearTimeout(deadline);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(deadline);
        if (code === 0) resolve();
        else reject(new Error(`Worker exited ${String(code)}`));
      });
      child.send({
        type: "start",
        attempt: 1,
        task: { kind: "resolve_conflict" },
        model: "amazon-bedrock/model-that-does-not-exist",
      });
    });
    assert(
      messages.some(
        (value) =>
          value !== null &&
          typeof value === "object" &&
          "text" in value &&
          value.text === "Using existing AWS Bedrock authentication",
      ),
    );
    assert(
      messages.some(
        (value) =>
          value !== null &&
          typeof value === "object" &&
          "error" in value &&
          value.error ===
            "Configured worker model is unavailable; select a supported provider-qualified model with --model",
      ),
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    if (child.exitCode === null) child.kill();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Bedrock uses the SDK runtime without requiring or writing ChatGPT credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-bedrock-auth-"));
  const previous = process.env["AWS_BEARER_TOKEN_BEDROCK"];
  process.env["AWS_BEARER_TOKEN_BEDROCK"] = "synthetic-bedrock-token";
  try {
    const { runtime, source } = await createWorkerRuntime({
      provider: "amazon-bedrock",
      piAgentDir: directory,
      codexHome: join(directory, "absent-codex"),
    });
    assert.equal(source, "aws");
    assert.equal(runtime.hasConfiguredAuth("amazon-bedrock"), true);
    assert.notEqual(
      runtime.getModel("amazon-bedrock", "us.anthropic.claude-opus-4-6-v1"),
      undefined,
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    if (previous === undefined) delete process.env["AWS_BEARER_TOKEN_BEDROCK"];
    else process.env["AWS_BEARER_TOKEN_BEDROCK"] = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing Bedrock configuration fails without creating credentials or falling back to ChatGPT", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-bedrock-missing-"));
  const names = [
    "AWS_PROFILE",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
  ];
  const previous = new Map<string, string | undefined>(
    names.map((name) => [name, process.env[name]]),
  );
  for (const name of names) Reflect.deleteProperty(process.env, name);
  try {
    await assert.rejects(
      createWorkerRuntime({
        provider: "amazon-bedrock",
        piAgentDir: directory,
        codexHome: join(directory, "absent-codex"),
      }),
      /Amazon Bedrock authentication is unavailable/u,
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
