import { migrateDigestMembership } from "./schema.js";
import { allocateMessageId } from "./identifiers.js";
import type { ReceiptTarget } from "../merging/receipt-types.js";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  archivedInspection,
  type ArchivedInspection,
  DigestState,
  digest,
  revision,
  digestEvent,
  type Digest,
  type DigestRevision,
  type DigestEvent,
  type QueueTransport,
} from "./types.js";
import { resolveId } from "../tracking/identifiers.js";
export class DigestStore {
  private statements = new Map<string, StatementSync>();
  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (statement === undefined) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
  constructor(
    private db: DatabaseSync,
    private now: () => number,
    private eventSink: (kind: string, detail: string) => void,
  ) {
    migrateDigestMembership(db);
    // Index immutable delivery identities without rewriting historical records.
    db.exec(
      "CREATE INDEX IF NOT EXISTS digest_dispatch_prefix ON agent_digest_revisions(substr(json_extract(data,'$.dispatchId'),1,8))",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS digest_events_by_kind ON agent_digest_events(digest_id,kind,sequence)",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS digest_events_by_digest ON agent_digest_events(digest_id,sequence)",
    );
  }
  archivedInspection(agentId: string): ArchivedInspection | undefined {
    const row = this.statement("SELECT value FROM settings WHERE key=?").get(
      `digest-archive-check:${agentId}`,
    );
    return row === undefined
      ? undefined
      : archivedInspection(JSON.parse(String(row["value"])));
  }
  saveArchivedInspection(agentId: string, value: ArchivedInspection): void {
    archivedInspection(value);
    this.statement(
      "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(`digest-archive-check:${agentId}`, JSON.stringify(value));
  }
  clearArchivedInspection(agentId: string): void {
    this.statement("DELETE FROM settings WHERE key=?").run(
      `digest-archive-check:${agentId}`,
    );
  }
  private dispatchId(): string {
    return allocateMessageId(this.db);
  }

  findDelivery(id: string): DigestRevision | undefined {
    if (!/^[a-f0-9-]{8,36}$/u.test(id))
      throw new Error("Invalid message receipt ID");
    const rows = this.statement(
      "SELECT data FROM agent_digest_revisions WHERE substr(json_extract(data,'$.dispatchId'),1,8)=? AND replace(json_extract(data,'$.dispatchId'),'-','') LIKE ? LIMIT 2",
    ).all(id.slice(0, 8), `${id.replaceAll("-", "")}%`);
    if (rows.length === 0) return undefined;
    if (rows.length > 1)
      throw new Error("Invalid ambiguous message receipt ID");
    return revision(JSON.parse(String(rows[0]?.["data"])));
  }
  delivery(id: string): DigestRevision {
    const found = this.findDelivery(id);
    if (found === undefined) throw new Error("Message receipt not found");
    return found;
  }
  list(agentId?: string): Digest[] {
    const rows =
      agentId === undefined
        ? this.statement("SELECT data FROM agent_digests ORDER BY rowid").all()
        : this.statement(
            "SELECT data FROM agent_digests WHERE agent_id=? ORDER BY rowid",
          ).all(agentId);
    return rows.map((row) => digest(JSON.parse(String(row["data"]))));
  }
  cleanup(agentId: string): Digest[] {
    return this.statement(
      "SELECT data FROM agent_digests WHERE agent_id=? AND state IN ('received','cancelled') AND json_extract(data,'$.cleanupPending') IS NOT 0 ORDER BY rowid",
    )
      .all(agentId)
      .map((row) => digest(JSON.parse(String(row["data"]))));
  }
  get(id: string): Digest {
    let row = this.statement("SELECT data FROM agent_digests WHERE id=?").get(
      id,
    );
    if (row === undefined) {
      const ids = this.statement("SELECT id FROM agent_digests ORDER BY rowid")
        .all()
        .map((value) => String(value["id"]));
      const full = resolveId(id, ids);
      if (full === undefined) throw new Error("Digest not found");
      row = this.statement("SELECT data FROM agent_digests WHERE id=?").get(
        full,
      );
    }
    if (row === undefined) throw new Error("Digest not found");
    return digest(JSON.parse(String(row["data"])));
  }
  active(agentId: string): Digest | undefined {
    const row = this.statement(
      "SELECT data FROM agent_digests WHERE agent_id=? AND state NOT IN ('received','cancelled') ORDER BY rowid LIMIT 1",
    ).get(agentId);
    return row === undefined
      ? undefined
      : digest(JSON.parse(String(row["data"])));
  }
  coveredMessageIds(agentId: string): Set<string> {
    return new Set(
      this.statement(
        "SELECT DISTINCT m.message_id FROM agent_digest_members m JOIN agent_digests d ON d.id=m.digest_id WHERE d.agent_id=?",
      )
        .all(agentId)
        .map((row) => String(row["message_id"])),
    );
  }
  revisions(id: string): DigestRevision[] {
    return this.statement(
      "SELECT data FROM agent_digest_revisions WHERE digest_id=? ORDER BY revision",
    )
      .all(id)
      .map((row) => revision(JSON.parse(String(row["data"]))));
  }
  version(id: string, number: number): DigestRevision {
    const row = this.statement(
      "SELECT data FROM agent_digest_revisions WHERE digest_id=? AND revision=?",
    ).get(id, number);
    if (row === undefined) throw new Error("Digest revision not found");
    return revision(JSON.parse(String(row["data"])));
  }

  hasEvent(id: string, kind: string): boolean {
    return (
      this.statement(
        "SELECT 1 FROM agent_digest_events WHERE digest_id=? AND kind=? LIMIT 1",
      ).get(id, kind) !== undefined
    );
  }
  events(id: string, kinds?: readonly string[], limit?: number): DigestEvent[] {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))
      throw new Error("Invalid digest event limit");
    if (kinds?.length === 0 || limit === 0) return [];
    const filter =
      kinds === undefined
        ? ""
        : ` AND kind IN (${kinds.map(() => "?").join(",")})`;
    const index =
      kinds === undefined ? "digest_events_by_digest" : "digest_events_by_kind";
    const rows = this.statement(
      `SELECT sequence,digest_id AS digestId,agent_id AS agentId,at_ms AS at,kind,detail FROM agent_digest_events INDEXED BY ${index} WHERE digest_id=?${filter} ORDER BY sequence${limit === undefined ? "" : " DESC LIMIT ?"}`,
    ).all(id, ...(kinds ?? []), ...(limit === undefined ? [] : [limit]));
    if (limit !== undefined) rows.reverse();
    return rows.map((row) =>
      digestEvent({
        ...row,
        detail: JSON.parse(String(row["detail"])) as unknown,
      }),
    );
  }
  create(
    agentId: string,
    transport: QueueTransport,
    render: (receiptId: string) => {
      body: string;
      messageIds: string[];
      mergeTarget?: ReceiptTarget;
    },
  ): Digest {
    const existing = this.active(agentId);
    if (existing !== undefined) return existing;
    const at = this.now(),
      id = randomUUID(),
      dispatchId = this.dispatchId(),
      content = render(dispatchId),
      value: Digest = {
        id,
        agentId,
        transport,
        cleanupPending: true,
        state: DigestState.Ready,
        revision: 1,
        createdAt: at,
        updatedAt: at,
        nextCheckAt: at,
      };
    this.transaction(() => {
      this.write(value);
      this.insertVersion({
        ...content,
        dispatchId,
        digestId: id,
        revision: 1,
        createdAt: at,
      });
      this.event(agentId, id, "digest_created", {
        revision: 1,
        messages: content.messageIds,
      });
    });
    return value;
  }
  revise(
    value: Digest,
    render: (receiptId: string) => {
      body: string;
      messageIds: string[];
      mergeTarget?: ReceiptTarget;
    },
  ): Digest {
    const previous = this.version(value.id, value.revision);
    const current = render(previous.dispatchId);
    if (
      JSON.stringify(current.messageIds) ===
        JSON.stringify(previous.messageIds) &&
      current.body === previous.body &&
      JSON.stringify(current.mergeTarget) ===
        JSON.stringify(previous.mergeTarget)
    )
      return value;
    const dispatchId = this.dispatchId();
    const content = render(dispatchId);
    const next = {
      ...value,
      revision: value.revision + 1,
      updatedAt: this.now(),
      nextCheckAt: this.now(),
    };
    this.transaction(() => {
      this.write(next);
      this.insertVersion({
        ...content,
        dispatchId,
        digestId: value.id,
        revision: next.revision,
        createdAt: this.now(),
      });
      this.event(value.agentId, value.id, "digest_revised", {
        revision: next.revision,
        messages: content.messageIds,
      });
    });
    return next;
  }
  private insertVersion(value: DigestRevision): void {
    revision(value);
    this.statement("INSERT INTO agent_digest_revisions VALUES(?,?,?)").run(
      value.digestId,
      value.revision,
      JSON.stringify(value),
    );
  }
  private write(value: Digest): void {
    digest(value);
    this.statement(
      "INSERT INTO agent_digests(id,agent_id,state,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data",
    ).run(value.id, value.agentId, value.state, JSON.stringify(value));
  }
  save(value: Digest, kind: string, detail: unknown = {}): Digest {
    const next = { ...value, updatedAt: this.now() };
    this.transaction(() => {
      this.write(next);
      this.event(value.agentId, value.id, kind, detail);
    });
    return next;
  }
  defer(value: Digest, nextCheckAt: number): void {
    this.write({ ...value, nextCheckAt });
  }
  event(
    agentId: string,
    digestId: string | undefined,
    kind: string,
    detail: unknown,
  ): void {
    this.statement(
      "INSERT INTO agent_digest_events(digest_id,agent_id,at_ms,kind,detail) VALUES(?,?,?,?,?)",
    ).run(digestId ?? null, agentId, this.now(), kind, JSON.stringify(detail));
    const reason =
      typeof detail === "object" &&
      detail !== null &&
      "reason" in detail &&
      typeof detail.reason === "string"
        ? detail.reason
        : undefined;
    this.eventSink(
      kind,
      `${kind.replaceAll("_", " ")} · agent ${agentId}${reason === undefined ? "" : ` · ${reason}`}`,
    );
  }
  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  receipts(id: string): { revision: number; agentId: string; at: number }[] {
    return this.statement(
      "SELECT revision,agent_id,at_ms FROM agent_digest_receipts WHERE digest_id=? ORDER BY revision",
    )
      .all(id)
      .map((row) => ({
        revision: Number(row["revision"]),
        agentId: String(row["agent_id"]),
        at: Number(row["at_ms"]),
      }));
  }
  receipt(
    id: string,
    number: number,
  ): { agentId: string; at: number } | undefined {
    const row = this.statement(
      "SELECT agent_id,at_ms FROM agent_digest_receipts WHERE digest_id=? AND revision=?",
    ).get(id, number);
    return row === undefined
      ? undefined
      : { agentId: String(row["agent_id"]), at: Number(row["at_ms"]) };
  }
  receiveInside(value: Digest, number: number): void {
    if (!this.db.isTransaction)
      throw new Error("Digest receipt requires a coordinator transaction");
    const inserted = this.statement(
      "INSERT OR IGNORE INTO agent_digest_receipts VALUES(?,?,?,?)",
    ).run(value.id, number, value.agentId, this.now());
    if (Number(inserted.changes) === 0) return;
    this.write({
      ...this.get(value.id),
      state: DigestState.Received,
      updatedAt: this.now(),
      nextCheckAt: this.now(),
    });
    this.event(value.agentId, value.id, "digest_received", {
      revision: number,
    });
  }
  recover(): void {
    for (const value of this.list())
      if (
        value.state === DigestState.Withdrawing ||
        value.state === DigestState.Enqueueing
      )
        this.save(
          { ...value, state: DigestState.Uncertain, nextCheckAt: this.now() },
          "digest_recovery",
          { reason: "Coordinator interrupted a queue operation" },
        );
  }
}
