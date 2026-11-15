import { unwire } from "../src/api/codec.js";
import {
  DomainMergeReceiptResultSchema,
  DomainMergeReceiptResultState,
} from "../src/gen/octomanager/v2/domain_pb.js";
import { linkPRReferences } from "../src/notifications/links.js";
import { DeliveryState } from "../src/tracking/types.js";
import assert from "node:assert/strict";
import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Coordinator } from "../src/coordinator.js";
import { schedulerClient } from "../src/client.js";
import { codexHook } from "../src/integrations/codex.js";
import type { QueueConnection, QueuedMessage } from "../src/agents/codex.js";
import type { MergeProvider, MergeSnapshot } from "../src/merging/github.js";
import { EntryState } from "../src/merging/contracts.js";
import { references } from "../src/merging/policy.js";
import { defaultTrackingConfig } from "../src/tracking/config.js";
import { agentMessage } from "../src/tracking/messages.js";
import { renderDigest, messageReceiptId } from "../src/notifications/render.js";
const url = "https://github.com/owner/repo/pull/38";
const head = "a".repeat(40),
  base = "b".repeat(40);
const owner = {
  harness: "codex",
  endpoint: "local",
  sessionId: "receipt-merge-owner",
};
function snapshot(): MergeSnapshot {
  return {
    observation: {
      observedAt: 1000,
      headSha: head,
      baseSha: base,
      targetBase: { ref: "main", sha: base },
      lifecycle: "open",
      mergeability: "mergeable",
      checks: {
        state: "complete",
        value: [
          {
            id: "run:1",
            key: "ci",
            name: "CI",
            headSha: head,
            status: "completed",
            conclusion: "success",
            at: 1000,
            url,
          },
        ],
      },
      workflows: { state: "complete", value: [] },
      reviews: { state: "complete", value: [] },
      feedback: { state: "complete", value: [] },
    },
    draft: false,
    gate: "CLEAN",
    review: null,
    required: ["CI"],
    queueRequired: false,
    methods: ["squash"],
  };
}
async function fixture(initialReview: string | null = null) {
  const directory = await mkdtemp(join(tmpdir(), "octo-receipt-merge-"));
  const config = defaultTrackingConfig();
  config.endpoints["local"] = { delivery: "queue", socket: "/controlled" };
  let now = 1000,
    current = snapshot(),
    reads = 0,
    writes = 0,
    uncertain = false,
    readError: string | undefined;
  current.review = initialReview;
  let slots: QueuedMessage[] = [];
  const queue: QueueConnection = {
    prepare: () => Promise.resolve({ busy: true }),
    queued: () => Promise.resolve(slots),
    enqueueQueued: (_agent, clientId, body) => {
      const item = { clientId, queueId: clientId, body };
      slots.push(item);
      return Promise.resolve(item);
    },
    cancelQueued: (_agent, id) => {
      slots = slots.filter((s) => s.queueId !== id);
      return Promise.resolve(true);
    },
    received: () => Promise.resolve({ bodies: [], complete: true }),
    close() {},
  };
  const provider: MergeProvider = {
    inspect: () => {
      reads++;
      if (readError !== undefined) return Promise.reject(new Error(readError));
      return Promise.resolve(structuredClone(current));
    },
    merge: (_url, pinned, _method, _signal, beforeSend) => {
      beforeSend();
      expect(pinned).toBe(current.observation.headSha);
      writes++;
      if (uncertain)
        return Promise.reject(new Error("Response lost after send"));
      current.observation.lifecycle = "merged";
      current.mergeCommit = "c".repeat(40);
      return Promise.resolve(current.mergeCommit);
    },
  };
  const options = {
    now: () => now,
    trackingConfig: config,
    trackingOptions: {
      read: () => Promise.resolve(structuredClone(current.observation)),
    },
    mergeOptions: { provider },
    digestOptions: { connect: () => queue },
  };
  let coordinator = new Coordinator(directory, options);
  const pr = coordinator.store.tracking.track(url, owner);
  coordinator.store.tracking.observe(pr.id, current.observation, config);
  const action = coordinator.store.tracking
    .actions()
    .filter((action) => action.prId === pr.id)
    .find((a) => a.blocker.kind === "check_results");
  if (action === undefined) throw new Error("No completion action");
  const delivery = coordinator.store.tracking
    .deliveries()
    .find((d) => d.actionId === action.id);
  if (delivery === undefined) throw new Error("No completion delivery");
  coordinator.store.tracking.inbox.record(
    delivery.id,
    agentMessage(action, url, delivery.id),
  );
  await coordinator.merging.tick();
  await coordinator.digests.flush();
  const envelope = coordinator.store.digests.active(pr.ownerAgentId);
  if (envelope === undefined) throw new Error("No notice");
  const notice = coordinator.store.digests.version(
    envelope.id,
    envelope.revision,
  );
  const id = messageReceiptId(notice.body);
  if (id === undefined) throw new Error("No receipt command");
  await coordinator.start();
  return {
    directory,
    pr,
    notice,
    id,
    get coordinator() {
      return coordinator;
    },
    get reads() {
      return reads;
    },
    get writes() {
      return writes;
    },
    get current() {
      return current;
    },
    set current(value: MergeSnapshot) {
      current = value;
    },
    failReads(value?: string) {
      readError = value;
    },
    uncertain() {
      uncertain = true;
    },
    async merge() {
      const response = await schedulerClient(directory).mergeAgentMessage({
        receiptId: id,
        agentTarget: owner,
      });
      assert(response.result !== undefined);
      return {
        resultText: JSON.stringify(
          unwire(DomainMergeReceiptResultSchema, response.result),
        ),
      };
    },
    observe() {
      coordinator.store.tracking.observe(pr.id, current.observation, config);
    },
    async reopen() {
      await coordinator.close();
      coordinator = new Coordinator(directory, options);
      await coordinator.start();
    },
    advance() {
      now += 600000;
    },
    async close() {
      await coordinator.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
test("Ready offers one merge command; hook receipt alone cannot merge; explicit CLI request survives restart and replays once", async () => {
  const f = await fixture();
  try {
    expect(f.notice.body).toContain(`[PR #38](${url}) · Ready`);
    expect(f.notice.body).toContain(`\`octo-manager merge ${f.id}`);
    expect(f.notice.body).not.toContain("Ack:");
    const before = f.reads;
    await f.coordinator.merging.tick();
    expect(f.reads).toBe(before);
    await codexHook(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: owner.sessionId,
        cwd: "/fixture",
        prompt: f.notice.body,
      },
      f.directory,
    );
    expect(f.coordinator.store.merging.entries()).toHaveLength(0);
    const inspect = Bun.spawn(
      [
        process.execPath,
        resolve("src/cli.ts"),
        "message",
        f.id,
        "--state",
        f.directory,
        "--full",
        "--json",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [inspection, inspectionCode, inspectionError] = await Promise.all([
      new Response(inspect.stdout).text(),
      inspect.exited,
      new Response(inspect.stderr).text(),
    ]);
    expect(inspectionCode, inspectionError).toBe(0);
    const inspected: unknown = JSON.parse(inspection);
    expect(inspected).toMatchObject({
      merge: { pr: url, head, method: "squash" },
    });
    const child = Bun.spawn(
      [
        process.execPath,
        resolve("src/cli.ts"),
        "merge",
        f.id,
        "--state",
        f.directory,
        "--json",
      ],
      {
        env: {
          ...process.env,
          CODEX_THREAD_ID: owner.sessionId,
          OCTO_MANAGER_AGENT_ID: "",
          OCTO_MANAGER_ENDPOINT: "local",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(error).toBe("");
    expect(code).toBe(0);
    expect(output).toContain('"queued"');
    expect(f.writes).toBe(0);
    expect(f.coordinator.store.merging.entries()[0]?.autoMerge).toBe(false);
    await f.reopen();
    await f.coordinator.merging.tick();
    expect(f.writes).toBe(1);
    expect((await f.merge()).resultText).toContain('"merged"');
    await f.coordinator.merging.tick();
    expect(f.writes).toBe(1);
  } finally {
    await f.close();
  }
});
test("another recipient cannot use the merge receipt and stale head requests acknowledge without scheduling a merge", async () => {
  const f = await fixture();
  try {
    const other = f.coordinator.tracking.registerAgent({
      ...owner,
      sessionId: "other",
    });
    await assert.rejects(
      schedulerClient(f.directory).mergeAgentMessage({
        receiptId: f.id,
        agentId: other.id,
      }),
      /another agent/u,
    );
    expect(
      f.coordinator.store.digests.receipts(f.notice.digestId),
    ).toHaveLength(0);
    f.current = {
      ...f.current,
      observation: { ...f.current.observation, headSha: "d".repeat(40) },
    };
    f.observe();
    expect((await f.merge()).resultText).toContain('"blocked"');
    expect(
      f.coordinator.store.digests.receipts(f.notice.digestId),
    ).toHaveLength(1);
    expect(f.coordinator.store.merging.entries()).toHaveLength(0);
    expect(f.writes).toBe(0);
  } finally {
    await f.close();
  }
});
test("fresh review gates stop a one-shot request and clearing the gate cannot trigger a later merge", async () => {
  const f = await fixture();
  try {
    await f.merge();
    f.current.review = "REVIEW_REQUIRED";
    await f.coordinator.merging.tick();
    expect(f.writes).toBe(0);
    expect(f.coordinator.store.merging.entries()[0]?.state).toBe(
      EntryState.Blocked,
    );
    f.current.review = "APPROVED";
    f.advance();
    await f.coordinator.merging.tick();
    await f.merge();
    expect(f.writes).toBe(0);
    expect(f.coordinator.store.merging.chains()).toHaveLength(1);
  } finally {
    await f.close();
  }
});
test("unknown merge outcomes are not replayed by repeated receipt commands", async () => {
  const f = await fixture();
  try {
    f.uncertain();
    await f.merge();
    await f.coordinator.merging.tick();
    expect(f.writes).toBe(1);
    expect((await f.merge()).resultText).toContain('"uncertain"');
    f.advance();
    await f.coordinator.merging.tick();
    expect(f.writes).toBe(1);
  } finally {
    await f.close();
  }
});
test("reference discovery ignores examples and link labels while keeping cross-repository PR links", async () => {
  const f = await fixture();
  try {
    const pr = f.coordinator.store.tracking.pr(f.pr.id);
    const body =
      "Example:\n```text\nPR #310 · Ready\n```\n`#311`\n~~~text\n#312\n~~~\nDepends on [PR #13](https://github.com/another/repo/pull/13).\nAlso owner/library#14";
    const refs = references(pr, [{ key: "description", text: body, url }], []);
    expect(refs.map((r) => r.targetUrl)).toEqual([
      "https://github.com/another/repo/pull/13",
      "https://github.com/owner/library/issues/14",
    ]);
    f.current.observation.description = body;
    f.observe();
    f.coordinator.store.merging.scan(f.coordinator.store.tracking.pr(f.pr.id));
    const notices = f.coordinator.store.tracking.inbox
      .list(f.pr.ownerAgentId, 0, false, true)
      .messages.filter((m) => m.workflowPRId !== undefined);
    expect(
      notices.some((m) =>
        m.body.includes(
          "[another/repo#13](https://github.com/another/repo/pull/13)",
        ),
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test("manual merge preserves the automatic switch while a paused chain blocks readiness", async () => {
  const f = await fixture();
  try {
    f.coordinator.merging.command({
      op: "auto_merge",
      pr: url,
      actorId: f.pr.ownerAgentId,
      enabled: true,
      requestId: "existing-policy",
    });
    f.coordinator.merging.command({
      op: "auto_merge",
      pr: url,
      actorId: f.pr.ownerAgentId,
      enabled: false,
      requestId: "off",
    });
    await f.coordinator.merging.tick();
    expect((await f.merge()).resultText).toContain("changed since this notice");
    const unread = f.coordinator.store.tracking.inbox.list(
      f.pr.ownerAgentId,
      0,
      false,
      true,
    ).messages;
    expect(
      unread.some((message) => !f.notice.messageIds.includes(message.id)),
    ).toBe(true);
    await f.coordinator.digests.flush();
    const envelope = f.coordinator.store.digests.active(f.pr.ownerAgentId);
    if (envelope === undefined) throw new Error("No policy-bound offer");
    const current = f.coordinator.store.digests.version(
      envelope.id,
      envelope.revision,
    );
    const token = messageReceiptId(current.body);
    if (token === undefined) throw new Error("No policy receipt");
    expect(token).not.toBe(f.id);
    expect(
      (
        await schedulerClient(f.directory).mergeAgentMessage({
          receiptId: token,
          agentTarget: owner,
        })
      ).result?.state,
    ).toBe(DomainMergeReceiptResultState.QUEUED);
    expect(f.coordinator.store.merging.entries()[0]?.autoMerge).toBe(false);
    f.coordinator.merging.command({
      op: "auto_merge",
      pr: url,
      actorId: f.pr.ownerAgentId,
      enabled: true,
      requestId: "on",
    });
    f.coordinator.merging.command({
      op: "pause",
      id: f.coordinator.store.merging.entries()[0]?.chainId,
    });
    await f.coordinator.merging.tick();
    const paused = f.coordinator.store.tracking.inbox
      .list(f.pr.ownerAgentId, 0, false, true)
      .messages.map((message) =>
        f.coordinator.merging.receipts.presentation(message),
      )
      .find((view) => view.summary?.includes("paused") === true);
    expect(paused?.summary).toContain("paused");
    expect(paused?.mergeTarget).toBeUndefined();
  } finally {
    await f.close();
  }
});
test("approval after check receipt produces one fresh linked Ready notice and old commands cannot rebind the new request", async () => {
  const f = await fixture("REVIEW_REQUIRED");
  try {
    expect(f.notice.body).not.toContain(" · Ready");
    await schedulerClient(f.directory).acknowledgeAgentDigest({
      receiptId: f.id,
      agentTarget: owner,
    });
    f.current.review = "APPROVED";
    f.current.observation.reviews = {
      state: "complete",
      value: [
        {
          id: "review:2",
          author: "reviewer",
          headSha: head,
          state: "APPROVED",
          at: 2000,
          url,
        },
      ],
    };
    f.observe();
    await f.coordinator.merging.tick();
    await f.coordinator.digests.flush();
    const envelope = f.coordinator.store.digests.active(f.pr.ownerAgentId);
    if (envelope === undefined) throw new Error("No new Ready notice");
    const ready = f.coordinator.store.digests.version(
      envelope.id,
      envelope.revision,
    );
    expect(ready.body).toContain(`[PR #38](${url}) · Ready`);
    const token = messageReceiptId(ready.body);
    if (token === undefined) throw new Error("No merge receipt");
    expect(token).not.toBe(f.id);
    await f.coordinator.merging.tick();
    const notices = f.coordinator.store.tracking.inbox
      .list(f.pr.ownerAgentId, 0, false, true)
      .messages.filter((m) => m.workflowPRId !== undefined);
    expect(notices).toHaveLength(1);
    await schedulerClient(f.directory).mergeAgentMessage({
      receiptId: token,
      agentTarget: owner,
    });
    expect((await f.merge()).resultText).toContain("no merge target");
    expect(f.coordinator.store.merging.entries()[0]?.receiptId).toBe(
      ready.dispatchId,
    );
    await f.coordinator.merging.tick();
    expect(f.writes).toBe(1);
  } finally {
    await f.close();
  }
});

test("a new ordinary owner assessment retires obsolete receipt authority without rebinding old commands", async () => {
  const f = await fixture();
  try {
    await f.merge();
    const newer = "e".repeat(40);
    f.current.observation.headSha = newer;
    if (f.current.observation.checks.state !== "complete")
      throw new Error("Missing check coverage");
    f.current.observation.checks.value = f.current.observation.checks.value.map(
      (check) => ({ ...check, id: "run:2", headSha: newer }),
    );
    f.observe();
    await f.coordinator.merging.tick();
    expect(f.writes).toBe(0);
    f.coordinator.merging.command({
      op: "auto_merge",
      pr: url,
      actorId: f.pr.ownerAgentId,
      enabled: true,
      requestId: "new-ordinary-authority",
    });
    f.coordinator.merging.command({
      op: "ready",
      pr: url,
      actorId: f.pr.ownerAgentId,
      head: newer,
    });
    expect(f.coordinator.store.merging.entries()[0]?.receiptId).toBeUndefined();
    expect((await f.merge()).resultText).toContain("superseded");
    await f.coordinator.merging.tick();
    expect(f.writes).toBe(1);
    expect((await f.merge()).resultText).toContain("superseded");
    expect(f.coordinator.store.merging.operations()[0]?.head).toBe(newer);
  } finally {
    await f.close();
  }
});

test("an older offer receipt cannot consume a newer policy-bound Ready decision", async () => {
  const f = await fixture();
  try {
    f.coordinator.merging.command({
      op: "auto_merge",
      pr: url,
      actorId: f.pr.ownerAgentId,
      enabled: true,
      requestId: "policy-created",
    });
    f.coordinator.merging.command({
      op: "auto_merge",
      pr: url,
      actorId: f.pr.ownerAgentId,
      enabled: false,
      requestId: "policy-disabled",
    });
    await f.coordinator.merging.tick();
    await f.coordinator.digests.flush();
    const envelope = f.coordinator.store.digests.active(f.pr.ownerAgentId);
    if (envelope === undefined) throw new Error("No replacement offer");
    const newer = f.coordinator.store.digests.version(
      envelope.id,
      envelope.revision,
    );
    expect(
      newer.messageIds.some((id) => !f.notice.messageIds.includes(id)),
    ).toBe(true);
    await schedulerClient(f.directory).acknowledgeAgentDigest({
      receiptId: f.id,
      agentTarget: owner,
    });
    for (const id of newer.messageIds.filter(
      (id) => !f.notice.messageIds.includes(id),
    ))
      expect(
        f.coordinator.store.tracking.inbox.get(id)?.acknowledgedAt,
      ).toBeUndefined();
    expect(f.writes).toBe(0);
  } finally {
    await f.close();
  }
});
test("a collapsed message offers merge only for one unambiguous Ready PR", async () => {
  const f = await fixture();
  try {
    const message = f.coordinator.store.tracking.inbox.get(
      f.notice.messageIds[0] ?? "",
    );
    const target = f.notice.mergeTarget;
    if (message === undefined || target === undefined)
      throw new Error("No Ready fixture");
    const extra = {
      ...message,
      id: "extra",
      actionId: "",
      body: "[PR #40](https://github.com/owner/repo/pull/40) · Needs input",
    };
    const single = renderDigest(
      [message, extra],
      f.directory,
      "12345678-1234-4123-8123-123456789abc",
      (row) =>
        row.id === message.id ? { summary: "Ready", mergeTarget: target } : {},
    );
    expect(single.body).toContain("octo-manager merge 12345678");
    expect(single.messageIds).toHaveLength(2);
    const multiple = renderDigest(
      [message, extra],
      f.directory,
      "12345678-1234-4123-8123-123456789abc",
      (row) => ({
        summary: "Ready",
        mergeTarget:
          row.id === message.id ? target : { ...target, prId: "another-pr" },
      }),
    );
    expect(multiple.body).toContain("octo-manager ack 12345678");
    expect(multiple.mergeTarget).toBeUndefined();
  } finally {
    await f.close();
  }
});

test("a queue observer cannot cancel the direct-turn owner's check delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-mixed-ready-"));
  const config = defaultTrackingConfig();
  config.endpoints["local"] = { delivery: "turn", socket: "/controlled-turn" };
  config.endpoints["queue"] = {
    delivery: "queue",
    socket: "/controlled-queue",
  };
  const current = snapshot(),
    sent: string[] = [];
  const coordinator = new Coordinator(directory, {
    now: () => 1000,
    trackingConfig: config,
    trackingOptions: {
      read: () => Promise.resolve(current.observation),
      connect: () => ({
        prepare: () => Promise.resolve({ busy: false }),
        send: (agent) => {
          sent.push(agent.id);
          return Promise.resolve({ turnId: "controlled-turn" });
        },
        find: () => Promise.resolve({ found: false }),
        close() {},
      }),
    },
    mergeOptions: {
      provider: {
        inspect: () => Promise.resolve(current),
        merge: () => Promise.reject(new Error("No merge expected")),
      },
    },
  });
  try {
    const pr = coordinator.tracking.track(url, owner);
    const observer = coordinator.tracking.registerAgent({
      ...owner,
      endpoint: "queue",
      sessionId: "queue-observer",
    });
    coordinator.tracking.subscribe(pr.id, {
      ...owner,
      endpoint: "queue",
      sessionId: "queue-observer",
    });
    coordinator.store.tracking.observe(pr.id, current.observation, config);
    const completion = coordinator.store.tracking
      .actions()
      .find((action) => action.blocker.kind === "check_results");
    if (completion === undefined) throw new Error("No completion");
    const deliveries = coordinator.store.tracking
      .deliveries()
      .filter((d) => d.actionId === completion.id);
    for (const delivery of deliveries)
      coordinator.store.tracking.inbox.record(
        delivery.id,
        agentMessage(completion, url, delivery.id),
      );
    await coordinator.merging.tick();
    const ownerDelivery = coordinator.store.tracking
      .deliveries()
      .find(
        (d) =>
          d.actionId === completion.id &&
          d.recipientAgentId === pr.ownerAgentId,
      );
    expect(ownerDelivery?.progress.state).not.toBe(DeliveryState.Cancelled);
    expect(
      coordinator.store.tracking
        .deliveries()
        .find(
          (d) =>
            d.actionId === completion.id && d.recipientAgentId === observer.id,
        )?.progress.state,
    ).toBe(DeliveryState.Cancelled);
    const queuedReady = coordinator.store.tracking.inbox
      .list(observer.id, 0, false, true)
      .messages.find((m) => m.workflowPRId === pr.id);
    if (queuedReady === undefined) throw new Error("No observer Ready notice");
    expect(queuedReady.body).toContain("Role: observer");
    expect(
      coordinator.merging.receipts.presentation(queuedReady).mergeTarget,
    ).toBeUndefined();
    for (
      let attempt = 0;
      attempt < 50 && !sent.includes(pr.ownerAgentId);
      attempt++
    ) {
      coordinator.tracking.tick();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(sent).toContain(pr.ownerAgentId);
    expect(sent).not.toContain(observer.id);
  } finally {
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("a same-head rerun first observed completed replaces all older queue completion copies", async () => {
  const f = await fixture();
  try {
    if (f.current.observation.checks.state !== "complete")
      throw new Error("Missing checks");
    f.current.observation.checks.value = f.current.observation.checks.value.map(
      (check) => ({ ...check, id: "run:2", at: 2000 }),
    );
    f.observe();
    const latest = f.coordinator.store.tracking
      .actions()
      .filter((a) => a.blocker.kind === "check_results")
      .at(-1);
    if (latest === undefined) throw new Error("No latest generation");
    const delivery = f.coordinator.store.tracking
      .deliveries()
      .find((d) => d.actionId === latest.id);
    if (delivery === undefined) throw new Error("No latest delivery");
    if (f.coordinator.store.tracking.inbox.get(delivery.id) === undefined)
      f.coordinator.store.tracking.inbox.record(
        delivery.id,
        agentMessage(latest, url, delivery.id),
      );
    await f.coordinator.merging.tick();
    await f.coordinator.digests.flush();
    expect(
      f.coordinator.store.merging.noticeReadiness(f.pr.id)?.target.actionId,
    ).toBe(latest.id);
    const unread = f.coordinator.store.tracking.inbox.list(
      f.pr.ownerAgentId,
      0,
      false,
      true,
    ).messages;
    expect(unread.some((m) => m.actionId !== "")).toBe(false);
    const ready = unread.filter((m) => m.workflowPRId === f.pr.id);
    expect(ready).toHaveLength(1);
    expect(
      ready.every(
        (m) => f.coordinator.merging.receipts.presentation(m).defer !== true,
      ),
    ).toBe(true);
    expect(
      f.notice.messageIds.every(
        (id) =>
          f.coordinator.store.tracking.inbox.get(id)?.applicable === false,
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test("readiness returning to an earlier state creates a fresh decision instead of reviving a receipted message", async () => {
  const f = await fixture();
  try {
    await schedulerClient(f.directory).acknowledgeAgentDigest({
      receiptId: f.id,
      agentTarget: owner,
    });
    f.current.review = "REVIEW_REQUIRED";
    f.advance();
    await f.coordinator.merging.tick();
    await f.coordinator.digests.flush();
    const blocked = f.coordinator.store.digests.active(f.pr.ownerAgentId);
    if (blocked === undefined) throw new Error("No blocked decision");
    const blockedVersion = f.coordinator.store.digests.version(
      blocked.id,
      blocked.revision,
    );
    const blockedId = messageReceiptId(blockedVersion.body);
    if (blockedId === undefined) throw new Error("No blocked receipt");
    await schedulerClient(f.directory).acknowledgeAgentDigest({
      receiptId: blockedId,
      agentTarget: owner,
    });
    f.current.review = "APPROVED";
    f.advance();
    await f.coordinator.merging.tick();
    await f.coordinator.digests.flush();
    const ready = f.coordinator.store.digests.active(f.pr.ownerAgentId);
    if (ready === undefined) throw new Error("No renewed Ready decision");
    const version = f.coordinator.store.digests.version(
      ready.id,
      ready.revision,
    );
    expect(version.body).toContain(" · Ready");
    expect(
      version.messageIds.some((id) => !f.notice.messageIds.includes(id)),
    ).toBe(true);
    expect(
      version.messageIds.every(
        (id) =>
          f.coordinator.store.tracking.inbox.get(id)?.acknowledgedAt ===
          undefined,
      ),
    ).toBe(true);
    expect(
      f.coordinator.store.merging.noticeReadiness(f.pr.id)?.generation,
    ).toBe(3);
  } finally {
    await f.close();
  }
});

test("agent presentation links native GitHub references while preserving existing links and code", () => {
  const parent = "https://github.com/owner/repo/pull/13";
  const text = linkPRReferences(
    "Parent PR #13; other/repo#14; `#15`; [PR #16](https://github.com/owner/repo/pull/16)",
    url,
    parent,
  );
  expect(text).toContain(
    "PR [owner/repo#13](https://github.com/owner/repo/pull/13)",
  );
  expect(text).toContain(
    "[other/repo#14](https://github.com/other/repo/issues/14)",
  );
  expect(text).toContain("`#15`");
  expect(text).toContain("[PR #16](https://github.com/owner/repo/pull/16)");
  const bounded = linkPRReferences(
    Array.from({ length: 40 }, (_, index) => `#${String(index + 1)}`).join(" "),
    url,
    undefined,
    180,
  );
  expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(180);
  expect(bounded.endsWith("…")).toBe(true);
  expect(bounded.replace(/\[[^\]]*\]\([^)]*\)/gu, "")).not.toMatch(/#[0-9]/u);
});

test("rendered excerpts preserve complete existing links beyond the old plain-text cutoff", async () => {
  const f = await fixture();
  try {
    const message = f.coordinator.store.tracking.inbox.get(
      f.notice.messageIds[0] ?? "",
    );
    if (message === undefined) throw new Error("No source message");
    const target = `https://github.com/owner/${"repository".repeat(6)}/pull/13?diff=split#discussion_r123`;
    const link = `[parent review](${target})`;
    const rendered = renderDigest(
      [
        {
          ...message,
          body: `[PR #38](${url}) · Review\n> ${"Context ".repeat(18)}${link}\n[Evidence](${url})`,
        },
      ],
      f.directory,
      "12345678-1234-4123-8123-123456789abc",
    );
    expect(rendered.body).toContain(link);
    const plain = linkPRReferences(`See ${target}`, url);
    expect(plain).toContain(`](${target})`);
    expect(plain).not.toContain(")?diff=");
  } finally {
    await f.close();
  }
});

test("read failures and recovery do not repeat a receipted Ready decision, including across restart", async () => {
  const f = await fixture();
  try {
    await schedulerClient(f.directory).acknowledgeAgentDigest({
      receiptId: f.id,
      agentTarget: owner,
    });
    const generation = f.coordinator.store.merging.noticeReadiness(
      f.pr.id,
    )?.generation;
    for (let cycle = 0; cycle < 3; cycle++) {
      f.failReads("Synthetic GitHub timeout");
      f.advance();
      await f.coordinator.merging.tick();
      await f.coordinator.digests.flush();
      expect(
        f.coordinator.store.merging.noticeReadiness(f.pr.id)?.inspectionError,
      ).toBe("Synthetic GitHub timeout");
      const source = f.coordinator.store.tracking.inbox.get(
        f.notice.messageIds[0] ?? "",
      );
      assert(source !== undefined);
      expect(f.coordinator.merging.receipts.presentation(source).defer).toBe(
        true,
      );
      const reads = f.reads;
      await f.coordinator.merging.tick();
      expect(f.reads).toBe(reads);
      if (cycle === 0) {
        await f.reopen();
        expect((await f.merge()).resultText).toContain('"blocked"');
        expect(f.coordinator.store.merging.entries()).toHaveLength(0);
      }
      expect(
        f.coordinator.store.digests.active(f.pr.ownerAgentId),
      ).toBeUndefined();
      f.failReads();
      f.advance();
      await f.coordinator.merging.tick();
      await f.coordinator.digests.flush();
      expect(
        f.coordinator.store.merging.noticeReadiness(f.pr.id)?.inspectionError,
      ).toBeUndefined();
      expect(
        f.coordinator.store.merging.noticeReadiness(f.pr.id)?.generation,
      ).toBe(generation);
      expect(
        f.coordinator.store.digests.active(f.pr.ownerAgentId),
      ).toBeUndefined();
    }
    expect(f.writes).toBe(0);
  } finally {
    await f.close();
  }
});
test("known dependency blockers avoid eligibility reads and repeat notices", async () => {
  const f = await fixture();
  try {
    const parent = f.coordinator.store.tracking.track(
      "https://github.com/owner/repo/pull/37",
      owner,
    );
    f.coordinator.store.tracking.observe(
      parent.id,
      f.current.observation,
      defaultTrackingConfig(),
    );
    f.coordinator.store.merging.confirm(
      f.pr.id,
      parent.id,
      f.pr.ownerAgentId,
      "Parent must merge first",
    );
    const reads = f.reads;
    f.failReads("GitHub unavailable");
    await f.coordinator.merging.tick();
    await f.coordinator.digests.flush();
    expect(f.reads).toBe(reads);
    const digest = f.coordinator.store.digests.active(f.pr.ownerAgentId);
    assert(digest !== undefined);
    const version = f.coordinator.store.digests.version(
      digest.id,
      digest.revision,
    );
    expect(version.body).toContain("dependency requirements remain");
    const id = messageReceiptId(version.body);
    assert(id !== undefined);
    await schedulerClient(f.directory).acknowledgeAgentDigest({
      receiptId: id,
      agentTarget: owner,
    });
    for (let cycle = 0; cycle < 3; cycle++) {
      f.advance();
      await f.coordinator.merging.tick();
      await f.coordinator.digests.flush();
      expect(f.reads).toBe(reads);
      expect(
        f.coordinator.store.digests.active(f.pr.ownerAgentId),
      ).toBeUndefined();
    }
    f.failReads();
    f.current.observation.lifecycle = "merged";
    f.coordinator.store.tracking.observe(
      parent.id,
      f.current.observation,
      defaultTrackingConfig(),
    );
    f.current.observation.lifecycle = "open";
    f.advance();
    await f.coordinator.merging.tick();
    await f.coordinator.digests.flush();
    const ready = f.coordinator.store.digests.active(f.pr.ownerAgentId);
    assert(ready !== undefined);
    expect(
      f.coordinator.store.digests.version(ready.id, ready.revision).body,
    ).toContain(" · Ready");
    expect(f.writes).toBe(0);
  } finally {
    await f.close();
  }
});

test("caller instructions survive restart and accompany only its PR updates and confirmed merge", async () => {
  const f = await fixture();
  const instructions =
    "Fix review findings; after merge pull latest and reinstall.";
  try {
    const observer = f.coordinator.tracking.registerAgent({
      ...owner,
      sessionId: "instruction-observer",
    });
    f.coordinator.tracking.subscribe(f.pr.id, {
      ...owner,
      sessionId: "instruction-observer",
    });
    const child = Bun.spawn(
      [
        process.execPath,
        resolve("src/cli.ts"),
        "pr",
        "auto-merge",
        url,
        "--on",
        "--agent-id",
        f.pr.ownerAgentId,
        "--instructions",
        instructions,
        "--state",
        f.directory,
        "--json",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, error + output).toBe(0);
    expect(
      f.coordinator.store.merging.agentInstructions(f.pr.id, f.pr.ownerAgentId),
    ).toBe(instructions);
    expect(
      f.coordinator.store.merging.agentInstructions(f.pr.id, observer.id),
    ).toBeUndefined();
    const frozen = f.coordinator.store.digests.version(
      f.notice.digestId,
      f.notice.revision,
    ).body;
    expect(frozen).not.toContain(instructions);
    await f.reopen();
    expect(
      f.coordinator.store.merging.agentInstructions(f.pr.id, f.pr.ownerAgentId),
    ).toBe(instructions);
    await f.coordinator.merging.tick();
    const pending = f.coordinator.store.tracking.inbox.list(
      f.pr.ownerAgentId,
      0,
      false,
      true,
    ).messages;
    const body = renderDigest(
      pending,
      f.directory,
      "12345678",
      f.coordinator.merging.receipts.presentation,
    ).body;
    expect(body.split(instructions)).toHaveLength(2);
    f.coordinator.store.merging.ready(url, f.pr.ownerAgentId, head);
    await f.coordinator.merging.tick();
    expect(f.writes).toBe(1);
    await f.coordinator.digests.flush();
    const digest = f.coordinator.store.digests.active(f.pr.ownerAgentId);
    assert(digest !== undefined);
    const delivered = f.coordinator.store.digests.version(
      digest.id,
      digest.revision,
    ).body;
    expect(delivered).toContain("GitHub confirmed merge");
    expect(delivered).toContain(`Instructions: ${instructions}`);
  } finally {
    await f.close();
  }
});

test("instruction updates and clearing do not change readiness, and invalid or non-owner configuration fails", async () => {
  const f = await fixture();
  try {
    const store = f.coordinator.store.merging;
    store.autoMerge(
      url,
      f.pr.ownerAgentId,
      true,
      "instructions",
      "Review and repair actionable feedback.",
    );
    store.ready(url, f.pr.ownerAgentId, head);
    const before = store.entry(url).ready;
    store.autoMerge(
      url,
      f.pr.ownerAgentId,
      true,
      "replace",
      "After merge update the local install.",
    );
    expect(store.entry(url).ready).toEqual(before);
    const observer = f.coordinator.tracking.registerAgent({
      ...owner,
      sessionId: "instruction-observer",
    });
    expect(() =>
      store.autoMerge(url, observer.id, true, "unauthorized", "Do work"),
    ).toThrow();
    expect(() =>
      store.autoMerge(
        url,
        f.pr.ownerAgentId,
        true,
        "oversize",
        "x".repeat(1001),
      ),
    ).toThrow();
    store.autoMerge(url, f.pr.ownerAgentId, true, "clear", "");
    expect(store.agentInstructions(f.pr.id, f.pr.ownerAgentId)).toBeUndefined();
    expect(store.entry(url).ready).toEqual(before);
    store.autoMerge(
      url,
      f.pr.ownerAgentId,
      true,
      "restore",
      "After merge reinstall.",
    );
    const assigned = f.coordinator.store.tracking.assign(f.pr.id, {
      ...owner,
      sessionId: "new-owner",
    });
    expect(
      store.agentInstructions(f.pr.id, assigned.ownerAgentId),
    ).toBeUndefined();
    expect(store.agentInstructions(f.pr.id, f.pr.ownerAgentId)).toBeUndefined();
  } finally {
    await f.close();
  }
});

test("a squash receipt cannot authorize a replacement rebase chain for the same head", async () => {
  const f = await fixture();
  try {
    expect(f.notice.mergeTarget?.method).toBe("squash");
    f.coordinator.store.merging.queue({
      requestId: "replacement-rebase-policy",
      actorId: f.pr.ownerAgentId,
      entries: [{ prUrl: url, method: "rebase", checks: ["CI"] }],
    });
    expect((await f.merge()).resultText).toContain("blocked");
    expect(f.coordinator.store.merging.entry(url).ready).toBeUndefined();
    expect(f.writes).toBe(0);
  } finally {
    await f.close();
  }
});
