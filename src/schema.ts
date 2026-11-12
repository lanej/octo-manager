import type { DatabaseSync } from "node:sqlite";

export function migrateEvidence(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get();
  if (row === undefined || row["user_version"] !== 2) {
    if (
      row?.["user_version"] === 3 ||
      row?.["user_version"] === 4 ||
      row?.["user_version"] === 5 ||
      row?.["user_version"] === 6 ||
      row?.["user_version"] === 7 ||
      row?.["user_version"] === 8 ||
      row?.["user_version"] === 9
    )
      return;
    throw new Error("Unsupported evidence database version");
  }
  db.exec(`BEGIN IMMEDIATE;
    ALTER TABLE pr_observations ADD COLUMN target_base_json TEXT CHECK(target_base_json IS NULL OR json_valid(target_base_json));
    ALTER TABLE events ADD COLUMN action_context_json TEXT CHECK(action_context_json IS NULL OR json_valid(action_context_json));
    PRAGMA user_version=3;
    COMMIT;`);
}
