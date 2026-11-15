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
import { messageReceiptId } from "../src/notifications/render.js";
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
    uncertain = false;
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
    uncertain() {
      uncertain = true;
    },
    async merge() {
      return schedulerClient(directory).mergeAgentMessage({
        receiptId: id,
        agentTarget: owner,
      });
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
    const [inspection, inspectionCode] = await Promise.all([
      new Response(inspect.stdout).text(),
      inspect.exited,
    ]);
    expect(inspectionCode).toBe(0);
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
    expect((await f.merge()).resultJson).toContain('"merged"');
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
    expect((await f.merge()).resultJson).toContain('"blocked"');
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
    expect((await f.merge()).resultJson).toContain('"uncertain"');
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
    const message = f.coordinator.store.tracking.inbox.get(
      f.notice.messageIds[0] ?? "",
    );
    if (message === undefined) throw new Error("No completion message");
    const off = f.coordinator.merging.receipts.presentation(message);
    expect(off.summary).toBe("Ready");
    expect(off.mergeTarget).toBeDefined();
    await f.merge();
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
    const paused = f.coordinator.merging.receipts.presentation(message);
    expect(paused.summary).toContain("paused");
    expect(paused.mergeTarget).toBeUndefined();
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
    expect((await f.merge()).resultJson).toContain("no merge target");
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
    expect((await f.merge()).resultJson).toContain("superseded");
    await f.coordinator.merging.tick();
    expect(f.writes).toBe(1);
    expect((await f.merge()).resultJson).toContain("superseded");
    expect(f.coordinator.store.merging.operations()[0]?.head).toBe(newer);
  } finally {
    await f.close();
  }
});
