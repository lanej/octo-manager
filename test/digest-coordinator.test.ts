import { record as objectRecord } from "../src/api/codec.js";
import { cliJSON } from "../src/client.js";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { messageReceiptId } from "../src/notifications/render.js";
import { shortId } from "../src/tracking/identifiers.js";
import { test, expect, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { WorkScheduler } from "../src/scheduling/work.js";
import { createApplicationFixture } from "./support/application.js";
import { codexHook } from "../src/integrations/codex.js";
import { schedulerClient } from "../src/client.js";
import { defaultTrackingConfig } from "../src/tracking/config.js";
import { SubmissionState } from "../src/submissions/contracts.js";
import type { QueuedMessage, QueueConnection } from "../src/agents/codex.js";
import { ActionState, type ObservationInput } from "../src/tracking/types.js";
import { feedbackRevision } from "../src/tracking/feedback.js";
import { Messages } from "../src/notifications/messages.js";

async function waitForQueue(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("Queue did not reconcile after the state change");
}

for (const callback of ["presentation", "ownerFeedbackCovered"] as const) {
  test(`custom ${callback} state changes are observed without a database write`, async () => {
    const directory = await mkdtemp("/tmp/octo-custom-digest-input-");
    const config = defaultTrackingConfig();
    config.endpoints["local"] = { delivery: "queue", socket: "/synthetic" };
    let blocked = true;
    const slots: QueuedMessage[] = [];
    const queue: QueueConnection = {
      prepare: () => Promise.resolve({ busy: false }),
      queued: () => Promise.resolve(slots),
      enqueueQueued: (_agent, clientId, body) => {
        const item = { queueId: clientId, clientId, body };
        slots.push(item);
        return Promise.resolve(item);
      },
      cancelQueued: () => Promise.resolve(true),
      received: () => Promise.resolve({ bodies: [], complete: true }),
      close() {},
    };
    const callbacks =
      callback === "presentation"
        ? { presentation: () => ({ defer: blocked }) }
        : { ownerFeedbackCovered: () => blocked };
    const coordinator = await createApplicationFixture(directory, {
      trackingConfig: config,
      now: () => 1000,
      digestOptions: { connect: () => queue, ...callbacks },
    });
    try {
      const pr = coordinator.tracking.track("https://github.com/owner/repo/pull/1", {
        harness: "codex",
        endpoint: "local",
        sessionId: "custom-input",
      });
      coordinator.store.tracking.observe(
        pr.id,
        {
          observedAt: 1000,
          headSha: "a".repeat(40),
          baseSha: "b".repeat(40),
          lifecycle: "open",
          mergeability: "conflicting",
          checks: { state: "complete", value: [] },
          reviews: { state: "complete", value: [] },
        },
        config,
      );
      const delivery = coordinator.store.tracking.deliveries()[0];
      if (delivery === undefined) throw new Error("Missing delivery");
      const action = coordinator.store.tracking.action(delivery.actionId);
      const notice = coordinator.store.tracking.noticeForAction(action, pr.ownerAgentId);
      const inbox = coordinator.store.tracking.inbox;
      inbox.freezeNotice(delivery.id, notice);
      inbox.record(delivery.id, inbox.render(delivery.id, notice));
      await coordinator.digests.flush();
      expect(slots).toHaveLength(0);
      const revision = coordinator.store.inputRevision();
      blocked = false;
      expect(coordinator.store.inputRevision()).toBe(revision);
      await coordinator.digests.flush();
      expect(slots).toHaveLength(1);
    } finally {
      await coordinator.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("owner readiness wakes queue cleanup and old receipts flag stale items", async () => {
  const directory = await mkdtemp("/tmp/oc-stale-"),
    config = defaultTrackingConfig();
  config.endpoints["local"] = { delivery: "queue", socket: "/synthetic" };
  const slots = new Map<string, QueuedMessage>();
  let serial = 0;
  const queue: QueueConnection = {
    prepare: () => Promise.resolve({ busy: true }),
    queued: (agent) => Promise.resolve([...slots].flatMap(([id, item]) => (id === agent.id ? [item] : []))),
    enqueueQueued: (agent, clientId, body) => {
      const item = { queueId: `q-${String(++serial)}`, clientId, body };
      slots.set(agent.id, item);
      return Promise.resolve(item);
    },
    cancelQueued: (agent, id) => Promise.resolve(slots.get(agent.id)?.queueId === id && slots.delete(agent.id)),
    received: () => Promise.resolve({ bodies: [], complete: true }),
    close: () => {},
  };
  const coordinator = await createApplicationFixture(directory, {
    trackingConfig: config,
    digestOptions: {
      connect: () => queue,
      intervalMs: 60_000,
      presentation: () => ({ instructions: "Inspect the current finding." }),
    },
  });
  const { store, digests } = coordinator;
  const scheduler = new WorkScheduler();
  const url = "https://github.com/owner/repo/pull/1";
  const head = "a".repeat(40);
  const check = {
    id: "check-1",
    key: "test",
    name: "Tests",
    headSha: head,
    status: "completed",
    conclusion: "failure",
    at: 1,
    url,
  };
  const feedback = feedbackRevision({
    source: "inline",
    id: "review-comment",
    author: "reviewer",
    body: "Please handle the missing input case.",
    url: `${url}#discussion_r1`,
    headSha: head,
    reviewId: "review",
  });
  const input: ObservationInput = {
    observedAt: 1,
    headSha: head,
    baseSha: "b".repeat(40),
    targetBase: { ref: "main", sha: "b".repeat(40) },
    lifecycle: "open",
    mergeability: "mergeable",
    checks: { state: "complete", value: [check] },
    reviews: { state: "complete", value: [] },
    feedback: { state: "complete", value: [feedback] },
  };
  const owner = { harness: "codex", endpoint: "local", sessionId: "owner" };
  const observer = { ...owner, sessionId: "observer" };
  function freezePendingNotices() {
    const tracking = store.tracking;
    for (const delivery of tracking.deliveries()) {
      if (tracking.inbox.get(delivery.id) !== undefined) continue;
      const action = tracking.action(delivery.actionId);
      if (action.blocker.kind !== "check_failed" && action.blocker.kind !== "review_feedback") continue;
      const notice = tracking.noticeForAction(action, delivery.recipientAgentId);
      tracking.inbox.freezeNotice(delivery.id, notice);
      tracking.inbox.record(delivery.id, tracking.inbox.render(delivery.id, notice));
    }
  }
  try {
    const pr = store.tracking.track(url, owner);
    const watcher = coordinator.tracking.registerAgent(observer);
    store.tracking.subscribe(pr.id, observer);
    for (const agentId of [pr.ownerAgentId, watcher.id])
      for (const message of store.tracking.inbox.list(agentId).messages)
        store.tracking.acknowledgeMessage(message.id, agentId);
    store.tracking.observe(pr.id, input, config);
    freezePendingNotices();
    digests.start(scheduler);
    scheduler.start();
    await digests.flush();
    const original = slots.get(pr.ownerAgentId);
    if (original === undefined) throw new Error("Missing initial owner digest");
    expect(original.body).toContain("Checks failed");
    expect(original.body).toContain("Review feedback");
    const watcherDigest = slots.get(watcher.id);
    expect(watcherDigest?.body).toContain("Review feedback");

    store.merging.ready(pr.id, pr.ownerAgentId, head);
    await waitForQueue(() => {
      const item = slots.get(pr.ownerAgentId);
      return item !== undefined && item.clientId !== original.clientId;
    });
    expect(slots.get(pr.ownerAgentId)?.body).toContain("Checks failed");
    expect(slots.get(pr.ownerAgentId)?.body).not.toContain("Review feedback");
    expect(slots.get(watcher.id)).toEqual(watcherDigest);
    const messages = new Messages(store, digests, () => ({
      instructions: "Inspect the current finding.",
    }));
    const read = messages.get(original.clientId);
    expect(read.items).toHaveLength(2);
    const current = read.items.find((item) => item.applicable);
    expect(current?.summary).toBe("Checks failed");
    expect(read.items.find((item) => !item.applicable)?.summary).toBe("Stale · Review feedback");
    expect(store.tracking.actions().find((action) => action.blocker.kind === "review_feedback")?.progress.state).toBe(
      ActionState.Open,
    );

    store.tracking.observe(
      pr.id,
      {
        ...input,
        observedAt: 2,
        checks: {
          state: "complete",
          value: [{ ...check, at: 2, conclusion: "success" }],
        },
      },
      config,
    );
    await waitForQueue(() => !slots.has(pr.ownerAgentId));
    const historical = messages.read(original.clientId, pr.ownerAgentId);
    expect(historical.message.items.every((item) => !item.applicable)).toBe(true);
    expect(historical.message.items.every((item) => item.acknowledgedAtMs !== undefined)).toBe(true);
    expect(historical.instructions).toEqual([]);

    store.tracking.observe(
      pr.id,
      {
        ...input,
        observedAt: 3,
        feedback: {
          state: "complete",
          value: [
            feedbackRevision({
              ...feedback,
              body: "Please handle empty and missing inputs.",
            }),
          ],
        },
      },
      config,
    );
    const edited = store.tracking
      .actions()
      .find((action) => action.blocker.kind === "review_feedback" && action.progress.state === ActionState.Open);
    if (edited === undefined) throw new Error("Missing edited action");
    freezePendingNotices();
    await waitForQueue(() => slots.get(pr.ownerAgentId)?.body?.includes("Review feedback") === true);
    store.tracking.untrack(pr.id);
    await waitForQueue(() => !slots.has(pr.ownerAgentId) && !slots.has(watcher.id));
  } finally {
    scheduler.stop();
    await coordinator.close();
    await scheduler.close();
    await rm(directory, { recursive: true, force: true });
  }
});
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
  const coordinator = await createApplicationFixture(directory, {
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
    const pr = coordinator.store.tracking.track("https://github.com/owner/repo/pull/1", owner);
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
    coordinator.store.submissions.notify(submission, actor.id);
    await coordinator.start();
    for (let attempt = 0; attempt < 100; attempt++) {
      const current = coordinator.store.digests.active(actor.id);
      if (
        current !== undefined &&
        coordinator.store.digests.version(current.id, current.revision).messageIds.length === 2
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const digest = coordinator.store.digests.active(actor.id);
    if (digest === undefined) throw new Error("No shared digest");
    const version = coordinator.store.digests.version(digest.id, digest.revision);
    expect(version.messageIds).toHaveLength(2);
    expect(version.body).toContain(`\`octo-manager read ${shortId(version.dispatchId)}`);
    expect(version.body).not.toContain(actor.id);
    expect(slot?.body).toBe(version.body);
    expect(directCalls).toBe(0);
    const reconciliation = {
      historyComplete: false,
      oldRevision: 0,
      nextRevision: 2,
    };
    coordinator.store.digests.event(actor.id, digest.id, "queue_replaced", {
      ...reconciliation,
      futureEvidence: "retained in journal",
    });
    const client = schedulerClient(directory),
      record = await client.getAgentDigest({ id: digest.id, revision: 1 });
    expect(JSON.stringify(record.inspection, cliJSON)).toContain(digest.id);
    const inspection: unknown = JSON.parse(JSON.stringify(record.inspection, cliJSON));
    const events = objectRecord(inspection)["events"];
    if (!Array.isArray(events)) throw new Error("Missing digest events");
    const replacement: unknown = events.find((value: unknown) => objectRecord(value)["kind"] === "queue_replaced");
    expect(objectRecord(replacement)["detail"]).toEqual({
      ...reconciliation,
      omittedFields: ["futureEvidence"],
    });
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
      coordinator.store.digests.event(actor.id, digest.id, "synthetic_history", {
        detail: "historical event ".repeat(100),
      });
    const receipt = await client.acknowledgeAgentDigest({
      id: digest.id,
      revision: digest.revision,
      agentId: shortId(actor.id),
      expectedBody: version.body,
    });
    expect(receipt.messages).toHaveLength(2);
    expect(receipt.messages.find((message) => message.submissionId === submission.id)?.summary).toBe(
      "Submission update",
    );
    expect(Buffer.byteLength(JSON.stringify(receipt.receipt, cliJSON))).toBeLessThan(300);
    expect(JSON.stringify(receipt.receipt, cliJSON)).not.toContain("synthetic_history");
    expect(JSON.stringify(receipt.receipt, cliJSON)).not.toContain("messageIds");
    expect(JSON.stringify(receipt.receipt, cliJSON)).not.toContain("events");
    expect(receipt.messages.every((message) => message.acknowledgedAtMs !== undefined)).toBe(true);
    expect(coordinator.store.tracking.actions()[0]?.progress.state).toBe(ActionState.Open);
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
  const coordinator = await createApplicationFixture(directory, {
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
    const child = Bun.spawn([process.execPath, resolve("src/cli.ts"), "ack", id, "--state", directory], {
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
    });
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
        const version = coordinator.store.digests.version(value.id, value.revision);
        if (version.messageIds.length === count) return version;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Missing notification");
  }
  const actor = coordinator.tracking.registerAgent(owner);
  try {
    const first = coordinator.store.tracking.track("https://github.com/owner/repo/pull/1", owner);
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
    const second = coordinator.store.tracking.track("https://github.com/owner/repo/pull/2", owner);
    coordinator.store.tracking.observe(second.id, input, config);
    const replacement = await current(2);
    expect(messageReceiptId(replacement.body)).not.toBe(token);
    expect(replacement.body).not.toContain("\n- ");
    expect((await run(token, {})).code).not.toBe(0);
    expect((await run(token, { CODEX_THREAD_ID: "unknown-session" })).code).not.toBe(0);
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
    expect(coordinator.store.tracking.inbox.get(previous.messageIds[0] ?? "")?.acknowledgedAt).toBeDefined();
    const added = replacement.messageIds.find((id) => !previous.messageIds.includes(id));
    if (added === undefined) throw new Error("No newer member");
    expect(coordinator.store.tracking.inbox.get(added)?.acknowledgedAt).toBeUndefined();
    expect((await run(token, { OCTO_MANAGER_AGENT_ID: actor.id })).code).toBe(0);
    expect(coordinator.store.tracking.inbox.get(added)?.acknowledgedAt).toBeUndefined();
  } finally {
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("default discovery skips scheduler bookkeeping but still queues a fresh notification", async () => {
  const directory = await mkdtemp("/tmp/octo-default-revision-");
  const config = defaultTrackingConfig();
  config.endpoints["local"] = { delivery: "queue", socket: "/synthetic" };
  const slots: QueuedMessage[] = [];
  const queue: QueueConnection = {
    prepare: () => Promise.resolve({ busy: false }),
    queued: () => Promise.resolve(slots),
    enqueueQueued: (_agent, clientId, body) => {
      const item = { queueId: clientId, clientId, body };
      slots.push(item);
      return Promise.resolve(item);
    },
    cancelQueued: () => Promise.resolve(true),
    received: () => Promise.resolve({ bodies: [], complete: true }),
    close() {},
  };
  let now = 1000;
  const coordinator = await createApplicationFixture(directory, {
    now: () => now,
    trackingConfig: config,
    digestOptions: { connect: () => queue },
  });
  const reads = spyOn(coordinator.store.tracking.inbox, "list");
  const recovery = spyOn(coordinator.store.tracking, "prepareSafeRecovery");
  try {
    const owner = {
      harness: "codex" as const,
      endpoint: "local",
      sessionId: "default-revision",
    };
    const agent = coordinator.tracking.registerAgent(owner);
    coordinator.store.tracking.runtime(agent.id, "1.0.0");
    await coordinator.digests.flush();
    reads.mockClear();
    recovery.mockClear();
    now += 1;
    coordinator.store.tracking.runtime(agent.id, "1.0.0");
    coordinator.store.schedules.saveDispatch({
      ...coordinator.store.schedules.dispatch(),
      nextAtMs: 2000,
    });
    await coordinator.digests.flush();
    expect(reads).not.toHaveBeenCalled();
    expect(recovery).not.toHaveBeenCalled();
    now += 60001;
    await coordinator.digests.flush();
    expect(reads).not.toHaveBeenCalled();
    expect(recovery).not.toHaveBeenCalled();
    reads.mockClear();
    const request = coordinator.store.submissions.request({
      requestId: "new-notification",
      repository: "owner/repo",
      headRef: "feature",
      headSha: "a".repeat(40),
      baseRef: "main",
      purpose: "Fixture",
      validation: [],
      draft: false,
      owner,
    });
    coordinator.store.submissions.save({
      ...request,
      state: SubmissionState.NeedsInput,
      detail: "Owner input required",
      notificationRevision: 1,
    });
    coordinator.store.submissions.notify(request, agent.id);
    await coordinator.digests.flush();
    expect(reads).toHaveBeenCalled();
    expect(slots).toHaveLength(1);
    expect(recovery).toHaveBeenCalled();
  } finally {
    reads.mockRestore();
    recovery.mockRestore();
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});
