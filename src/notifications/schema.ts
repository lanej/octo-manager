import type { DatabaseSync } from "node:sqlite";
export function migrateDigests(db: DatabaseSync): void {
  const version = db.prepare("PRAGMA user_version").get()?.["user_version"];
  if (version === 11 || version === 10) return;
  if (version !== 9) throw new Error("Unsupported digest database version");
  try {
    db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS agent_digests (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agent_refs(id),
      state TEXT NOT NULL CHECK(state IN ('ready','queued','withdrawing','enqueueing','uncertain','received','cancelled','unavailable')),
      data TEXT NOT NULL CHECK(json_valid(data)),
      CHECK(json_extract(data,'$.id') IS id),CHECK(json_extract(data,'$.agentId') IS agent_id),CHECK(json_extract(data,'$.state') IS state)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS one_pending_digest ON agent_digests(agent_id) WHERE state NOT IN ('received','cancelled');
    CREATE TRIGGER IF NOT EXISTS immutable_digest_identity BEFORE UPDATE OF id,agent_id ON agent_digests BEGIN SELECT RAISE(ABORT,'Digest identity is immutable'); END;
    CREATE TABLE IF NOT EXISTS agent_digest_revisions (
      digest_id TEXT NOT NULL REFERENCES agent_digests(id), revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 4294967295),
      data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(digest_id,revision),
      CHECK(json_extract(data,'$.digestId') IS digest_id),CHECK(json_extract(data,'$.revision') IS revision)
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS immutable_digest_revision BEFORE UPDATE ON agent_digest_revisions BEGIN SELECT RAISE(ABORT,'Digest revisions are immutable'); END;
    CREATE TABLE IF NOT EXISTS agent_digest_receipts (
      digest_id TEXT NOT NULL,revision INTEGER NOT NULL,agent_id TEXT NOT NULL REFERENCES agent_refs(id),at_ms INTEGER NOT NULL,
      PRIMARY KEY(digest_id,revision),FOREIGN KEY(digest_id,revision) REFERENCES agent_digest_revisions(digest_id,revision)
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS immutable_digest_receipt BEFORE UPDATE ON agent_digest_receipts BEGIN SELECT RAISE(ABORT,'Digest receipts are immutable'); END;
    CREATE TABLE IF NOT EXISTS agent_digest_events (
      sequence INTEGER PRIMARY KEY, digest_id TEXT REFERENCES agent_digests(id), agent_id TEXT NOT NULL REFERENCES agent_refs(id),
      at_ms INTEGER NOT NULL,kind TEXT NOT NULL,detail TEXT NOT NULL CHECK(json_valid(detail))
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS immutable_digest_event BEFORE UPDATE ON agent_digest_events BEGIN SELECT RAISE(ABORT,'Digest events are immutable'); END;
    PRAGMA user_version=10;COMMIT;`);
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
