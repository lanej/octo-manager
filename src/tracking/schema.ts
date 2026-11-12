import type { DatabaseSync } from "node:sqlite";
export function migrateTracking(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys=ON");
  const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
  if (version > 8)
    throw new Error("Tracking database is newer than this application");
  if (version >= 1) return;
  db.exec(`BEGIN IMMEDIATE;
    ALTER TABLE events ADD COLUMN pr_id TEXT;
    ALTER TABLE events ADD COLUMN action_id TEXT;
    CREATE TABLE agent_refs (
      id TEXT PRIMARY KEY, harness TEXT NOT NULL, endpoint TEXT NOT NULL, session_id TEXT NOT NULL,
      label TEXT, harness_version TEXT, version_observed_at_ms INTEGER,
      UNIQUE(harness,endpoint,session_id),
      CHECK((harness_version IS NULL)=(version_observed_at_ms IS NULL))
    ) STRICT;
    CREATE TABLE tracked_prs (
      id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE,
      origin_agent_id TEXT NOT NULL REFERENCES agent_refs(id), owner_agent_id TEXT NOT NULL REFERENCES agent_refs(id),
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
      last_refresh_error TEXT, last_refresh_error_at_ms INTEGER,
      CHECK((last_refresh_error IS NULL)=(last_refresh_error_at_ms IS NULL))
    ) STRICT;
    CREATE TABLE pr_observations (
      id INTEGER PRIMARY KEY, pr_id TEXT NOT NULL REFERENCES tracked_prs(id), observed_at_ms INTEGER NOT NULL,
      head_sha TEXT NOT NULL, base_sha TEXT NOT NULL,
      lifecycle TEXT NOT NULL CHECK(lifecycle IN ('open','closed','merged')),
      mergeability TEXT NOT NULL CHECK(mergeability IN ('mergeable','conflicting','unknown')),
      checks_state TEXT NOT NULL CHECK(checks_state IN ('complete','partial','unavailable')),
      checks_json TEXT NOT NULL CHECK(json_valid(checks_json)),
      reviews_state TEXT NOT NULL CHECK(reviews_state IN ('complete','partial','unavailable')),
      reviews_json TEXT NOT NULL CHECK(json_valid(reviews_json)), UNIQUE(id,pr_id),
      CHECK(json_extract(checks_json,'$.state') IS checks_state),
      CHECK(json_extract(reviews_json,'$.state') IS reviews_state)
    ) STRICT;
    CREATE INDEX observations_by_pr ON pr_observations(pr_id,id DESC);
    CREATE TABLE actions (
      id TEXT PRIMARY KEY, pr_id TEXT NOT NULL REFERENCES tracked_prs(id),
      opened_observation_id INTEGER NOT NULL, owner_agent_id TEXT NOT NULL REFERENCES agent_refs(id),
      kind TEXT NOT NULL CHECK(kind IN ('conflict','check_failed','changes_requested')), source_key TEXT NOT NULL,
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
    CREATE UNIQUE INDEX unfinished_blockers ON actions(pr_id,kind,source_key) WHERE state IN ('open','acknowledged','working');
    CREATE INDEX actions_by_owner ON actions(owner_agent_id,state);
    CREATE TABLE deliveries (
      id TEXT PRIMARY KEY, action_id TEXT NOT NULL REFERENCES actions(id), recipient_agent_id TEXT NOT NULL REFERENCES agent_refs(id),
      state TEXT NOT NULL CHECK(state IN ('pending','sending','delivered','uncertain','unavailable','cancelled')),
      progress_json TEXT NOT NULL CHECK(json_valid(progress_json)), next_attempt_at_ms INTEGER, retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count>=0),
      created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
      CHECK(json_extract(progress_json,'$.state') IS state),
      CHECK((state='pending')=(next_attempt_at_ms IS NOT NULL)),
      CHECK(state NOT IN ('uncertain','unavailable','cancelled') OR json_type(progress_json,'$.reason') IS 'text')
    ) STRICT;
    CREATE INDEX pending_deliveries ON deliveries(next_attempt_at_ms) WHERE state='pending';
    CREATE TABLE delivery_attempts (
      delivery_id TEXT NOT NULL REFERENCES deliveries(id), number INTEGER NOT NULL CHECK(number>0),
      started_at_ms INTEGER NOT NULL, harness_version TEXT,
      outcome TEXT NOT NULL CHECK(outcome IN ('sending','accepted','rejected','uncertain')),
      outcome_json TEXT NOT NULL CHECK(json_valid(outcome_json)),
      PRIMARY KEY(delivery_id,number), CHECK(json_extract(outcome_json,'$.state') IS outcome),
      CHECK(outcome='sending' OR json_type(outcome_json,'$.at') IS 'integer')
    ) STRICT;
    PRAGMA user_version=1;
    COMMIT;`);
}
