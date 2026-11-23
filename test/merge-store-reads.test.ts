import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.js";
import {
  ChainState,
  OperationState,
  ReferenceDecision,
  type PRReference,
} from "../src/merging/contracts.js";

test("scoped merge reads isolate unrelated history while preserving fresh validated state and chain prefixes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-merge-reads-"));
  const store = new Store(directory);
  const db = new DatabaseSync(join(directory, "jobs.sqlite"));
  try {
    const target = {
      harness: "codex",
      endpoint: "local",
      sessionId: "scoped-reads",
    };
    const selected = store.tracking.track(
      "https://github.com/owner/repo/pull/1",
      target,
    );
    const other = store.tracking.track(
      "https://github.com/owner/repo/pull/2",
      target,
    );
    const chain = store.merging.queue({
      requestId: "selected",
      actorId: selected.ownerAgentId,
      entries: [{ prUrl: selected.url, checks: ["CI"] }],
    });
    const unrelated = store.merging.queue({
      requestId: "other",
      actorId: other.ownerAgentId,
      entries: [{ prUrl: other.url, checks: ["CI"] }],
    });
    expect(store.merging.entries(selected.id)).toHaveLength(1);
    expect(store.merging.entries()).toHaveLength(2);
    for (const pr of [selected, other]) {
      const entry = store.merging.entries(pr.id)[0];
      if (entry === undefined) throw new Error("Missing fixture entry");
      store.merging.saveOperation({
        id: `operation-${pr.id}`,
        entryId: entry.id,
        prId: pr.id,
        epoch: 0,
        kind: "merge",
        state: OperationState.Succeeded,
        phase: "merging",
        head: "a".repeat(40),
        baseRef: "main",
        baseSha: "b".repeat(40),
        graph: "fixture",
        ownerId: pr.ownerAgentId,
        createdAt: 1,
        updatedAt: 1,
        detail: "Fixture completed",
      });
      const ref: PRReference = {
        id: `reference-${pr.id}`,
        prId: pr.id,
        targetUrl: other.url,
        targetKind: "pr",
        sourceKey: "description",
        revision: "fixture",
        evidenceUrl: pr.url,
        excerpt: "Related work",
        hint: "mentioned",
        active: true,
        decision: ReferenceDecision.Suggested,
        createdAt: 1,
      };
      db.prepare("INSERT INTO pr_references VALUES(?,?,?,?)").run(
        ref.id,
        pr.id,
        ref.targetUrl,
        JSON.stringify(ref),
      );
    }
    expect(store.merging.operations(selected.id)).toHaveLength(1);
    expect(store.merging.refs(selected.id)).toHaveLength(1);
    expect(store.merging.operations()).toHaveLength(2);
    expect(store.merging.refs()).toHaveLength(2);
    const readers = [
      {
        table: "merge_entries",
        read: () => store.merging.entries(selected.id),
      },
      {
        table: "merge_operations",
        read: () => store.merging.operations(selected.id),
      },
      { table: "pr_references", read: () => store.merging.refs(selected.id) },
    ];
    for (const { table, read } of readers) {
      const saved = JSON.stringify(read()[0]);
      db.prepare(
        `UPDATE ${table} SET data=json_set(data,'$.prId',?) WHERE pr_id=?`,
      ).run(other.id, selected.id);
      expect(read).toThrow("PR identity mismatch");
      db.prepare(`UPDATE ${table} SET data=? WHERE pr_id=?`).run(
        saved,
        selected.id,
      );
      db.prepare(`UPDATE ${table} SET data='{}' WHERE pr_id=?`).run(other.id);
      expect(read()).toHaveLength(1);
    }
    expect(
      store.merging.chain(chain.id.replaceAll("-", "").slice(0, 8)),
    ).toEqual(chain);
    const fresh = store.merging.control(chain.id, ChainState.Paused);
    expect(store.merging.chain(chain.id)).toEqual(fresh);
    db.prepare("UPDATE merge_chains SET data='{}' WHERE id=?").run(
      unrelated.id,
    );
    expect(store.merging.entries(selected.id)[0]?.prId).toBe(selected.id);
    expect(store.merging.chain(chain.id)).toEqual(fresh);
    expect(() => store.merging.entries(other.id)).toThrow(
      "Invalid merge-chain data",
    );
    expect(() => store.merging.chain(unrelated.id)).toThrow(
      "Invalid merge-chain data",
    );
    expect(() => store.merging.chain("not-present")).toThrow(
      "Merge chain not found",
    );
    for (const [id, requestId] of [
      ["abcdefab-1111-4111-8111-111111111111", "prefix-one"],
      ["abcdefab-2222-4222-8222-222222222222", "prefix-two"],
    ] as const) {
      const value = { ...fresh, id, requestId };
      db.prepare("INSERT INTO merge_chains VALUES(?,?,?,?)").run(
        id,
        requestId,
        value.state,
        JSON.stringify(value),
      );
    }
    expect(() => store.merging.chain("ABCDEFAB")).toThrow(
      "ambiguous ID prefix",
    );
  } finally {
    db.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
