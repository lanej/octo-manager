import { isDeepStrictEqual } from "node:util";
import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  writeFileSync,
  statSync,
  readFileSync,
  existsSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Store } from "../store.js";
import { decodeIssue } from "./validation.js";
import { contentOf, sameContent, type IssueRepository } from "./repository.js";
import { Waiting, AttemptState, type IssueRecord } from "./contracts.js";
import { StorageMigrationState } from "./repository-store.js";
import { synchronizeIssue } from "./storage.js";

function verifyBackup(path: string): void {
  if (!existsSync(path) || !statSync(path).isFile())
    throw new Error("Migration backup is missing; restore it before resuming");
  const saved = new DatabaseSync(path);
  try {
    saved.exec("PRAGMA query_only=ON");
    const integrity = saved.prepare("PRAGMA integrity_check").get();
    if (integrity?.["integrity_check"] !== "ok")
      throw new Error("Migration backup failed integrity check");
  } finally {
    saved.close();
  }
}

/** Internal records only. Dry-run queries the existing database read-only and performs no provider writes. */
export async function migrateIssueStorage(
  directory: string,
  root: string,
  dryRun: boolean,
  repository: () => IssueRepository | undefined,
): Promise<{
  state: string;
  count: number;
  migrated: number;
  alreadyMigrated?: number;
  backup?: string;
}> {
  const filename = join(directory, "jobs.sqlite");
  if (!statSync(filename).isFile())
    throw new Error("Coordinator database is not a regular file");
  // Bun 1.4.4 cannot create missing WAL sidecars with readOnly:true. query_only
  // permits that SQLite housekeeping while rejecting all SQL data mutations.
  const source = new DatabaseSync(filename);
  source.exec("PRAGMA query_only=ON");
  let count: number;
  try {
    const installed = source
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='managed_issues'",
      )
      .get();
    count =
      installed === undefined
        ? 0
        : source
            .prepare("SELECT data FROM managed_issues")
            .all()
            .map((row) => decodeIssue(row["data"]))
            .filter((issue) => resolve(issue.root) === resolve(root)).length;
  } finally {
    source.close();
  }
  if (dryRun || count === 0)
    return { state: dryRun ? "dry_run" : "empty", count, migrated: 0 };
  const target = repository();
  if (target === undefined)
    throw new Error("Configure issues.storage.backend before migration");
  const store = new Store(directory);
  try {
    const issues = store.issues
      .list()
      .filter((issue) => resolve(issue.root) === resolve(root));
    const journal = store.issues.repository;
    const verifiedBackups = new Set<string>();
    const checkpoint = (path: string) => {
      if (verifiedBackups.has(path)) return;
      verifyBackup(path);
      verifiedBackups.add(path);
    };
    const seedTracker = (issue: IssueRecord) => {
      // Empty title is the enrollment sentinel: no tracker observation exists yet.
      if (issue.title !== "")
        journal.seedTracker(issue.id, {
          title: issue.title,
          body: issue.body,
          closed: issue.externalClosed,
        });
    };
    const recoverTracker = (issue: IssueRecord, backup: string | undefined) => {
      if (journal.tracker(issue.id) !== undefined) return;
      if (backup === undefined) {
        if (issue.title === "") return;
        throw new Error(
          `Original migration checkpoint required to recover tracker baseline for ${issue.id.slice(0, 8)}`,
        );
      }
      checkpoint(backup);
      const saved = new DatabaseSync(backup);
      try {
        saved.exec("PRAGMA query_only=ON");
        const row = saved
          .prepare("SELECT data FROM managed_issues WHERE id=?")
          .get(issue.id);
        if (row === undefined)
          throw new Error(
            "Original issue snapshot is missing from migration checkpoint",
          );
        const original = decodeIssue(row["data"]);
        if (
          original.id !== issue.id ||
          !isDeepStrictEqual(original.ref, issue.ref)
        )
          throw new Error(
            "Migration checkpoint issue identity differs from the current issue",
          );
        seedTracker(original);
      } finally {
        saved.close();
      }
    };
    const complete = issues.filter((issue) => {
      const binding = journal.get(issue.id);
      if (binding !== undefined && binding.repository !== target.identity)
        throw new Error("Issue storage identity changed; migrate explicitly");
      return binding?.baseline !== undefined;
    });
    const completedIds = new Set(complete.map((issue) => issue.id));
    const pending = issues.filter((issue) => !completedIds.has(issue.id));
    const selected = new Set(pending.map((issue) => issue.id));
    if (
      store.issues
        .assignments()
        .some(
          (item) =>
            selected.has(item.issueId) &&
            [
              AttemptState.Intended,
              AttemptState.Running,
              AttemptState.Uncertain,
            ].includes(item.state),
        )
    )
      throw new Error(
        "Pause selected issues and confirm all assignments terminal before migration",
      );

    const manifest = (backup: string) => {
      const entries = issues.flatMap((issue) => {
        const receipt = journal.migration(issue.id, target.identity);
        return receipt?.backup === backup
          ? [{ id: issue.id, state: receipt.state }]
          : [];
      });
      const path = join(dirname(backup), "manifest.json");
      const text = JSON.stringify(
        { repository: target.identity, backup, issues: entries },
        null,
        2,
      );
      if (existsSync(path) && readFileSync(path, "utf8") === text) return;
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
        renameSync(temporary, path);
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
    };

    // Completion is the confirmed binding, not a frozen source snapshot. A replay
    // must not overwrite legitimate content or workflow changes made after cutover.
    for (const issue of complete) {
      const existing = await target.read(issue.id, AbortSignal.timeout(30000));
      if (existing === undefined)
        throw new Error(
          "Previously migrated issue is missing from authoritative storage",
        );
      const receipt = journal.migration(issue.id, target.identity);
      recoverTracker(issue, receipt?.backup);
      if (receipt !== undefined) {
        if (receipt.state === StorageMigrationState.Started) {
          checkpoint(receipt.backup);
          journal.completeMigration(issue.id, target.identity);
        }
        manifest(receipt.backup);
      }
    }
    const fresh = pending.filter(
      (issue) => journal.migration(issue.id, target.identity) === undefined,
    );
    let backup = issues.flatMap((issue) => {
      const receipt = journal.migration(issue.id, target.identity);
      return receipt === undefined ? [] : [receipt.backup];
    })[0];
    if (fresh.length > 0) {
      for (const issue of fresh) {
        const existing = await target.read(
          issue.id,
          AbortSignal.timeout(30000),
        );
        if (
          journal.get(issue.id) === undefined &&
          existing !== undefined &&
          !sameContent(contentOf(issue), existing)
        )
          throw new Error(
            "Conflicting issue content already exists in target storage",
          );
      }
      const key = createHash("sha256")
        .update(
          JSON.stringify([
            1,
            target.identity,
            fresh
              .slice()
              .sort((left, right) => left.id.localeCompare(right.id)),
          ]),
        )
        .digest("hex");
      const location = join(
        directory,
        "migration-backups",
        `issue-storage-${key}`,
      );
      mkdirSync(location, { recursive: true, mode: 0o700 });
      backup = join(location, "jobs.sqlite");
      if (!existsSync(backup)) {
        const temporary = `${backup}.${randomUUID()}.tmp`;
        try {
          store.backup(temporary);
          renameSync(temporary, backup);
        } finally {
          if (existsSync(temporary)) unlinkSync(temporary);
        }
      } else {
        checkpoint(backup);
      }
      const backupPath = backup;
      store.issues.atomic(() => {
        for (const issue of fresh) {
          const paused = {
            ...issue,
            waiting: Waiting.Paused,
            epoch: issue.epoch + 1,
            detail: "Issue storage migration; resume explicitly",
          };
          store.issues.save(paused, "storage_migration", paused.detail);
          journal.bind(contentOf(paused), target.identity);
          seedTracker(issue);
          journal.beginMigration(issue.id, target.identity, backupPath);
        }
      });
      manifest(backup);
    }
    for (const issue of pending) {
      const receipt = journal.migration(issue.id, target.identity);
      if (receipt === undefined) throw new Error("Migration receipt missing");
      if (receipt.state === StorageMigrationState.Completed)
        throw new Error("Completed migration has no confirmed storage binding");
      checkpoint(receipt.backup);
      recoverTracker(issue, receipt.backup);
      await synchronizeIssue(
        store.issues,
        store.issues.get(issue.id),
        target,
        AbortSignal.timeout(30000),
      );
      if (!journal.ready(issue.id))
        throw new Error("Issue migration remains unconfirmed");
      journal.completeMigration(issue.id, target.identity);
      manifest(receipt.backup);
    }
    return {
      state: pending.length === 0 ? "already_migrated" : "migrated",
      count: issues.length,
      migrated: pending.length,
      alreadyMigrated: complete.length,
      ...(backup === undefined ? {} : { backup }),
    };
  } finally {
    store.close();
  }
}
