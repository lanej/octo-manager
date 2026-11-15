import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { messageReceiptId } from "../src/notifications/render.js";
import { shortId } from "../src/tracking/identifiers.js";
import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Coordinator } from "../src/coordinator.js";
import { codexHook } from "../src/integrations/codex.js";
import { schedulerClient } from "../src/client.js";
import { defaultTrackingConfig } from "../src/tracking/config.js";
import { SubmissionState } from "../src/submissions/contracts.js";
import type { QueuedMessage, QueueConnection } from "../src/agents/codex.js";
import { ActionState, type ObservationInput } from "../src/tracking/types.js";
test("coordinator combines both producers and atomically receipts exact members through RPC", async () => {
  const directory = await mkdtemp("/tmp/oc-dig-"),
    config = defaultTrackingConfig();
  config.endpoints["local"] = { delivery: "queue", socket: "/synthetic" };
  let slot: QueuedMessage | undefined,
    serial = 0,
    directCalls = 0;
  const queue: QueueConnection = {
    prepare: () => Promise.resolve({ busy: true }),
    queued: () => Promise.resolve(slot === undefined ? [] : [slot]),
    enqueueQueued: (_agent, clientId, body) => {
      slot = { queueId: `q-${String(++serial)}`, clientId, body };
      return Promise.resolve(slot);
    },
    cancelQueued: () => {
      slot = undefined;
      return Promise.resolve(true);
    },
    received: () => Promise.resolve({ bodies: [], complete: true }),
    close: () => {},
  };
  const input: ObservationInput = {
    observedAt: 1000,
    headSha: "head",
    baseSha: "base",
    lifecycle: "open",
    mergeability: "conflicting",
    checks: { state: "complete", value: [] },
    reviews: { state: "complete", value: [] },
  };
  const coordinator = new Coordinator(directory, {
    trackingConfig: config,
    trackingOptions: {
      read: () => Promise.resolve(input),
      connect: () => {
        directCalls++;
        throw new Error("Legacy producer must delegate");
      },
    },
    digestOptions: { connect: () => queue, intervalMs: 10 },
  });
  try {
    const owner = {
        harness: "codex",
        endpoint: "local",
        sessionId: "synthetic-agent",
      },
      actor = coordinator.tracking.registerAgent(owner);
    const pr = coordinator.store.tracking.track(
      "https://github.com/owner/repo/pull/1",
      owner,
    );
    coordinator.store.tracking.observe(pr.id, input, config);
    const submission = coordinator.store.submissions.request({
      requestId: "controlled",
      repository: "owner/repo",
      headRef: "branch",
      headSha: "a".repeat(40),
      baseRef: "main",
      purpose: "Synthetic",
      validation: [],
      draft: false,
      owner: { ...owner, harness: "codex" },
    });
    coordinator.store.submissions.save({
      ...submission,
      state: SubmissionState.NeedsInput,
      notificationRevision: 1,
    });
    coordinator.store.submissions.notify(
      submission,
      actor.id,
      "[octo-delivery:11111111]\nPR submission needs_input: Synthetic request",
    );
    await coordinator.start();
    for (let attempt = 0; attempt < 100; attempt++) {
      const current = coordinator.store.digests.active(actor.id);
      if (
        current !== undefined &&
        coordinator.store.digests.version(current.id, current.revision)
          .messageIds.length === 2
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const digest = coordinator.store.digests.active(actor.id);
    if (digest === undefined) throw new Error("No shared digest");
    const version = coordinator.store.digests.version(
      digest.id,
      digest.revision,
    );
    expect(version.messageIds).toHaveLength(2);
    expect(version.body).toContain(
      `Ack: \`octo-manager ack ${shortId(version.dispatchId)}`,
    );
    expect(version.body).not.toContain(actor.id);
    expect(slot?.body).toBe(version.body);
    expect(directCalls).toBe(0);
    const client = schedulerClient(directory),
      record = await client.getAgentDigest({ id: digest.id, revision: 1 });
    expect(record.recordJson).toContain(digest.id);
    const altered = codexHook(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: owner.sessionId,
        cwd: "/fixture/project",
        prompt: version.body + " changed",
      },
      directory,
    );
    await altered.then(
      () => {
        throw new Error("Expected exact body rejection");
      },
      (error: unknown) => {
        expect(String(error)).toContain("match");
      },
    );
    const hookResult = await codexHook(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: owner.sessionId,
        cwd: "/fixture/project",
        prompt: version.body,
      },
      directory,
    );
    expect(hookResult.output).toBeUndefined();
    for (let index = 0; index < 200; index++)
      coordinator.store.digests.event(
        actor.id,
        digest.id,
        "synthetic_history",
        { detail: "historical event ".repeat(100) },
      );
    const receipt = await client.acknowledgeAgentDigest({
      id: digest.id,
      revision: digest.revision,
      agentId: shortId(actor.id),
      expectedBody: version.body,
    });
    expect(receipt.messages).toHaveLength(2);
    expect(
      receipt.messages.find((message) => message.submissionId === submission.id)
        ?.summary,
    ).toBe("PR submission needs_input: Synthetic request");
    expect(Buffer.byteLength(receipt.recordJson)).toBeLessThan(300);
    expect(receipt.recordJson).not.toContain("synthetic_history");
    expect(receipt.recordJson).not.toContain("messageIds");
    expect(receipt.recordJson).not.toContain("events");
    expect(
      receipt.messages.every(
        (message) => message.acknowledgedAtMs !== undefined,
      ),
    ).toBe(true);
    expect(coordinator.store.tracking.actions()[0]?.progress.state).toBe(
      ActionState.Open,
    );
    await coordinator.digests.flush();
    expect(slot).toBeUndefined();
  } finally {
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("opaque receipts infer the caller, hide revision machinery and never acknowledge unseen replacements", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-message-receipt-"));
  const config = defaultTrackingConfig();
  config.endpoints["local"] = { delivery: "queue", socket: "/fixture" };
  config.endpoints["other"] = { socket: "/fixture-other" };
  let slots: QueuedMessage[] = [];
  const queue: QueueConnection = {
    prepare: () => Promise.resolve({ busy: true }),
    queued: () => Promise.resolve(slots),
    enqueueQueued: (_agent, clientId, body) => {
      const item = { queueId: clientId, clientId, body };
      slots.push(item);
      return Promise.resolve(item);
    },
    cancelQueued: (_agent, id) => {
      slots = slots.filter((item) => item.queueId !== id);
      return Promise.resolve(true);
    },
    received: () => Promise.resolve({ bodies: [], complete: true }),
    close: () => {},
  };
  const input: ObservationInput = {
    observedAt: 1000,
    headSha: "head",
    baseSha: "base",
    lifecycle: "open",
    mergeability: "conflicting",
    checks: { state: "complete", value: [] },
    reviews: { state: "complete", value: [] },
  };
  const coordinator = new Coordinator(directory, {
    trackingConfig: config,
    trackingOptions: { read: () => Promise.resolve(input) },
    digestOptions: { connect: () => queue, intervalMs: 10 },
  });
  const owner = {
    harness: "codex",
    endpoint: "local",
    sessionId: "receipt-owner",
  };
  async function run(id: string, env: NodeJS.ProcessEnv) {
    const child = Bun.spawn(
      [
        process.execPath,
        resolve("src/cli.ts"),
        "ack",
        id,
        "--state",
        directory,
      ],
      {
        env: {
          ...process.env,
          CODEX_THREAD_ID: undefined,
          OCTO_MANAGER_AGENT_ID: undefined,
          OCTO_MANAGER_ENDPOINT: undefined,
          OCTO_MANAGER_AGENT: "1",
          ...env,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  }
  async function current(count: number) {
    for (let n = 0; n < 200; n++) {
      const value = coordinator.store.digests.active(actor.id);
      if (value !== undefined) {
        const version = coordinator.store.digests.version(
          value.id,
          value.revision,
        );
        if (version.messageIds.length === count) return version;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Missing notification");
  }
  const actor = coordinator.tracking.registerAgent(owner);
  try {
    const first = coordinator.store.tracking.track(
      "https://github.com/owner/repo/pull/1",
      owner,
    );
    coordinator.store.tracking.observe(first.id, input, config);
    await coordinator.start();
    const previous = await current(1);
    const token = messageReceiptId(previous.body);
    if (token === undefined) throw new Error("No receipt ID");
    expect(previous.body).not.toContain("octo-digest");
    expect(previous.body).not.toContain(" updates");
    expect(previous.body).not.toContain("\n- ");
    expect(previous.body).not.toContain("Action:");
    expect(previous.body).not.toContain("--agent-id");
    expect(previous.body).not.toContain("--revision");
    const second = coordinator.store.tracking.track(
      "https://github.com/owner/repo/pull/2",
      owner,
    );
    coordinator.store.tracking.observe(second.id, input, config);
    const replacement = await current(2);
    expect(messageReceiptId(replacement.body)).not.toBe(token);
    expect(replacement.body).not.toContain("\n- ");
    expect((await run(token, {})).code).not.toBe(0);
    expect(
      (await run(token, { CODEX_THREAD_ID: "unknown-session" })).code,
    ).not.toBe(0);
    expect(coordinator.store.tracking.agents()).toHaveLength(1);
    coordinator.tracking.registerAgent({ ...owner, endpoint: "other" });
    const ambiguous = await run(token, { CODEX_THREAD_ID: owner.sessionId });
    expect(ambiguous.code).not.toBe(0);
    expect(ambiguous.stderr).toContain("ambiguous");
    const received = await run(token, {
      CODEX_THREAD_ID: owner.sessionId,
      OCTO_MANAGER_ENDPOINT: "local",
    });
    expect(received.code).toBe(0);
    expect(received.stdout).not.toContain('"revision"');
    expect(received.stdout).not.toContain("digest");
    expect(
      coordinator.store.tracking.inbox.get(previous.messageIds[0] ?? "")
        ?.acknowledgedAt,
    ).toBeDefined();
    const added = replacement.messageIds.find(
      (id) => !previous.messageIds.includes(id),
    );
    if (added === undefined) throw new Error("No newer member");
    expect(
      coordinator.store.tracking.inbox.get(added)?.acknowledgedAt,
    ).toBeUndefined();
    expect((await run(token, { OCTO_MANAGER_AGENT_ID: actor.id })).code).toBe(
      0,
    );
    expect(
      coordinator.store.tracking.inbox.get(added)?.acknowledgedAt,
    ).toBeUndefined();
  } finally {
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});
