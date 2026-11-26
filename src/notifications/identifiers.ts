import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const sources = [
  ["deliveries", "id"],
  ["operation_notifications", "id"],
  ["participant_messages", "id"],
  ["merge_notices", "id"],
  ["issue_notices", "id"],
  ["safe_recovery_messages", "id"],
  ["safe_agent_notices", "message_id"],
] as const;
// Public prefixes are shared by direct deliveries and grouped dispatches.
export function allocateMessageId(db: DatabaseSync, generate: () => string = randomUUID): string {
  const present = sources.filter(
    ([table]) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined,
  );
  for (let attempt = 0; attempt < 32; attempt++) {
    const id = generate(),
      prefix = id.slice(0, 8);
    const grouped = db
      .prepare(
        /* sql */ `SELECT 1 FROM agent_digest_revisions
        WHERE substr(json_extract(data,'$.dispatchId'),1,8)=? LIMIT 1`,
      )
      .get(prefix);
    if (grouped !== undefined) continue;
    if (
      present.some(
        ([table, column]) =>
          db
            .prepare(
              /* sql */ `SELECT 1 FROM ${table}
              WHERE ${column} GLOB ? LIMIT 1`,
            )
            .get(prefix + "*") !== undefined,
      )
    )
      continue;
    return id;
  }
  throw new Error("Unable to allocate a unique message receipt ID");
}
