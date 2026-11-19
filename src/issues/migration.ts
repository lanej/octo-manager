import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../store.js";
import { decodeIssue } from "./validation.js";
import { contentOf, sameContent, type IssueRepository } from "./repository.js";
import { Waiting, AttemptState } from "./contracts.js";
import { synchronizeIssue } from "./storage.js";

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
    const selected = new Set(issues.map((issue) => issue.id));
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
    const location = join(
      directory,
      "migration-backups",
      `issue-storage-${randomUUID()}`,
    );
    mkdirSync(location, { recursive: true, mode: 0o700 });
    const backup = join(location, "jobs.sqlite");
    store.backup(backup);
    const migrated: string[] = [];
    const manifest = () => {
      writeFileSync(
        join(location, "manifest.json"),
        JSON.stringify(
          {
            repository: target.identity,
            ids: issues.map((issue) => issue.id),
            migrated,
            backup,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    };
    manifest();
    for (const issue of issues) {
      const signal = AbortSignal.timeout(30000);
      const original = contentOf(issue);
      const existing = await target.read(issue.id, signal);
      if (
        store.issues.repository.get(issue.id) === undefined &&
        existing !== undefined &&
        !sameContent(original, existing)
      )
        throw new Error(
          "Conflicting issue content already exists in target storage",
        );
      store.issues.atomic(() => {
        const paused = {
          ...issue,
          waiting: Waiting.Paused,
          epoch: issue.epoch + 1,
          detail: "Issue storage migration; resume explicitly",
        };
        store.issues.save(paused, "storage_migration", paused.detail);
        store.issues.repository.bind(contentOf(paused), target.identity);
      });
      await synchronizeIssue(
        store.issues,
        store.issues.get(issue.id),
        target,
        signal,
      );
      if (!store.issues.repository.ready(issue.id))
        throw new Error("Issue migration remains unconfirmed");
      migrated.push(issue.id);
      manifest();
    }
    return {
      state: "migrated",
      count: issues.length,
      migrated: migrated.length,
      backup,
    };
  } finally {
    store.close();
  }
}
