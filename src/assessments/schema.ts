import type { DatabaseSync } from "node:sqlite";
export function migrateAssessments(db: DatabaseSync): void {
  // Additive feature tables have their own policy version; existing database migrations remain untouched.
  db.exec(`CREATE TABLE IF NOT EXISTS evidence_assessments (
      id TEXT PRIMARY KEY, action_id TEXT NOT NULL REFERENCES actions(id), fingerprint TEXT NOT NULL,
      data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(action_id,fingerprint)
    ) STRICT;`);
}
