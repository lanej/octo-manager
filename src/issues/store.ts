import { IssueSubscriptions } from "./subscriptions.js";
import type { NotificationRepository } from "../notifications/repository.js";
import { decodeIssue, decodeAssignment, decodeIssueBrief } from "./validation.js";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Assignment, IssueRecord, IssueEvent, Brief } from "./contracts.js";
import { AttemptState } from "./contracts.js";
export class IssueStore {
  readonly subscriptions: IssueSubscriptions;
  constructor(
    private db: DatabaseSync,
    private now: () => number,
    notifications?: NotificationRepository,
    changed?: () => void,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS issue_briefs(issue_id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(issue_id,version));
CREATE TABLE IF NOT EXISTS managed_issues(id TEXT PRIMARY KEY, identity TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS issue_assignments(id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS issue_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, issue_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS issue_requests(id TEXT PRIMARY KEY, input TEXT NOT NULL, issue_id TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS issue_effects(id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL, url TEXT NOT NULL);`);
    this.subscriptions = new IssueSubscriptions(db, now, notifications, changed);
  }
  atomic<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  ownPosts(issueId: string): { url: string; body: string }[] {
    return this.db
      .prepare("SELECT id,url,body FROM issue_effects WHERE issue_id=? AND kind='post' AND state='completed'")
      .all(issueId)
      .map((row) => ({
        url: String(row["url"]),
        body: `${String(row["body"])}\n\n<!-- octo-issue:${String(row["id"])} -->`,
      }));
  }
  private notice(issue: IssueRecord, kind: string): void {
    const revision = createHash("sha256")
      .update(JSON.stringify([issue.stage, issue.waiting, issue.brief?.version, issue.detail]))
      .digest("hex");
    this.subscriptions.status(issue, revision, kind !== "refresh_failed" && kind !== "subscription_refresh_failed");
  }

  list(): IssueRecord[] {
    return this.db
      .prepare("SELECT data FROM managed_issues ORDER BY rowid")
      .all()
      .map((row) => decodeIssue(row["data"]));
  }
  get(id: string): IssueRecord {
    const matches = this.list().filter((issue) => issue.id === id || issue.id.startsWith(id) || issue.ref.url === id);
    if (matches.length !== 1) throw new Error("Issue not found or ambiguous");
    const issue = matches[0];
    if (issue == null) throw new Error("Issue not found");
    return issue;
  }
  save(issue: IssueRecord, kind: string, detail: string): void {
    this.db.exec("SAVEPOINT issue_save");
    try {
      issue.updatedAt = this.now();
      this.db
        .prepare("INSERT INTO managed_issues VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
        .run(
          issue.id,
          JSON.stringify([issue.ref.provider, issue.ref.project, issue.ref.externalId]),
          JSON.stringify(issue),
        );
      this.db
        .prepare("INSERT INTO issue_events(issue_id,at,kind,detail) VALUES(?,?,?,?)")
        .run(issue.id, this.now(), kind, detail.slice(0, 16000));
      if (issue.brief !== undefined) {
        this.db
          .prepare("INSERT OR IGNORE INTO issue_briefs VALUES(?,?,?)")
          .run(issue.id, issue.brief.version, JSON.stringify(issue.brief));
      }
      this.notice(issue, kind);
      this.db.exec("RELEASE issue_save");
    } catch (error) {
      this.db.exec("ROLLBACK TO issue_save; RELEASE issue_save");
      throw error;
    }
  }
  assignments(issueId?: string): Assignment[] {
    return this.db
      .prepare("SELECT data FROM issue_assignments ORDER BY rowid")
      .all()
      .map((row) => decodeAssignment(row["data"]))
      .filter((item) => issueId === undefined || item.issueId === issueId);
  }
  assignment(value: Assignment): void {
    this.db
      .prepare("INSERT INTO issue_assignments VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
      .run(value.id, value.issueId, JSON.stringify(value));
  }
  recover(): void {
    for (const item of this.assignments())
      if (item.state === AttemptState.Intended || item.state === AttemptState.Running)
        this.assignment({
          ...item,
          state: AttemptState.Uncertain,
          detail: "Coordinator restarted; reconcile before dispatch",
        });
  }
  briefs(id: string): Brief[] {
    return this.db
      .prepare("SELECT data FROM issue_briefs WHERE issue_id=? ORDER BY version DESC LIMIT 10")
      .all(id)
      .map((row) => decodeIssueBrief(row["data"]));
  }
  events(id: string, before = Number.MAX_SAFE_INTEGER): IssueEvent[] {
    return this.db
      .prepare(
        "SELECT sequence,issue_id AS issueId,at,kind,detail FROM issue_events WHERE issue_id=? AND sequence<? ORDER BY sequence DESC LIMIT 50",
      )
      .all(id, before)
      .map((row) => ({
        sequence: Number(row["sequence"]),
        issueId: String(row["issueId"]),
        at: Number(row["at"]),
        kind: String(row["kind"]),
        detail: String(row["detail"]),
      }));
  }
  request(id: string, input: string): string | undefined {
    if (id.length === 0 || id.length > 200) throw new Error("Request ID required");
    const row = this.db.prepare("SELECT input,issue_id FROM issue_requests WHERE id=?").get(id);
    if (row == null) return undefined;
    if (row["input"] !== input) throw new Error("Request ID already used with different input");
    return String(row["issue_id"]);
  }
  remember(id: string, input: string, issueId: string): void {
    this.db.prepare("INSERT INTO issue_requests VALUES(?,?,?)").run(id, input, issueId);
  }
  effects(): Effect[] {
    return this.db
      .prepare("SELECT * FROM issue_effects WHERE state NOT IN ('completed','superseded')")
      .all()
      .map((row) => ({
        id: String(row["id"]),
        issueId: String(row["issue_id"]),
        kind: String(row["kind"]),
        body: String(row["body"]),
        title: String(row["title"]),
        state: String(row["state"]),
        url: String(row["url"]),
      }));
  }
  effect(value: Effect): void {
    const prior = this.db.prepare("SELECT state FROM issue_effects WHERE id=?").get(value.id);
    this.db
      .prepare(
        "INSERT INTO issue_effects VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=CASE WHEN excluded.state='intended' THEN issue_effects.state ELSE excluded.state END,url=CASE WHEN excluded.state='intended' THEN issue_effects.url ELSE excluded.url END",
      )
      .run(value.id, value.issueId, value.kind, value.body, value.title, value.state, value.url);
    if (value.state !== "intended" || prior === undefined) {
      if (prior?.["state"] !== value.state)
        this.db
          .prepare("INSERT INTO issue_events(issue_id,at,kind,detail) VALUES(?,?,?,?)")
          .run(
            value.issueId,
            this.now(),
            `effect_${value.state}`,
            `${value.kind} · ${value.id}${value.url === "" ? "" : ` · ${value.url}`}`,
          );
    }
  }
}
export interface Effect {
  id: string;
  issueId: string;
  kind: string;
  body: string;
  title: string;
  state: string;
  url: string;
}
