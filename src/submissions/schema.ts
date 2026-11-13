import type { DatabaseSync } from "node:sqlite";
export function migrateSubmissions(db: DatabaseSync): void {
  const version = Number(
    db.prepare("PRAGMA user_version").get()?.["user_version"],
  );
  if (
    version === 9 ||
    version === 14 ||
    version === 13 ||
    version === 12 ||
    version === 11 ||
    version === 10
  )
    return;
  if (version !== 8) throw new Error("Unsupported submission database version");
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS repository_policies (
      repository TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0), source_digest TEXT NOT NULL,
      data TEXT NOT NULL CHECK(json_valid(data)), created_at_ms INTEGER NOT NULL,
      PRIMARY KEY(repository,version), CHECK(json_extract(data,'$.repository') IS repository), CHECK(json_extract(data,'$.version') IS version)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS policy_inputs ON repository_policies(repository,source_digest,version);
    CREATE TRIGGER IF NOT EXISTS immutable_repository_policy BEFORE UPDATE ON repository_policies BEGIN SELECT RAISE(ABORT,'Policy versions are immutable'); END;
    CREATE TABLE IF NOT EXISTS pr_submissions (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('queued','analyzing','writing','publishing','enrolling','succeeded','needs_input','failed','uncertain','cancelled')),
      data TEXT NOT NULL CHECK(json_valid(data)), created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
      CHECK(json_extract(data,'$.id') IS id), CHECK(json_extract(data,'$.state') IS state), CHECK(json_extract(data,'$.request.requestId') IS request_id)
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS immutable_submission_request BEFORE UPDATE ON pr_submissions WHEN json_extract(NEW.data,'$.request') IS NOT json_extract(OLD.data,'$.request') BEGIN SELECT RAISE(ABORT,'Submission requests are immutable'); END;
    CREATE TABLE IF NOT EXISTS inbox_sequence (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL);
    INSERT OR IGNORE INTO inbox_sequence VALUES(1,(SELECT COALESCE(MAX(sequence),0) FROM delivery_messages));
    CREATE TABLE IF NOT EXISTS operation_notifications (
      sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, submission_id TEXT NOT NULL REFERENCES pr_submissions(id),
      recipient_agent_id TEXT NOT NULL REFERENCES agent_refs(id), body TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
      acknowledged_at_ms INTEGER, next_check_at_ms INTEGER NOT NULL, applicable INTEGER NOT NULL CHECK(applicable IN(0,1)),
      state TEXT NOT NULL CHECK(state IN ('pending','sending','accepted','uncertain','unavailable')), queue_id TEXT, error TEXT,
      attempts TEXT NOT NULL CHECK(json_valid(attempts)), CHECK(length(body)>0 AND length(body)<=1048576)
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS immutable_operation_message BEFORE UPDATE OF id,body,submission_id,recipient_agent_id,created_at_ms ON operation_notifications BEGIN SELECT RAISE(ABORT,'Message payload is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS monotonic_operation_receipt BEFORE UPDATE OF acknowledged_at_ms ON operation_notifications WHEN OLD.acknowledged_at_ms IS NOT NULL AND NEW.acknowledged_at_ms IS NOT OLD.acknowledged_at_ms BEGIN SELECT RAISE(ABORT,'Message receipt is immutable'); END;
    PRAGMA user_version=9; COMMIT;`);
}
export function nextInboxSequence(db: DatabaseSync): number {
  const row = db
    .prepare(
      "UPDATE inbox_sequence SET value=value+1 WHERE id=1 RETURNING value",
    )
    .get();
  if (typeof row?.["value"] !== "number")
    throw new Error("Inbox sequence unavailable");
  return row["value"];
}
