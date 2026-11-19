import { isDeepStrictEqual } from "node:util";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { DatabaseSync } from "node:sqlite";
import { decodeContent, sameContent, type IssueContent } from "./repository.js";

const trackerSchema = Type.Object({
  title: Type.String(),
  body: Type.String(),
  closed: Type.Boolean(),
  revision: Type.String(),
});

export interface ContentBinding {
  repository: string;
  baseline: IssueContent | undefined;
  pending: IssueContent | undefined;
  error: string;
}
/** SQLite holds write intentions and cached content; repository confirmation releases work. */
export class RepositoryJournal {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS issue_storage (
      issue_id TEXT PRIMARY KEY, repository TEXT NOT NULL, baseline TEXT, pending TEXT,
      error TEXT NOT NULL DEFAULT ''
    ); CREATE TABLE IF NOT EXISTS issue_tracker_baselines(issue_id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
  }
  get(id: string): ContentBinding | undefined {
    const row = this.db
      .prepare("SELECT * FROM issue_storage WHERE issue_id=?")
      .get(id);
    if (row === undefined) return undefined;
    const parse = (value: unknown) =>
      typeof value === "string"
        ? decodeContent(JSON.parse(value) as unknown)
        : undefined;
    return {
      repository: String(row["repository"]),
      baseline: parse(row["baseline"]),
      pending: parse(row["pending"]),
      error: String(row["error"]),
    };
  }
  bind(content: IssueContent, repository: string): void {
    const prior = this.get(content.id);
    if (prior !== undefined && prior.repository !== repository)
      throw new Error("Issue storage identity changed; migrate explicitly");
    this.db
      .prepare(
        "INSERT OR IGNORE INTO issue_storage(issue_id,repository,pending) VALUES(?,?,?)",
      )
      .run(content.id, repository, JSON.stringify(content));
  }
  intend(content: IssueContent): void {
    const prior = this.get(content.id);
    if (
      prior === undefined ||
      (prior.pending !== undefined && sameContent(prior.pending, content)) ||
      (prior.pending === undefined &&
        prior.baseline !== undefined &&
        sameContent(prior.baseline, content))
    )
      return;
    const previous = prior.pending ?? prior.baseline;
    const fieldTimes = { ...previous?.fieldTimes };
    for (const field of ["title", "body", "externalClosed", "brief"] as const) {
      if (!isDeepStrictEqual(previous?.[field], content[field]))
        fieldTimes[field] = content.updatedAt;
    }
    this.db
      .prepare("UPDATE issue_storage SET pending=? WHERE issue_id=?")
      .run(JSON.stringify({ ...content, fieldTimes }), content.id);
  }
  retime(
    id: string,
    at: number,
    fields: ("title" | "body" | "externalClosed")[],
  ): void {
    const pending = this.get(id)?.pending;
    if (pending !== undefined) {
      const fieldTimes = { ...pending.fieldTimes };
      for (const field of fields) fieldTimes[field] = at;
      this.db
        .prepare("UPDATE issue_storage SET pending=? WHERE issue_id=?")
        .run(
          JSON.stringify({
            ...pending,
            updatedAt: Math.max(pending.updatedAt, at),
            fieldTimes,
          }),
          id,
        );
    }
  }
  confirm(content: IssueContent, expected: IssueContent | undefined): void {
    // A command admitted during the repository write must retain its newer intention.
    const current = this.get(content.id);
    const unchanged =
      JSON.stringify(current?.pending) === JSON.stringify(expected);
    this.db
      .prepare(
        "UPDATE issue_storage SET baseline=?,pending=CASE WHEN ? THEN NULL ELSE pending END,error='' WHERE issue_id=?",
      )
      .run(JSON.stringify(content), unchanged ? 1 : 0, content.id);
  }
  fail(id: string, message: string): void {
    this.db
      .prepare("UPDATE issue_storage SET error=? WHERE issue_id=?")
      .run(message.slice(0, 1000), id);
  }
  tracker(id: string) {
    const row = this.db
      .prepare("SELECT data FROM issue_tracker_baselines WHERE issue_id=?")
      .get(id);
    if (row === undefined) return undefined;
    const value: unknown = JSON.parse(String(row["data"]));
    if (!Check(trackerSchema, value))
      throw new Error("Invalid issue tracker baseline");
    return value;
  }
  observedTracker(
    id: string,
    value: { title: string; body: string; closed: boolean; revision: string },
  ): void {
    this.db
      .prepare(
        "INSERT INTO issue_tracker_baselines VALUES(?,?) ON CONFLICT(issue_id) DO UPDATE SET data=excluded.data",
      )
      .run(id, JSON.stringify(value));
  }
  ready(id: string): boolean {
    const value = this.get(id);
    return (
      value === undefined ||
      (value.pending === undefined &&
        value.error === "" &&
        value.baseline !== undefined)
    );
  }
}
