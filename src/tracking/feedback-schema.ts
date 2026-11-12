import type { DatabaseSync } from "node:sqlite";

export function migrateFeedback(db: DatabaseSync): void {
  const version = db.prepare("PRAGMA user_version").get()?.["user_version"];
  if (
    version === 6 ||
    version === 7 ||
    version === 8 ||
    version === 9 ||
    version === 10
  )
    return;
  if (version !== 5) throw new Error("Unsupported feedback database version");
  // rationale: SQLite requires rebuilding the table to extend its checked action kinds; dependent rows retain their original keys.
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE actions_next (
      id TEXT PRIMARY KEY, pr_id TEXT NOT NULL REFERENCES tracked_prs(id),
      opened_observation_id INTEGER NOT NULL, owner_agent_id TEXT NOT NULL REFERENCES agent_refs(id),
      kind TEXT NOT NULL CHECK(kind IN ('conflict','check_failed','changes_requested','review_feedback')), source_key TEXT NOT NULL,
      blocker_json TEXT NOT NULL CHECK(json_valid(blocker_json)), summary TEXT NOT NULL, evidence_url TEXT NOT NULL,
      profile_json TEXT NOT NULL CHECK(json_valid(profile_json)),
      state TEXT NOT NULL CHECK(state IN ('open','acknowledged','working','resolved','superseded')),
      progress_json TEXT NOT NULL CHECK(json_valid(progress_json)),
      resolved_observation_id INTEGER, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
      FOREIGN KEY(opened_observation_id,pr_id) REFERENCES pr_observations(id,pr_id),
      FOREIGN KEY(resolved_observation_id,pr_id) REFERENCES pr_observations(id,pr_id),
      CHECK(json_extract(progress_json,'$.state') IS state),
      CHECK(json_extract(blocker_json,'$.kind') IS kind),
      CHECK((state='resolved')=(resolved_observation_id IS NOT NULL)),
      CHECK(state NOT IN ('resolved','superseded') OR (json_type(progress_json,'$.at') IS 'integer' AND json_type(progress_json,'$.reason') IS 'text')),
      CHECK(state NOT IN ('acknowledged','working') OR (json_type(progress_json,'$.at') IS 'integer' AND json_type(progress_json,'$.agentId') IS 'text'))
    ) STRICT;

    INSERT INTO actions_next SELECT * FROM actions;
    DROP TABLE actions;
    ALTER TABLE actions_next RENAME TO actions;
    CREATE UNIQUE INDEX unfinished_blockers ON actions(pr_id,kind,source_key) WHERE state IN ('open','acknowledged','working');
    CREATE INDEX actions_by_owner ON actions(owner_agent_id,state);

    ALTER TABLE pr_observations ADD COLUMN feedback_json TEXT CHECK(feedback_json IS NULL OR json_valid(feedback_json));`);
    if (db.prepare("PRAGMA foreign_key_check").all().length !== 0)
      throw new Error("Feedback migration violated foreign keys");
    db.exec("PRAGMA user_version=6; COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys=ON");
  }
}
