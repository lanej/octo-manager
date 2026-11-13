import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Coordinator } from "../src/coordinator.js";
import { schedulerClient } from "../src/client.js";
import { defaultTrackingConfig } from "../src/tracking/config.js";
import type { QueuedMessage, QueueConnection } from "../src/agents/codex.js";
import type { ObservationInput } from "../src/tracking/types.js";
const input: ObservationInput = {
  observedAt: 1000,
  headSha: "head",
  baseSha: "base",
  lifecycle: "open",
  mergeability: "conflicting",
  checks: { state: "complete", value: [] },
  reviews: { state: "complete", value: [] },
};
test("subscription RPCs feed participant-aware per-agent digests and compact CLI receipts", async () => {
  const directory = await mkdtemp("/tmp/om-listeners-");
  const config = defaultTrackingConfig();
  config.endpoints["local"] = { delivery: "queue", socket: "/synthetic" };
  const slots = new Map<string, QueuedMessage>();
  let serial = 0;
  const coordinator = new Coordinator(directory, {
    trackingConfig: config,
    trackingOptions: {
      read: () => Promise.resolve(input),
      failureExcerpt: () => Promise.resolve(undefined),
    },
    digestOptions: {
      intervalMs: 10,
      connect: (agent) => {
        const connection: QueueConnection = {
          prepare: () => Promise.resolve({ busy: true }),
          queued: () =>
            Promise.resolve(
              slots.has(agent.id)
                ? [slots.get(agent.id)].filter(
                    (value): value is QueuedMessage => value !== undefined,
                  )
                : [],
            ),
          enqueueQueued: (_agent, clientId, body) => {
            const value = { queueId: `q-${String(++serial)}`, clientId, body };
            slots.set(agent.id, value);
            return Promise.resolve(value);
          },
          cancelQueued: () => {
            slots.delete(agent.id);
            return Promise.resolve(true);
          },
          received: () => Promise.resolve({ bodies: [], complete: true }),
          close: () => {},
        };
        return connection;
      },
    },
  });
  try {
    await coordinator.start();
    const client = schedulerClient(directory);
    const owner = {
        harness: "codex",
        endpoint: "local",
        sessionId: "owner",
        label: "Implementation",
      },
      listener = { ...owner, sessionId: "listener", label: "Review" };
    const tracked = await client.trackPullRequest({
      url: "https://github.com/owner/repo/pull/1",
      owner,
    });
    if (tracked.pr === undefined) throw new Error("Missing PR");
    const participants = await client.subscribePullRequest({
      id: tracked.pr.id,
      agent: listener,
    });
    expect(participants.participants.map((item) => item.role)).toEqual([
      "owner",
      "observer",
    ]);
    const observer = participants.participants.find(
      (item) => item.role === "observer",
    );
    if (observer === undefined) throw new Error("Missing observer");
    for (let attempt = 0; attempt < 150; attempt++) {
      coordinator.tracking.tick();
      await coordinator.digests.flush();
      const unread = coordinator.store.tracking.inbox.list(
        observer.agentId,
        0,
        false,
        true,
      ).messages;
      if (
        unread.some((item) => item.actionId !== "") &&
        slots.get(observer.agentId)?.body?.includes("action:") === true
      )
        break;
      await Bun.sleep(20);
    }
    expect(slots.get(observer.agentId)?.body).toContain(
      "owner: Implementation",
    );
    expect(slots.get(observer.agentId)?.body).toContain("observer: Review");
    expect(slots.get(observer.agentId)?.body).toContain("Role: observer");
    const digest = coordinator.store.digests.active(observer.agentId);
    if (digest === undefined) throw new Error("Missing observer digest");
    for (let index = 0; index < 200; index++)
      coordinator.store.digests.event(observer.agentId, digest.id, "history", {
        content: "past event ".repeat(100),
      });
    const child = Bun.spawn(
      [
        process.execPath,
        "src/cli.ts",
        "acknowledge-digest",
        digest.id,
        "--revision",
        String(digest.revision),
        "--agent-id",
        observer.agentId,
        "--state",
        directory,
        "--json",
      ],
      {
        env: { ...process.env, OCTO_MANAGER_AGENT: "0" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [output, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(Buffer.byteLength(output)).toBeLessThan(6002);
    expect(output).not.toContain('"events"');
    expect(output).not.toContain('"body"');
    expect(output).toContain('"role":"observer"');
    expect(output).toContain('"receipt"');
    const ownerMessages = coordinator.store.tracking.inbox.list(
      tracked.pr.ownerAgentId,
      0,
      false,
      true,
    ).messages;
    expect(ownerMessages.length).toBeGreaterThan(0);
    const ownerNotice = ownerMessages[0];
    if (ownerNotice === undefined) throw new Error("Missing owner notice");
    const receiptChild = Bun.spawn(
      [
        process.execPath,
        "src/cli.ts",
        "acknowledge-message",
        ownerNotice.id,
        "--agent-id",
        tracked.pr.ownerAgentId.replaceAll("-", "").slice(0, 8),
        "--state",
        directory,
      ],
      {
        env: { ...process.env, OCTO_MANAGER_AGENT: "0" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [noticeOutput, noticeCode] = await Promise.all([
      new Response(receiptChild.stdout).text(),
      receiptChild.exited,
    ]);
    expect(noticeCode).toBe(0);
    expect(Buffer.byteLength(noticeOutput)).toBeLessThan(250);
    expect(noticeOutput).not.toContain("body");

    await client.unsubscribePullRequest({
      id: tracked.pr.id,
      agentId: observer.agentId,
    });
    expect((await client.listPRParticipants({ id: tracked.pr.id })).total).toBe(
      1,
    );
    expect(
      coordinator.store.tracking.inbox.list(observer.agentId, 0, false, true)
        .messages,
    ).toHaveLength(0);
  } finally {
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});
