import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { PullRequestDetails } from "../github/reviews.js";
import {
  decode,
  DispatchSchema,
  RefreshKind,
  ScheduleSchema,
  ScheduleState,
  ViewSchema,
  type ScheduledRefresh,
} from "./contracts.js";

export function migrateScheduling(db: DatabaseSync): void {
  const version = db.prepare("PRAGMA user_version").get()?.["user_version"];
  if (version === 15) return;
  if (version !== 14) throw new Error("Unsupported GitHub scheduling database version");
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

// SQL remains authoritative across rollback and other connections. Only identical
// serialized values reuse validation; callers receive independent object graphs.
class ValidatedValues<T extends object> {
  private values = new Map<string, T>();
  private bytes = 0;

  constructor(private decodeValue: (data: string) => T) {}

  read(data: string): T {
    const cached = this.values.get(data);
    if (cached !== undefined) return structuredClone(cached);
    const value = this.decodeValue(data);
    const bytes = data.length * 2;
    if (bytes <= 1024 * 1024) {
      while (this.values.size >= 256 || this.bytes + bytes > 1024 * 1024) {
        const oldest = this.values.keys().next();
        if (oldest.done === true) break;
        this.values.delete(oldest.value);
        this.bytes -= oldest.value.length * 2;
      }
      this.values.set(data, value);
      this.bytes += bytes;
    }
    return structuredClone(value);
  }
}

export class ScheduleStore {
  private statements: Record<
    | "list"
    | "queued"
    | "reviews"
    | "get"
    | "save"
    | "remove"
    | "view"
    | "saveView"
    | "usage"
    | "evictView"
    | "dispatch"
    | "saveDispatch",
    StatementSync
  >;
  private schedules = new ValidatedValues((data) => decode(ScheduleSchema, data));
  private dispatchValues = new ValidatedValues((data) => decode(DispatchSchema, data));

  constructor(
    db: DatabaseSync,
    private now: () => number,
  ) {
    this.statements = {
      list: db.prepare("SELECT data FROM github_schedules ORDER BY due_at_ms,key"),
      queued: db.prepare("SELECT key FROM github_schedules WHERE state=?"),
      reviews: db.prepare(
        "SELECT data FROM github_schedules WHERE kind=? OR json_extract(data,'$.kind')=? ORDER BY due_at_ms,key",
      ),
      get: db.prepare("SELECT data FROM github_schedules WHERE key=?"),
      save: db.prepare(
        "INSERT INTO github_schedules VALUES(?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET due_at_ms=excluded.due_at_ms,state=excluded.state,data=excluded.data",
      ),
      remove: db.prepare("DELETE FROM github_schedules WHERE key=?"),
      view: db.prepare("SELECT data FROM github_views WHERE url=?"),
      saveView: db.prepare(
        "INSERT INTO github_views VALUES(?,?,?) ON CONFLICT(url) DO UPDATE SET data=excluded.data,accessed_at_ms=excluded.accessed_at_ms",
      ),
      usage: db.prepare(
        "SELECT count(*) AS count, coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes FROM github_views",
      ),
      evictView: db.prepare(
        "DELETE FROM github_views WHERE url=(SELECT url FROM github_views ORDER BY accessed_at_ms,url LIMIT 1)",
      ),
      dispatch: db.prepare("SELECT value FROM settings WHERE key='github_dispatch'"),
      saveDispatch: db.prepare("UPDATE settings SET value=? WHERE key='github_dispatch'"),
    };
    for (const row of this.list())
      if (row.state === ScheduleState.Running)
        this.save({
          ...row,
          state: ScheduleState.Queued,
          deferredReason: "Interrupted refresh queued after restart",
        });
  }

  list(): ScheduledRefresh[] {
    return this.statements.list.all().map((row) => this.schedules.read(String(row["data"])));
  }

  queuedKeys(): Set<string> {
    return new Set(this.statements.queued.all(ScheduleState.Queued).map((row) => String(row["key"])));
  }

  reviews(): ScheduledRefresh[] {
    return this.statements.reviews
      .all(RefreshKind.Reviews, RefreshKind.Reviews)
      .map((row) => this.schedules.read(String(row["data"])));
  }

  get(key: string): ScheduledRefresh | undefined {
    const row = this.statements.get.get(key);
    return !row ? undefined : this.schedules.read(String(row["data"]));
  }

  save(value: ScheduledRefresh): void {
    this.statements.save.run(value.key, value.kind, value.subject, value.dueAtMs, value.state, JSON.stringify(value));
  }

  remove(key: string): void {
    this.statements.remove.run(key);
  }

  view(url: string): PullRequestDetails | undefined {
    const row = this.statements.view.get(url);
    if (!row) return undefined;
    return decode(ViewSchema, String(row["data"]));
  }

  saveView(value: PullRequestDetails): void {
    this.statements.saveView.run(value.url, JSON.stringify(value), this.now());
    for (let remaining = 129; remaining > 0; remaining--) {
      const usage = this.statements.usage.get();
      if (Number(usage?.["count"]) <= 128 && Number(usage?.["bytes"]) <= 16 * 1024 * 1024) break;
      this.statements.evictView.run();
    }
  }

  dispatch() {
    const row = this.statements.dispatch.get();
    if (!row) throw new Error("GitHub dispatch state missing");
    return this.dispatchValues.read(String(row["value"]));
  }

  saveDispatch(value: ReturnType<ScheduleStore["dispatch"]>): void {
    this.statements.saveDispatch.run(JSON.stringify(value));
  }
}
