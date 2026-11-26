import type { DatabaseSync, StatementSync } from "node:sqlite";

export class NotificationInputRevision {
  private readonly schemaVersion: unknown;
  private readonly read: StatementSync;
  private readonly fallback: StatementSync;

  constructor(db: DatabaseSync) {
    this.schemaVersion = db.prepare("PRAGMA main.schema_version").get()?.["schema_version"];
    db.exec(
      "CREATE TEMP TABLE notification_input_revision(value INTEGER NOT NULL); INSERT INTO notification_input_revision VALUES(0)",
    );
    const tables = db
      .prepare("SELECT name FROM main.sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all();
    for (const [index, row] of tables.entries()) {
      const table = String(row["name"]);
      // Default notification decisions read observed PR facts, not scheduler dispatch state or cached review views.
      if (table === "github_schedules" || table === "github_views") continue;
      const quoted = `"${table.replaceAll('"', '""')}"`;
      // Successful queue probes refresh timestamps without changing recipient identity or runtime version.
      const agentChanges =
        table === "agent_refs"
          ? db
              .prepare(`PRAGMA main.table_info(${quoted})`)
              .all()
              .map((column) => String(column["name"]))
              .filter((column) => column !== "version_observed_at_ms")
              .map((column) => {
                const name = `"${column.replaceAll('"', '""')}"`;
                return `OLD.${name} IS NOT NEW.${name}`;
              })
              .join(" OR ")
          : undefined;
      for (const operation of ["INSERT", "UPDATE", "DELETE"] as const) {
        const condition =
          operation === "UPDATE" && agentChanges !== undefined
            ? `WHEN ${agentChanges.length === 0 ? "0" : agentChanges}`
            : table !== "settings"
              ? ""
              : operation === "UPDATE"
                ? "WHEN OLD.key IS NOT 'github_dispatch' OR NEW.key IS NOT 'github_dispatch'"
                : `WHEN ${operation === "DELETE" ? "OLD" : "NEW"}.key IS NOT 'github_dispatch'`;
        db.exec(
          `CREATE TEMP TRIGGER notification_input_${String(index)}_${operation} AFTER ${operation} ON main.${quoted} ${condition} BEGIN UPDATE notification_input_revision SET value=value+1; END`,
        );
      }
    }
    this.read = db.prepare(
      "SELECT value AS local_changes, (SELECT data_version FROM pragma_data_version) AS external_changes, (SELECT schema_version FROM pragma_schema_version) AS schema_version FROM notification_input_revision",
    );
    this.fallback = db.prepare(
      "SELECT total_changes() AS local_changes, (SELECT data_version FROM pragma_data_version) AS external_changes",
    );
  }

  current(): string {
    // Unknown schema additions retain conservative invalidation until the next connection installs its triggers.
    const row = this.read.get();
    if (row === undefined) throw new Error("Notification input revision is unavailable");
    const schema = row["schema_version"];
    return JSON.stringify([
      schema,
      schema === this.schemaVersion
        ? {
            local_changes: row["local_changes"],
            external_changes: row["external_changes"],
          }
        : this.fallback.get(),
    ]);
  }
}
