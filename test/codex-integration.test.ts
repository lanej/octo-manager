import { shortId } from "../src/tracking/identifiers.js";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Code, ConnectError } from "@connectrpc/connect";
import { test, spyOn } from "bun:test";
import * as filesystem from "node:fs/promises";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  stat,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Coordinator } from "../src/coordinator.js";
import { Handoffs } from "../src/integrations/handoffs.js";
import {
  codexHooks,
  desktopConfig,
  launchAgent,
} from "../src/install/config.js";
import {
  ActionState,
  DeliveryState,
  type ObservationInput,
} from "../src/tracking/types.js";

const url = "https://github.com/owner/repo/pull/1";
const input: ObservationInput = {
  observedAt: 1000,
  headSha: "head",
  baseSha: "base",
  lifecycle: "open",
  mergeability: "conflicting",
  checks: { state: "complete", value: [] },
  workflows: { state: "complete", value: [] },
  reviews: { state: "complete", value: [] },
};
function artifact(sessionId = "owner", address = url) {
  return {
    session_id: sessionId,
    cwd: "/work/feature",
    hook_event_name: "PostToolUse",
    tool_name: "mcp__codex_app__attach_artifact",
    tool_input: { artifact_type: "pull_request", url: address },
    tool_response: {
      content: [
        {
          type: "text",
          text: JSON.stringify({ artifact_type: "pull_request", url: address }),
        },
      ],
    },
  };
}
async function hookProcess(
  directory: string,
  input: string,
): Promise<{ output: string; error: string }> {
  const child = Bun.spawn(
    [process.execPath, "src/cli.ts", "codex-hook", "--state", directory],
    { cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  await child.stdin.write(input);
  await child.stdin.end();
  const output = await new Response(child.stdout).text();
  const error = await new Response(child.stderr).text();
  assert.equal(await child.exited, 0, error);
  return { output, error };
}
async function hook(directory: string, event: object): Promise<string> {
  return (await hookProcess(directory, JSON.stringify(event))).output;
}
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Native integration handoff did not finish");
}

test("hook failures append private diagnostics with the underlying connection error without logging payloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-hook-errors-"));
  try {
    const event = {
      session_id: "owner",
      cwd: "/work/feature",
      hook_event_name: "UserPromptSubmit",
      prompt: "private prompt must not appear in diagnostics",
      tool_response: "private tool output must not appear in diagnostics",
    };
    const first = await hookProcess(directory, JSON.stringify(event));
    assert(first.output.includes("could not complete this hook"));
    const path = join(directory, "codex-hook-errors.jsonl");
    const log = await readFile(path, "utf8");
    assert.equal(first.error, log);
    assert(log.includes('"event":"UserPromptSubmit"'));
    assert(log.includes('"sessionId":"owner"'));
    assert(log.includes('"phase":"recovery"'));
    assert(log.includes('"name":"ConnectError"'));
    assert(log.includes('"message":'));
    assert(log.includes('"stack":'));
    assert(log.includes('"code":'));
    assert(log.includes(`connect ENOENT ${join(directory, "run.sock")}`));
    assert(log.includes('"code":"ENOENT"'));
    assert(log.includes('"cause":'));
    assert(!log.includes(event.prompt));
    assert(!log.includes(event.tool_response));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const second = await hookProcess(directory, JSON.stringify(event));
    assert.equal(await readFile(path, "utf8"), log + second.error);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("malformed hook input logs a parse failure without copying parser input excerpts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-hook-parse-"));
  try {
    const result = await hookProcess(directory, '{"prompt":"secret-input');
    assert(result.output.includes("could not complete this hook"));
    const log = await readFile(
      join(directory, "codex-hook-errors.jsonl"),
      "utf8",
    );
    assert(log.includes('"phase":"input"'));
    assert(log.includes('"name":"SyntaxError"'));
    assert(log.includes("Invalid JSON in Codex hook input"));
    assert(!log.includes("secret-input"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a closed stderr pipe preserves both the diagnostic file and advisory stdout response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-hook-stderr-"));
  try {
    const child = spawn(
      process.execPath,
      ["src/cli.ts", "codex-hook", "--state", directory],
      { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stderr.destroy();
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    const exit = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    child.stdin.end("{bad");
    assert.equal(await exit, 0);
    assert(output.includes("could not complete this hook"));
    const log = await readFile(
      join(directory, "codex-hook-errors.jsonl"),
      "utf8",
    );
    assert(log.includes("Invalid JSON in Codex hook input"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("hook logging refuses symlinks and retains the original failure on stderr when the log is unavailable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-hook-log-link-"));
  try {
    const target = join(directory, "retained");
    await writeFile(target, "Retained data", { mode: 0o600 });
    await symlink(target, join(directory, "codex-hook-errors.jsonl"));
    const result = await hookProcess(
      directory,
      JSON.stringify({
        session_id: "owner",
        cwd: "invalid-relative-path",
        hook_event_name: "SessionStart",
      }),
    );
    assert(result.output.includes("could not complete this hook"));
    assert(result.error.includes("Invalid Codex hook session context"));
    assert(result.error.includes('"loggingError":'));
    assert.equal(await readFile(target, "utf8"), "Retained data");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native PR attachment survives offline intake, preserves ownership and recovers exact unread notices with independent receipts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-native-"));
  const handoffs = new Handoffs(directory);
  let coordinator: Coordinator | undefined;
  try {
    assert((await hook(directory, artifact())).includes("handoff queued"));
    await hook(directory, artifact());
    assert.equal((await handoffs.status("owner")).pending.length, 1);
    const failed = artifact("failed", "https://github.com/owner/repo/pull/99");
    await hook(directory, {
      ...failed,
      tool_response: { ...failed.tool_response, isError: true },
    });
    assert.equal((await handoffs.status("failed")).pending.length, 0);
    coordinator = new Coordinator(directory, {
      trackingOptions: {
        read: () => Promise.resolve(input),
        connect: () => ({
          prepare: () => Promise.resolve({ busy: true }),
          send: () => Promise.resolve({}),
          find: () => Promise.resolve({ found: false }),
          close: () => {},
        }),
      },
    });
    await coordinator.start();
    const store = coordinator.store.tracking;
    await until(() => store.prs().length === 1);
    const pr = store.prs()[0];
    assert(pr !== undefined);
    await until(() => store.inbox.list(pr.ownerAgentId).messages.length === 1);
    const notice = store.inbox.list(pr.ownerAgentId).messages[0];
    assert(notice !== undefined);
    assert.equal((await handoffs.status("owner")).pending.length, 0);
    const receiptFailure = spyOn(
      store.inbox,
      "acknowledge",
    ).mockImplementationOnce(() => {
      throw new ConnectError("Receipt storage failed", Code.Internal);
    });
    try {
      const failedRecovery = await hookProcess(
        directory,
        JSON.stringify({
          session_id: "owner",
          cwd: "/work/feature",
          hook_event_name: "SessionStart",
          source: "resume",
        }),
      );
      assert(failedRecovery.output.includes(shortId(notice.id)));
      assert(!failedRecovery.output.includes("systemMessage"));
      assert(failedRecovery.error.includes("Receipt storage failed"));
      assert(failedRecovery.error.includes('"phase":"receipt"'));
      const log = await readFile(
        join(directory, "codex-hook-errors.jsonl"),
        "utf8",
      );
      assert(log.includes("Receipt storage failed"));
      assert(!log.includes(notice.body));
      assert.equal(store.inbox.get(notice.id)?.acknowledgedAt, undefined);
    } finally {
      receiptFailure.mockRestore();
    }
    const recovery = await hook(directory, {
      session_id: "owner",
      cwd: "/work/feature",
      hook_event_name: "SessionStart",
      source: "resume",
    });
    assert(recovery.includes(shortId(notice.id)));
    assert(store.inbox.get(notice.id)?.acknowledgedAt !== undefined);
    assert.equal(
      store.action(notice.actionId).progress.state,
      ActionState.Open,
    );
    await hook(directory, artifact("other"));
    await until(() => store.prs().length === 1);
    for (
      let i = 0;
      i < 200 && (await handoffs.status("other")).failed.length === 0;
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await handoffs.status("other")).failed.length, 1);
    assert.equal(store.pr(pr.id).ownerAgentId, pr.ownerAgentId);
    assert(
      (
        await hook(directory, {
          session_id: "other",
          cwd: "/work/review",
          hook_event_name: "UserPromptSubmit",
          prompt: "continue",
        })
      ).includes("another agent"),
    );
    coordinator.tracking.assign(pr.id, {
      harness: "codex",
      endpoint: "local",
      sessionId: "other",
    });
    await hook(directory, artifact("other"));
    for (
      let i = 0;
      i < 300 && (await handoffs.status("other")).failed.length !== 0;
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await handoffs.status("other")).failed.length, 0);
    const second = store.track("https://github.com/owner/repo/pull/2", {
      harness: "codex",
      endpoint: "local",
      sessionId: "owner",
    });
    store.observe(second.id, input, coordinator.tracking.config);
    await until(() => store.inbox.list(pr.ownerAgentId).messages.length === 1);
    const incoming = store.inbox.list(pr.ownerAgentId).messages[0];
    assert(incoming !== undefined);
    const altered = await hook(directory, {
      session_id: "owner",
      cwd: "/work/feature",
      hook_event_name: "UserPromptSubmit",
      prompt: incoming.body + " changed",
    });
    assert(altered.includes("systemMessage"));
    assert.equal(store.inbox.get(incoming.id)?.acknowledgedAt, undefined);
    const received = await hook(directory, {
      session_id: "owner",
      cwd: "/work/feature",
      hook_event_name: "UserPromptSubmit",
      prompt: incoming.body,
    });
    assert.equal(received, "");
    assert(store.inbox.get(incoming.id)?.acknowledgedAt !== undefined);
    assert.equal(
      store.action(incoming.actionId).progress.state,
      ActionState.Open,
    );
  } finally {
    await coordinator?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("hook installation appends idempotently without rewriting custom hooks and service paths leave the source checkout", async () => {
  const custom = {
    description: "User settings",
    hooks: {
      SessionStart: [
        {
          matcher: "resume",
          hooks: [{ type: "command", command: "custom", timeout: 3 }],
        },
      ],
      PostToolUse: [
        {
          hooks: [
            {
              type: "command",
              command: "disabled-user-command",
              enabled: false,
            },
          ],
        },
      ],
      Stop: [{ hooks: [{ type: "command", command: "user-stop" }] }],
    },
  };
  const merged = codexHooks(
    custom,
    "/home/person with space/.local/bin/octo-manager",
    "/home/person/.local/state/octo-manager",
  );
  assert.deepEqual(
    codexHooks(
      merged,
      "/home/person with space/.local/bin/octo-manager",
      "/home/person/.local/state/octo-manager",
    ),
    merged,
  );
  assert.equal(custom.hooks.SessionStart.length, 1);
  const serialized = JSON.stringify(merged);
  assert(serialized.includes("disabled-user-command"));
  assert(serialized.includes('"enabled":false'));
  assert(serialized.includes("user-stop"));
  assert.deepEqual(
    desktopConfig({
      profiles: { keep: { model: "custom" } },
      endpoints: { local: { delivery: "turn", socket: "/custom/socket" } },
    }),
    {
      profiles: { keep: { model: "custom" } },
      endpoints: { local: { delivery: "turn", socket: "/custom/socket" } },
    },
  );
  const directory = await mkdtemp(join(tmpdir(), "octo-service-"));
  try {
    const file = join(directory, "service.plist");
    await writeFile(
      file,
      launchAgent(
        "/Users/person",
        "/private/bun",
        "/private/release",
        "/private/state",
        "/usr/bin:/bin",
      ),
    );
    const source = await readFile(file, "utf8");
    assert(source.includes("/private/release/dist/cli.js"));
    assert(source.includes("KeepAlive"));
    assert(!source.includes("/src/octo-manager"));
    const process = Bun.spawn(
      [
        "python3",
        "-c",
        "import plistlib,sys; d=plistlib.load(open(sys.argv[1],'rb')); assert d['RunAtLoad'] and d['KeepAlive']; assert d['ProgramArguments']==['/private/bun','/private/release/dist/cli.js','serve']; assert d['EnvironmentVariables']['PATH']=='/usr/bin:/bin'",
        file,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    assert.equal(
      await process.exited,
      0,
      await new Response(process.stderr).text(),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("automatic recovery skips a full historical page before selecting current unread notifications", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-native-history-"));
  const coordinator = new Coordinator(directory, {
    trackingOptions: {
      read: () => Promise.resolve(input),
      connect: () => ({
        prepare: () => Promise.resolve({ busy: true }),
        send: () => Promise.resolve({}),
        find: () => Promise.resolve({ found: false }),
        close: () => {},
      }),
    },
  });
  try {
    const store = coordinator.store.tracking;
    const pr = store.track(url, {
      harness: "codex",
      endpoint: "local",
      sessionId: "owner",
    });
    store.observe(pr.id, input, coordinator.tracking.config);
    const current = store.deliveries()[0];
    assert(current !== undefined);
    for (let i = 0; i < 200; i++) {
      const historical = {
        ...current,
        id: randomUUID(),
        progress: {
          state: DeliveryState.Cancelled,
          at: 1000,
          reason: "Historical superseded notice",
        } as const,
      };
      store.saveDelivery(historical, "delivery_cancelled");
      store.inbox.record(historical.id, "Historical notification");
    }
    store.inbox.record(
      current.id,
      "Current notification after a full historical page",
    );
    await coordinator.start();
    const output = await hook(directory, {
      session_id: "owner",
      cwd: "/work/feature",
      hook_event_name: "SessionStart",
      source: "resume",
    });
    assert(
      output.includes("Current notification after a full historical page"),
    );
    assert(store.inbox.get(current.id)?.acknowledgedAt !== undefined);
    assert.equal(store.inbox.list(pr.ownerAgentId).messages.length, 200);
    assert.equal(
      store.inbox.list(pr.ownerAgentId, 0, false, true).messages.length,
      0,
    );
  } finally {
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("handoff status tolerates files removed after listing but preserves read and parse failures", async () => {
  for (const folder of ["pending", "failed"] as const) {
    const directory = await mkdtemp(join(tmpdir(), "octo-status-"));
    try {
      const handoffs = new Handoffs(directory);
      const request = await handoffs.enqueue(
        url,
        {
          harness: "codex",
          endpoint: "local",
          sessionId: "owner",
        },
        "/work/feature",
      );
      if (folder === "failed")
        await handoffs.drain(() => ({
          accepted: false,
          reason: "Different owner",
        }));
      const missing = spyOn(filesystem, "readFile").mockRejectedValueOnce(
        Object.assign(new Error("Removed after listing"), { code: "ENOENT" }),
      );
      try {
        assert.deepEqual(await handoffs.status("owner"), {
          pending: [],
          failed: [],
        });
      } finally {
        missing.mockRestore();
      }
      assert.equal((await handoffs.status("owner"))[folder].length, 1);
      const denied = spyOn(filesystem, "readFile").mockRejectedValueOnce(
        Object.assign(new Error("Access denied"), { code: "EACCES" }),
      );
      try {
        await assert.rejects(handoffs.status("owner"), { code: "EACCES" });
      } finally {
        denied.mockRestore();
      }
      await writeFile(
        join(directory, "handoffs", folder, `${request.id}.json`),
        "invalid JSON",
      );
      await assert.rejects(handoffs.status("owner"), SyntaxError);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("failed handoff publication never exposes a partially written status file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "om-atomic-handoff-"));
  const handoffs = new Handoffs(directory);
  const request = await handoffs.enqueue(
    "https://github.com/owner/repo/pull/1",
    { harness: "codex", endpoint: "local", sessionId: "atomic" },
    directory,
  );
  const partial = Promise.withResolvers<undefined>(),
    resume = Promise.withResolvers<undefined>();
  const original = filesystem.writeFile;
  let capture = true;
  const write = spyOn(filesystem, "writeFile").mockImplementation(
    async (path, data, options) => {
      if (capture && typeof path === "string" && path.startsWith(directory)) {
        capture = false;
        await original(path, "{", options);
        partial.resolve(undefined);
        await resume.promise;
        await original(path, data, { mode: 0o600, flag: "w" });
        return;
      }
      await original(path, data, options);
    },
  );
  const draining = handoffs.drain(() => ({
    accepted: false,
    reason: "Conflicting owner",
  }));
  try {
    await partial.promise;
    const during = await handoffs.status("atomic");
    assert.equal(during.failed.length, 0);
    assert.equal(during.pending[0]?.id, request.id);
    resume.resolve(undefined);
    await draining;
    const after = await handoffs.status("atomic");
    assert.equal(after.pending.length, 0);
    assert.equal(after.failed[0]?.reason, "Conflicting owner");
  } finally {
    resume.resolve(undefined);
    await draining.catch(() => {});
    write.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});
