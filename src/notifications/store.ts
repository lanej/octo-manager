import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  DigestState,
  digest,
  revision,
  digestEvent,
  terminal,
  type Digest,
  type DigestRevision,
  type DigestEvent,
  type QueueTransport,
} from "./types.js";
import { resolveId } from "../tracking/identifiers.js";
export class DigestStore {
  constructor(
    private db: DatabaseSync,
    private now: () => number,
    private eventSink: (kind: string, detail: string) => void,
  ) {
    // Index immutable delivery identities without rewriting historical records.
    db.exec(
      "CREATE INDEX IF NOT EXISTS digest_dispatch_prefix ON agent_digest_revisions(substr(json_extract(data,'$.dispatchId'),1,8))",
    );
  }
  private dispatchId(): string {
    for (let attempt = 0; attempt < 32; attempt++) {
      const id = randomUUID();
      if (
        this.db
          .prepare(
            "SELECT 1 FROM agent_digest_revisions WHERE substr(json_extract(data,'$.dispatchId'),1,8)=? LIMIT 1",
          )
          .get(id.slice(0, 8)) === undefined
      )
        return id;
    }
    throw new Error("Unable to allocate a unique message receipt ID");
  }
  delivery(id: string): DigestRevision {
    if (!/^[a-f0-9-]{8,36}$/u.test(id))
      throw new Error("Invalid message receipt ID");
    const rows = this.db
      .prepare(
        "SELECT data FROM agent_digest_revisions WHERE substr(json_extract(data,'$.dispatchId'),1,8)=? AND replace(json_extract(data,'$.dispatchId'),'-','') LIKE ? LIMIT 2",
      )
      .all(id.slice(0, 8), `${id.replaceAll("-", "")}%`);
    if (rows.length !== 1)
      throw new Error(
        rows.length === 0
          ? "Message receipt not found"
          : "Invalid ambiguous message receipt ID",
      );
    return revision(JSON.parse(String(rows[0]?.["data"])));
  }
  list(agentId?: string): Digest[] {
    return this.db
      .prepare(
        "SELECT data FROM agent_digests WHERE (? IS NULL OR agent_id=?) ORDER BY rowid",
      )
      .all(agentId ?? null, agentId ?? null)
      .map((row) => digest(JSON.parse(String(row["data"]))));
  }
  get(id: string): Digest {
    const rows = this.list(),
      full = resolveId(
        id,
        rows.map((row) => row.id),
      ),
      value = rows.find((row) => row.id === full);
    if (value === undefined) throw new Error("Digest not found");
    return value;
  }
  active(agentId: string): Digest | undefined {
    return this.list(agentId).find((value) => !terminal(value));
  }
  revisions(id: string): DigestRevision[] {
    return this.db
      .prepare(
        "SELECT data FROM agent_digest_revisions WHERE digest_id=? ORDER BY revision",
      )
      .all(id)
      .map((row) => revision(JSON.parse(String(row["data"]))));
  }
  version(id: string, number: number): DigestRevision {
    const value = this.revisions(id).find((value) => value.revision === number);
    if (value === undefined) throw new Error("Digest revision not found");
    return value;
  }
  events(id: string): DigestEvent[] {
    return this.db
      .prepare(
        "SELECT sequence,digest_id AS digestId,agent_id AS agentId,at_ms AS at,kind,detail FROM agent_digest_events WHERE digest_id=? ORDER BY sequence",
      )
      .all(id)
      .map((row) =>
        digestEvent({
          ...row,
          detail: JSON.parse(String(row["detail"])) as unknown,
        }),
      );
  }
  create(
    agentId: string,
    transport: QueueTransport,
    render: (receiptId: string) => { body: string; messageIds: string[] },
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
    render: (receiptId: string) => { body: string; messageIds: string[] },
  ): Digest {
    const previous = this.version(value.id, value.revision);
    const current = render(previous.dispatchId);
    if (
      JSON.stringify(current.messageIds) ===
        JSON.stringify(previous.messageIds) &&
      current.body === previous.body
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
    this.db
      .prepare("INSERT INTO agent_digest_revisions VALUES(?,?,?)")
      .run(value.digestId, value.revision, JSON.stringify(value));
  }
  private write(value: Digest): void {
    digest(value);
    this.db
      .prepare(
        "INSERT INTO agent_digests(id,agent_id,state,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data",
      )
      .run(value.id, value.agentId, value.state, JSON.stringify(value));
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
    this.db
      .prepare(
        "INSERT INTO agent_digest_events(digest_id,agent_id,at_ms,kind,detail) VALUES(?,?,?,?,?)",
      )
      .run(digestId ?? null, agentId, this.now(), kind, JSON.stringify(detail));
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
    return this.db
      .prepare(
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
    const row = this.db
      .prepare(
        "SELECT agent_id,at_ms FROM agent_digest_receipts WHERE digest_id=? AND revision=?",
      )
      .get(id, number);
    return row === undefined
      ? undefined
      : { agentId: String(row["agent_id"]), at: Number(row["at_ms"]) };
  }
  receiveInside(value: Digest, number: number): void {
    if (!this.db.isTransaction)
      throw new Error("Digest receipt requires a coordinator transaction");
    const inserted = this.db
      .prepare("INSERT OR IGNORE INTO agent_digest_receipts VALUES(?,?,?,?)")
      .run(value.id, number, value.agentId, this.now());
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
