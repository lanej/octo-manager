import { StorageMigrationState } from "../src/issues/repository-store.js";
import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  mkdirSync,
  rmdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IssueStore } from "../src/issues/store.js";
import {
  IssueStage,
  Waiting,
  type IssueRecord,
} from "../src/issues/contracts.js";
import {
  contentOf,
  type IssueContent,
  type IssueRepository,
} from "../src/issues/repository.js";
import { synchronizeIssue } from "../src/issues/storage.js";
import { migrateIssueStorage } from "../src/issues/migration.js";
import { Store } from "../src/store.js";

const signal = () => AbortSignal.timeout(5000);
async function rejected(promise: Promise<unknown>): Promise<string> {
  return await promise.then(
    () => {
      throw new Error("Expected rejection");
    },
    (error: unknown) => {
      if (error instanceof Error) return error.message;
      throw new Error("Unexpected rejection value");
    },
  );
}

function issue(): IssueRecord {
  return {
    id: randomUUID(),
    ref: {
      provider: "github",
      project: "lanej/octo-manager",
      externalId: "47",
      url: "https://github.com/lanej/octo-manager/issues/47",
    },
    root: process.cwd(),
    ownerId: "owner",
    title: "Preserve identity",
    body: "Original body",
    stage: IssueStage.Investigation,
    waiting: Waiting.Paused,
    detail: "Paused",
    epoch: 1,
    brief: undefined,
    approvedVersion: 0,
    publicationVersion: 0,
    policyHash: "policy",
    externalClosed: false,
    comments: [],
    reviewedComments: [],
    pendingComments: [],
    clarificationRound: 0,
    clarificationDueAt: undefined,
    timeoutPlanned: false,
    prUrl: "",
    prHead: "",
    verifiedHead: "",
    assignmentId: "",
    workspace: "",
    createdAt: 1000,
    updatedAt: 1000,
    nextAt: 0,
    pollIntervalMs: 60000,
  };
}
class MemoryRepository implements IssueRepository {
  identity = "controlled-storage";
  documents = new Map<string, IssueContent>();
  failing = false;
  writes = 0;
  read(id: string): Promise<IssueContent | undefined> {
    if (this.failing) return Promise.reject(new Error("Storage unavailable"));
    return Promise.resolve(structuredClone(this.documents.get(id)));
  }
  write(content: IssueContent): Promise<void> {
    this.writes++;
    this.documents.set(content.id, structuredClone(content));
    return Promise.resolve();
  }
}
function fixture() {
  const db = new DatabaseSync(":memory:");
  const store = new IssueStore(db, () => 2000);
  const value = issue();
  store.save(value, "enrolled", "fixture");
  const repository = new MemoryRepository();
  store.repository.bind(contentOf(value), repository.identity);
  return { db, store, value, repository };
}
test("content persists independently while Octo identity and execution state remain local", async () => {
  const f = fixture();
  try {
    expect(f.store.repository.ready(f.value.id)).toBe(false);
    await synchronizeIssue(f.store, f.value, f.repository, signal());
    expect(f.repository.documents.get(f.value.id)?.title).toBe(
      "Preserve identity",
    );
    expect(f.store.repository.ready(f.value.id)).toBe(true);
    f.store.save(
      { ...f.store.get(f.value.id), detail: "Execution changed", epoch: 2 },
      "execution",
      "Changed",
    );
    await synchronizeIssue(
      f.store,
      f.store.get(f.value.id),
      f.repository,
      signal(),
    );
    expect(f.repository.writes).toBe(1);
    expect(f.store.get(f.value.id).epoch).toBe(2);
  } finally {
    f.db.close();
  }
});
test("storage failure gates work and recovery never treats a missing document as an empty issue", async () => {
  const f = fixture();
  try {
    await synchronizeIssue(f.store, f.value, f.repository, signal());
    f.repository.failing = true;
    expect(
      await rejected(
        synchronizeIssue(f.store, f.value, f.repository, signal()),
      ),
    ).toContain("Storage unavailable");
    expect(f.store.repository.ready(f.value.id)).toBe(false);
    f.repository.failing = false;
    f.repository.documents.clear();
    expect(
      await rejected(
        synchronizeIssue(f.store, f.value, f.repository, signal()),
      ),
    ).toContain("Authoritative issue content is missing");
    expect(f.repository.writes).toBe(1);
  } finally {
    f.db.close();
  }
});
test("direct content edits supersede stale work and preserve explicit pause", async () => {
  const f = fixture();
  try {
    await synchronizeIssue(f.store, f.value, f.repository, signal());
    const content = f.repository.documents.get(f.value.id);
    if (content === undefined) throw new Error("Missing fixture content");
    f.repository.documents.set(f.value.id, {
      ...content,
      body: "Edited outside Octo",
      updatedAt: 3000,
    });
    await synchronizeIssue(f.store, f.value, f.repository, signal());
    const changed = f.store.get(f.value.id);
    expect(changed.body).toBe("Edited outside Octo");
    expect(changed.waiting).toBe(Waiting.Paused);
    expect(
      changed.pendingComments.some(
        (item) => item.body === "Edited outside Octo",
      ),
    ).toBe(true);
    expect(changed.epoch).toBeGreaterThan(f.value.epoch);
    expect(f.store.effects().some((item) => item.kind === "sync_content")).toBe(
      true,
    );
  } finally {
    f.db.close();
  }
});
test("last write wins retains conflict evidence and stored values win timestamp ties", async () => {
  const f = fixture();
  try {
    await synchronizeIssue(f.store, f.value, f.repository, signal());
    f.store.save(
      { ...f.store.get(f.value.id), body: "Local competing edit" },
      "edit",
      "Local",
    );
    const content = f.repository.documents.get(f.value.id);
    if (content === undefined) throw new Error("Missing fixture content");
    f.repository.documents.set(f.value.id, {
      ...content,
      body: "Stored competing edit",
      updatedAt: 2000,
    });
    await synchronizeIssue(
      f.store,
      f.store.get(f.value.id),
      f.repository,
      signal(),
    );
    expect(f.store.get(f.value.id).body).toBe("Stored competing edit");
    const event = f.store
      .events(f.value.id)
      .find((item) => item.kind === "storage_conflict");
    expect(event?.detail).toContain("Local competing edit");
    expect(event?.detail).toContain("Stored competing edit");
  } finally {
    f.db.close();
  }
});
test("an intention admitted during a repository write is retained for the next reconciliation", async () => {
  const f = fixture();
  const original = f.repository.write.bind(f.repository);
  f.repository.write = async (content) => {
    await original(content);
    f.store.save(
      { ...f.store.get(f.value.id), body: "Newer command" },
      "edit",
      "Admitted concurrently",
    );
  };
  try {
    await synchronizeIssue(f.store, f.value, f.repository, signal());
    expect(f.store.repository.ready(f.value.id)).toBe(false);
    expect(f.store.repository.get(f.value.id)?.pending?.body).toBe(
      "Newer command",
    );
    f.repository.write = original;
    await synchronizeIssue(
      f.store,
      f.store.get(f.value.id),
      f.repository,
      signal(),
    );
    expect(f.repository.documents.get(f.value.id)?.body).toBe("Newer command");
  } finally {
    f.db.close();
  }
});
test("migration backs up internal records, preserves identifiers, pauses work and safely replays", async () => {
  const directory = mkdtempSync(join(tmpdir(), "octo-storage-migration-"));
  const repository = new MemoryRepository();
  const value = issue();
  const original = new Store(directory);
  original.issues.save(value, "enrolled", "Migration fixture");
  original.close();
  try {
    const dry = await migrateIssueStorage(directory, value.root, true, () => {
      throw new Error("Dry-run contacted storage");
    });
    expect(dry).toEqual({ state: "dry_run", count: 1, migrated: 0 });
    const result = await migrateIssueStorage(
      directory,
      value.root,
      false,
      () => repository,
    );
    expect(result.migrated).toBe(1);
    expect(existsSync(result.backup ?? "")).toBe(true);
    const paused = new Store(directory);
    const resumed = {
      ...paused.issues.get(value.id),
      waiting: Waiting.None,
      epoch: 42,
      detail: "Resumed after migration",
    };
    paused.issues.save(resumed, "resumed", resumed.detail);
    const events = paused.issues.events(value.id);
    paused.close();
    const writes = repository.writes;
    const before = readdirSync(join(directory, "migration-backups"));
    const replay = await migrateIssueStorage(
      directory,
      value.root,
      false,
      () => repository,
    );
    expect(replay).toMatchObject({
      state: "already_migrated",
      migrated: 0,
      alreadyMigrated: 1,
      backup: result.backup,
    });
    expect(repository.documents.size).toBe(1);
    expect(repository.writes).toBe(writes);
    expect(readdirSync(join(directory, "migration-backups"))).toEqual(before);
    const check = new Store(directory);
    try {
      expect(check.issues.get(value.id).ref).toEqual(value.ref);
      expect(check.issues.get(value.id)).toEqual(resumed);
      expect(check.issues.events(value.id)).toEqual(events);
      expect(check.issues.assignments()).toEqual([]);
    } finally {
      check.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("an empty pre-lifecycle database migrates without creating records or contacting Beads", async () => {
  const directory = mkdtempSync(join(tmpdir(), "octo-storage-empty-"));
  const db = new DatabaseSync(join(directory, "jobs.sqlite"));
  db.exec("CREATE TABLE jobs(id TEXT PRIMARY KEY)");
  db.close();
  try {
    const result = await migrateIssueStorage(
      directory,
      process.cwd(),
      false,
      () => {
        throw new Error("Empty migration contacted storage");
      },
    );
    expect(result).toEqual({ state: "empty", count: 0, migrated: 0 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a missing confirmed record is not recreated when a local write is pending", async () => {
  const f = fixture();
  try {
    await synchronizeIssue(f.store, f.value, f.repository, signal());
    f.store.save(
      { ...f.store.get(f.value.id), body: "Pending edit" },
      "edit",
      "Local",
    );
    f.repository.documents.clear();
    expect(
      await rejected(
        synchronizeIssue(f.store, f.value, f.repository, signal()),
      ),
    ).toContain("Authoritative issue content is missing");
    expect(f.repository.writes).toBe(1);
    expect(f.store.repository.get(f.value.id)?.pending?.body).toBe(
      "Pending edit",
    );
  } finally {
    f.db.close();
  }
});

test("projection intent and observed content commit together and replay after an interrupted insert", async () => {
  const f = fixture();
  try {
    await synchronizeIssue(f.store, f.value, f.repository, signal());
    const content = f.repository.documents.get(f.value.id);
    if (content === undefined) throw new Error("Missing fixture content");
    f.repository.documents.set(f.value.id, {
      ...content,
      body: "Needs projection",
      updatedAt: 3000,
    });
    f.db.exec(
      "CREATE TRIGGER fail_projection BEFORE INSERT ON issue_effects BEGIN SELECT RAISE(ABORT,'projection unavailable'); END",
    );
    expect(
      await rejected(
        synchronizeIssue(f.store, f.value, f.repository, signal()),
      ),
    ).toContain("projection unavailable");
    expect(f.store.get(f.value.id).body).toBe("Original body");
    expect(f.store.effects()).toHaveLength(0);
    f.db.exec("DROP TRIGGER fail_projection");
    await synchronizeIssue(f.store, f.value, f.repository, signal());
    expect(f.store.get(f.value.id).body).toBe("Needs projection");
    expect(
      f.store.effects().filter((item) => item.kind === "sync_content"),
    ).toHaveLength(1);
  } finally {
    f.db.close();
  }
});

test("an independent newer body edit does not discard an incoming comment revision", async () => {
  const f = fixture();
  try {
    const comment = {
      id: "github:1",
      revision: "2026-11-19T01:00:00Z",
      author: "reviewer",
      body: "Original comment",
      url: f.value.ref.url,
    };
    f.store.save(
      { ...f.value, comments: [comment] },
      "input",
      "Initial comment",
    );
    await synchronizeIssue(
      f.store,
      f.store.get(f.value.id),
      f.repository,
      signal(),
    );
    const content = f.repository.documents.get(f.value.id);
    if (content === undefined) throw new Error("Missing fixture content");
    f.store.save(
      {
        ...f.store.get(f.value.id),
        comments: [
          {
            ...comment,
            revision: "2026-11-19T01:01:00Z",
            body: "Edited comment",
          },
        ],
      },
      "input",
      "Incoming revision",
    );
    f.repository.documents.set(f.value.id, {
      ...content,
      body: "Independent body edit",
      updatedAt: 10000,
    });
    await synchronizeIssue(
      f.store,
      f.store.get(f.value.id),
      f.repository,
      signal(),
    );
    expect(f.store.get(f.value.id).body).toBe("Independent body edit");
    expect(f.store.get(f.value.id).comments[0]?.body).toBe("Edited comment");
  } finally {
    f.db.close();
  }
});

test("field timestamps keep an unrelated recent edit from winning an older conflicting title", async () => {
  const f = fixture();
  try {
    await synchronizeIssue(f.store, f.value, f.repository, signal());
    f.store.save(
      { ...f.store.get(f.value.id), title: "Latest title" },
      "edit",
      "Title at 2000",
    );
    const content = f.repository.documents.get(f.value.id);
    if (content === undefined) throw new Error("Missing fixture content");
    f.repository.documents.set(f.value.id, {
      ...content,
      title: "Older competing title",
      body: "Recent body",
      updatedAt: 10000,
      fieldTimes: { title: 1500, body: 10000 },
    });
    await synchronizeIssue(
      f.store,
      f.store.get(f.value.id),
      f.repository,
      signal(),
    );
    expect(f.store.get(f.value.id).title).toBe("Latest title");
    expect(f.store.get(f.value.id).body).toBe("Recent body");
  } finally {
    f.db.close();
  }
});

test("an unchanged stored field retains its original clock across unrelated native changes", async () => {
  const f = fixture();
  try {
    await synchronizeIssue(f.store, f.value, f.repository, signal());
    const content = f.repository.documents.get(f.value.id);
    if (content === undefined) throw new Error("Missing fixture content");
    f.repository.documents.set(f.value.id, {
      ...content,
      body: "Native edit",
      updatedAt: 3000,
      fieldTimes: { body: 3000 },
    });
    await synchronizeIssue(f.store, f.value, f.repository, signal());
    const updated = f.repository.documents.get(f.value.id);
    if (updated === undefined) throw new Error("Missing updated content");
    f.repository.documents.set(f.value.id, {
      ...updated,
      updatedAt: 10000,
      fieldTimes: { body: 10000 },
    });
    await synchronizeIssue(
      f.store,
      f.store.get(f.value.id),
      f.repository,
      signal(),
    );
    expect(f.store.repository.get(f.value.id)?.baseline?.fieldTimes?.body).toBe(
      3000,
    );
  } finally {
    f.db.close();
  }
});

test("an interrupted migration reuses its backup and pause receipt without repeating a committed provider write", async () => {
  const directory = mkdtempSync(join(tmpdir(), "octo-migration-resume-"));
  const repository = new MemoryRepository();
  const value = issue();
  const setup = new Store(directory);
  setup.issues.save(value, "enrolled", "Migration fixture");
  setup.close();
  const write = repository.write.bind(repository);
  let loseReply = true;
  repository.write = async (content) => {
    await write(content);
    if (loseReply) {
      loseReply = false;
      throw new Error("Write reply lost");
    }
  };
  try {
    expect(
      await rejected(
        migrateIssueStorage(directory, value.root, false, () => repository),
      ),
    ).toContain("Write reply lost");
    const backups = readdirSync(join(directory, "migration-backups"));
    expect(backups).toHaveLength(1);
    // Simulate a started migration produced before tracker baseline seeding existed.
    const legacy = new DatabaseSync(join(directory, "jobs.sqlite"));
    legacy.exec("DELETE FROM issue_tracker_baselines");
    legacy.close();
    const interrupted = new Store(directory);
    const epoch = interrupted.issues.get(value.id).epoch;
    const receipt = interrupted.issues.repository.migration(
      value.id,
      repository.identity,
    );
    expect(receipt?.state).toBe(StorageMigrationState.Started);
    interrupted.close();
    const result = await migrateIssueStorage(
      directory,
      value.root,
      false,
      () => repository,
    );
    expect(result.migrated).toBe(1);
    expect(result.backup).toBe(receipt?.backup);
    expect(repository.writes).toBe(1);
    expect(readdirSync(join(directory, "migration-backups"))).toEqual(backups);
    const verified = new Store(directory);
    try {
      expect(verified.issues.get(value.id).epoch).toBe(epoch);
      expect(verified.issues.repository.tracker(value.id)).toEqual({
        title: value.title,
        body: value.body,
        closed: value.externalClosed,
        revision: "",
      });
      expect(
        verified.issues.repository.migration(value.id, repository.identity)
          ?.state,
      ).toBe(StorageMigrationState.Completed);
      expect(
        verified.issues
          .events(value.id)
          .filter((event) => event.kind === "storage_migration"),
      ).toHaveLength(1);
    } finally {
      verified.close();
    }
    const location = join(
      directory,
      "migration-backups",
      backups[0] ?? "missing",
      "manifest.json",
    );
    const manifest = readFileSync(location, "utf8");
    await migrateIssueStorage(directory, value.root, false, () => repository);
    expect(readFileSync(location, "utf8")).toBe(manifest);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("migration processes newly added internal issues without touching completed issues", async () => {
  const directory = mkdtempSync(join(tmpdir(), "octo-migration-additive-"));
  const repository = new MemoryRepository();
  const first = issue();
  const setup = new Store(directory);
  setup.issues.save(first, "enrolled", "First issue");
  setup.close();
  try {
    await migrateIssueStorage(directory, first.root, false, () => repository);
    const updated = new Store(directory);
    const before = updated.issues.get(first.id);
    const second = {
      ...issue(),
      ref: {
        ...first.ref,
        externalId: "48",
        url: "https://github.com/lanej/octo-manager/issues/48",
      },
    };
    updated.issues.save(second, "enrolled", "New issue");
    updated.close();
    const result = await migrateIssueStorage(
      directory,
      first.root,
      false,
      () => repository,
    );
    expect(result).toMatchObject({ migrated: 1, alreadyMigrated: 1, count: 2 });
    expect(repository.writes).toBe(2);
    const verified = new Store(directory);
    try {
      expect(verified.issues.get(first.id)).toEqual(before);
    } finally {
      verified.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("confirmation before receipt completion replays bookkeeping without re-pausing resumed work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "octo-migration-confirmed-"));
  const repository = new MemoryRepository();
  const value = issue();
  const setup = new Store(directory);
  setup.issues.save(value, "enrolled", "Migration fixture");
  setup.close();
  const raw = new DatabaseSync(join(directory, "jobs.sqlite"));
  raw.exec(
    "CREATE TRIGGER fail_completion BEFORE UPDATE ON issue_storage_migrations WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'completion reply lost'); END",
  );
  raw.close();
  try {
    expect(
      await rejected(
        migrateIssueStorage(directory, value.root, false, () => repository),
      ),
    ).toContain("completion reply lost");
    const raw = new DatabaseSync(join(directory, "jobs.sqlite"));
    raw.exec("DROP TRIGGER fail_completion");
    raw.close();
    const resumedStore = new Store(directory);
    const resumed = {
      ...resumedStore.issues.get(value.id),
      waiting: Waiting.None,
      epoch: 99,
      detail: "Resumed by operator",
    };
    resumedStore.issues.save(resumed, "resumed", resumed.detail);
    resumedStore.close();
    const result = await migrateIssueStorage(
      directory,
      value.root,
      false,
      () => repository,
    );
    expect(result).toMatchObject({
      state: "already_migrated",
      migrated: 0,
      alreadyMigrated: 1,
    });
    expect(repository.writes).toBe(1);
    const verified = new Store(directory);
    try {
      expect(verified.issues.get(value.id)).toEqual(resumed);
      expect(
        verified.issues.repository.migration(value.id, repository.identity)
          ?.state,
      ).toBe(StorageMigrationState.Completed);
    } finally {
      verified.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unfinished migration refuses to resume when its original backup has disappeared", async () => {
  const directory = mkdtempSync(join(tmpdir(), "octo-migration-backup-"));
  const repository = new MemoryRepository();
  const value = issue();
  const setup = new Store(directory);
  setup.issues.save(value, "enrolled", "Migration fixture");
  setup.close();
  const write = repository.write.bind(repository);
  repository.write = () => Promise.reject(new Error("Provider unavailable"));
  try {
    expect(
      await rejected(
        migrateIssueStorage(directory, value.root, false, () => repository),
      ),
    ).toContain("Provider unavailable");
    const paused = new Store(directory);
    const receipt = paused.issues.repository.migration(
      value.id,
      repository.identity,
    );
    paused.close();
    if (receipt === undefined) throw new Error("Missing fixture receipt");
    unlinkSync(receipt.backup);
    repository.write = write;
    expect(
      await rejected(
        migrateIssueStorage(directory, value.root, false, () => repository),
      ),
    ).toContain("Migration backup is missing");
    expect(repository.writes).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("completed migration receipts repair a lost manifest without repeating migration", async () => {
  const directory = mkdtempSync(join(tmpdir(), "octo-migration-manifest-"));
  const repository = new MemoryRepository();
  const value = issue();
  const setup = new Store(directory);
  setup.issues.save(value, "enrolled", "Migration fixture");
  setup.close();
  const write = repository.write.bind(repository);
  let path = "";
  repository.write = async (content) => {
    await write(content);
    const backup = readdirSync(join(directory, "migration-backups"))[0];
    if (backup === undefined) throw new Error("Missing fixture backup");
    path = join(directory, "migration-backups", backup, "manifest.json");
    unlinkSync(path);
    mkdirSync(path);
  };
  try {
    const failure = await rejected(
      migrateIssueStorage(directory, value.root, false, () => repository),
    );
    expect(failure).toContain("EISDIR");
    const completed = new Store(directory);
    expect(
      completed.issues.repository.migration(value.id, repository.identity)
        ?.state,
    ).toBe(StorageMigrationState.Completed);
    const before = completed.issues.get(value.id);
    completed.close();
    rmdirSync(path);
    const result = await migrateIssueStorage(
      directory,
      value.root,
      false,
      () => repository,
    );
    expect(result.migrated).toBe(0);
    expect(repository.writes).toBe(1);
    expect(readFileSync(path, "utf8")).toContain('"state": "completed"');
    const checked = new Store(directory);
    try {
      expect(checked.issues.get(value.id)).toEqual(before);
    } finally {
      checked.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("migration seeds observed tracker values once without fabricating a source revision", async () => {
  const directory = mkdtempSync(join(tmpdir(), "octo-migration-baseline-"));
  const repository = new MemoryRepository();
  const value = issue();
  const setup = new Store(directory);
  setup.issues.save(value, "observed", "Known tracker input");
  setup.close();
  try {
    await migrateIssueStorage(directory, value.root, false, () => repository);
    const migrated = new Store(directory);
    try {
      expect(migrated.issues.repository.tracker(value.id)).toEqual({
        title: value.title,
        body: value.body,
        closed: value.externalClosed,
        revision: "",
      });
      const newer = {
        title: "New tracker input",
        body: "Updated remotely",
        closed: true,
        revision: "2026-11-20T00:00:00Z",
      };
      migrated.issues.repository.observedTracker(value.id, newer);
      migrated.issues.repository.seedTracker(value.id, {
        title: "Old",
        body: "Old",
        closed: false,
      });
      expect(migrated.issues.repository.tracker(value.id)).toEqual(newer);
    } finally {
      migrated.close();
    }
    await migrateIssueStorage(directory, value.root, false, () => repository);
    const replayed = new Store(directory);
    try {
      expect(replayed.issues.repository.tracker(value.id)?.revision).toBe(
        "2026-11-20T00:00:00Z",
      );
    } finally {
      replayed.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("completed migration recovers a missing baseline from the original checkpoint rather than edited content", async () => {
  const directory = mkdtempSync(join(tmpdir(), "octo-baseline-recovery-"));
  const repository = new MemoryRepository();
  const value = issue();
  const setup = new Store(directory);
  setup.issues.save(value, "observed", "Known tracker input");
  setup.close();
  try {
    await migrateIssueStorage(directory, value.root, false, () => repository);
    const raw = new DatabaseSync(join(directory, "jobs.sqlite"));
    raw.exec("DELETE FROM issue_tracker_baselines");
    raw.close();
    const edited = new Store(directory);
    edited.issues.save(
      { ...edited.issues.get(value.id), body: "Edited after migration" },
      "input",
      "Later input",
    );
    edited.close();
    const stored = repository.documents.get(value.id);
    if (stored === undefined) throw new Error("Missing fixture content");
    repository.documents.set(value.id, {
      ...stored,
      title: "Native edit",
      body: "Native body",
      updatedAt: Date.now(),
    });
    const writes = repository.writes;
    const replay = await migrateIssueStorage(
      directory,
      value.root,
      false,
      () => repository,
    );
    expect(replay.state).toBe("already_migrated");
    expect(repository.writes).toBe(writes);
    const checked = new Store(directory);
    try {
      expect(checked.issues.repository.tracker(value.id)).toEqual({
        title: value.title,
        body: value.body,
        closed: value.externalClosed,
        revision: "",
      });
      expect(checked.issues.get(value.id).body).toBe("Edited after migration");
    } finally {
      checked.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("baseline recovery refuses a missing original checkpoint without guessing from current content", async () => {
  const directory = mkdtempSync(join(tmpdir(), "octo-baseline-missing-"));
  const repository = new MemoryRepository();
  const value = issue();
  const setup = new Store(directory);
  setup.issues.save(value, "observed", "Known tracker input");
  setup.close();
  try {
    const result = await migrateIssueStorage(
      directory,
      value.root,
      false,
      () => repository,
    );
    const raw = new DatabaseSync(join(directory, "jobs.sqlite"));
    raw.exec("DELETE FROM issue_tracker_baselines");
    raw.close();
    if (result.backup === undefined)
      throw new Error("Missing fixture checkpoint");
    unlinkSync(result.backup);
    expect(
      await rejected(
        migrateIssueStorage(directory, value.root, false, () => repository),
      ),
    ).toContain("Migration backup is missing");
    expect(repository.writes).toBe(1);
    const checked = new Store(directory);
    try {
      expect(checked.issues.repository.tracker(value.id)).toBeUndefined();
    } finally {
      checked.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("never-observed enrollment leaves its tracker baseline uninitialized", async () => {
  const directory = mkdtempSync(join(tmpdir(), "octo-baseline-unobserved-"));
  const repository = new MemoryRepository();
  const value = { ...issue(), title: "", body: "" };
  const setup = new Store(directory);
  setup.issues.save(value, "enrolled", "No observation yet");
  setup.close();
  try {
    await migrateIssueStorage(directory, value.root, false, () => repository);
    await migrateIssueStorage(directory, value.root, false, () => repository);
    const checked = new Store(directory);
    try {
      expect(checked.issues.repository.tracker(value.id)).toBeUndefined();
    } finally {
      checked.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
