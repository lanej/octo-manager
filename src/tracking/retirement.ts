import type { DatabaseSync } from "node:sqlite";
import { CheckWatchState, checkEvidence, type CheckWatches } from "./checks.js";
import type { PRObservation } from "./types.js";
export enum TrackingState {
  Watching = "watching",
  Draining = "draining",
  Archived = "archived",
  Disabled = "disabled",
}
export enum ArchiveReason {
  Settled = "settled",
  Deadline = "deadline",
}
export interface Lifecycle {
  state: TrackingState;
  trackingEpoch: number;
  drainDeadlineAt?: number;
  archivedAt?: number;
  archiveReason?: ArchiveReason;
}
export function lifecycle(row: Record<string, unknown>): Lifecycle {
  const state =
    row["tracking_state"] ??
    (row["enabled"] === 0 ? TrackingState.Disabled : TrackingState.Watching);
  const checkedState = Object.values(TrackingState).find(
    (value) => value === state,
  );
  if (checkedState === undefined) throw new Error("Invalid tracking state");
  const result: Lifecycle = {
    state: checkedState,
    trackingEpoch: Number(row["tracking_epoch"] ?? 0),
  };
  if (!Number.isSafeInteger(result.trackingEpoch) || result.trackingEpoch < 0)
    throw new Error("Invalid tracking epoch");
  if (typeof row["drain_deadline_ms"] === "number")
    result.drainDeadlineAt = row["drain_deadline_ms"];
  if (typeof row["archived_at_ms"] === "number")
    result.archivedAt = row["archived_at_ms"];
  const reason = row["archive_reason"];
  if (reason !== undefined && reason !== null) {
    if (reason !== ArchiveReason.Settled && reason !== ArchiveReason.Deadline)
      throw new Error("Invalid archive reason");
    result.archiveReason = reason;
  }
  return result;
}
export function migrateRetirement(db: DatabaseSync, now: number): void {
  const version = db.prepare("PRAGMA user_version").get()?.["user_version"];
  if (version === 11) return;
  if (version !== 10)
    throw new Error("Unsupported retirement database version");
  db.exec("BEGIN IMMEDIATE");
  try {
    const columns = db.prepare("PRAGMA table_info(tracked_prs)").all();
    if (!columns.some((row) => row["name"] === "tracking_state")) {
      db.exec(`ALTER TABLE tracked_prs ADD COLUMN tracking_state TEXT NOT NULL DEFAULT 'watching' CHECK(tracking_state IN ('watching','draining','archived','disabled'));
 ALTER TABLE tracked_prs ADD COLUMN tracking_epoch INTEGER NOT NULL DEFAULT 0;
 ALTER TABLE tracked_prs ADD COLUMN drain_deadline_ms INTEGER;
 ALTER TABLE tracked_prs ADD COLUMN archived_at_ms INTEGER;
 ALTER TABLE tracked_prs ADD COLUMN archive_reason TEXT CHECK(archive_reason IN ('settled','deadline'));
 UPDATE tracked_prs SET tracking_state='disabled' WHERE enabled=0;`);
      db.prepare(
        `UPDATE tracked_prs SET tracking_state='draining',drain_deadline_ms=? WHERE enabled=1 AND (SELECT lifecycle FROM pr_observations WHERE pr_id=tracked_prs.id ORDER BY id DESC LIMIT 1) IN ('closed','merged')`,
      ).run(now + 86400000);
    }
    const sql = String(
      db
        .prepare("SELECT sql FROM sqlite_master WHERE name='check_watches'")
        .get()?.["sql"],
    );
    if (!sql.includes("'expired'"))
      db.exec(`CREATE TABLE check_watches_next (
 id TEXT PRIMARY KEY,pr_id TEXT NOT NULL REFERENCES tracked_prs(id),head_sha TEXT NOT NULL,generation INTEGER NOT NULL CHECK(generation>0),
 state TEXT NOT NULL CHECK(state IN ('waiting','completed','superseded','cancelled','expired')),
 evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),created_at_ms INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL,replacement_head_sha TEXT,
 UNIQUE(pr_id,head_sha,generation),CHECK((state='superseded')=(replacement_head_sha IS NOT NULL)));
 INSERT INTO check_watches_next SELECT * FROM check_watches;DROP TABLE check_watches;ALTER TABLE check_watches_next RENAME TO check_watches;
 CREATE UNIQUE INDEX one_waiting_check_watch ON check_watches(pr_id) WHERE state='waiting';`);
    db.exec(`CREATE TABLE IF NOT EXISTS notification_cursors(account TEXT PRIMARY KEY,data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
 CREATE TABLE IF NOT EXISTS notification_seen(account TEXT NOT NULL,thread_id TEXT NOT NULL,updated_ms INTEGER NOT NULL,PRIMARY KEY(account,thread_id,updated_ms)) STRICT;
 CREATE TABLE IF NOT EXISTS notification_refreshes(pr_id TEXT PRIMARY KEY REFERENCES tracked_prs(id),revision INTEGER NOT NULL,next_check_ms INTEGER NOT NULL DEFAULT 0) STRICT;
 CREATE TRIGGER IF NOT EXISTS tracking_state_enabled_update BEFORE UPDATE ON tracked_prs WHEN NEW.enabled!=(NEW.tracking_state!='disabled') BEGIN SELECT RAISE(ABORT,'Tracking state/enrollment mismatch');END;
 CREATE TRIGGER IF NOT EXISTS tracking_state_enabled_insert BEFORE INSERT ON tracked_prs WHEN NEW.enabled!=(NEW.tracking_state!='disabled') BEGIN SELECT RAISE(ABORT,'Tracking state/enrollment mismatch');END;
 `);
    if (db.prepare("PRAGMA foreign_key_check").all().length !== 0)
      throw new Error("Retirement migration violated foreign keys");
    db.exec("PRAGMA user_version=11;COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
export class RetirementStore {
  constructor(
    private db: DatabaseSync,
    private now: () => number,
    private checks: CheckWatches,
    private event: (kind: string, detail: string, prId: string) => void,
  ) {}
  private set(
    id: string,
    state: TrackingState,
    deadline: number | null,
    reason: ArchiveReason | null,
  ): void {
    this.db
      .prepare(
        `UPDATE tracked_prs SET tracking_state=?,enabled=?,tracking_epoch=tracking_epoch+1,drain_deadline_ms=?,archive_reason=?,archived_at_ms=?,updated_at_ms=? WHERE id=?`,
      )
      .run(
        state,
        state === TrackingState.Disabled ? 0 : 1,
        deadline,
        reason,
        state === TrackingState.Archived ? this.now() : null,
        this.now(),
        id,
      );
  }
  resumeInside(id: string): void {
    this.set(id, TrackingState.Watching, null, null);
  }
  disableInside(id: string): void {
    this.set(id, TrackingState.Disabled, null, null);
  }
  observeInside(id: string, observation: PRObservation): void {
    const row = this.db.prepare("SELECT * FROM tracked_prs WHERE id=?").get(id);
    if (row === undefined) throw new Error("Tracked PR not found");
    const current = lifecycle(row);
    if (current.state === TrackingState.Disabled) return;
    if (observation.lifecycle === "open") {
      if (current.state !== TrackingState.Watching) {
        this.resumeInside(id);
        this.event(
          "pr_reactivated",
          "Reopened PR monitoring resumed under its existing owner",
          id,
        );
      }
      return;
    }
    if (current.state === TrackingState.Archived) return;
    if (current.state === TrackingState.Watching) {
      this.set(id, TrackingState.Draining, this.now() + 86400000, null);
      this.event(
        "pr_draining",
        "PR closed; finishing existing check watches for at most 24 hours",
        id,
      );
      return;
    }
    if (
      checkEvidence(observation).state === "complete" &&
      observation.reviews.state === "complete" &&
      (observation.feedback === undefined ||
        observation.feedback.state === "complete") &&
      !this.checks.hasWaiting(id)
    ) {
      this.set(id, TrackingState.Archived, null, ArchiveReason.Settled);
      this.event(
        "pr_archived",
        "Polling stopped after a final complete refresh; unread deliveries retained",
        id,
      );
    }
  }
  expire(): string[] {
    const rows = this.db
      .prepare(
        "SELECT id FROM tracked_prs WHERE tracking_state='draining' AND drain_deadline_ms<=?",
      )
      .all(this.now());
    if (rows.length === 0) return [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const id = String(row["id"]);
        this.checks.cancel(id, CheckWatchState.Expired);
        this.set(id, TrackingState.Archived, null, ArchiveReason.Deadline);
        this.event(
          "pr_archived",
          "24-hour drain deadline reached; check results remain incomplete; unread deliveries retained",
          id,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return rows.map((row) => String(row["id"]));
  }
}
