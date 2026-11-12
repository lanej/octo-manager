import { nextInboxSequence } from "../submissions/schema.js";
import { compactId } from "./identifiers.js";
import type { DatabaseSync } from "node:sqlite";

export interface AgentMessage {
  sequence: number;
  id: string;
  actionId: string;
  submissionId?: string;
  recipientAgentId: string;
  body: string;
  createdAt: number;
  acknowledgedAt?: number;
  nextCheckAt: number;
  applicable: boolean;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid inbox integer");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value === "")
    throw new Error("Invalid inbox text");
  return value;
}
const applicable =
  "(p.enabled=1 AND a.owner_agent_id=d.recipient_agent_id AND a.state IN ('open','acknowledged','working') AND d.state!='cancelled')";
const query = `SELECT m.*,d.action_id,d.recipient_agent_id,
  NULL AS submission_id, ${applicable} AS applicable
  FROM delivery_messages m JOIN deliveries d ON d.id=m.delivery_id
  JOIN actions a ON a.id=d.action_id JOIN tracked_prs p ON p.id=a.pr_id`;
const messagesQuery = `SELECT * FROM (${query} UNION ALL SELECT sequence,id AS delivery_id,body,created_at_ms,acknowledged_at_ms,next_check_at_ms,'' AS action_id,recipient_agent_id,submission_id,applicable FROM operation_notifications)`;
function decode(row: Record<string, unknown>): AgentMessage {
  return {
    sequence: integer(row["sequence"]),
    id: text(row["delivery_id"]),
    actionId: typeof row["action_id"] === "string" ? row["action_id"] : "",
    ...(typeof row["submission_id"] === "string"
      ? { submissionId: row["submission_id"] }
      : {}),
    recipientAgentId: text(row["recipient_agent_id"]),
    body: text(row["body"]),
    createdAt: integer(row["created_at_ms"]),
    nextCheckAt: integer(row["next_check_at_ms"]),
    applicable: row["applicable"] === 1,
    ...(row["acknowledged_at_ms"] === null
      ? {}
      : { acknowledgedAt: integer(row["acknowledged_at_ms"]) }),
  };
}
export class AgentInbox {
  constructor(
    private db: DatabaseSync,
    private now: () => number,
  ) {}
  get(id: string): AgentMessage | undefined {
    const row = this.db.prepare(`${messagesQuery} WHERE delivery_id=?`).get(id);
    if (row !== undefined) return decode(row);
    const prefix = compactId(id);
    if (!/^[a-f0-9]{8,32}$/.test(prefix)) return undefined;
    const matches = this.db
      .prepare(
        `${messagesQuery} WHERE replace(delivery_id,'-','') LIKE ? LIMIT 2`,
      )
      .all(prefix + "%");
    if (matches.length > 1)
      throw new Error("Invalid ambiguous ID prefix; use a longer ID");
    return matches[0] === undefined ? undefined : decode(matches[0]);
  }
  record(id: string, body: string): AgentMessage {
    const previous = this.get(id);
    if (previous !== undefined) return previous;
    if (body === "" || body.length > 1024 * 1024)
      throw new Error("Invalid inbox message size");
    this.db
      .prepare(
        "INSERT INTO delivery_messages(sequence,delivery_id,body,created_at_ms,next_check_at_ms) VALUES(?,?,?,?,?)",
      )
      .run(nextInboxSequence(this.db), id, body, this.now(), this.now());
    const result = this.get(id);
    if (result === undefined) throw new Error("Message was not recorded");
    return result;
  }
  list(
    agentId: string,
    after = 0,
    includeAcknowledged = false,
    applicableOnly = false,
  ): { messages: AgentMessage[]; nextSequence: number; hasMore: boolean } {
    integer(after);
    const rows = this.db
      .prepare(
        `${messagesQuery} WHERE recipient_agent_id=? AND sequence>? AND (?=1 OR acknowledged_at_ms IS NULL) AND (?=0 OR applicable=1) ORDER BY sequence LIMIT 201`,
      )
      .all(agentId, after, includeAcknowledged ? 1 : 0, applicableOnly ? 1 : 0);
    const messages = rows.slice(0, 200).map(decode);
    return {
      messages,
      nextSequence: messages.at(-1)?.sequence ?? after,
      hasMore: rows.length > 200,
    };
  }
  acknowledge(id: string, agentId: string): AgentMessage {
    const message = this.get(id);
    if (message === undefined) throw new Error("Message not found");
    if (message.recipientAgentId !== agentId)
      throw new Error("Message belongs to another agent");
    if (message.acknowledgedAt !== undefined) return message;
    this.db
      .prepare(
        message.submissionId === undefined
          ? "UPDATE delivery_messages SET acknowledged_at_ms=? WHERE delivery_id=? AND acknowledged_at_ms IS NULL"
          : "UPDATE operation_notifications SET acknowledged_at_ms=? WHERE id=? AND acknowledged_at_ms IS NULL",
      )
      .run(this.now(), message.id);
    const result = this.get(message.id);
    if (result === undefined)
      throw new Error("Message not found after acknowledgment");
    return result;
  }
  defer(id: string, at: number): void {
    this.db
      .prepare(
        "UPDATE delivery_messages SET next_check_at_ms=? WHERE delivery_id=?",
      )
      .run(integer(at), id);
  }
}
export function migrateInbox(db: DatabaseSync): void {
  const version = db.prepare("PRAGMA user_version").get()?.["user_version"];
  if (version === 7 || version === 8 || version === 9) return;
  if (version !== 6) throw new Error("Unsupported inbox database version");
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE delivery_messages (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      delivery_id TEXT NOT NULL UNIQUE REFERENCES deliveries(id),
      body TEXT NOT NULL CHECK(length(body)>0 AND length(body)<=1048576),
      created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
      acknowledged_at_ms INTEGER CHECK(acknowledged_at_ms IS NULL OR acknowledged_at_ms>=0),
      next_check_at_ms INTEGER NOT NULL CHECK(next_check_at_ms>=0)
    ) STRICT;
    CREATE INDEX unread_messages ON delivery_messages(next_check_at_ms) WHERE acknowledged_at_ms IS NULL;
    CREATE TRIGGER immutable_message BEFORE UPDATE OF sequence,delivery_id,body,created_at_ms ON delivery_messages BEGIN SELECT RAISE(ABORT,'Message payload is immutable'); END;
    CREATE TRIGGER immutable_message_recipient BEFORE UPDATE OF action_id,recipient_agent_id ON deliveries WHEN EXISTS(SELECT 1 FROM delivery_messages WHERE delivery_id=OLD.id) BEGIN SELECT RAISE(ABORT,'Message destination is immutable'); END;
    CREATE TRIGGER monotonic_message_receipt BEFORE UPDATE OF acknowledged_at_ms ON delivery_messages WHEN OLD.acknowledged_at_ms IS NOT NULL AND NEW.acknowledged_at_ms IS NOT OLD.acknowledged_at_ms BEGIN SELECT RAISE(ABORT,'Message receipt is immutable'); END;
    PRAGMA user_version=7; COMMIT;`);
}
