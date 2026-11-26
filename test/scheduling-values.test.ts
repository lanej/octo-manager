import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import * as values from "typebox/value";
import { ScheduleStore } from "../src/scheduling/store.js";
import { RefreshKind, ScheduleSchema, ScheduleState, type ScheduledRefresh } from "../src/scheduling/contracts.js";

function database(path = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE github_schedules(key TEXT PRIMARY KEY,kind TEXT,subject TEXT,due_at_ms INTEGER,state TEXT,data TEXT);
    CREATE TABLE github_views(url TEXT PRIMARY KEY,data TEXT,accessed_at_ms INTEGER);
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
    INSERT INTO settings VALUES('github_dispatch','{"nextAtMs":0,"coreRetryAtMs":0,"graphqlRetryAtMs":0}');`);
  return db;
}

function schedule(key = "reviews:one"): ScheduledRefresh {
  return {
    key,
    kind: RefreshKind.Reviews,
    subject: key,
    dueAtMs: 100,
    intervalMs: 60000,
    state: ScheduleState.Deferred,
  };
}

test("unchanged scheduling reads reuse preparation and validation while still executing SQL", () => {
  const db = database();
  const prepare = spyOn(db, "prepare");
  const parse = spyOn(JSON, "parse");
  const check = spyOn(values, "Check");
  const get = spyOn(StatementSync.prototype, "get");
  const all = spyOn(StatementSync.prototype, "all");
  try {
    const store = new ScheduleStore(db, () => 0);
    store.save(schedule());
    expect(store.get("reviews:one")?.dueAtMs).toBe(100);
    expect(store.dispatch().nextAtMs).toBe(0);
    prepare.mockClear();
    parse.mockClear();
    check.mockClear();
    get.mockClear();
    all.mockClear();
    for (let index = 0; index < 3; index++) {
      expect(store.get("reviews:one")?.dueAtMs).toBe(100);
      expect(store.list().length).toBe(1);
      expect(store.reviews().length).toBe(1);
      expect(store.queuedKeys().size).toBe(0);
      expect(store.dispatch().nextAtMs).toBe(0);
    }
    expect(prepare.mock.calls.length).toBe(0);
    expect(parse.mock.calls.length).toBe(0);
    expect(check.mock.calls.length).toBe(0);
    expect(get.mock.calls.length).toBe(6);
    expect(all.mock.calls.length).toBe(9);
    store.save({ ...schedule(), dueAtMs: 200 });
    expect(store.get("reviews:one")?.dueAtMs).toBe(200);
    expect(parse.mock.calls.length).toBe(1);
    expect(check.mock.calls.length).toBe(1);
    const checkedSchema: unknown = check.mock.calls[0]?.[0];
    expect(checkedSchema).toBe(ScheduleSchema);
  } finally {
    all.mockRestore();
    get.mockRestore();
    check.mockRestore();
    parse.mockRestore();
    prepare.mockRestore();
    db.close();
  }
});

test("retained scheduling values isolate saved inputs, returned graphs, rollback and sibling stores", () => {
  const db = database();
  try {
    const store = new ScheduleStore(db, () => 0);
    const input = { ...schedule(), extra: { labels: ["original"] } };
    store.save(input);
    input.extra.labels.push("unsaved");
    const first = store.get(input.key);
    if (first === undefined) throw new Error("Missing saved schedule");
    Object.assign(first, { dueAtMs: 999, extra: { labels: ["replaced"] } });
    const list = store.list();
    const extra: unknown = Reflect.get(list[0] ?? {}, "extra");
    expect(extra).toEqual({ labels: ["original"] });
    if (typeof extra !== "object" || extra === null) throw new Error("Missing retained extra data");
    Reflect.set(extra, "labels", ["nested mutation"]);
    const retained: unknown = store.get(input.key);
    expect(retained).toEqual({
      ...schedule(),
      extra: { labels: ["original"] },
    });
    const dispatch = store.dispatch();
    dispatch.nextAtMs = 999;
    expect(store.dispatch().nextAtMs).toBe(0);
    db.exec("BEGIN");
    store.save({ ...schedule(), dueAtMs: 222 });
    store.saveDispatch({ ...dispatch, nextAtMs: 222 });
    expect(store.get(input.key)?.dueAtMs).toBe(222);
    expect(store.dispatch().nextAtMs).toBe(222);
    db.exec("ROLLBACK");
    expect(store.get(input.key)?.dueAtMs).toBe(100);
    expect(store.dispatch().nextAtMs).toBe(0);
    const sibling = new ScheduleStore(db, () => 0);
    sibling.save({ ...schedule(), dueAtMs: 333 });
    expect(store.get(input.key)?.dueAtMs).toBe(333);
    sibling.remove(input.key);
    expect(store.get(input.key)).toBeUndefined();
    store.save({ ...schedule(), state: ScheduleState.Running });
    const restarted = new ScheduleStore(db, () => 0);
    expect(restarted.get(input.key)?.state).toBe(ScheduleState.Queued);
    expect(store.get(input.key)?.state).toBe(ScheduleState.Queued);
  } finally {
    db.close();
  }
});

test("external writes remain authoritative including payload kind and corrupt values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-schedule-values-"));
  const path = join(directory, "schedules.sqlite");
  const db = database(path);
  const external = new DatabaseSync(path);
  try {
    const store = new ScheduleStore(db, () => 0);
    store.save(schedule());
    expect(store.reviews().length).toBe(1);
    external.prepare("UPDATE github_schedules SET kind='tracking',data=json_set(data,'$.dueAtMs',456)").run();
    expect(store.reviews()[0]?.dueAtMs).toBe(456);
    external.prepare("UPDATE github_schedules SET data=json_remove(data,'$.intervalMs')").run();
    expect(() => store.reviews()).toThrow("Invalid stored GitHub schedule data");
    external.prepare("UPDATE settings SET value='{}' WHERE key='github_dispatch'").run();
    expect(() => store.dispatch()).toThrow("Invalid stored GitHub schedule data");
  } finally {
    external.close();
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("validation retention has bounded entries and oversized values remain correct", () => {
  const db = database();
  const parse = spyOn(JSON, "parse");
  try {
    const store = new ScheduleStore(db, () => 0);
    for (let index = 0; index < 257; index++) {
      const value = schedule(`reviews:${String(index)}`);
      store.save(value);
      store.get(value.key);
    }
    parse.mockClear();
    expect(store.get("reviews:256")?.key).toBe("reviews:256");
    expect(parse.mock.calls.length).toBe(0);
    expect(store.get("reviews:0")?.key).toBe("reviews:0");
    expect(parse.mock.calls.length).toBe(1);
    const oversized = {
      ...schedule("reviews:large"),
      extra: "x".repeat(524288),
    };
    store.save(oversized);
    store.get(oversized.key);
    parse.mockClear();
    expect(store.get(oversized.key)).toEqual(oversized);
    expect(parse.mock.calls.length).toBe(1);
  } finally {
    parse.mockRestore();
    db.close();
  }
});
