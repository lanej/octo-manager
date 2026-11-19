import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
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
    await migrateIssueStorage(directory, value.root, false, () => repository);
    expect(repository.documents.size).toBe(1);
    const check = new Store(directory);
    try {
      expect(check.issues.get(value.id).ref).toEqual(value.ref);
      expect(check.issues.get(value.id).waiting).toBe(Waiting.Paused);
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
