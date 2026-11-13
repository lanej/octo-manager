import type { DatabaseSync } from "node:sqlite";
export function migrateMerging(db: DatabaseSync): void {
  const version = db.prepare("PRAGMA user_version").get()?.["user_version"];
  if (version === 14 || version === 13) return;
  if (version !== 12)
    throw new Error("Unsupported merge-chain database version");
  db.exec("BEGIN IMMEDIATE");
  try {
    if (
      !db
        .prepare("PRAGMA table_info(pr_observations)")
        .all()
        .some((row) => row["name"] === "description")
    )
      db.exec("ALTER TABLE pr_observations ADD COLUMN description TEXT");
    db.exec(`CREATE TABLE IF NOT EXISTS pr_references(id TEXT PRIMARY KEY,pr_id TEXT NOT NULL REFERENCES tracked_prs(id),target_url TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
 CREATE TABLE IF NOT EXISTS pr_dependencies(id TEXT PRIMARY KEY,dependent_id TEXT NOT NULL REFERENCES tracked_prs(id),prerequisite_id TEXT NOT NULL REFERENCES tracked_prs(id),data TEXT NOT NULL CHECK(json_valid(data)),UNIQUE(dependent_id,prerequisite_id),CHECK(dependent_id!=prerequisite_id)) STRICT;
 CREATE TABLE IF NOT EXISTS merge_chains(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,state TEXT NOT NULL CHECK(state IN ('active','paused','cancelled','completed')),data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
 CREATE TABLE IF NOT EXISTS merge_entries(id TEXT PRIMARY KEY,chain_id TEXT NOT NULL REFERENCES merge_chains(id),pr_id TEXT NOT NULL REFERENCES tracked_prs(id),state TEXT NOT NULL CHECK(state IN ('waiting','preparing','waiting_owner','waiting_checks','ready','merging','merged','blocked','uncertain','cancelled')),data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
 CREATE UNIQUE INDEX IF NOT EXISTS one_active_merge_entry ON merge_entries(pr_id) WHERE state NOT IN ('merged','cancelled');
 CREATE TABLE IF NOT EXISTS merge_operations(id TEXT PRIMARY KEY,entry_id TEXT NOT NULL REFERENCES merge_entries(id),pr_id TEXT NOT NULL REFERENCES tracked_prs(id),state TEXT NOT NULL CHECK(state IN ('planned','running','succeeded','failed','uncertain')),data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
 CREATE UNIQUE INDEX IF NOT EXISTS one_merge_operation ON merge_operations(pr_id) WHERE state IN ('planned','running','uncertain');
 CREATE TABLE IF NOT EXISTS merge_conflict_cases (id INTEGER PRIMARY KEY,repair_id TEXT NOT NULL REFERENCES merge_operations(id),round INTEGER NOT NULL,path TEXT NOT NULL,recipe TEXT NOT NULL,tool_version TEXT NOT NULL,decision TEXT NOT NULL CHECK(decision IN ('pending','applied','declined','error')),reason TEXT NOT NULL,refs_json TEXT NOT NULL CHECK(json_valid(refs_json)),inputs_json TEXT CHECK(inputs_json IS NULL OR json_valid(inputs_json)),candidate TEXT,agent_result TEXT,created_at_ms INTEGER NOT NULL,UNIQUE(repair_id,round,path,recipe)) STRICT;
 CREATE TABLE IF NOT EXISTS merge_notices(sequence INTEGER PRIMARY KEY,id TEXT NOT NULL UNIQUE,pr_id TEXT NOT NULL REFERENCES tracked_prs(id),recipient_agent_id TEXT NOT NULL REFERENCES agent_refs(id),subject_kind TEXT NOT NULL CHECK(subject_kind IN ('reference','entry')),subject_id TEXT NOT NULL,revision TEXT NOT NULL,body TEXT NOT NULL CHECK(length(body)>0 AND length(body)<=6000),created_at_ms INTEGER NOT NULL,acknowledged_at_ms INTEGER,next_check_at_ms INTEGER NOT NULL,applicable INTEGER NOT NULL CHECK(applicable IN (0,1)),UNIQUE(subject_kind,subject_id,recipient_agent_id,revision)) STRICT;
 CREATE INDEX IF NOT EXISTS merge_notice_inbox ON merge_notices(recipient_agent_id,sequence);
 CREATE TRIGGER IF NOT EXISTS immutable_merge_notice BEFORE UPDATE OF sequence,id,pr_id,recipient_agent_id,subject_kind,subject_id,revision,body,created_at_ms ON merge_notices BEGIN SELECT RAISE(ABORT,'Workflow notice is immutable');END;
 CREATE TRIGGER IF NOT EXISTS monotonic_merge_notice_receipt BEFORE UPDATE OF acknowledged_at_ms ON merge_notices WHEN OLD.acknowledged_at_ms IS NOT NULL AND NEW.acknowledged_at_ms IS NOT OLD.acknowledged_at_ms BEGIN SELECT RAISE(ABORT,'Workflow receipt is immutable');END;
 PRAGMA user_version=13;COMMIT;`);
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
