import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotificationInputRevision } from "../src/notifications/input-revision.js";
import { Store } from "../src/store.js";

function schema(db: DatabaseSync): void {
  db.exec(
    "CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE github_schedules(id TEXT PRIMARY KEY,value TEXT); CREATE TABLE github_views(id TEXT PRIMARY KEY,value TEXT); CREATE TABLE facts(id TEXT PRIMARY KEY,value TEXT)",
  );
}

test("notification revisions isolate bookkeeping and follow all other local mutations transactionally", () => {
  const db = new DatabaseSync(":memory:");
  try {
    schema(db);
    const revision = new NotificationInputRevision(db);
    const initial = revision.current();
    for (const table of ["github_schedules", "github_views"]) {
      db.prepare(`INSERT INTO ${table} VALUES('fixture','one')`).run();
      db.prepare(`UPDATE ${table} SET value='two'`).run();
      db.prepare(`DELETE FROM ${table}`).run();
    }
    db.prepare("INSERT INTO settings VALUES('github_dispatch','one')").run();
    db.prepare(
      "UPDATE settings SET value='two' WHERE key='github_dispatch'",
    ).run();
    db.prepare("DELETE FROM settings WHERE key='github_dispatch'").run();
    expect(revision.current()).toBe(initial);
    let previous = initial;
    for (const sql of [
      "INSERT INTO facts VALUES('fixture','one')",
      "UPDATE facts SET value='two'",
      "DELETE FROM facts",
      "INSERT INTO settings VALUES('policy','one')",
      "UPDATE settings SET value='two' WHERE key='policy'",
      "UPDATE settings SET key='github_dispatch' WHERE key='policy'",
      "UPDATE settings SET key='policy' WHERE key='github_dispatch'",
      "DELETE FROM settings WHERE key='policy'",
    ]) {
      db.prepare(sql).run();
      expect(revision.current()).not.toBe(previous);
      previous = revision.current();
    }
    db.exec("BEGIN; INSERT INTO facts VALUES('rollback','fixture')");
    expect(revision.current()).not.toBe(previous);
    db.exec("ROLLBACK");
    expect(revision.current()).toBe(previous);
  } finally {
    db.close();
  }
});

test("notification revisions observe external bookkeeping writes and fall back after unknown schema changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-revision-"));
  const db = new DatabaseSync(join(directory, "fixture.sqlite"));
  const external = new DatabaseSync(join(directory, "fixture.sqlite"));
  try {
    schema(db);
    const revision = new NotificationInputRevision(db);
    let previous = revision.current();
    external
      .prepare("INSERT INTO github_views VALUES('external','fixture')")
      .run();
    expect(revision.current()).not.toBe(previous);
    previous = revision.current();
    db.exec("CREATE TABLE future_input(id TEXT PRIMARY KEY,value TEXT)");
    expect(revision.current()).not.toBe(previous);
    previous = revision.current();
    for (const sql of [
      "INSERT INTO future_input VALUES('fixture','one')",
      "UPDATE future_input SET value='two'",
      "DELETE FROM future_input",
    ]) {
      db.prepare(sql).run();
      expect(revision.current()).not.toBe(previous);
      previous = revision.current();
    }
  } finally {
    external.close();
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Store keeps the general revision conservative while default notifications ignore dispatch accounting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-store-revision-"));
  const store = new Store(directory);
  try {
    const notification = store.notificationInputRevision(),
      all = store.inputRevision();
    store.schedules.saveDispatch({
      ...store.schedules.dispatch(),
      nextAtMs: 1234,
    });
    expect(store.inputRevision()).not.toBe(all);
    expect(store.notificationInputRevision()).toBe(notification);
    store.tracking.registerAgent({
      harness: "codex",
      endpoint: "local",
      sessionId: "new-recipient",
    });
    expect(store.notificationInputRevision()).not.toBe(notification);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
