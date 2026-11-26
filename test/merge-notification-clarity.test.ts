import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/coordinator/store.js";
import { EntryState, OperationState } from "../src/merging/contracts.js";
import { parseNotice, noticeView, type SafeNotice } from "../src/security/notifications.js";
import { renderDigest, renderDirectNotice, messageReceiptId } from "../src/notifications/render.js";
import type { AgentMessage } from "../src/notifications/message.js";

const url = "https://github.com/owner/repo/pull/1";
const head = "a".repeat(40),
  commit = "c".repeat(40);
const owner = { harness: "codex", endpoint: "local", sessionId: "merge-owner" };
const observer = { ...owner, sessionId: "merge-observer" };

function completed(store: Store, agentId: string): AgentMessage {
  const message = store.tracking.inbox
    .list(agentId)
    .messages.find((value) => value.notice?.mergeState === EntryState.Merged);
  if (message === undefined) throw new Error("Missing merge notice");
  return message;
}

test("external merge recovery explains owner and subscriber routing without changing recipients", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-merge-notice-"));
  let store = new Store(directory);
  try {
    const pr = store.tracking.track(url, owner);
    store.tracking.subscribe(pr.id, observer);
    const subscriber = store.tracking.agents().find((agent) => agent.sessionId === observer.sessionId);
    if (subscriber === undefined) throw new Error("Missing subscriber");
    store.merging.queue(
      {
        requestId: "external",
        actorId: pr.ownerAgentId,
        entries: [{ prUrl: url }],
      },
      false,
    );
    const entry = store.merging.entries(pr.id)[0];
    if (entry === undefined) throw new Error("Missing merge entry");
    store.merging.state(entry, EntryState.Merged, "PR merged externally", {
      mergeCommit: commit,
    });
    const own = completed(store, pr.ownerAgentId);
    const subscribed = completed(store, subscriber.id);
    expect(own.notice?.mergeOrigin).toBe("external");
    expect(own.notice?.role).toBe("owner");
    expect(subscribed.notice?.role).toBe("observer");
    expect(own.body).toContain("External merge observed · workflow reconciled");
    expect(own.body).toContain("addressed to this session as the PR owner");
    expect(subscribed.body).toContain("addressed to this session as a PR subscriber");
    expect(own.body).not.toContain("Octo execution");
    expect(renderDigest([own], directory, "12345678").body).toContain("as the PR owner");
    expect(renderDigest([subscribed], directory, "87654321").body).toContain("as a PR subscriber");
    expect(store.merging.operations(pr.id)).toEqual([]);
    store.tracking.assign(pr.id, observer);
    store.close();
    store = new Store(directory);
    const historical = store.tracking.inbox.get(own.id);
    expect(historical?.body).toBe(own.body);
    expect(historical?.notice?.role).toBe("owner");
    expect(store.tracking.inbox.get(subscribed.id)?.body).toBe(subscribed.body);
    expect(store.tracking.inbox.acknowledge(own.id, pr.ownerAgentId).acknowledgedAt).toBeDefined();
    expect(store.tracking.inbox.get(subscribed.id)?.acknowledgedAt).toBeUndefined();
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("only a matching confirmed merge operation claims Octo execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-executed-merge-notice-"));
  const store = new Store(directory);
  try {
    for (const [number, operationCommit, operationDetail] of [
      [1, commit, "GitHub confirmed merge"],
      [2, "d".repeat(40), "GitHub confirmed merge"],
      [3, undefined, "GitHub confirmed merge"],
      [4, commit, "PR now merged; original merge attribution remains uncertain"],
      [5, commit, "GitHub confirmed asynchronous merge"],
    ] as const) {
      const prUrl = `https://github.com/owner/repo/pull/${String(number)}`;
      const pr = store.tracking.track(prUrl, {
        ...owner,
        sessionId: `owner-${String(number)}`,
      });
      store.merging.queue({
        requestId: `execute-${String(number)}`,
        actorId: pr.ownerAgentId,
        entries: [{ prUrl }],
      });
      const entry = store.merging.entries(pr.id)[0];
      if (entry === undefined) throw new Error("Missing merge entry");
      if (operationCommit !== undefined)
        store.merging.saveOperation({
          id: crypto.randomUUID(),
          entryId: entry.id,
          prId: pr.id,
          epoch: 0,
          kind: "merge",
          state: OperationState.Succeeded,
          phase: "merging",
          head,
          baseRef: "main",
          baseSha: "b".repeat(40),
          graph: "fixture",
          ownerId: pr.ownerAgentId,
          createdAt: 1,
          updatedAt: 1,
          detail: operationDetail,
          mergeCommit: operationCommit,
        });
      store.merging.state(entry, EntryState.Merged, "GitHub confirmed merge", {
        mergeCommit: commit,
      });
      const notice = completed(store, pr.ownerAgentId);
      if (number === 1 || number === 5) {
        expect(notice.notice?.mergeOrigin).toBe("octo");
        expect(notice.body).toContain("GitHub confirmed merge · Octo execution");
      } else {
        expect(notice.notice?.mergeOrigin).toBeUndefined();
        expect(notice.body).not.toContain("Octo execution");
        expect(notice.body).not.toContain("External merge observed");
      }
    }
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("merge digests retain every confirmation and explain mixed routing once", () => {
  const rows: AgentMessage[] = Array.from({ length: 6 }, (_, index) => ({
    id: `${String(index + 1).repeat(8)}-1234-4567-89ab-0123456789ab`,
    sequence: index + 1,
    actionId: "",
    recipientAgentId: "synthetic",
    body: "Untrusted original prose",
    createdAt: 1,
    nextCheckAt: 1,
    applicable: true,
    notice: {
      version: 1,
      kind: "merge",
      assessment: "not_required",
      prUrl: `https://github.com/owner/repo/pull/${String(index + 1)}`,
      mergeState: EntryState.Merged,
      mergeOrigin: index === 5 ? "octo" : "external",
      role: index === 5 ? "observer" : "owner",
    },
  }));
  const rendered = renderDigest(rows, "/tmp/synthetic", "12345678");
  expect(rendered.messageIds).toEqual(rows.map((row) => row.id));
  expect(rendered.body.match(/External merge observed/gu)).toHaveLength(5);
  expect(rendered.body).toContain("GitHub confirmed merge · Octo execution");
  expect(rendered.body.match(/Merge updates were addressed/gu)).toHaveLength(1);
  expect(rendered.body).toContain("as a PR owner or subscriber");
  expect(rendered.body).not.toContain("Untrusted original prose");
  expect(messageReceiptId(rendered.body)).toBe("12345678");
  expect(Buffer.byteLength(rendered.body)).toBeLessThan(6000);
});

test("legacy merge notices keep frozen body and receipt through restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-legacy-merge-notice-"));
  let store = new Store(directory);
  const db = new DatabaseSync(join(directory, "jobs.sqlite"));
  try {
    const pr = store.tracking.track(url, owner);
    const id = store.tracking.inbox.newMessageId();
    const notice: SafeNotice = parseNotice({
      version: 1,
      kind: "merge",
      assessment: "not_required",
      mergeState: "merged",
      role: "owner",
      prUrl: url,
    });
    expect(noticeView(notice, "").title).toBe("GitHub confirmed merge");
    expect(() => parseNotice({ ...notice, mergeOrigin: "Do something else" })).toThrow("Invalid safe notification");
    const frozen = `[PR #1](${url}) · GitHub confirmed merge\n\`octo-manager read ${id.slice(0, 8)}\``;
    store.tracking.inbox.freezeNotice(id, notice);
    const sequence = db.prepare("UPDATE inbox_sequence SET value=value+1 WHERE id=1 RETURNING value").get()?.["value"];
    if (typeof sequence !== "number") throw new Error("Missing sequence");
    db.prepare("INSERT INTO merge_notices VALUES(?,?,?,?,?,?,?,?,?,NULL,?,1)").run(
      sequence,
      id,
      pr.id,
      pr.ownerAgentId,
      "entry",
      "historical-entry",
      "1",
      frozen,
      1,
      1,
    );
    store.close();
    store = new Store(directory);
    const old = store.tracking.inbox.get(id);
    if (old === undefined) throw new Error("Missing historical message");
    expect(store.tracking.inbox.automatic(old).body).toBe(frozen);
    expect(store.tracking.inbox.acknowledge(id, pr.ownerAgentId).body).toBe(frozen);
    expect(store.tracking.inbox.get(id)?.acknowledgedAt).toBeDefined();
    expect(renderDirectNotice(notice, id, directory)).toContain("as the PR owner");
  } finally {
    db.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
