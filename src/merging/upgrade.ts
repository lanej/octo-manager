import type { DatabaseSync } from "node:sqlite";
export function migrateAutoMerge(db: DatabaseSync): void {
  const version = db.prepare("PRAGMA user_version").get()?.["user_version"];
  if (version === 15 || version === 14) return;
  if (version !== 13)
    throw new Error("Unsupported auto-merge database version");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(
      "UPDATE merge_entries SET data=json_set(data,'$.autoMerge',json('true')); PRAGMA user_version=14; COMMIT;",
    );
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
