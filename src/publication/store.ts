import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { ContractSchema } from "./contract.js";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, lstatSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { digest, PublicationError } from "./contract.js";

const InputSchema = Type.Object({
  title: Type.String(),
  body: Type.String(),
  repository: Type.String(),
  root: Type.String(),
  headRef: Type.String(),
  headSha: Type.String(),
  baseRef: Type.String(),
  draft: Type.Boolean(),
  contract: ContractSchema,
  contractHash: Type.String(),
  track: Type.Optional(
    Type.Object({
      sessionId: Type.String(),
      endpoint: Type.String(),
      harness: Type.Optional(Type.Union([Type.Literal("codex"), Type.Literal("pi")])),
    }),
  ),
});
const PublicationSchema = Type.Object({
  id: Type.String(),
  state: Type.Union([
    Type.Literal("pending"),
    Type.Literal("published"),
    Type.Literal("failed"),
    Type.Literal("uncertain"),
  ]),
  input: InputSchema,
  attempted: Type.Boolean(),
  url: Type.Optional(Type.String()),
  error: Type.Optional(Type.Object({ code: Type.String(), fix: Type.String() })),
  tracking: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("unavailable")])),
});
export type PublicationInput = Static<typeof InputSchema>;
export type Publication = Static<typeof PublicationSchema>;

function parsePublication(text: string): Publication {
  const value: unknown = JSON.parse(text);
  if (!Check(PublicationSchema, value))
    throw new PublicationError("invalid_receipt", "Publication receipt is invalid; preserve it for inspection.");
  return value;
}

export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (lstatSync(path).isSymbolicLink())
    throw new PublicationError("linked_state", "The publication state directory must not be a symlink.");
  chmodSync(path, 0o700);
}

export class PublicationStore {
  private db: DatabaseSync;
  readonly directory: string;

  constructor(state: string) {
    this.directory = join(state, "publications");
    privateDirectory(this.directory);
    const file = join(this.directory, "requests.sqlite");
    try {
      if (lstatSync(file).isSymbolicLink())
        throw new PublicationError("linked_state", "Publication storage must not be a symlink.");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, digest TEXT NOT NULL, data TEXT NOT NULL);",
    );
  }

  close(): void {
    this.db.close();
  }

  accept(input: PublicationInput, requestKey?: string): Publication {
    const fingerprint = digest(input),
      key = requestKey ?? fingerprint;
    const value: Publication = {
      id: randomUUID(),
      state: "pending",
      input,
      attempted: false,
    };
    this.db
      .prepare("INSERT OR IGNORE INTO requests(id,request_key,digest,data) VALUES(?,?,?,?)")
      .run(value.id, key, fingerprint, JSON.stringify(value));
    const row = this.db.prepare("SELECT digest,data FROM requests WHERE request_key=?").get(key);
    if (typeof row?.["data"] !== "string") throw new Error("Publication request was not saved.");
    if (row["digest"] !== fingerprint)
      throw new PublicationError("request_changed", "Request ID already has different content; use a new request ID.");
    return parsePublication(row["data"]);
  }

  adoptLegacy(id: string, input: PublicationInput): Publication {
    if (!/^[a-f0-9-]{36}$/u.test(id)) throw new PublicationError("invalid_id", "Use a complete legacy submission ID.");
    const value: Publication = {
      id,
      state: "uncertain",
      input,
      attempted: true,
    };
    this.db
      .prepare("INSERT OR IGNORE INTO requests(id,request_key,digest,data) VALUES(?,?,?,?)")
      .run(id, "legacy:" + id, digest(input), JSON.stringify(value));
    return this.get(id);
  }

  get(id: string): Publication {
    const row = this.db.prepare("SELECT data FROM requests WHERE id=?").get(id);
    if (typeof row?.["data"] !== "string") throw new PublicationError("not_found", "Publication request not found.");
    return parsePublication(row["data"]);
  }

  save(value: Publication): void {
    this.db.prepare("UPDATE requests SET data=? WHERE id=?").run(JSON.stringify(value), value.id);
  }

  list(before: number, limit = 8): { items: Publication[]; next: number | undefined } {
    const rows = this.db
      .prepare("SELECT rowid,data FROM requests WHERE rowid<? ORDER BY rowid DESC LIMIT ?")
      .all(before, limit + 1);
    return {
      items: rows.slice(0, limit).map((row) => parsePublication(String(row["data"]))),
      next: rows.length > limit ? Number(rows[limit - 1]?.["rowid"]) : undefined,
    };
  }

  retry(id: string): Publication {
    const lock = this.lock(id);
    if (!lock) return this.get(id);
    try {
      const current = this.get(id);
      if (current.state === "published" || current.state === "pending") return current;
      const pending: Publication = { ...current, state: "pending" };
      delete pending.error;
      this.save(pending);
      return pending;
    } finally {
      lock.close();
    }
  }

  launchFailure(id: string): Publication {
    const lock = this.lock(id);
    if (!lock) return this.get(id);
    try {
      const current = this.get(id);
      if (current.state !== "pending") return current;
      const failed: Publication = {
        ...current,
        state: current.attempted ? "uncertain" : "failed",
        error: {
          code: "publisher_start",
          fix: "Publisher could not start; retry this receipt.",
        },
      };
      this.save(failed);
      return failed;
    } finally {
      lock.close();
    }
  }

  lock(id: string): DatabaseSync | undefined {
    if (!/^[a-f0-9-]{36}$/u.test(id))
      throw new PublicationError("invalid_id", "Use a complete publication request ID.");
    const locks = join(this.directory, "locks");
    privateDirectory(locks);
    const file = join(locks, id + ".sqlite");
    try {
      if (lstatSync(file).isSymbolicLink())
        throw new PublicationError("linked_state", "Publication lock must not be a symlink.");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const lock = new DatabaseSync(file);
    chmodSync(file, 0o600);
    try {
      lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
    } catch {
      lock.close();
      return undefined;
    }
    return lock;
  }
}

export function receipt(value: Publication): Record<string, unknown> {
  const tracking =
    value.tracking ??
    (value.input.track && (value.state === "pending" || value.state === "published") ? "pending" : undefined);
  return {
    id: value.id,
    state: value.state,
    ...(value.url === undefined ? {} : { url: value.url }),
    ...(!value.error ? {} : { error: value.error }),
    ...(tracking === undefined ? {} : { tracking }),
  };
}
