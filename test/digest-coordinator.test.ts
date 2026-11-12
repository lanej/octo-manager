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
      "PR submission needs_input: Synthetic request",
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
      `Receipt: \`octo-manager acknowledge-digest ${shortId(digest.id)} --revision ${String(digest.revision)} --agent-id ${shortId(actor.id)}`,
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
    const receipt = await client.acknowledgeAgentDigest({
      id: digest.id,
      revision: digest.revision,
      agentId: shortId(actor.id),
      expectedBody: version.body,
    });
    expect(receipt.messages).toHaveLength(2);
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
