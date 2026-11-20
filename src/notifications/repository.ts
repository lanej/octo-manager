import { randomUUID } from "node:crypto";
import { renderNotice } from "../security/notifications.js";
import { shortId } from "../tracking/identifiers.js";
import { parseNotice, type SafeNotice } from "../security/notifications.js";
import type { AgentMessage } from "./message.js";
import { nextInboxSequence } from "../submissions/schema.js";
import { compactId } from "../tracking/identifiers.js";
import type { DatabaseSync } from "node:sqlite";

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
  "(NOT EXISTS(SELECT 1 FROM safe_notice_replacements r WHERE r.original_id=m.delivery_id) AND NOT EXISTS(SELECT 1 FROM safe_notice_supersessions s WHERE s.original_id=m.delivery_id) AND p.enabled=1 AND (p.owner_agent_id=d.recipient_agent_id OR EXISTS(SELECT 1 FROM pr_subscriptions s WHERE s.pr_id=p.id AND s.agent_id=d.recipient_agent_id)) AND a.state IN ('open','acknowledged','working') AND d.state!='cancelled')";
const query = `SELECT m.*,d.action_id,d.recipient_agent_id,
  NULL AS submission_id,NULL AS participant_pr_id,NULL AS workflow_pr_id, ${applicable} AS applicable
  FROM delivery_messages m JOIN deliveries d ON d.id=m.delivery_id
  JOIN actions a ON a.id=d.action_id JOIN tracked_prs p ON p.id=a.pr_id`;
const workflowMessagesQuery = `SELECT * FROM (${query} UNION ALL SELECT sequence,id AS delivery_id,body,created_at_ms,acknowledged_at_ms,next_check_at_ms,'' AS action_id,recipient_agent_id,submission_id,NULL AS participant_pr_id,NULL AS workflow_pr_id,applicable FROM operation_notifications UNION ALL SELECT m.sequence,m.id,m.body,m.created_at_ms,m.acknowledged_at_ms,m.next_check_at_ms,'' AS action_id,m.recipient_agent_id,NULL AS submission_id,m.pr_id AS participant_pr_id,NULL AS workflow_pr_id,(p.enabled=1 AND m.revision=r.revision AND (p.owner_agent_id=m.recipient_agent_id OR EXISTS(SELECT 1 FROM pr_subscriptions s WHERE s.pr_id=p.id AND s.agent_id=m.recipient_agent_id))) AS applicable FROM participant_messages m JOIN tracked_prs p ON p.id=m.pr_id JOIN pr_participant_revisions r ON r.pr_id=p.id UNION ALL SELECT m.sequence,m.id,m.body,m.created_at_ms,m.acknowledged_at_ms,m.next_check_at_ms,'' AS action_id,m.recipient_agent_id,NULL AS submission_id,NULL AS participant_pr_id,m.pr_id AS workflow_pr_id,(m.applicable=1 AND p.enabled=1 AND (substr(m.subject_id,1,6)!='ready:' OR EXISTS(SELECT 1 FROM actions a WHERE a.id=substr(m.subject_id,7) AND a.state IN ('open','acknowledged','working'))) AND (p.owner_agent_id=m.recipient_agent_id OR EXISTS(SELECT 1 FROM pr_subscriptions s WHERE s.pr_id=p.id AND s.agent_id=m.recipient_agent_id))) AS applicable FROM merge_notices m JOIN tracked_prs p ON p.id=m.pr_id)`;
const canonicalMessagesQuery = `SELECT * FROM (SELECT *,NULL AS issue_id FROM (${workflowMessagesQuery}) UNION ALL SELECT sequence,id AS delivery_id,body,created_at_ms,acknowledged_at_ms,next_check_at_ms,'' AS action_id,recipient_agent_id,NULL AS submission_id,NULL AS participant_pr_id,NULL AS workflow_pr_id,applicable,issue_id FROM issue_notices)`;
const messagesQuery = `SELECT * FROM (SELECT m.sequence,m.delivery_id,m.body,m.created_at_ms,m.acknowledged_at_ms,m.next_check_at_ms,m.action_id,m.recipient_agent_id,m.submission_id,m.participant_pr_id,m.workflow_pr_id,(m.applicable AND NOT EXISTS(SELECT 1 FROM safe_notice_replacements r WHERE r.original_id=m.delivery_id)) AS applicable,m.issue_id FROM (${canonicalMessagesQuery}) m UNION ALL SELECT r.sequence,r.id,r.body,r.created_at_ms,r.acknowledged_at_ms,r.next_check_at_ms,m.action_id,m.recipient_agent_id,m.submission_id,m.participant_pr_id,m.workflow_pr_id,m.applicable,m.issue_id FROM safe_recovery_messages r JOIN (${canonicalMessagesQuery}) m ON m.delivery_id=r.original_id)`;

function decode(row: Record<string, unknown>): AgentMessage {
  return {
    sequence: integer(row["sequence"]),
    id: text(row["delivery_id"]),
    actionId: typeof row["action_id"] === "string" ? row["action_id"] : "",
    ...(typeof row["submission_id"] === "string"
      ? { submissionId: row["submission_id"] }
      : {}),
    ...(typeof row["participant_pr_id"] === "string"
      ? { participantPRId: row["participant_pr_id"] }
      : {}),
    ...(typeof row["workflow_pr_id"] === "string"
      ? { workflowPRId: row["workflow_pr_id"] }
      : {}),
    ...(typeof row["issue_id"] === "string"
      ? { issueId: row["issue_id"] }
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
export class NotificationRepository {
  constructor(
    private db: DatabaseSync,
    private now: () => number,
  ) {}
  recoverWorkflows(): void {
    const rows = this.db
      .prepare(
        `${messagesQuery} WHERE action_id='' AND applicable=1 AND acknowledged_at_ms IS NULL AND NOT EXISTS(SELECT 1 FROM safe_agent_notices n WHERE n.message_id=delivery_id)`,
      )
      .all();
    for (const row of rows) {
      const message = decode(row),
        id = randomUUID();
      const subject: SafeNotice["subject"] =
        message.issueId !== undefined
          ? { kind: "issue", id: message.issueId }
          : message.submissionId !== undefined
            ? { kind: "submission", id: message.submissionId }
            : undefined;
      const prId = message.participantPRId ?? message.workflowPRId;
      const pr =
        prId === undefined
          ? undefined
          : this.db
              .prepare("SELECT url FROM tracked_prs WHERE id=?")
              .get(prId)?.["url"];
      const notice: SafeNotice = {
        version: 1,
        kind:
          message.issueId !== undefined
            ? "issue"
            : message.submissionId !== undefined
              ? "submission"
              : message.participantPRId !== undefined
                ? "participants"
                : "merge",
        assessment: "not_required",
        ...(subject === undefined ? {} : { subject }),
        ...(typeof pr === "string" ? { prUrl: pr } : {}),
      };
      this.freezeNotice(id, notice);
      this.db
        .prepare("INSERT INTO safe_recovery_messages VALUES(?,?,?,?,?,NULL,?)")
        .run(
          nextInboxSequence(this.db),
          id,
          message.id,
          renderNotice(this.notice(id) ?? notice, id, ""),
          this.now(),
          this.now(),
        );
      this.markReplacement(message.id, id);
    }
  }
  isReplaced(id: string): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM safe_notice_replacements WHERE original_id=? UNION ALL SELECT 1 FROM safe_notice_supersessions WHERE original_id=?",
        )
        .get(id, id) !== undefined
    );
  }
  supersede(originalId: string, replacementId: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO safe_notice_supersessions(original_id,replacement_id) VALUES(?,?)",
      )
      .run(originalId, replacementId);
  }
  markReplacement(originalId: string, replacementId: string): void {
    this.db
      .prepare(
        "INSERT INTO safe_notice_replacements(original_id,replacement_id) VALUES(?,?)",
      )
      .run(originalId, replacementId);
  }
  freezeNotice(id: string, notice: SafeNotice): void {
    parseNotice(notice);
    const ids = (table: string, column = "id") =>
      this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(table) === undefined
        ? []
        : this.db
            .prepare(`SELECT ${column} FROM ${table}`)
            .all()
            .map((row) => String(row[column]));
    const messages = [
      ...ids("deliveries"),
      ...ids("operation_notifications"),
      ...ids("participant_messages"),
      ...ids("merge_notices"),
      ...ids("issue_notices"),
      ...ids("safe_recovery_messages"),
      id,
    ];
    const action = this.db
      .prepare("SELECT action_id FROM deliveries WHERE id=?")
      .get(id)?.["action_id"];
    const reference = (value: string, namespace: string[]) =>
      /^[a-f0-9-]{8,36}$/u.test(value)
        ? shortId(value, namespace)
        : "unavailable";
    const references = {
      message: reference(id, messages),
      action:
        typeof action === "string" ? reference(action, ids("actions")) : "none",
      ...(notice.assessmentId === undefined
        ? {}
        : {
            assessment: reference(
              notice.assessmentId,
              ids("evidence_assessments"),
            ),
          }),
      ...(notice.subject === undefined
        ? {}
        : {
            subject: reference(
              notice.subject.id,
              ids(
                notice.subject.kind === "action"
                  ? "actions"
                  : notice.subject.kind === "issue"
                    ? "managed_issues"
                    : notice.subject.kind === "submission"
                      ? "pr_submissions"
                      : notice.subject.kind === "merge_entry"
                        ? "merge_entries"
                        : "pr_references",
              ),
            ),
          }),
    };
    notice = { ...notice, references };
    this.db
      .prepare(
        "INSERT OR IGNORE INTO safe_agent_notices(message_id,notice_json) VALUES(?,?)",
      )
      .run(id, JSON.stringify(notice));
  }
  notice(id: string): SafeNotice | undefined {
    const row = this.db
      .prepare("SELECT notice_json FROM safe_agent_notices WHERE message_id=?")
      .get(id);
    return row === undefined
      ? undefined
      : parseNotice(JSON.parse(String(row["notice_json"])));
  }
  private withNotice(message: AgentMessage): AgentMessage {
    const notice = this.notice(message.id);
    return notice === undefined ? message : { ...message, notice };
  }
  get(id: string): AgentMessage | undefined {
    const row = this.db.prepare(`${messagesQuery} WHERE delivery_id=?`).get(id);
    if (row !== undefined) return this.withNotice(decode(row));
    const prefix = compactId(id);
    if (!/^[a-f0-9]{8,32}$/.test(prefix)) return undefined;
    const matches = this.db
      .prepare(
        `${messagesQuery} WHERE replace(delivery_id,'-','') LIKE ? LIMIT 2`,
      )
      .all(prefix + "%");
    if (matches.length > 1)
      throw new Error("Invalid ambiguous ID prefix; use a longer ID");
    return matches[0] === undefined
      ? undefined
      : this.withNotice(decode(matches[0]));
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
    const messages = rows
      .slice(0, 200)
      .map((row) => this.withNotice(decode(row)));
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
        this.db
          .prepare("SELECT 1 FROM safe_recovery_messages WHERE id=?")
          .get(message.id) !== undefined
          ? "UPDATE safe_recovery_messages SET acknowledged_at_ms=? WHERE id=? AND acknowledged_at_ms IS NULL"
          : message.issueId !== undefined
            ? "UPDATE issue_notices SET acknowledged_at_ms=? WHERE id=? AND acknowledged_at_ms IS NULL"
            : message.workflowPRId !== undefined
              ? "UPDATE merge_notices SET acknowledged_at_ms=? WHERE id=? AND acknowledged_at_ms IS NULL"
              : message.participantPRId !== undefined
                ? "UPDATE participant_messages SET acknowledged_at_ms=? WHERE id=? AND acknowledged_at_ms IS NULL"
                : message.submissionId === undefined
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
