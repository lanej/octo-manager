import type { DatabaseSync } from "node:sqlite";
import { activityInput, type ActivityReport } from "./types.js";

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid activity cursor or time");
  return value;
}
function report(row: Record<string, unknown>): ActivityReport {
  if (typeof row["payload"] !== "string")
    throw new Error("Invalid stored activity");
  const value: unknown = JSON.parse(row["payload"]);
  return {
    ...activityInput(value),
    sequence: integer(row["sequence"]),
    recordedAt: integer(row["recorded_at_ms"]),
  };
}
export class ActivityStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
  ) {
    const version = db.prepare("PRAGMA user_version").get();
    if (version === undefined) throw new Error("Missing database version");
    const current = integer(version["user_version"]);
    if (current > 11)
      throw new Error("Activity database is newer than this application");
    if (current >= 2) return;
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE agent_activity (
        sequence INTEGER PRIMARY KEY REFERENCES events(seq),
        request_id TEXT NOT NULL UNIQUE,
        operation_id TEXT NOT NULL,
        name TEXT NOT NULL CHECK(name IN ('merge_pr','run_checks','resolve_conflict','summarize_pr','notify_agent')),
        outcome TEXT NOT NULL CHECK(outcome IN ('attempted','succeeded','failed','uncertain')),
        payload TEXT NOT NULL CHECK(json_valid(payload)),
        recorded_at_ms INTEGER NOT NULL,
        CHECK(json_extract(payload,'$.requestId') IS request_id),
        CHECK(json_extract(payload,'$.operationId') IS operation_id),
        CHECK(json_extract(payload,'$.name') IS name),
        CHECK(json_extract(payload,'$.outcome') IS outcome)
      ) STRICT;
      CREATE INDEX activity_by_operation ON agent_activity(operation_id,sequence);
      PRAGMA user_version=2;
      COMMIT;`);
  }
  record(value: unknown): ActivityReport {
    const input = activityInput(value);
    const payload = JSON.stringify(input);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare("SELECT * FROM agent_activity WHERE request_id=?")
        .get(input.requestId);
      if (existing !== undefined) {
        if (existing["payload"] !== payload)
          throw new Error(
            "Activity request ID already used with a different report",
          );
        const result = report(existing);
        this.db.exec("COMMIT");
        return result;
      }
      const recordedAt = integer(this.now());
      const event = this.db
        .prepare(
          "INSERT INTO events(job_id,at,kind,detail,pr_id) VALUES('',?,'agent_activity',?,(SELECT id FROM tracked_prs WHERE url=?))",
        )
        .run(
          recordedAt,
          `${input.name}: ${input.outcome} · ${input.detail}`,
          input.prUrl ?? null,
        );
      const sequence = Number(event.lastInsertRowid);
      this.db
        .prepare(
          "INSERT INTO agent_activity(sequence,request_id,operation_id,name,outcome,payload,recorded_at_ms) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          sequence,
          input.requestId,
          input.operationId,
          input.name,
          input.outcome,
          payload,
          recordedAt,
        );
      this.db.exec("COMMIT");
      return { ...input, sequence, recordedAt };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  list(after: number): ActivityReport[] {
    return this.db
      .prepare(
        "SELECT * FROM agent_activity WHERE sequence>? ORDER BY sequence LIMIT 200",
      )
      .all(integer(after))
      .map(report);
  }
}
