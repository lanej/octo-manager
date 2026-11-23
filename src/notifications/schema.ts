import { revision } from "./types.js";
import type { DatabaseSync } from "node:sqlite";
export function migrateDigests(db: DatabaseSync): void {
  const version = db.prepare("PRAGMA user_version").get()?.["user_version"];
  if (
    version === 15 ||
    version === 14 ||
    version === 13 ||
    version === 12 ||
    version === 11 ||
    version === 10
  )
    return;
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

export function migrateInbox(db: DatabaseSync): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS issue_notices(sequence INTEGER PRIMARY KEY,id TEXT UNIQUE NOT NULL,issue_id TEXT NOT NULL,recipient_agent_id TEXT NOT NULL,body TEXT NOT NULL,created_at_ms INTEGER NOT NULL,acknowledged_at_ms INTEGER,next_check_at_ms INTEGER NOT NULL,applicable INTEGER NOT NULL)",
  );
  const version = db.prepare("PRAGMA user_version").get()?.["user_version"];
  if (
    version === 7 ||
    version === 8 ||
    version === 9 ||
    version === 15 ||
    version === 14 ||
    version === 13 ||
    version === 12 ||
    version === 11 ||
    version === 10
  )
    return;
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

export function migrateNotificationEvidence(db: DatabaseSync): void {
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS safe_recovery_messages (sequence INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, original_id TEXT UNIQUE NOT NULL, body TEXT NOT NULL, created_at_ms INTEGER NOT NULL, acknowledged_at_ms INTEGER, next_check_at_ms INTEGER NOT NULL) STRICT;
    CREATE TRIGGER IF NOT EXISTS immutable_safe_recovery BEFORE UPDATE OF sequence,id,original_id,body,created_at_ms ON safe_recovery_messages BEGIN SELECT RAISE(ABORT,'Recovery message is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS monotonic_safe_recovery_receipt BEFORE UPDATE OF acknowledged_at_ms ON safe_recovery_messages WHEN OLD.acknowledged_at_ms IS NOT NULL AND NEW.acknowledged_at_ms IS NOT OLD.acknowledged_at_ms BEGIN SELECT RAISE(ABORT,'Recovery receipt is immutable'); END;
    CREATE TABLE IF NOT EXISTS safe_notice_supersessions (original_id TEXT PRIMARY KEY, replacement_id TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS safe_notice_replacements (original_id TEXT PRIMARY KEY, replacement_id TEXT NOT NULL UNIQUE) STRICT;
    CREATE TABLE IF NOT EXISTS safe_agent_notices (message_id TEXT PRIMARY KEY, notice_json TEXT NOT NULL CHECK(json_valid(notice_json))) STRICT;
    CREATE TRIGGER IF NOT EXISTS immutable_safe_notice BEFORE UPDATE ON safe_agent_notices BEGIN SELECT RAISE(ABORT,'Safe notification is immutable'); END;
    COMMIT;`);
}

// rationale: Membership is a derived index; immutable revisions retain the audit authority and ordering.
export function migrateDigestMembership(db: DatabaseSync): void {
  if (
    db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='agent_digest_members'",
      )
      .get() !== undefined
  )
    return;
  try {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE agent_digest_members (
        digest_id TEXT NOT NULL, revision INTEGER NOT NULL, message_id TEXT NOT NULL CHECK(length(message_id)>0),
        PRIMARY KEY(digest_id,revision,message_id),
        FOREIGN KEY(digest_id,revision) REFERENCES agent_digest_revisions(digest_id,revision) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX digest_members_by_message ON agent_digest_members(message_id,digest_id);
      CREATE INDEX IF NOT EXISTS digests_by_agent ON agent_digests(agent_id);
    `);
    const insert = db.prepare("INSERT INTO agent_digest_members VALUES(?,?,?)");
    for (const row of db
      .prepare("SELECT digest_id,revision,data FROM agent_digest_revisions")
      .all()) {
      const value = revision(JSON.parse(String(row["data"])));
      if (
        value.digestId !== row["digest_id"] ||
        value.revision !== row["revision"]
      )
        throw new Error("Digest revision identity mismatch");
      for (const id of value.messageIds)
        insert.run(value.digestId, value.revision, id);
    }
    db.exec(`CREATE TRIGGER index_digest_members AFTER INSERT ON agent_digest_revisions BEGIN
      SELECT CASE WHEN json_type(NEW.data,'$.messageIds') IS NOT 'array' OR json_array_length(NEW.data,'$.messageIds') NOT BETWEEN 1 AND 20 OR EXISTS(SELECT 1 FROM json_each(NEW.data,'$.messageIds') WHERE type!='text' OR length(value)=0) THEN RAISE(ABORT,'Invalid digest membership') END;
      INSERT INTO agent_digest_members(digest_id,revision,message_id) SELECT NEW.digest_id,NEW.revision,value FROM json_each(NEW.data,'$.messageIds');
      END;
      CREATE TRIGGER immutable_digest_member BEFORE UPDATE ON agent_digest_members BEGIN SELECT RAISE(ABORT,'Digest membership is immutable'); END;
      COMMIT;`);
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
