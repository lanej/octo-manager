import type { DatabaseSync } from "node:sqlite";
import type { PullRequestDetails } from "../github.js";
import {
  decode,
  DispatchSchema,
  ScheduleSchema,
  ScheduleState,
  ViewSchema,
  type ScheduledRefresh,
} from "./contracts.js";

export function migrateScheduling(db: DatabaseSync): void {
  const version = db.prepare("PRAGMA user_version").get()?.["user_version"];
  if (version === 15) return;
  if (version !== 14)
    throw new Error("Unsupported GitHub scheduling database version");
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS github_schedules (
      key TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('tracking','reviews')),
      subject TEXT NOT NULL, due_at_ms INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('queued','running','deferred')),
      data TEXT NOT NULL CHECK(json_valid(data)),
      CHECK(json_extract(data,'$.key')=key), CHECK(json_extract(data,'$.state')=state)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS github_views (url TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)), accessed_at_ms INTEGER NOT NULL) STRICT;
    INSERT OR IGNORE INTO settings(key,value) VALUES ('github_dispatch','{"nextAtMs":0,"coreRetryAtMs":0,"graphqlRetryAtMs":0}');
    PRAGMA user_version=15; COMMIT;`);
}
export class ScheduleStore {
  constructor(
    private db: DatabaseSync,
    private now: () => number,
  ) {
    for (const row of this.list())
      if (row.state === ScheduleState.Running)
        this.save({
          ...row,
          state: ScheduleState.Queued,
          deferredReason: "Interrupted refresh queued after restart",
        });
  }
  list(): ScheduledRefresh[] {
    return this.db
      .prepare("SELECT data FROM github_schedules ORDER BY due_at_ms,key")
      .all()
      .map((row) => decode(ScheduleSchema, String(row["data"])));
  }
  get(key: string): ScheduledRefresh | undefined {
    const row = this.db
      .prepare("SELECT data FROM github_schedules WHERE key=?")
      .get(key);
    return row === undefined
      ? undefined
      : decode(ScheduleSchema, String(row["data"]));
  }
  save(value: ScheduledRefresh): void {
    this.db
      .prepare(
        "INSERT INTO github_schedules VALUES(?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET due_at_ms=excluded.due_at_ms,state=excluded.state,data=excluded.data",
      )
      .run(
        value.key,
        value.kind,
        value.subject,
        value.dueAtMs,
        value.state,
        JSON.stringify(value),
      );
  }
  remove(key: string): void {
    this.db.prepare("DELETE FROM github_schedules WHERE key=?").run(key);
  }
  view(url: string): PullRequestDetails | undefined {
    const row = this.db
      .prepare("SELECT data FROM github_views WHERE url=?")
      .get(url);
    if (row === undefined) return undefined;
    return decode(ViewSchema, String(row["data"]));
  }
  saveView(value: PullRequestDetails): void {
    this.db
      .prepare(
        "INSERT INTO github_views VALUES(?,?,?) ON CONFLICT(url) DO UPDATE SET data=excluded.data,accessed_at_ms=excluded.accessed_at_ms",
      )
      .run(value.url, JSON.stringify(value), this.now());
    for (let remaining = 129; remaining > 0; remaining--) {
      const usage = this.db
        .prepare(
          "SELECT count(*) AS count, coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes FROM github_views",
        )
        .get();
      if (
        Number(usage?.["count"]) <= 128 &&
        Number(usage?.["bytes"]) <= 16 * 1024 * 1024
      )
        break;
      this.db
        .prepare(
          "DELETE FROM github_views WHERE url=(SELECT url FROM github_views ORDER BY accessed_at_ms,url LIMIT 1)",
        )
        .run();
    }
  }
  dispatch() {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key='github_dispatch'")
      .get();
    if (row === undefined) throw new Error("GitHub dispatch state missing");
    return decode(DispatchSchema, String(row["value"]));
  }
  saveDispatch(value: ReturnType<ScheduleStore["dispatch"]>): void {
    this.db
      .prepare("UPDATE settings SET value=? WHERE key='github_dispatch'")
      .run(JSON.stringify(value));
  }
}
