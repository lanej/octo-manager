import type { DatabaseSync } from "node:sqlite";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { TrackingState } from "./retirement.js";
import {
  githubNotifications,
  NotificationAccessError,
  type NotificationReader,
  type NotificationPage,
} from "./notification-reader.js";
import type { TrackingService } from "./service.js";
const CursorSchema = Type.Object(
  {
    since: Type.Integer({ minimum: 0 }),
    page: Type.Integer({ minimum: 1 }),
    scanStartedAt: Type.Optional(Type.Integer()),
    lastModified: Type.Optional(Type.String()),
    scanModified: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
type Cursor = Static<typeof CursorSchema>;
const StatusSchema = Type.Object(
  {
    nextPollAt: Type.Integer(),
    lastError: Type.Optional(Type.String()),
    account: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
type Status = Static<typeof StatusSchema>;
export class NotificationStore {
  constructor(
    private db: DatabaseSync,
    private now: () => number,
    private event: (kind: string, detail: string) => void,
  ) {}
  cursor(account: string): Cursor {
    const row = this.db
      .prepare("SELECT data FROM notification_cursors WHERE account=?")
      .get(account);
    if (row === undefined) return { since: 0, page: 1 };
    const value: unknown = JSON.parse(String(row["data"]));
    if (!Check(CursorSchema, value))
      throw new Error("Invalid notification cursor");
    return value;
  }
  status(): Status {
    const row = this.db
      .prepare(
        "SELECT value FROM settings WHERE key='github_notification_monitor'",
      )
      .get();
    if (row === undefined) return { nextPollAt: 0 };
    const value: unknown = JSON.parse(String(row["value"]));
    if (!Check(StatusSchema, value))
      throw new Error("Invalid notification monitor status");
    return value;
  }
  statusResult(value: Status): void {
    if (!Check(StatusSchema, value))
      throw new Error("Invalid notification monitor status");
    const old = this.status();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO settings(key,value) VALUES('github_notification_monitor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(JSON.stringify(value));
      if (old.lastError !== value.lastError)
        this.event(
          value.lastError === undefined
            ? "notification_monitor_recovered"
            : "notification_monitor_unavailable",
          value.lastError === undefined
            ? "GitHub notification access recovered"
            : value.lastError,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  eligible(): boolean {
    return (
      this.db
        .prepare(
          "SELECT id FROM tracked_prs WHERE enabled=1 AND tracking_state='archived' LIMIT 1",
        )
        .get() !== undefined
    );
  }
  page(account: string, page: NotificationPage): void {
    const cursor = this.cursor(account),
      next: Cursor = { ...cursor };
    if (page.notModified) {
      if (cursor.page !== 1)
        throw new Error("Unexpected conditional response during pagination");
      return;
    }
    if (cursor.page === 1) {
      next.scanStartedAt = page.serverTime ?? this.now();
      delete next.scanModified;
      if (page.lastModified !== undefined)
        next.scanModified = page.lastModified;
    }
    if (page.more) next.page++;
    else {
      next.since = Math.max(
        cursor.since,
        (next.scanStartedAt ?? this.now()) - 60000,
      );
      next.page = 1;
      if (next.scanModified === undefined) delete next.lastModified;
      else next.lastModified = next.scanModified;
      delete next.scanStartedAt;
      delete next.scanModified;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const update of page.updates) {
        if (update.prUrl === undefined) continue;
        const pr = this.db
          .prepare(
            "SELECT id FROM tracked_prs WHERE url=? AND enabled=1 AND tracking_state='archived'",
          )
          .get(update.prUrl);
        if (
          pr !== undefined &&
          Number(
            this.db
              .prepare("INSERT OR IGNORE INTO notification_seen VALUES(?,?,?)")
              .run(account, update.id, update.updatedAt).changes,
          ) > 0
        )
          this.db
            .prepare(
              "INSERT INTO notification_refreshes(pr_id,revision,next_check_ms) VALUES(?,?,0) ON CONFLICT(pr_id) DO UPDATE SET revision=max(revision,excluded.revision),next_check_ms=CASE WHEN excluded.revision>revision THEN 0 ELSE next_check_ms END",
            )
            .run(String(pr["id"]), update.updatedAt);
      }
      this.db
        .prepare(
          "INSERT INTO notification_cursors(account,data) VALUES(?,?) ON CONFLICT(account) DO UPDATE SET data=excluded.data",
        )
        .run(account, JSON.stringify(next));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  pending(): { id: string; revision: number }[] {
    return this.db
      .prepare(
        "SELECT pr_id,revision FROM notification_refreshes WHERE next_check_ms<=? LIMIT 20",
      )
      .all(this.now())
      .map((row) => ({
        id: String(row["pr_id"]),
        revision: Number(row["revision"]),
      }));
  }
  finish(id: string, revision: number): void {
    this.db
      .prepare(
        "DELETE FROM notification_refreshes WHERE pr_id=? AND revision=?",
      )
      .run(id, revision);
  }
  defer(id: string, revision: number): void {
    this.db
      .prepare(
        "UPDATE notification_refreshes SET next_check_ms=? WHERE pr_id=? AND revision=?",
      )
      .run(this.now() + 60000, id, revision);
  }
}
export class NotificationService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private work: Promise<void> | undefined;
  private stopped = false;
  private controller: AbortController | undefined;
  constructor(
    private store: NotificationStore,
    private tracking: TrackingService,
    private now: () => number = Date.now,
    private reader: NotificationReader = githubNotifications,
  ) {}
  private isStopped(): boolean {
    return this.stopped;
  }
  start(): void {
    this.timer = setInterval(() => {
      this.flush().catch(() => {});
    }, 1000);
    this.flush().catch(() => {});
  }
  flush(): Promise<void> {
    if (this.work !== undefined) return this.work;
    if (this.isStopped()) return Promise.resolve();
    this.work = this.run().finally(() => {
      this.work = undefined;
    });
    return this.work;
  }
  private async run(): Promise<void> {
    const status = this.store.status();
    if (this.store.eligible() && status.nextPollAt <= this.now()) {
      const controller = new AbortController();
      this.controller = controller;
      try {
        const account = await this.reader.identity(controller.signal);
        let interval = 60;
        for (let index = 0; index < 10 && !this.isStopped(); index++) {
          const cursor = this.store.cursor(account);
          const query = {
            since: cursor.since,
            page: cursor.page,
            ...(cursor.page === 1 && cursor.lastModified !== undefined
              ? { lastModified: cursor.lastModified }
              : {}),
          };
          const page = await this.reader.page(query, controller.signal);
          if (this.isStopped()) return;
          this.store.page(account, page);
          interval = page.pollSeconds;
          if (!page.more) break;
        }
        if (!this.isStopped())
          this.store.statusResult({
            nextPollAt: this.now() + Math.max(60, interval) * 1000,
            account,
          });
      } catch (error) {
        if (!this.isStopped())
          this.store.statusResult({
            nextPollAt: Math.max(
              this.now() + 60000,
              error instanceof NotificationAccessError
                ? (error.retryAt ?? 0)
                : 0,
            ),
            lastError:
              error instanceof Error
                ? error.message.slice(0, 500)
                : "GitHub notification access unavailable",
          });
      } finally {
        this.controller = undefined;
      }
    }
    for (const request of this.store.pending()) {
      if (this.isStopped()) return;
      const before = this.tracking.store.pr(request.id);
      if (before.state !== TrackingState.Archived || !before.enabled) {
        this.store.finish(request.id, request.revision);
        continue;
      }
      try {
        await this.tracking.refresh(request.id);
        if (this.isStopped()) return;
        const pr = this.tracking.store.pr(request.id);
        if (pr.lastRefreshError !== undefined)
          this.store.defer(request.id, request.revision);
        else this.store.finish(request.id, request.revision);
      } catch {
        this.store.defer(request.id, request.revision);
      }
    }
  }
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.controller?.abort();
  }
  async close(): Promise<void> {
    this.stop();
    await this.work;
  }
}
