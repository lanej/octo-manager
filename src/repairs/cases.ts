import type { DatabaseSync } from "node:sqlite";
import { record, single, diagnostic } from "./types.js";
import type { ConflictVersions } from "./yaml.js";
export enum RecipeDecision {
  Pending = "pending",
  Applied = "applied",
  Declined = "declined",
  Error = "error",
}
export interface ConflictCase {
  id: number;
  repairId: string;
  round: number;
  path: string;
  recipe: string;
  toolVersion: string;
  decision: RecipeDecision;
  reason: string;
  refs: Partial<ConflictVersions>;
  at: number;
  inputs?: ConflictVersions;
  candidate?: string;
  agentResult?: string;
}
function texts(value: unknown): Partial<ConflictVersions> {
  const raw = record(value);
  const result: Partial<ConflictVersions> = {};
  for (const key of ["base", "target", "replayed"] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== "string")
        throw new Error("Invalid conflict evidence");
      result[key] = raw[key];
    }
  }
  return result;
}
export class ConflictStore {
  constructor(
    private db: DatabaseSync,
    private now: () => number,
    private table: "conflict_cases" | "merge_conflict_cases" = "conflict_cases",
  ) {
    const version = db.prepare("PRAGMA user_version").get()?.["user_version"];
    if (version === 4)
      db.exec(`BEGIN IMMEDIATE;
 CREATE TABLE conflict_cases (
 id INTEGER PRIMARY KEY,repair_id TEXT NOT NULL REFERENCES repair_attempts(id),round INTEGER NOT NULL,path TEXT NOT NULL,recipe TEXT NOT NULL,tool_version TEXT NOT NULL,
 decision TEXT NOT NULL CHECK(decision IN ('pending','applied','declined','error')),reason TEXT NOT NULL,refs_json TEXT NOT NULL CHECK(json_valid(refs_json)),
 inputs_json TEXT CHECK(inputs_json IS NULL OR json_valid(inputs_json)),candidate TEXT,agent_result TEXT,created_at_ms INTEGER NOT NULL,
 UNIQUE(repair_id,round,path,recipe)) STRICT;
 CREATE INDEX cases_by_recipe ON conflict_cases(recipe,decision,id); PRAGMA user_version=5; COMMIT;`);
    else if (
      version !== 5 &&
      version !== 6 &&
      version !== 7 &&
      version !== 8 &&
      version !== 9 &&
      version !== 10 &&
      version !== 11 &&
      version !== 13 &&
      version !== 12
    )
      throw new Error("Unsupported conflict database version");
  }
  private decode(row: Record<string, unknown>): ConflictCase {
    const decision = Object.values(RecipeDecision).find(
      (value) => value === row["decision"],
    );
    if (decision === undefined) throw new Error("Invalid conflict decision");
    const result: ConflictCase = {
      id: Number(row["id"]),
      repairId: single(row["repair_id"], "repair ID"),
      round: Number(row["round"]),
      path: single(row["path"], "conflict path", 4000),
      recipe: single(row["recipe"], "recipe"),
      toolVersion: single(row["tool_version"], "tool version", 500),
      decision,
      reason: diagnostic(row["reason"], "recipe reason"),
      refs: texts(JSON.parse(String(row["refs_json"]))),
      at: Number(row["created_at_ms"]),
    };
    if (typeof row["inputs_json"] === "string") {
      const input = texts(JSON.parse(row["inputs_json"]));
      if (
        input.base === undefined ||
        input.target === undefined ||
        input.replayed === undefined
      )
        throw new Error("Incomplete conflict input");
      result.inputs = {
        base: input.base,
        target: input.target,
        replayed: input.replayed,
      };
    }
    if (typeof row["candidate"] === "string")
      result.candidate = row["candidate"];
    if (typeof row["agent_result"] === "string")
      result.agentResult = row["agent_result"];
    return result;
  }
  list(after = 0): ConflictCase[] {
    return this.db
      .prepare(
        `SELECT id,repair_id,round,path,recipe,tool_version,decision,reason,refs_json,created_at_ms FROM ${this.table} WHERE id>? ORDER BY id LIMIT 100`,
      )
      .all(after)
      .map((row) => this.decode(row));
  }
  get(id: number): ConflictCase {
    const row = this.db
      .prepare(`SELECT * FROM ${this.table} WHERE id=?`)
      .get(id);
    if (row === undefined) throw new Error("Conflict case not found");
    return this.decode(row);
  }
  add(
    repairId: string,
    round: number,
    path: string,
    recipe: string,
    refs: Partial<ConflictVersions>,
    toolVersion: string,
    inputs?: ConflictVersions,
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO ${this.table}(repair_id,round,path,recipe,tool_version,decision,reason,refs_json,inputs_json,created_at_ms) VALUES(?,?,?,?,?,'pending','Recipe not yet attempted',?,?,?)`,
      )
      .run(
        repairId,
        round,
        path,
        recipe,
        toolVersion,
        JSON.stringify(refs),
        inputs === undefined ? null : JSON.stringify(inputs),
        this.now(),
      );
    return Number(result.lastInsertRowid);
  }
  decide(
    id: number,
    decision: RecipeDecision,
    reason: string,
    candidate?: string,
  ): void {
    this.db
      .prepare(
        `UPDATE ${this.table} SET decision=?,reason=?,candidate=COALESCE(?,candidate) WHERE id=?`,
      )
      .run(decision, reason.slice(0, 2000), candidate ?? null, id);
  }
  agentResult(id: number, content: string): void {
    this.db
      .prepare(`UPDATE ${this.table} SET agent_result=? WHERE id=?`)
      .run(content, id);
  }
}
