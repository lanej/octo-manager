import { randomUUID } from "node:crypto";
import { test, spyOn } from "bun:test";
import * as filesystem from "node:fs/promises";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
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
async function hook(directory: string, event: object): Promise<string> {
  const child = Bun.spawn(
    [process.execPath, "src/cli.ts", "codex-hook", "--state", directory],
    { cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  await child.stdin.write(JSON.stringify(event));
  await child.stdin.end();
  const output = await new Response(child.stdout).text();
  const error = await new Response(child.stderr).text();
  assert.equal(await child.exited, 0, error);
  return output;
}
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Native integration handoff did not finish");
}

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
    const recovery = await hook(directory, {
      session_id: "owner",
      cwd: "/work/feature",
      hook_event_name: "SessionStart",
      source: "resume",
    });
    assert(recovery.includes(notice.id));
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
    assert(received.includes("exact incoming notification"));
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
