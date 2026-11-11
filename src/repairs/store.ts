import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  storedRepair,
  RepairState,
  RepairStep,
  type RepairAttempt,
  type RebaseInput,
  type RepairProfile,
} from "./types.js";
export class RepairStore {
  constructor(
    private db: DatabaseSync,
    private now: () => number,
  ) {
    const version = db.prepare("PRAGMA user_version").get()?.["user_version"];
    if (
      version !== 3 &&
      version !== 4 &&
      version !== 5 &&
      version !== 6 &&
      version !== 7
    )
      throw new Error("Unsupported repair database version");
    if (version === 3)
      db.exec(`BEGIN IMMEDIATE;
   CREATE TABLE repair_attempts (
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
    pr_id TEXT NOT NULL REFERENCES tracked_prs(id),
    state TEXT NOT NULL CHECK(state IN ('queued','running','awaiting_checks','succeeded','blocked','failed','uncertain')),
    payload TEXT NOT NULL CHECK(json_valid(payload)), created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
    CHECK(json_extract(payload,'$.id') IS id), CHECK(json_extract(payload,'$.request.requestId') IS request_id),
    CHECK(json_extract(payload,'$.prId') IS pr_id), CHECK(json_extract(payload,'$.state') IS state)
   ) STRICT;
   CREATE UNIQUE INDEX one_active_repair ON repair_attempts(pr_id) WHERE state IN ('queued','running','awaiting_checks');
   PRAGMA user_version=4; COMMIT;`);
  }
  list(): RepairAttempt[] {
    return this.db
      .prepare("SELECT payload FROM repair_attempts ORDER BY rowid DESC")
      .all()
      .map((row) => storedRepair(JSON.parse(String(row["payload"]))));
  }
  get(id: string): RepairAttempt {
    const item = this.list().find((a) => a.id === id);
    if (item === undefined) throw new Error("Repair not found");
    return item;
  }
  request(
    input: RebaseInput,
    profile: RepairProfile,
    prId: string,
  ): RepairAttempt {
    const existing = this.list().find(
      (a) => a.request.requestId === input.requestId,
    );
    if (existing !== undefined) {
      if (JSON.stringify(existing.request) !== JSON.stringify(input))
        throw new Error("Repair request ID already used with different input");
      return existing;
    }
    const at = this.now();
    const a: RepairAttempt = {
      id: randomUUID(),
      request: input,
      profile,
      prId,
      state: RepairState.Queued,
      step: RepairStep.Fetch,
      detail: "Rebase requested",
      createdAt: at,
      updatedAt: at,
      conflictedPaths: [],
      usedAgent: false,
      mechanicalRepairs: 0,
      history: [
        {
          state: RepairState.Queued,
          step: RepairStep.Fetch,
          detail: "Rebase requested",
          at,
        },
      ],
    };
    this.save(a);
    return a;
  }
  save(a: RepairAttempt): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO repair_attempts VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,payload=excluded.payload,updated_at_ms=excluded.updated_at_ms",
        )
        .run(
          a.id,
          a.request.requestId,
          a.prId,
          a.state,
          JSON.stringify(a),
          a.createdAt,
          a.updatedAt,
        );
      this.db
        .prepare(
          "INSERT INTO events(job_id,at,kind,detail,pr_id) VALUES('',?,'repair_progress',?,?)",
        )
        .run(a.updatedAt, a.detail, a.prId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
