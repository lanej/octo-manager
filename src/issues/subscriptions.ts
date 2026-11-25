import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { NotificationRepository } from "../notifications/repository.js";
import { renderDirectNotice } from "../notifications/render.js";
import type { SafeNotice } from "../security/notifications.js";
import { nextInboxSequence } from "../submissions/schema.js";
import { IssueNotificationKind, Waiting, IssueStage } from "./contracts.js";
import type { IssueRecord, TrackerObservation } from "./contracts.js";

const defaults = [
  IssueNotificationKind.Coordinator,
  IssueNotificationKind.RefreshFailure,
  IssueNotificationKind.RefreshRecovery,
];
const kindSchema = Type.Enum(IssueNotificationKind);
const selection = Type.Array(kindSchema, {
  maxItems: 8,
  uniqueItems: true,
});
const snapshot = Type.Object({
  title: Type.String(),
  body: Type.String(),
  closed: Type.Boolean(),
  revision: Type.String(),
  comments: Type.Array(
    Type.Object({ id: Type.String(), revision: Type.String() }),
  ),
});
const failureEvidence = Type.Object({
  detail: Type.String(),
  digest: Type.String(),
  truncated: Type.Boolean(),
  revision: Type.String(),
});
const evidence = Type.Object({
  id: Type.String(),
  issueId: Type.String(),
  kind: Type.Enum(IssueNotificationKind),
  revision: Type.String(),
  before: Type.String(),
  after: Type.String(),
  beforeTruncated: Type.Boolean(),
  afterTruncated: Type.Boolean(),
  beforeDigest: Type.String(),
  afterDigest: Type.String(),
  commentId: Type.String(),
  commentRevision: Type.String(),
  url: Type.String(),
  at: Type.Integer({ minimum: 0 }),
});
export type IssueNotificationEvidence = Static<typeof evidence>;
export interface IssueSubscription {
  issueId: string;
  agentId: string;
  explicit: boolean;
  mode: "legacy" | "selected";
  events: IssueNotificationKind[];
}
function parsed(value: unknown): unknown {
  if (typeof value !== "string")
    throw new Error("Invalid stored issue subscription");
  const decoded: unknown = JSON.parse(value);
  return decoded;
}
function events(value: unknown): IssueNotificationKind[] {
  const decoded = parsed(value);
  if (!Check(selection, decoded))
    throw new Error("Invalid stored issue event selection");
  return decoded;
}
function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Delivery preferences never mutate issue execution or enrollment state. */
export class IssueSubscriptions {
  constructor(
    private db: DatabaseSync,
    private now: () => number,
    private notifications?: NotificationRepository,
    private changed?: () => void,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS issue_subscriptions(issue_id TEXT NOT NULL REFERENCES managed_issues(id),agent_id TEXT NOT NULL REFERENCES agent_refs(id),events TEXT CHECK(events IS NULL OR json_valid(events)),PRIMARY KEY(issue_id,agent_id)) STRICT;
CREATE TABLE IF NOT EXISTS issue_source_observations(issue_id TEXT PRIMARY KEY REFERENCES managed_issues(id),data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
CREATE TABLE IF NOT EXISTS issue_notification_events(id TEXT PRIMARY KEY,issue_id TEXT NOT NULL REFERENCES managed_issues(id),data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
CREATE TABLE IF NOT EXISTS issue_notification_members(message_id TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES issue_notification_events(id),kind TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS issue_notification_status(issue_id TEXT PRIMARY KEY REFERENCES managed_issues(id),kind TEXT NOT NULL,revision TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS issue_refresh_failures(issue_id TEXT PRIMARY KEY REFERENCES managed_issues(id),data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
CREATE TRIGGER IF NOT EXISTS immutable_issue_notification_event BEFORE UPDATE ON issue_notification_events BEGIN SELECT RAISE(ABORT,'Issue event evidence is immutable'); END;`);
  }
  list(issue: IssueRecord): IssueSubscription[] {
    const rows = this.db
      .prepare(
        "SELECT agent_id,events FROM issue_subscriptions WHERE issue_id=? ORDER BY agent_id",
      )
      .all(issue.id);
    return [
      issue.ownerId,
      ...rows
        .map((row) => String(row["agent_id"]))
        .filter((id) => id !== issue.ownerId),
    ].map((agentId) => {
      const row = rows.find((item) => item["agent_id"] === agentId);
      return {
        issueId: issue.id,
        agentId,
        explicit: row?.["events"] != null,
        mode:
          row?.["events"] == null ? ("legacy" as const) : ("selected" as const),
        events: row?.["events"] == null ? [...defaults] : events(row["events"]),
      };
    });
  }
  private atomic<T>(work: () => T): T {
    this.db.exec("SAVEPOINT issue_notifications");
    try {
      const value = work();
      this.db.exec("RELEASE issue_notifications");
      return value;
    } catch (error) {
      this.db.exec(
        "ROLLBACK TO issue_notifications; RELEASE issue_notifications",
      );
      throw error;
    }
  }
  set(
    issue: IssueRecord,
    agentId: string,
    selected: IssueNotificationKind[] | undefined,
  ): IssueSubscription[] {
    return this.atomic(() => this.setInside(issue, agentId, selected));
  }
  private setInside(
    issue: IssueRecord,
    agentId: string,
    selected: IssueNotificationKind[] | undefined,
  ): IssueSubscription[] {
    if (
      agentId.length === 0 ||
      this.db.prepare("SELECT id FROM agent_refs WHERE id=?").get(agentId) ===
        undefined
    )
      throw new Error("Registered subscriber agent required");
    if (selected !== undefined && !Check(selection, selected))
      throw new Error("Invalid issue event selection");
    this.db
      .prepare(
        "INSERT INTO issue_subscriptions VALUES(?,?,?) ON CONFLICT(issue_id,agent_id) DO UPDATE SET events=excluded.events",
      )
      .run(
        issue.id,
        agentId,
        selected === undefined ? null : JSON.stringify(selected),
      );
    const effective = selected ?? defaults;
    // Historical digests and receipts stay immutable; current applicability fences future delivery.
    for (const row of this.db
      .prepare(
        "SELECT n.id,m.kind FROM issue_notices n LEFT JOIN issue_notification_members m ON m.message_id=n.id WHERE n.issue_id=? AND n.recipient_agent_id=? AND n.applicable=1",
      )
      .all(issue.id, agentId)) {
      const kind =
        row["kind"] == null
          ? IssueNotificationKind.Coordinator
          : String(row["kind"]);
      if (!Check(kindSchema, kind))
        throw new Error("Invalid stored issue event kind");
      if (!effective.includes(kind))
        this.db
          .prepare("UPDATE issue_notices SET applicable=0 WHERE id=?")
          .run(String(row["id"]));
    }
    this.changed?.();
    return this.list(issue);
  }
  evidence(id: string): IssueNotificationEvidence | undefined {
    const row = this.db
      .prepare("SELECT data FROM issue_notification_events WHERE id=?")
      .get(id);
    if (row === undefined) return undefined;
    const value = parsed(row["data"]);
    if (!Check(evidence, value))
      throw new Error("Invalid stored issue event evidence");
    return value;
  }
  private emit(
    issue: IssueRecord,
    kind: IssueNotificationKind,
    revision: string,
    before = "",
    after = "",
    commentId = "",
    commentRevision = "",
    url = issue.ref.url,
    retainedBefore?: { digest: string; truncated: boolean },
  ): void {
    const id = randomUUID();
    const event: IssueNotificationEvidence = {
      id,
      issueId: issue.id,
      kind,
      revision,
      before: before.slice(0, 16000),
      after: after.slice(0, 16000),
      beforeTruncated: retainedBefore?.truncated ?? before.length > 16000,
      afterTruncated: after.length > 16000,
      beforeDigest:
        retainedBefore?.digest ??
        createHash("sha256").update(before).digest("hex"),
      afterDigest: createHash("sha256").update(after).digest("hex"),
      commentId,
      commentRevision,
      url,
      at: this.now(),
    };
    this.db
      .prepare("INSERT INTO issue_notification_events VALUES(?,?,?)")
      .run(id, issue.id, JSON.stringify(event));
    if (
      this.db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name='issue_notices'",
        )
        .get() === undefined
    )
      return;
    this.changed?.();
    for (const subscription of this.list(issue)) {
      if (!subscription.events.includes(kind)) continue;
      const messageId = this.notifications?.newMessageId() ?? randomUUID();
      const notice: SafeNotice = {
        version: 1,
        kind: "issue",
        assessment: "not_required",
        subject: { kind: "issue", id: issue.id },
        issueStage: issue.stage,
        issueWaiting: issue.waiting,
        issueRevision: fingerprint(revision),
        issueEventKind: kind,
        issueEventId: id,
      };
      this.notifications?.freezeNotice(messageId, notice);
      this.db
        .prepare("INSERT INTO issue_notices VALUES(?,?,?,?,?,?,NULL,?,1)")
        .run(
          nextInboxSequence(this.db),
          messageId,
          issue.id,
          subscription.agentId,
          this.notifications?.render(messageId, notice) ??
            renderDirectNotice(notice, messageId),
          this.now(),
          this.now(),
        );
      this.db
        .prepare("INSERT INTO issue_notification_members VALUES(?,?,?)")
        .run(messageId, id, kind);
    }
  }
  failure(issue: IssueRecord, detail: string): void {
    this.atomic(() => {
      const digest = createHash("sha256").update(detail).digest("hex");
      const previous = this.db
        .prepare("SELECT data FROM issue_refresh_failures WHERE issue_id=?")
        .get(issue.id);
      if (previous !== undefined) {
        const value = parsed(previous["data"]);
        if (!Check(failureEvidence, value))
          throw new Error("Invalid stored issue refresh failure");
        if (value.digest === digest) return;
      }
      const value = {
        detail: detail.slice(0, 16000),
        digest,
        truncated: detail.length > 16000,
        revision: randomUUID(),
      };
      this.db
        .prepare(
          "INSERT INTO issue_refresh_failures VALUES(?,?) ON CONFLICT(issue_id) DO UPDATE SET data=excluded.data",
        )
        .run(issue.id, JSON.stringify(value));
      this.emit(
        issue,
        IssueNotificationKind.RefreshFailure,
        value.revision,
        "",
        detail,
      );
    });
  }
  status(issue: IssueRecord, revision: string, emit = true): void {
    if (
      this.db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name='issue_notices'",
        )
        .get() === undefined
    )
      return;
    const kind = IssueNotificationKind.Coordinator;
    const actionable =
      issue.waiting !== Waiting.None || issue.stage === IssueStage.Done;
    const effectiveRevision = actionable ? revision : "inactive";
    const previous = this.db
      .prepare(
        "SELECT kind,revision FROM issue_notification_status WHERE issue_id=?",
      )
      .get(issue.id);
    if (previous === undefined && actionable) {
      const legacy = this.db
        .prepare(
          "SELECT n.id FROM issue_notices n LEFT JOIN issue_notification_members m ON m.message_id=n.id WHERE n.issue_id=? AND n.applicable=1 AND m.message_id IS NULL ORDER BY n.sequence DESC LIMIT 1",
        )
        .get(issue.id);
      const prior =
        typeof legacy?.["id"] === "string"
          ? this.notifications?.notice(legacy["id"])
          : undefined;
      if (
        prior?.kind === "issue" &&
        prior.subject?.kind === "issue" &&
        prior.subject.id === issue.id &&
        prior.issueEventKind === undefined &&
        prior.issueRevision === revision
      ) {
        this.db
          .prepare("INSERT INTO issue_notification_status VALUES(?,?,?)")
          .run(issue.id, kind, effectiveRevision);
        return;
      }
    }
    if (
      previous?.["revision"] === effectiveRevision &&
      previous["kind"] === kind
    )
      return;
    this.db
      .prepare(
        "INSERT INTO issue_notification_status VALUES(?,?,?) ON CONFLICT(issue_id) DO UPDATE SET kind=excluded.kind,revision=excluded.revision",
      )
      .run(issue.id, kind, effectiveRevision);
    // Coordinator snapshots supersede coordinator snapshots, never retained source or refresh events.
    this.db
      .prepare(
        "UPDATE issue_notices SET applicable=0 WHERE issue_id=? AND (id NOT IN (SELECT message_id FROM issue_notification_members) OR id IN (SELECT message_id FROM issue_notification_members WHERE kind='coordinator'))",
      )
      .run(issue.id);
    if (actionable && emit) this.emit(issue, kind, revision, "", issue.detail);
    this.changed?.();
  }
  sourceIssueIds(): ReadonlySet<string> {
    return new Set(
      this.db
        .prepare(
          "SELECT DISTINCT s.issue_id FROM issue_subscriptions s JOIN json_each(s.events) selected WHERE selected.value IN (?,?,?,?,?)",
        )
        .all(
          IssueNotificationKind.Title,
          IssueNotificationKind.Description,
          IssueNotificationKind.Comment,
          IssueNotificationKind.Closed,
          IssueNotificationKind.Reopened,
        )
        .map((row) => String(row["issue_id"])),
    );
  }
  observesSource(issue: IssueRecord): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM issue_subscriptions s JOIN json_each(s.events) selected WHERE s.issue_id=? AND selected.value IN (?,?,?,?,?) LIMIT 1",
        )
        .get(
          issue.id,
          IssueNotificationKind.Title,
          IssueNotificationKind.Description,
          IssueNotificationKind.Comment,
          IssueNotificationKind.Closed,
          IssueNotificationKind.Reopened,
        ) !== undefined
    );
  }
  observe(issue: IssueRecord, observed: TrackerObservation): void {
    this.atomic(() => {
      this.observeInside(issue, observed);
    });
  }
  private observeInside(
    issue: IssueRecord,
    observed: TrackerObservation,
  ): void {
    if (!observed.complete) return;
    const current = {
      title: observed.title,
      body: observed.body,
      closed: observed.closed,
      revision: observed.revision,
      comments: observed.comments.map((comment) => ({
        id: comment.id,
        revision: comment.revision,
      })),
    };
    const row = this.db
      .prepare("SELECT data FROM issue_source_observations WHERE issue_id=?")
      .get(issue.id);
    if (row !== undefined) {
      const previous = parsed(row["data"]);
      if (!Check(snapshot, previous))
        throw new Error("Invalid stored issue source observation");
      if (previous.title !== current.title)
        this.emit(
          issue,
          IssueNotificationKind.Title,
          observed.revision,
          previous.title,
          current.title,
        );
      if (previous.body !== current.body)
        this.emit(
          issue,
          IssueNotificationKind.Description,
          observed.revision,
          previous.body,
          current.body,
        );
      if (previous.closed !== current.closed)
        this.emit(
          issue,
          current.closed
            ? IssueNotificationKind.Closed
            : IssueNotificationKind.Reopened,
          observed.revision,
          String(previous.closed),
          String(current.closed),
        );
      const previousComments = new Set(
        previous.comments.map((comment) =>
          JSON.stringify([comment.id, comment.revision]),
        ),
      );
      for (const comment of observed.comments)
        if (
          !previousComments.has(JSON.stringify([comment.id, comment.revision]))
        )
          this.emit(
            issue,
            IssueNotificationKind.Comment,
            observed.revision,
            "",
            comment.body,
            comment.id,
            comment.revision,
            comment.url,
          );
    }
    this.db
      .prepare(
        "INSERT INTO issue_source_observations VALUES(?,?) ON CONFLICT(issue_id) DO UPDATE SET data=excluded.data",
      )
      .run(issue.id, JSON.stringify(current));
    const failure = this.db
      .prepare("SELECT data FROM issue_refresh_failures WHERE issue_id=?")
      .get(issue.id);
    if (failure !== undefined) {
      const value = parsed(failure["data"]);
      if (!Check(failureEvidence, value))
        throw new Error("Invalid stored issue refresh failure");
      this.emit(
        issue,
        IssueNotificationKind.RefreshRecovery,
        value.revision,
        value.detail,
        "Complete tracker observation restored",
        "",
        "",
        issue.ref.url,
        { digest: value.digest, truncated: value.truncated },
      );
      this.db
        .prepare("DELETE FROM issue_refresh_failures WHERE issue_id=?")
        .run(issue.id);
    }
  }
}
